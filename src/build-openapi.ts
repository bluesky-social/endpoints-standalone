/**
 * Lexicon -> OpenAPI converter.
 *
 * Node/TS port of the original Deno `atproto-openapi-types/main.ts`. Reads the
 * lexicon JSON installed by `@atproto/lex` (`lexicons/**​/*.json`), converts each
 * query/procedure into an OpenAPI path and each schema def into a component.
 * Endpoints are partitioned by namespace into the views in `VIEWS`, and one
 * `openapi.<slug>.json` document is written per view. The rendered reference
 * (Scalar) loads them as a multi-source switcher.
 */
import { writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import fg from "fast-glob";
import type { OpenAPIV3_1 } from "openapi-types";

import { calculateTag, loadLexicon } from "./lib/utils";
import { codeSamplesFor } from "./lib/codesamples";

/**
 * Heuristic: does this operation require an authenticated session?
 *
 * Lexicons mark some endpoints with "Requires auth" in the description but the
 * convention is incomplete (e.g. `chat.bsky.*` and `tools.ozone.*` rarely use
 * it). We additionally treat the following as auth-required:
 *   - everything proxied via PDS to chat/Ozone backends
 *   - every write under `app.bsky.*` and `com.atproto.repo.*`
 *
 * `com.atproto.server.*` procedures are deliberately *not* auto-flagged: that's
 * where unauthenticated bootstrap endpoints live (createSession, createAccount,
 * requestPasswordReset, ...). The few server endpoints that do require auth
 * (deleteAccount, refreshSession, ...) already say so in their description.
 *
 * The flag is surfaced to Scalar as a per-operation `security: [{ Bearer: [] }]`
 * — that drives the "Auth Required" badge and lets the renderer hide the
 * misleading test-request button.
 */
function requiresAuth(id: string, def: any): boolean {
  if (id.startsWith("chat.bsky.") || id.startsWith("tools.ozone.")) return true;
  if (def.type === "procedure") {
    if (id.startsWith("app.bsky.") || id.startsWith("com.atproto.repo.")) return true;
  }
  // Falsely claims no-auth but the live deployment gates it (probe silent-404 audit).
  if (AUTH_REQUIRED.has(id)) return true;
  const desc = String(def.description ?? "").toLowerCase();
  return desc.includes("requires auth");
}

/**
 * For chat.bsky.* and tools.ozone.*, the PDS needs an `atproto-proxy` header
 * naming the backend to forward to. We surface this as an OpenAPI header
 * parameter with a `default`, so Scalar's test-request panel pre-fills the
 * usual value and users don't have to remember the DID.
 */
function atprotoProxyParameter(id: string): OpenAPIV3_1.ParameterObject | null {
  if (id.startsWith("chat.bsky.")) {
    return {
      name: "atproto-proxy",
      in: "header",
      required: true,
      description: "Service DID for the central Bluesky chat service. Don't change this.",
      schema: { type: "string", default: "did:web:api.bsky.chat#bsky_chat" },
    };
  }
  if (id.startsWith("tools.ozone.")) {
    return {
      name: "atproto-proxy",
      in: "header",
      required: true,
      description:
        "Service DID for the target Ozone instance. The default points at Bluesky's moderation service; replace it with a different DID for self-hosted Ozone.",
      schema: { type: "string", default: "did:plc:ar7c4by46qjdydhdevvrndac#atproto_labeler" },
    };
  }
  return null;
}

function injectProxyHeader(
  op: OpenAPIV3_1.OperationObject,
  id: string,
): void {
  const param = atprotoProxyParameter(id);
  if (!param) return;
  op.parameters = [...(op.parameters ?? []), param];
}

function injectSecurity(
  op: OpenAPIV3_1.OperationObject,
  id: string,
  def: any,
): void {
  if (requiresAuth(id, def)) {
    op.security = [{ Bearer: [] }];
  }
}
import {
  convertArray,
  convertObject,
  convertProcedure,
  convertQuery,
  convertRecord,
  convertString,
  convertToken,
} from "./lib/converters/mod";
import {
  INCLUDE_PREFIXES,
  NAMESPACE_ORDER,
  VIEWS,
  UNIMPLEMENTED_MANIFEST,
  AUTH_MISMATCH_MANIFEST,
  type View,
} from "../endpoints.config";

/**
 * Lexicon source trees, globbed in order. `lexicons/` is managed by `npm run
 * seed` + `@atproto/lex` (on-network, CID-pinned). `vendored-lexicons/` holds
 * hand-copied documents that aren't resolvable on-network yet (Jetstream v2's
 * `network.bsky.jetstream.*`) — kept separate because `seed-allowlist.ts`
 * `rmSync`s `lexicons/` on every run. See `vendored-lexicons/README.md`.
 */
const LEXICON_DIRS = [
  resolve(process.cwd(), "lexicons"),
  resolve(process.cwd(), "vendored-lexicons"),
];

/**
 * Endpoints the live network answers with `501 MethodNotImplemented`, discovered by
 * `npm run probe` (see `scripts/probe-implemented.ts`). They're specced but not
 * served, so we don't list cards for them — same treatment as unspecced/deprecated.
 * Absent/unreadable manifest ⇒ no boundary (build stays self-contained for CI).
 */
const UNIMPLEMENTED: Set<string> = (() => {
  const path = resolve(process.cwd(), UNIMPLEMENTED_MANIFEST);
  if (!existsSync(path)) return new Set<string>();
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return new Set<string>(data.unimplemented ?? []);
  } catch {
    return new Set<string>();
  }
})();

