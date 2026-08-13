/**
 * Probe Bluesky's live services for endpoints that are *specced* but not actually
 * *implemented*, and record them so `build-openapi` can unlist them.
 *
 * Why this exists: the reference enumerates every query/procedure the schema
 * authorities publish, but the live AppView/PDS/relay don't necessarily serve all of
 * them (e.g. `com.atproto.identity.resolveDid` returns `501 MethodNotImplemented`;
 * `app.bsky.graph.searchStarterPacks` returns `404 XRPCNotSupported`). Listing a card
 * for an endpoint nobody answers is misleading, so we prune them.
 *
 * How it decides — see the long note on `PROBE_*` in `endpoints.config.ts`. In short:
 * each method has a home service and hosts return a "not my method" answer for methods
 * that aren't their own, so we probe a panel of hosts. Which host is authoritative —
 * and what its "unimplemented" answer looks like — is namespace-specific: the
 * authenticated PDS is authoritative for `com.atproto.*` (via `501 MethodNotImplemented`),
 * the appview for `app.bsky.*` (via `404 XRPCNotSupported`). All other hosts contribute
 * positive ("served here") signals only.
 *
 * Only QUERIES are probed — we never send a procedure (write) to the live network.
 *
 * Run: `npm run probe`. For the authoritative PDS check set:
 *   BSKY_PROBE_IDENTIFIER     handle or DID (e.g. probe-bot.bsky.social)
 *   BSKY_PROBE_APP_PASSWORD   an app password (the probe only sends GETs, so it never
 *                             writes — prefer a throwaway/secondary account regardless)
 *   BSKY_PROBE_PDS            optional; defaults to PROBE_HOSTS.pds
 * Without credentials the probe runs in a safe no-op mode (unlists nothing, warns).
 *
 * Output: `UNIMPLEMENTED_MANIFEST` (committed; an input to the deterministic build,
 * like `lexicons.json`). Re-runnable.
 */
import dns from "node:dns";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import fg from "fast-glob";

import { loadLexicon } from "../src/lib/utils";
import {
  PROBE_NAMESPACES,
  PROBE_HOSTS,
  UNIMPLEMENTED_MANIFEST,
  AUTH_AUDIT_HOSTS,
  AUTH_MISMATCH_MANIFEST,
} from "../endpoints.config";

// Same Windows loopback-only DNS workaround as seed-allowlist / lex.mjs
// (nodejs/node#62347). No-op on healthy systems, including Linux CI.
if (dns.getServers().every((s) => s === "127.0.0.1" || s === "::1")) {
  dns.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);
}

const WORKSPACE = resolve(fileURLToPath(new URL("..", import.meta.url)));
const LEXICONS_DIR = resolve(WORKSPACE, "lexicons");
const MANIFEST = resolve(WORKSPACE, UNIMPLEMENTED_MANIFEST);
const AUTH_MANIFEST = resolve(WORKSPACE, AUTH_MISMATCH_MANIFEST);

