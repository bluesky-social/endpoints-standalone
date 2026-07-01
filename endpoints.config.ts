/**
 * Source-of-truth configuration for the standalone endpoints reference.
 *
 * The reference covers exactly the namespaces in `INCLUDE_PREFIXES`. The set of
 * endpoints is derived automatically: `scripts/seed-allowlist.ts` enumerates every
 * query/procedure NSID published in those namespaces (skipping unspecced/temp/
 * deprecated and anything in `EXCLUDE`), writes them to `lexicons.json`, and
 * `@atproto/lex` fetches them plus any transitively-referenced schema defs. The
 * defs are needed for `$ref`s but are never listed as endpoints.
 *
 * - `INCLUDE_PREFIXES` — the curated namespaces. This is the one place to widen or
 *   narrow scope. Editing it changes what `seed-allowlist` pulls in and what the
 *   converter is willing to emit a path for.
 * - `NAMESPACE_ORDER` biases grouping/order in the rendered reference.
 */

/** Namespaces this reference covers (and the only ones converted to endpoints). */
export const INCLUDE_PREFIXES: string[] = [
  "app.bsky.",
  "com.atproto.",
  "chat.bsky.",
  "tools.ozone.",
  // Jetstream v2 archive/backfill XRPC. NOT enumerated by `npm run seed` — these
  // lexicons aren't published on-network yet, so they're hand-vendored under
  // `vendored-lexicons/` (see that dir's README for the "fetch on-network" TODO).
  // The live websocket stream has no lexicon; see JETSTREAM_WEBSOCKET_PATHS in
  // build-openapi.ts.
  "network.bsky.jetstream.",
];

/**
 * Canonical accounts that publish the `com.atproto.lexicon.schema` records for the
 * namespaces above. Used by `seed-allowlist` to ENUMERATE every endpoint: DNS
 * resolves an individual NSID's authority, but only listing a repo enumerates a
 * whole namespace. These are stable; each can be re-derived from the `_lexicon.*`
 * TXT records (e.g. did:plc:4v4y5r3... is `bsky-lexicons.bsky.social`).
 */
export const SCHEMA_AUTHORITIES: string[] = [
  "did:plc:4v4y5r3lwsbtmsxhile2ljac", // app.bsky.*, chat.bsky.*
  "did:plc:6msi3pj7krzih5qxqtryxlzw", // com.atproto.*
  "did:plc:33dt5kftu3jq2h5h4jjlqezt", // tools.ozone.*
];

/** Exact NSIDs to drop even though they are query/procedure endpoints. */
export const EXCLUDE: string[] = [];

/**
 * Live-implementation boundary (`scripts/probe-implemented.ts` → `npm run probe`).
 *
 * The schema authorities publish every *specced* endpoint, but Bluesky's live
 * services don't necessarily serve all of them yet — e.g. the newer
 * `com.atproto.identity` GET methods (`resolveDid`, `resolveIdentity`) return
 * `501 MethodNotImplemented`, and `app.bsky.graph.searchStarterPacks` is registered
 * nowhere (`404 XRPCNotSupported`). The probe calls each enumerated **query** in
 * `PROBE_NAMESPACES` against the canonical Bluesky hosts and records the ones that
 * aren't served anywhere into `UNIMPLEMENTED_MANIFEST`; `build-openapi` then unlists
 * those (no path, no sidebar tag), exactly like deprecated/unspecced endpoints. Only
 * queries are probed — we never fire procedures (writes) at the live network.
 *
 * Routing is the whole trick. Each method has a *home* service, and a host returns a
 * "not my method" answer for anything that isn't its own, so a single host can't tell
 * "unimplemented" from "lives elsewhere". We probe a panel, and which host is
 * AUTHORITATIVE (allowed to assert "unimplemented") — and what its authoritative
 * negative *looks like* — depends on the namespace:
 *
 *   - `com.atproto.*`: the authenticated `pds` (entryway) is authoritative and answers
 *     `501 MethodNotImplemented` for methods it doesn't serve. `appview`/`relay` are
 *     POSITIVE-only (a non-error there means "served here, keep it" — this is what
 *     rescues `identity.resolveHandle`, `repo.getRecord`, `sync.*`). The entryway
 *     auth-gates *before* method resolution, so unauthenticated every method returns
 *     `401` and can't be evaluated — credentials are required for the real answer.
 *   - `app.bsky.*`: the `appview` is home and authoritative, but ONLY on
 *     `404 XRPCNotSupported` (its proxy chain returns that when a method is registered
 *     nowhere upstream). A `501 MethodNotImplemented` from the appview is NOT
 *     definitive — some app.bsky methods (e.g. `actor.getPreferences`) are served by
 *     the PDS/entryway and proxied — so the authenticated `pds` stays as a POSITIVE-only
 *     rescue for those. Route-existence is auth-independent, so app.bsky detection
 *     works even unauthenticated; auth only adds the proxy rescue.
 *
 * Set `BSKY_PROBE_IDENTIFIER` + `BSKY_PROBE_APP_PASSWORD` (any account's app password
 * works — the probe only sends GETs, so it never writes despite the password's full
 * scope). Override the PDS host with `BSKY_PROBE_PDS` if self-hosted.
 *
 * The decision per endpoint: keep if any host says implemented; unlist only if the
 * authoritative host emits its "unimplemented" signal; otherwise keep (inconclusive).
 */