/**
 * Endpoints whose lexicon claims "Does not require auth" but whose live deployment
 * returns `404 XRPCNotSupported` unauthenticated while serving `200` authenticated —
 * the "silent-404" class from `npm run probe`'s auth-consistency audit (see
 * `scripts/probe-implemented.ts`). Unlike `UNIMPLEMENTED`, these ARE implemented, so we
 * keep the card; we just override the false no-auth claim (`overrideNoAuthClaim`) and
 * treat them as auth-required (`requiresAuth`), which hides the misleading live
 * test-request button. Only silent-404 is actioned — the audit's honest `401`
 * ("gated-401") mismatches are informational and left alone. Absent manifest ⇒ no-op.
 */
const AUTH_REQUIRED: Set<string> = (() => {
  const path = resolve(process.cwd(), AUTH_MISMATCH_MANIFEST);
  if (!existsSync(path)) return new Set<string>();
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    const mismatches: any[] = Array.isArray(data.mismatches) ? data.mismatches : [];
    return new Set<string>(
      mismatches
        .filter((m) => m?.severity === "silent-404" && typeof m.nsid === "string")
        .map((m) => m.nsid as string),
    );
  } catch {
    return new Set<string>();
  }
})();

/**
 * Rewrite a description that falsely claims the endpoint is callable without auth: drop
 * the "Does not require auth" sentence and mark it auth-required, so the card text
 * matches the live deployment. Called only for `AUTH_REQUIRED` ids. Self-healing: once
 * the lexicon/deployment is reconciled upstream and the mismatch clears from the audit,
 * the id leaves `AUTH_REQUIRED` and the original description flows through untouched.
 */