/** Matches a lexicon description that claims the method is callable without auth. */
const NO_AUTH_RE =
  /does ?n[o']?t require auth|no[- ]?auth|unauthenticated|public and does not require/i;

const PDS = (process.env.BSKY_PROBE_PDS ?? PROBE_HOSTS.pds).replace(/\/$/, "");
const IDENTIFIER = process.env.BSKY_PROBE_IDENTIFIER;
const APP_PASSWORD = process.env.BSKY_PROBE_APP_PASSWORD;

const REQUEST_TIMEOUT_MS = 15_000;
const CONCURRENCY = 6;

type Signal = "implemented" | "unimplemented" | "inconclusive";

interface HostResult {
  host: string;
  status: number | null; // null = network error / timeout
  error?: string; // XRPC error name from the JSON body, when present
  signal: Signal;
}

interface EndpointResult {
  nsid: string;
  decision: "keep" | "unlist" | "inconclusive";
  hosts: HostResult[];
}

interface Query {
  nsid: string;
  parameters?: any; // the lexicon `main.parameters` schema (a `params` def), if any
  claimsNoAuth: boolean; // description asserts the method is callable without auth
}

/** Enumerate the installed queries in `PROBE_NAMESPACES` from the local lexicons. */
async function enumerateQueries(): Promise<Query[]> {
  const files = await fg("**/*.json", { cwd: LEXICONS_DIR, absolute: true });
  const queries: Query[] = [];
  for (const file of files.sort()) {
    const doc = await loadLexicon(file);
    const id = doc.id as string;
    if (!PROBE_NAMESPACES.some((ns) => id.startsWith(ns))) continue;
    const main = (doc.defs as Record<string, any>)?.main;
    if (main?.type === "query") {
      queries.push({
        nsid: id,
        parameters: main.parameters,
        claimsNoAuth: NO_AUTH_RE.test(main.description ?? ""),
      });
    }
  }
  return queries;
}

/**
 * A syntactically-valid placeholder for a single param `schema`. The value only has
 * to PASS the appview's edge validation (presence + format) so the request reaches
 * routing — it needn't resolve to real data. This matters because the appview
 * validates params *before* proxying: a request missing a required param (or with a
 * malformed one) is rejected `400 InvalidRequest` at the edge, which is
 * indistinguishable from a real handler's `400` — so an unimplemented method (e.g.
 * `graph.searchStarterPacks`) would look implemented. With valid params the request
 * proxies through and the appview's true `404 XRPCNotSupported` surfaces.
 * Returns null for types we can't synthesize (the param is then omitted).
 */
function synthValue(schema: any): string | null {
  switch (schema?.type) {
    case "string":
      switch (schema.format) {
        case "at-identifier":
        case "handle":
          return "bsky.app";
        case "did":
          return "did:plc:z72i7hdynmk6r22z27h6tvur";
        case "at-uri":
          return "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/self";
        case "nsid":
          return "app.bsky.feed.post";
        case "datetime":
          return "2024-01-01T00:00:00.000Z";
        case "uri":
          return "https://example.com";
        case "language":
          return "en";
        default:
          if (typeof schema.const === "string") return schema.const;
          if (Array.isArray(schema.enum) && schema.enum.length) return String(schema.enum[0]);
          return "x";
      }
    case "integer":
      if (typeof schema.minimum === "number") return String(schema.minimum);
      if (typeof schema.default === "number") return String(schema.default);
      return "1";
    case "boolean":
      return "true";
    default:
      return null; // unknown/token — can't synthesize; omit
  }
}

/** Build a query string satisfying a query's REQUIRED params (see `synthValue`). */
function synthQuery(parameters: any): string {
  const required: string[] = parameters?.required ?? [];
  const props: Record<string, any> = parameters?.properties ?? {};
  const sp = new URLSearchParams();
  for (const key of required) {
    const schema = props[key];
    if (!schema) continue;
    const value =
      schema.type === "array" ? synthValue(schema.items) : synthValue(schema);
    if (value != null) sp.append(key, value);
  }
  return sp.toString();
}

/** One unauthenticated/authenticated XRPC GET. Never throws. */
async function xrpcGet(
  base: string,
  nsid: string,
  query: string,
  token?: string,
): Promise<{ status: number | null; error?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/xrpc/${nsid}${query ? `?${query}` : ""}`, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      signal: ctrl.signal,
    });
    let error: string | undefined;
    try {
      const body: any = await res.json();
      if (body && typeof body.error === "string") error = body.error;
    } catch {
      /* non-JSON body; status alone is enough */
    }
    return { status: res.status, error };
  } catch {
    return { status: null };
  } finally {
    clearTimeout(t);
  }
}

/** The (status, error) a given authoritative host returns to mean "not served here". */
interface DeadSignal {
  status: number;
  error: string; // lowercased XRPC error name
}

interface Target {
  host: string;
  base: string;
  authoritative: boolean;
  auth?: string;
  /**
   * On the authoritative host, the answer that definitively means "unimplemented".
   * PDS entryway → `501 MethodNotImplemented`; appview proxy → `404 XRPCNotSupported`.
   * Only consulted when `authoritative`; ignored on positive-only hosts.
   */
  dead?: DeadSignal;
}

/**
 * Map one host's HTTP response to a signal for `target`. The distinction that matters
 * is *did a method handler run* (→ implemented) vs *did the request never reach one*
 * (→ no signal) vs *did the authoritative host say "not served"* (→ unimplemented):
 *
 * - The authoritative host's own `dead` answer ⇒ unimplemented. Note this is
 *   host-specific: the appview `501`s app.bsky methods it proxies to the PDS (e.g.
 *   `actor.getPreferences`), so only its `404 XRPCNotSupported` — never its `501` —
 *   counts; the PDS's authoritative answer is `501 MethodNotImplemented`.
 * - `501 MethodNotImplemented` / `404 XRPCNotSupported` from any *other* host is just
 *   "not my method" ⇒ no signal (e.g. the appview `501`s com.atproto methods that live
 *   on the PDS; the appview `501`s proxied app.bsky methods).
 * - `401` is the entryway auth gate, which runs *before* method resolution, so it
 *   tells us nothing about whether the method exists.
 * - A bare `404 Not Found` (or any 404/5xx without a method-level error) is a routing
 *   miss — the host simply doesn't expose this path. The relay does this for non-`sync`
 *   methods, so it must NOT be read as "implemented".
 * - Everything else came from a running handler: `200`, `400 InvalidRequest/BadRequest`,
 *   `403`, or a method-level `404` (`HostNotFound`, `RecordNotFound`, …) ⇒ implemented.
 */
function classify(
  status: number | null,
  error: string | undefined,
  target: Target,
): Signal {
  if (status === null) return "inconclusive";
  const err = error?.toLowerCase();

  if (
    target.authoritative &&
    target.dead &&
    status === target.dead.status &&
    err === target.dead.error
  ) {
    return "unimplemented";
  }
  // "Not my method" answers from any host (incl. the authoritative host's non-`dead`
  // variant, e.g. the appview's `501` for proxied app.bsky methods) ⇒ no signal.
  if (status === 501 && err === "methodnotimplemented") return "inconclusive";
  if (status === 404 && err === "xrpcnotsupported") return "inconclusive";
  if (status === 401) return "inconclusive"; // auth gate / admin-only; pre-method
  if (status === 429) return "inconclusive"; // rate limited; retry, don't conclude
  // Generic routing miss (no method-level XRPC error in the body).
  if (status === 404 && (!err || err === "not found" || err === "notfound")) {
    return "inconclusive";
  }
  if (status >= 500) return "inconclusive"; // 5xx (incl. non-MNI 501) — gateway/transient
  return "implemented";
}

/**
 * The host panel for `nsid`, tailored to its namespace. See the `PROBE_*` note in
 * `endpoints.config.ts` for the authoritative-host rationale.
 */
function targetsFor(nsid: string, token: string | undefined): Target[] {
  if (nsid.startsWith("app.bsky.")) {
    return [
      // Home & authoritative, but only on `404 XRPCNotSupported`; its `501` means the
      // method is PDS-proxied (implemented), so it's not `dead`. Unauthenticated —
      // route-existence doesn't need auth.
      {
        host: "appview",
        base: PROBE_HOSTS.appview,
        authoritative: true,
        dead: { status: 404, error: "xrpcnotsupported" },
      },
      // Positive-only rescue: the authed PDS proxies app.bsky reads to the appview, so
      // a non-error here keeps auth-gated methods the public appview `401`s on.
      { host: "pds", base: PDS, authoritative: false, auth: token },
    ];
  }
  // com.atproto.* — unchanged from the original panel.
  return [
    { host: "appview", base: PROBE_HOSTS.appview, authoritative: false },
    { host: "relay", base: PROBE_HOSTS.relay, authoritative: false },
    {
      host: "pds",
      base: PDS,
      authoritative: true,
      auth: token,
      dead: { status: 501, error: "methodnotimplemented" },
    },
  ];
}

async function probeEndpoint(
  query: Query,
  token: string | undefined,
): Promise<EndpointResult> {
  const { nsid } = query;
  const targets = targetsFor(nsid, token);
  const qs = synthQuery(query.parameters);

  const hosts: HostResult[] = [];
  for (const tgt of targets) {
    const { status, error } = await xrpcGet(tgt.base, nsid, qs, tgt.auth);
    hosts.push({
      host: tgt.host,
      status,
      error,
      signal: classify(status, error, tgt),
    });
  }

  let decision: EndpointResult["decision"];
  if (hosts.some((h) => h.signal === "implemented")) {
    decision = "keep";
  } else if (hosts.some((h) => h.signal === "unimplemented")) {
    // Only an authoritative host can emit "unimplemented" (see `classify`).
    decision = "unlist";
  } else {
    decision = "inconclusive"; // no positive signal and the authority couldn't be reached/authed
  }
  return { nsid, decision, hosts };
}

// ── Auth-consistency audit ────────────────────────────────────────────────────
// See the `AUTH_AUDIT_HOSTS` note in `endpoints.config.ts`.

interface AuthMismatch {
  nsid: string;
  host: string;
  unauth: string; // "status[/error]"
  authed: string;
  severity: "silent-404" | "gated-401"; // 404 looks unimplemented; 401/403 is an honest gate
}

/** The host that actually implements `nsid`, where auth is the only variable. */
function authAuditHost(nsid: string): string | undefined {
  for (const [prefix, host] of Object.entries(AUTH_AUDIT_HOSTS)) {
    if (nsid.startsWith(prefix)) {
      // Honor a BSKY_PROBE_PDS override for the PDS-hosted namespaces.
      return host === PROBE_HOSTS.pds ? PDS : host;
    }
  }
  return undefined;
}

/** True if the response came from a running handler (see `classify`'s "implemented"). */
function ranHandler(status: number | null, error: string | undefined): boolean {
  return (
    classify(status, error, { host: "", base: "", authoritative: false }) ===
    "implemented"
  );
}

/**
 * Probe one no-auth-claiming query unauthenticated and authenticated against the host
 * that implements it. Returns a mismatch when the authed call reaches a handler but the
 * unauth call is blocked — i.e. the method requires auth despite claiming not to.
 */
async function auditAuth(
  query: Query,
  token: string,
): Promise<AuthMismatch | null> {
  const host = authAuditHost(query.nsid);
  if (!host) return null;
  const qs = synthQuery(query.parameters);
  const fmt = (r: { status: number | null; error?: string }) =>
    `${r.status === null ? "ERR" : r.status}${r.error ? `/${r.error}` : ""}`;

  const unauth = await xrpcGet(host, query.nsid, qs);
  const authed = await xrpcGet(host, query.nsid, qs, token);

  if (!ranHandler(authed.status, authed.error)) return null; // authed didn't reach a handler → inconclusive
  const err = unauth.error?.toLowerCase();
  const silent = unauth.status === 404 && err === "xrpcnotsupported";
  const gated = unauth.status === 401 || unauth.status === 403;
  if (!silent && !gated) return null; // unauth also reached a handler → claim holds

  return {
    nsid: query.nsid,
    host: host.replace(/^https?:\/\//, ""),
    unauth: fmt(unauth),
    authed: fmt(authed),
    severity: silent ? "silent-404" : "gated-401",
  };
}

/** Run `fn` over `items` with bounded concurrency, preserving input order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function createSession(): Promise<string | undefined> {
  if (!IDENTIFIER || !APP_PASSWORD) return undefined;
  const res = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: IDENTIFIER, password: APP_PASSWORD }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `createSession failed on ${PDS} (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  const { accessJwt } = await res.json();
  if (!accessJwt) throw new Error("createSession returned no accessJwt");
  return accessJwt;
}

function fmtHost(h: HostResult): string {
  const code = h.status === null ? "ERR" : String(h.status);
  const tag =
    h.signal === "implemented" ? "✓" : h.signal === "unimplemented" ? "✗" : "·";
  return `${h.host}=${code}${h.error ? `/${h.error}` : ""}${tag}`;
}

async function main() {
  const queries = await enumerateQueries();
  if (queries.length === 0) {
    throw new Error(
      `No queries found in ${LEXICONS_DIR}. Run \`npm run install-lexicons\` first.`,
    );
  }

  let token: string | undefined;
  try {
    token = await createSession();
  } catch (err) {
    console.error(`\n[probe] ${(err as Error).message}`);
    console.error("[probe] Continuing unauthenticated.\n");
  }
  const authenticated = Boolean(token);
  if (!authenticated) {
    console.warn(
      "[probe] No BSKY_PROBE_IDENTIFIER / BSKY_PROBE_APP_PASSWORD — running\n" +
        "        unauthenticated. The PDS auth-gates before method resolution, so\n" +
        "        com.atproto and auth-gated app.bsky methods can't be evaluated and\n" +
        "        will be KEPT (app.bsky route-existence is still checked). Set the\n" +
        "        credentials (an app password; the probe only sends GETs) for the full check.\n",
    );
  }

  console.log(
    `[probe] Probing ${queries.length} queries (${PROBE_NAMESPACES.join(", ")}) against ` +
      `appview/relay + PDS ${PDS} (${authenticated ? "authenticated" : "unauthenticated"})…\n`,
  );

  const results = await mapLimit(queries, CONCURRENCY, (query) =>
    probeEndpoint(query, token),
  );

  const unimplemented: string[] = [];
  const inconclusive: string[] = [];
  for (const r of results.sort((a, b) => a.nsid.localeCompare(b.nsid))) {
    const mark =
      r.decision === "unlist" ? "UNLIST" : r.decision === "keep" ? "keep  " : "?     ";
    console.log(`  ${mark}  ${r.nsid.padEnd(48)} ${r.hosts.map(fmtHost).join("  ")}`);
    if (r.decision === "unlist") unimplemented.push(r.nsid);
    if (r.decision === "inconclusive") inconclusive.push(r.nsid);
  }
  unimplemented.sort();

  writeFileSync(
    MANIFEST,
    JSON.stringify(
      {
        $generated:
          "scripts/probe-implemented.ts (npm run probe) — specced queries the live network doesn't serve (com.atproto via 501 MethodNotImplemented, app.bsky via 404 XRPCNotSupported). Do not edit by hand.",
        probedAt: new Date().toISOString(),
        pds: PDS,
        authenticated,
        unimplemented,
      },
      null,
      2,
    ) + "\n",
  );

  console.log(
    `\n[probe] ${unimplemented.length} unimplemented, ${inconclusive.length} inconclusive, ` +
      `${results.length - unimplemented.length - inconclusive.length} implemented.`,
  );
  if (inconclusive.length && !authenticated) {
    console.log(
      `[probe] ${inconclusive.length} endpoints were inconclusive (auth-gated). ` +
        `Re-run with credentials to evaluate them.`,
    );
  }
  console.log(`[probe] Wrote ${MANIFEST}. Rebuild with \`npm run build:openapi\`.`);

  // ── Auth-consistency audit ──────────────────────────────────────────────────
  const noAuthQueries = queries.filter((q) => q.claimsNoAuth);
  if (!token) {
    console.log(
      `\n[audit] Skipping auth-consistency audit for ${noAuthQueries.length} ` +
        `no-auth-claiming queries — needs credentials to compare unauth vs authed.`,
    );
    return;
  }

  console.log(
    `\n[audit] Auth-consistency: probing ${noAuthQueries.length} no-auth-claiming ` +
      `queries unauth vs authed on their implementing host…\n`,
  );
  const audited = await mapLimit(noAuthQueries, CONCURRENCY, (q) =>
    auditAuth(q, token!),
  );
  const mismatches = audited
    .filter((m): m is AuthMismatch => m !== null)
    .sort((a, b) => a.nsid.localeCompare(b.nsid));

  for (const m of mismatches) {
    const tag = m.severity === "silent-404" ? "SILENT" : "GATED ";
    console.log(
      `  ${tag}  ${m.nsid.padEnd(44)} ${m.host}  unauth=${m.unauth}  authed=${m.authed}`,
    );
  }

  writeFileSync(
    AUTH_MANIFEST,
    JSON.stringify(
      {
        $generated:
          "scripts/probe-implemented.ts (npm run probe) — queries whose lexicon claims no-auth but whose live deployment requires it (kept/listed, not unlisted; fix upstream in the lexicon or the deployment). silent-404 = unauth returns 404 XRPCNotSupported (looks unimplemented); gated-401 = unauth returns 401/403. Do not edit by hand.",
        probedAt: new Date().toISOString(),
        pds: PDS,
        mismatches,
      },
      null,
      2,
    ) + "\n",
  );

  console.log(
    `\n[audit] ${mismatches.length} auth mismatch${mismatches.length === 1 ? "" : "es"} ` +
      `(${mismatches.filter((m) => m.severity === "silent-404").length} silent-404, ` +
      `${mismatches.filter((m) => m.severity === "gated-401").length} gated-401) ` +
      `across ${noAuthQueries.length} no-auth-claiming queries.`,
  );
  console.log(`[audit] Wrote ${AUTH_MANIFEST}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