export const PROBE_NAMESPACES: string[] = ["com.atproto.", "app.bsky."];
export const PROBE_HOSTS = {
  appview: "https://public.api.bsky.app", // public read gateway (unimplemented probe)
  appviewService: "https://api.bsky.app", // the appview service itself (auth audit)
  relay: "https://relay1.us-west.bsky.network",
  pds: "https://bsky.social",
};
export const UNIMPLEMENTED_MANIFEST = "unimplemented.json";

/**
 * Auth-consistency audit (`scripts/probe-implemented.ts` → the "auth mismatch" section
 * and `AUTH_MISMATCH_MANIFEST`).
 *
 * Lexicons have no formal "auth required" field — it's stated in prose, e.g.
 * `app.bsky.graph.searchStarterPacks` says "Does not require auth." Some of those
 * claims are wrong against the live deployment: `searchStarterPacks` returns
 * `404 XRPCNotSupported` unauthenticated (looks *unimplemented*) but `200` authed, and
 * the bulk `com.atproto.sync.*` repo-download reads (`getRepo`, `getBlocks`, …) return
 * `401 AuthMissing` unauthenticated on `bsky.social` despite claiming to be public.
 *
 * The audit probes each no-auth-claiming QUERY twice — unauthenticated and
 * authenticated, with the same synthesized params — against the host that actually
 * *implements* it (so auth is the only variable, isolating a real per-method gate from
 * the entryway's blanket unauth `401`). A mismatch is reported (never unlisted — the
 * endpoint IS implemented) when the authed call reaches a handler but the unauth call
 * is blocked (`401`/`403`, or the silent `404 XRPCNotSupported`).
 *
 * The audit host per namespace: `app.bsky.*` → the appview service (`api.bsky.app`),
 * which serves public methods unauthenticated but gates the auth-required ones;
 * `com.atproto.*` → the PDS (`BSKY_PROBE_PDS`/`bsky.social`), which serves its public
 * reads unauthenticated but gates the ones it has locked down. Requires credentials.
 */
export const AUTH_AUDIT_HOSTS: Record<string, string> = {
  "app.bsky.": PROBE_HOSTS.appviewService,
  "com.atproto.": PROBE_HOSTS.pds,
};
export const AUTH_MISMATCH_MANIFEST = "auth-mismatch.json";

/**
 * Group/sort bias: namespaces matching earlier prefixes render first. Anything not
 * matched falls to the end in lexical order. Used to build OpenAPI `x-tagGroups`
 * and to sort the `tags` array.
 */
export const NAMESPACE_ORDER: string[] = [
  "app.bsky.",
  "com.atproto.",
  "chat.bsky.",
  "tools.ozone.",
  "network.bsky.",
];

/**
 * The reference is split into several documents, surfaced as a switcher dropdown
 * in the rendered site (Scalar's multi-source `sources`). Each view owns a subset
 * of the covered namespaces; an endpoint lands in the first view whose `prefixes`
 * match its NSID. Every view shares the same Introduction (`info.description`).
 *
 * `slug` is the document's URL key — it appears in the hash (e.g.
 * `#bluesky-dms/description/introduction`) and is what the Introduction's
 * cross-links point at, so keep these in sync with `SHARED_DESCRIPTION`.
 */
export interface View {
  slug: string;
  title: string;
  prefixes: string[];
}

export const VIEWS: View[] = [
  { slug: "bluesky-app", title: "Bluesky App", prefixes: ["app.bsky.", "com.atproto."] },
  { slug: "bluesky-dms", title: "Bluesky DMs", prefixes: ["chat.bsky."] },
  { slug: "ozone-moderation", title: "Ozone Moderation", prefixes: ["tools.ozone."] },
  // Jetstream v2: the archive/backfill XRPC methods (network.bsky.jetstream.*,
  // vendored) plus the hand-authored websocket cards injected in build-openapi.ts.
  { slug: "jetstream", title: "Jetstream API", prefixes: ["network.bsky.jetstream."] },
];