function overrideNoAuthClaim(def: any): void {
  const sentences = String(def.description ?? "")
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const kept = sentences.filter((s) => !/does\s*n[o']?t require auth/i.test(s));
  def.description = [...kept, "Requires auth."].join(" ").trim();
}

/** Per-view file written next to this config: `openapi.<slug>.json`. */
function outputFor(slug: string): string {
  return resolve(process.cwd(), `openapi.${slug}.json`);
}

/**
 * Shared Introduction (`info.description`), rendered as the first sidebar item in
 * every view. The cross-links in the routing bullet point at the per-view hash
 * slugs from `VIEWS` — keep them in sync.
 */
const SHARED_DESCRIPTION = [
  "This is the HTTP API reference for Bluesky. It covers the `app.bsky.*`, `com.atproto.*`, `chat.bsky.*`, and `tools.ozone.*` Lexicon namespaces — the Lexicons implemented by the Bluesky application, its related services (DMs, Ozone moderation), and the AT Protocol [PDS](https://atproto.com/guides/the-at-stack#pds) those services build on. Use the document switcher in the top left to move between endpoints.",
  "The wider AT Protocol Lexicon ecosystem is open and any service can publish its own Lexicons. For an index of community Lexicons see [lexicon.garden](https://lexicon.garden/), and for the schema language itself see the [Lexicon guide](https://atproto.com/guides/lexicon).",
  "## Authentication and request routing",
  "These endpoints don't all live on the same host, and where a request should be sent depends on whether the caller is authenticated:",
  [
    "- **Most `app.bsky.*` `GET`s are public** and can be called without authentication against the Bluesky AppView at `https://public.api.bsky.app`. `POST`s (writes) and any endpoint that returns account-private data require auth.",
    "- **Authenticated requests should be sent to the user's own PDS**. The PDS validates the session and, if needed, proxies the request to the correct backend. Proxied requests should [include an `atproto-proxy` header](https://atproto.com/specs/xrpc#service-proxying). [Bluesky DMs](#bluesky-dms/description/introduction) and [Ozone Moderation](#ozone-moderation/description/introduction) requests always require proxying.",
  ].join("\n"),
  "For client libraries that handle session management and proxying for you, see the [AT Protocol SDKs](https://atproto.com/sdks).",
  "To consume the whole network as a live, filterable JSON firehose (or replay a slice of it), see the [Jetstream API](#jetstream/description/introduction).",
].join("\n\n");

/** Public Bluesky-hosted Jetstream hosts (archive XRPC over https, live stream over wss). */
const JETSTREAM_HOST = "jetstream.us-west.bsky.network";

/**
 * Tag for the live-stream WebSocket cards. They get their own tag (not the
 * `network.bsky.jetstream` archive tag) so they render as a top-level group,
 * placed first in the Jetstream view (see the per-view ordering in main()).
 */
const JETSTREAM_STREAM_TAG = "Jetstream (WebSocket)";

/** Optional per-tag descriptions, rendered by Scalar as a tag-section intro. */
const TAG_DESCRIPTIONS: Record<string, string> = {
  [JETSTREAM_STREAM_TAG]:
    "Jetstream's live JSON firehose. These are **WebSocket** endpoints — connect with a WebSocket client.",
};

/**
 * Per-view Introduction for the Jetstream API document. Jetstream isn't a PDS
 * service — it's a standalone full-network archive + live JSON firehose — so it
 * gets its own intro rather than the shared auth/proxy guidance.
 */
const JETSTREAM_DESCRIPTION = [
  "[Jetstream](https://github.com/bluesky-social/jetstream) is a full-network archive and streaming service for AT Protocol. It ingests every record from the network and re-serves it as an easy-to-consume, filterable JSON stream.",
  "These docs covers two surfaces:",
  [
    "- **The live stream** — [`/subscribe`](#jetstream/tag/jetstream-websocket/GET/subscribe). A WebSocket of decoded JSON events, filterable by collection and DID.",
    "- **The replay archive** — the `network.bsky.jetstream.*` XRPC methods below. HTTP queries/procedures for planning and downloading the sealed binary archive, whether you're replaying history before cutting over to the live stream or taking a point-in-time snapshot.",
  ].join("\n"),
  "## Hosts and scope",
  `The Bluesky-hosted instances are at \`jetstream.us-west.bsky.network\` and \`jetstream.us-east.bsky.network\`.`,
].join("\n\n");

// ---------------------------------------------------------------------------
// Servers (per view). app.bsky/com.atproto reads default to the public AppView
// or the user's PDS; the relay (bsky.network) is added wherever com.atproto.sync
// methods live, since it's the only public host that serves them (the AppView
// 501s sync methods, the PDS auth-gates them). Jetstream lives on its own hosts.
// ---------------------------------------------------------------------------
const APPVIEW_SERVER: OpenAPIV3_1.ServerObject = {
  url: "https://public.api.bsky.app",
  description: "Public Bluesky AppView. Use this for unauthenticated `app.bsky.*` reads — no token required.",
};

const PDS_SERVER: OpenAPIV3_1.ServerObject = {
  url: "https://{host}",
  description:
    "Provide your PDS hostname. Use `bsky.social` if your account is hosted by Bluesky; replace it with your own PDS hostname (e.g. `pds.example.com`) if you're self-hosted. The PDS handles auth and proxies `app.bsky` / `chat.bsky` / `tools.ozone` calls onward. To get a token to make requests from this page, call `com.atproto.server.createSession` with your handle and an [app password](https://bsky.app/settings/app-passwords), and paste the returned `accessJwt` into the **Authentication** panel below. The token is then attached to every test request automatically.",
  variables: {
    host: { default: "bsky.social" },
  },
};

const RELAY_SERVER: OpenAPIV3_1.ServerObject = {
  url: "https://bsky.network",
  description:
    "Bluesky Relay. Serves the `com.atproto.sync.*` repo-sync reads (`listRepos`, `getRepo`, `listReposByCollection`, …) unauthenticated. Use when testing a `com.atproto.sync` method.",
};

const JETSTREAM_SERVERS: OpenAPIV3_1.ServerObject[] = [
  {
    url: "https://jetstream.us-west.bsky.network",
    description:
      "Bluesky Jetstream (US-West). XRPC methods (`network.bsky.jetstream.*`) are served via HTTPS; the stream is served via `wss://` (`/subscribe`).",
  },
  {
    url: "https://jetstream.us-east.bsky.network",
    description: "Bluesky Jetstream (US-East).",
  },
];

function serversFor(view: View): OpenAPIV3_1.ServerObject[] {
  if (view.slug === "jetstream") return JETSTREAM_SERVERS;
  const list = [APPVIEW_SERVER, PDS_SERVER];
  if (view.prefixes.some((p) => p.startsWith("com.atproto."))) list.push(RELAY_SERVER);
  return list;
}

function descriptionFor(view: View): string {
  return view.slug === "jetstream" ? JETSTREAM_DESCRIPTION : SHARED_DESCRIPTION;
}

/** Code-sample options for an endpoint: Jetstream archive XRPC targets its own
 *  host and has no SDK wrapper, so emit curl only. Everything else uses the
 *  SDK-backed defaults (TS/Go/curl against bsky.social). */
function codeSampleOptsFor(id: string) {
  if (id.startsWith("network.bsky.jetstream.")) {
    return { curlHost: JETSTREAM_HOST, only: ["shell" as const], auth: false };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Hand-authored WebSocket cards. Jetstream's live stream has no Lexicon, and
// OpenAPI/Scalar can't model a WebSocket — but the connection *handshake* is an
// HTTP GET (the route is literally `GET /subscribe`), so we document it as a GET
// whose query params are the real subscription options and whose response is the
// upgraded stream of JSON event frames. render.ts hides the in-page "Test
// Request" button on these (a plain GET without the Upgrade header just fails).
// Param/contract source: ../jetstream internal/subscribe/{handler,filter}.go.
// ---------------------------------------------------------------------------
const WS_EVENT_EXAMPLE = `\`\`\`json
{
  "did": "did:plc:eygmaihciaxprqvxpfvl6flk",
  "time_us": 1725911162329308,
  "cursor": 12345,
  "kind": "commit",
  "commit": {
    "rev": "3l3qo2vutsw2b",
    "operation": "create",
    "collection": "app.bsky.feed.like",
    "rkey": "3l3qo2vuowo2b",
    "cid": "bafyreidwaivazkwu67xztlmuobx35hs2lnfh3kolmgfmucldvhd3sgzcqi",
    "record": { "$type": "app.bsky.feed.like", "createdAt": "2024-09-09T19:46:02.102Z" }
  }
}
\`\`\``;

const WS_QUERY_PARAMS: OpenAPIV3_1.ParameterObject[] = [
  {
    name: "wantedCollections",
    in: "query",
    required: false,
    description:
      "Collections to receive `#commit` events for. Repeatable. Each value is an exact NSID (`app.bsky.feed.post`) or a namespace wildcard ending in `.*` (`app.bsky.feed.*`). Up to 100 entries; omit for all collections. Applies to commits only.",
    schema: { type: "array", items: { type: "string" } },
  },
  {
    name: "wantedDids",
    in: "query",
    required: false,
    description: "DIDs to receive events for, across all event kinds. Repeatable, up to 10,000 entries. Omit for all repos.",
    schema: { type: "array", items: { type: "string", format: "did" } },
  },
  {
    name: "cursor",
    in: "query",
    required: false,
    description:
      "Resume point. A value below 1×10¹⁵ is a Jetstream sequence number (`cursor=0` replays from the start of the replay window); a value at or above 1×10¹⁵ is read as a v1 unix-microsecond timestamp (backwards compatibility). Replay is bounded to the most recent 36h by default — older cursors clamp to the floor, future cursors start at the live tip. Omit to start live.",
    schema: { type: "integer", format: "int64", minimum: 0 },
  },
  {
    name: "extended",
    in: "query",
    required: false,
    description:
      "Set `true` for the extended payload: a strict superset adding `seq`, `upstream_relay_cursor`, `commit.record_cbor` (base64 DAG-CBOR), `sync.blocks` (base64 CAR), and interleaved control events (`segment_sealed`, `segment_compacted`, `heartbeat`). Heavier to produce and may be more strictly rate-limited.",
    schema: { type: "boolean", default: false },
  },
  {
    name: "maxMessageSizeBytes",
    in: "query",
    required: false,
    description: "Drop any event whose uncompressed JSON exceeds this size. `0` or omitted means no cap.",
    schema: { type: "integer", minimum: 0, default: 0 },
  },
  {
    name: "compress",
    in: "query",
    required: false,
    description:
      "Set `true` to opt into Jetstream's legacy custom zstd-dictionary compression (frames arrive as binary WebSocket messages). Kept for v1 compatibility only — prefer RFC 7692 `permessage-deflate`, which is negotiated automatically. Offering both at once is rejected.",
    schema: { type: "boolean", default: false },
  },
  {
    name: "requireHello",
    in: "query",
    required: false,
    description:
      "Set `true` to withhold all events until the client sends its first `options_update` message, so the filter can be set before any data flows.",
    schema: { type: "boolean", default: false },
  },
];

function jetstreamSubscribeOp(): OpenAPIV3_1.OperationObject {
  const path = "/subscribe";
  const url = `wss://${JETSTREAM_HOST}${path}?wantedCollections=app.bsky.feed.post`;
  const description = [
    `> **WebSocket endpoint (\`wss://\`).** This is a persistent event stream, not a request/response call — connect with a WebSocket client.`,
    `The connection opens as an HTTP \`GET ${path}\` with the standard \`Upgrade: websocket\` handshake, then streams JSON event frames over \`wss://${JETSTREAM_HOST}${path}\` for as long as it stays open. The query parameters below are the subscription options.`,
    "Each frame is one decoded event — `commit`, `identity`, `account`, or `sync` — for example:",
    WS_EVENT_EXAMPLE,
    "`time_us` is Jetstream's own ingest timestamp (unix microseconds); `cursor` is its monotonic per-event sequence number — save it and pass `?cursor=N` on reconnect to resume (delivery is at-least-once, so process idempotently).",
    "Clients may also send `options_update` messages to change the filter mid-stream, e.g. `{\"type\":\"options_update\",\"payload\":{\"wantedCollections\":[\"app.bsky.feed.like\"]}}`.",
  ].join("\n\n");

  // No `responses` block: this isn't a request/response operation, and a synthetic
  // `101` rendered in a "Responses" panel just reinforces the wrong mental model.
  // The event-frame shape lives in the description instead. render.ts relabels the
  // method badge GET -> WSS and recolors it (see markWebsocketMethod).
  return {
    tags: [JETSTREAM_STREAM_TAG],
    summary: path,
    description,
    operationId: "network.bsky.jetstream.subscribe",
    parameters: WS_QUERY_PARAMS,
    "x-codeSamples": [
      {
        lang: "shell",
        label: "websocat",
        source: `# stream all app.bsky.feed.post commits (Ctrl-C to stop)\nwebsocat '${url}'`,
      },
      {
        lang: "javascript",
        label: "Browser / Node (ws)",
        source:
          `const ws = new WebSocket(\n  '${url}'\n)\n` +
          `ws.onmessage = (e) => {\n  const evt = JSON.parse(e.data)\n  console.log(evt.kind, evt.did, evt.commit?.collection)\n}\n` +
          `// change the filter mid-stream:\n` +
          `// ws.send(JSON.stringify({ type: 'options_update', payload: { wantedCollections: ['app.bsky.feed.like'] } }))`,
      },
    ],
  } as OpenAPIV3_1.OperationObject;
}

/**
 * Synthetic WebSocket path injected into the Jetstream view. Cast through
 * `unknown` for the same reason the converter loop uses `@ts-ignore` on its
 * method-keyed PathItem writes: openapi-types' V3_1 PathItemObject references the
 * V3 OperationObject, whose `exclusiveMaximum`/array typing is incompatible.
 */
const JETSTREAM_WEBSOCKET_PATHS = {
  "/subscribe": { get: jetstreamSubscribeOp() },
} as unknown as OpenAPIV3_1.PathsObject;

/** Schema components are shared across views (cross-namespace `$ref`s are common). */
const components: OpenAPIV3_1.ComponentsObject = {
  schemas: {},
  securitySchemes: {
    Bearer: { type: "http", scheme: "bearer" },
  },
};

/** Endpoint paths and sidebar tags, accumulated per view (keyed by slug). */
const viewPaths: Record<string, OpenAPIV3_1.PathsObject> = {};
const viewTags: Record<string, Set<string>> = {};
for (const v of VIEWS) {
  viewPaths[v.slug] = {};
  viewTags[v.slug] = new Set<string>();
}

/** First view whose prefixes match this NSID (where the endpoint is filed). */
function viewForId(id: string): View | undefined {
  return VIEWS.find((v) => v.prefixes.some((p) => id.startsWith(p)));
}

/** Flag a (non-`$ref`) component schema as deprecated, in place. */
function markDeprecated(
  schema: OpenAPIV3_1.SchemaObject | OpenAPIV3_1.ReferenceObject,
  deprecated: boolean,
): OpenAPIV3_1.SchemaObject | OpenAPIV3_1.ReferenceObject {
  if (deprecated && schema && !("$ref" in schema)) {
    (schema as OpenAPIV3_1.SchemaObject).deprecated = true;
  }
  return schema;
}

/** Order tags by NAMESPACE_ORDER first, then alphabetically. */
function namespaceRank(id: string): number {
  const i = NAMESPACE_ORDER.findIndex((p) => id.startsWith(p));
  return i === -1 ? NAMESPACE_ORDER.length : i;
}

function sortedTags(tagNames: Set<string>): string[] {
  return Array.from(tagNames).sort((a, b) => {
    const ra = namespaceRank(a);
    const rb = namespaceRank(b);
    return ra !== rb ? ra - rb : a.localeCompare(b);
  });
}

/** Build Scalar/Redoc `x-tagGroups` so app.bsky.* and com.atproto.* lead. */
function tagGroups(tags: string[]): { name: string; tags: string[] }[] {
  const groups: { name: string; tags: string[] }[] = [];
  const used = new Set<string>();

  for (const prefix of NAMESPACE_ORDER) {
    const name = prefix.replace(/\.$/, "");
    const groupTags = tags.filter((t) => t.startsWith(prefix));
    groupTags.forEach((t) => used.add(t));
    if (groupTags.length) groups.push({ name, tags: groupTags });
  }

  const other = tags.filter((t) => !used.has(t));
  if (other.length) groups.push({ name: "Other", tags: other });

  return groups;
}

async function main() {
  const entries: string[] = [];
  for (const dir of LEXICON_DIRS) {
    if (!existsSync(dir)) continue;
    entries.push(...(await fg("**/*.json", { cwd: dir, absolute: true })));
  }

  if (entries.length === 0) {
    throw new Error(
      `No lexicon JSON found in ${LEXICON_DIRS.join(", ")}. Run \`npm run install-lexicons\` first.`,
    );
  }

  for (const entry of entries.sort()) {
    const doc = await loadLexicon(entry);
    const id = doc.id;
    const defs = doc.defs as Record<string, any>;

    // Endpoints are only emitted for the curated namespaces. Schemas (defs)
    // outside them may still be present as transitive `$ref` targets — those
    // become components but never get a path or a sidebar tag.
    const isEndpointNamespace = INCLUDE_PREFIXES.some((p) => id.startsWith(p));

    for (const [name, def] of Object.entries(defs)) {
      const identifier = name === "main" ? id : `${id}.${name}`;
      const isEndpoint = def.type === "query" || def.type === "procedure";

      const containsUnspecced =
        identifier.toLowerCase().includes("unspecced") ||
        identifier.toLowerCase().includes(".temp.");
      const isDeprecated =
        def.description?.toLowerCase().startsWith("deprecated") ?? false;

      // Endpoints: skip unspecced/temp/deprecated entirely — we don't want cards
      // for them. Schema defs: always emit, because they may be `$ref` targets;
      // dropping a referenced schema would leave a dangling pointer. Deprecated
      // schema defs are emitted but flagged via `deprecated: true`.
      if (isEndpoint && (containsUnspecced || isDeprecated)) {
        continue;
      }

      // Correct a false "Does not require auth" claim before the def is converted, so
      // both the rendered description and `injectSecurity` reflect the live deployment.
      if (isEndpoint && AUTH_REQUIRED.has(identifier)) {
        overrideNoAuthClaim(def);
      }

      switch (def.type) {
        case "array":
          components.schemas![identifier] = markDeprecated(
            convertArray(id, name, def),
            isDeprecated,
          );
          break;
        case "object":
          components.schemas![identifier] = markDeprecated(
            convertObject(id, name, def),
            isDeprecated,
          );
          break;
        case "procedure": {
          if (!isEndpointNamespace) break;
          const view = viewForId(id);
          if (!view) break;
          const post = convertProcedure(id, name, def);
          if (post) {
            (post as any)["x-codeSamples"] = codeSamplesFor(id, def, codeSampleOptsFor(id));
            injectProxyHeader(post, id);
            injectSecurity(post, id, def);
            // @ts-ignore method-keyed PathItem
            viewPaths[view.slug][`/xrpc/${id}`] = { post };
            viewTags[view.slug].add(calculateTag(id));
          }
          break;
        }
        case "query": {
          if (!isEndpointNamespace) break;
          // Specced but unimplemented upstream (probe found 501 MethodNotImplemented):
          // keep the schema as a possible `$ref` target, but emit no endpoint card.
          if (UNIMPLEMENTED.has(identifier)) break;
          const view = viewForId(id);
          if (!view) break;
          const get = convertQuery(id, name, def);
          if (get) {
            (get as any)["x-codeSamples"] = codeSamplesFor(id, def, codeSampleOptsFor(id));
            injectProxyHeader(get, id);
            injectSecurity(get, id, def);
            // @ts-ignore method-keyed PathItem
            viewPaths[view.slug][`/xrpc/${id}`] = { get };
            viewTags[view.slug].add(calculateTag(id));
          }
          break;
        }
        case "record":
          components.schemas![identifier] = markDeprecated(
            convertRecord(id, name, def),
            isDeprecated,
          );
          break;
        case "string":
          components.schemas![identifier] = markDeprecated(
            convertString(id, name, def),
            isDeprecated,
          );
          break;
        case "subscription":
          // Event-stream subscriptions can't be represented in OpenAPI; skip.
          break;
        case "permission-set":
          // No OpenAPI representation; skip.
          break;
        case "token":
          components.schemas![identifier] = markDeprecated(
            convertToken(id, name, def),
            isDeprecated,
          );
          break;
        default:
          throw new Error(`Unknown type: ${def.type} (${identifier})`);
      }
    }
  }

  // The Jetstream live stream has no Lexicon, so its WebSocket cards are
  // hand-authored (see JETSTREAM_WEBSOCKET_PATHS) and merged in here alongside
  // the converted `network.bsky.jetstream.*` archive endpoints.
  Object.assign(viewPaths["jetstream"], JETSTREAM_WEBSOCKET_PATHS);
  viewTags["jetstream"].add(JETSTREAM_STREAM_TAG);

  // One OpenAPI document per view; the renderer surfaces them as a switcher
  // dropdown. They share the full component set (cross-namespace `$ref`s are
  // common, and bundling every schema in each document keeps those pointers from
  // dangling); servers and the Introduction are per-view (see serversFor /
  // descriptionFor).
  for (const view of VIEWS) {
    let tags = sortedTags(viewTags[view.slug]);
    const paths = viewPaths[view.slug];

    // Jetstream gets no `x-tagGroups`: each of its two tags ("Live stream" and
    // the archive namespace) holds a single set of operations, so a group layer
    // just renders a redundant heading above each tag. Without groups, Scalar
    // lists the tags directly; we only reorder so the live stream leads.
    const isJetstream = view.slug === "jetstream";
    if (isJetstream) {
      tags = [JETSTREAM_STREAM_TAG, ...tags.filter((t) => t !== JETSTREAM_STREAM_TAG)];
    }

    const api: OpenAPIV3_1.Document & { "x-tagGroups"?: unknown } = {
      openapi: "3.1.0",
      info: {
        title: `Bluesky HTTP API Reference — ${view.title}`,
        summary: "HTTP/XRPC endpoint reference for Bluesky and AT Protocol lexicons.",
        description: descriptionFor(view),
        // We don't version this HTTP reference list, so leave it empty: Scalar's
        // InfoVersion badge renders nothing for a falsy version string (a real
        // "0.0.0" would otherwise show a meaningless "v0.0.0" badge by the title).
        version: "",
      },
      servers: serversFor(view),
      // No document-level `security` array — we only declare it per-operation
      // (via `injectSecurity`) on endpoints flagged by `requiresAuth`. That way
      // Scalar stamps an accurate "Auth Required" badge on the writes/proxied
      // endpoints it applies to, and stays silent on the public reads. The
      // renderer uses the badge's presence to hide the test-request button on
      // those operations — see render.ts.
      paths,
      components,
      tags: tags.map((name) => ({
        name,
        ...(TAG_DESCRIPTIONS[name] ? { description: TAG_DESCRIPTIONS[name] } : {}),
      })),
      "x-tagGroups": isJetstream ? undefined : tagGroups(tags),
    };

    const output = outputFor(view.slug);
    await writeFile(output, JSON.stringify(api, null, 2) + "\n");
    console.log(
      `Wrote ${output}: ${Object.keys(paths).length} endpoints, ` +
        `${Object.keys(components.schemas!).length} schemas, ${tags.length} tags.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
