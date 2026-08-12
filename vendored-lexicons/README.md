# Vendored lexicons

Lexicon documents that are **not yet resolvable on-network**, hand-copied into
this repo so the reference can render them. Everything here is converted to
OpenAPI by `src/build-openapi.ts` exactly like the seed-managed `lexicons/`
tree (the build globs both directories), but unlike that tree these files are
**not** managed by `npm run seed` / `@atproto/lex` — `seed-allowlist.ts` does an
`rmSync` on `lexicons/` every run, which is precisely why these live in a
separate directory.

## ⚠️ BIG TODO: fetch these on-network ASAP

These are a temporary stopgap. The moment the `network.bsky.jetstream.*`
lexicons are published as on-network `com.atproto.lexicon.schema` records
(i.e. Jetstream v2 ships and its schema authority DID is resolvable via the
`_lexicon.*` DNS TXT mechanism), we should:

1. Add the publishing DID to `SCHEMA_AUTHORITIES` in `endpoints.config.ts`.
2. Drop the `network.bsky.jetstream.` files from here and let `npm run seed`
   enumerate + `@atproto/lex` fetch + CID-pin them like every other namespace.
3. Delete this directory if nothing else remains vendored.

Until then these are maintained **by hand**: if the lexicons change in
`../jetstream/lexicons/`, re-copy them here.

## Current contents

- `network/bsky/jetstream/*.json` — the Jetstream replay-archive XRPC methods
  (`planSnapshot`, `listSegments`, `getSegment`, `getBlock`). Source of truth:
  `../jetstream/lexicons/network/bsky/jetstream/`. Last re-synced 2026-08-12.
  The live websocket stream is documented separately, via hand-authored OpenAPI
  paths in `build-openapi.ts` (`JETSTREAM_WEBSOCKET_PATHS`) covering `/subscribe`.

## Upstream lexicons deliberately NOT vendored

`../jetstream/lexicons/` holds four more schemas that we intentionally don't
list. If you re-sync this directory, don't "helpfully" copy them in:

- `subscribeEvents` — **a `subscription` def, which the converter skips**
  (`build-openapi.ts`: event streams have no OpenAPI representation). Vendoring
  it would add its message-payload objects as components and still produce no
  card, so the live stream stays hand-authored instead.
- `importTimestamps` / `getImportStatus` — **operator-only.** Registered only
  when the server is started with an import manager, and bearer-gated (401 by
  default), so they aren't public API surface. Verified against
  `jetstream.us-west.bsky.network`: `getImportStatus` returns `401 AuthRequired`.
- `getZstdDictionary` — serves the shared dict-zstd dictionary that the
  `zstdDictionary=<id>` stream option opts into. That option belongs to the
  `subscribeEvents` wire, which has no card, so listing this method would leave
  it with no documented consumer. The documented `/subscribe` stream's
  `compress=true` uses a *different*, embedded dictionary that this method does
  not serve.

## Removed upstream

- `getTombstones` — **deleted upstream.** Deletion markers now ride inline in
  the blocks named by `planSnapshot`; there is no separate tombstone fetch.
  The live host returns `501 MethodNotImplemented`.
