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

- `network/bsky/jetstream/*.json` — the Jetstream v2 archive/backfill XRPC
  methods (`getSegment`, `getBlock`, `getTombstones`, `listSegments`,
  `planBackfill`). Source of truth: the `bluesky-social/jetstream` repo.
  Note the live websocket stream (`/subscribe`, `/subscribe-v2`) has **no**
  lexicon — it is documented via hand-authored OpenAPI paths in
  `build-openapi.ts` (`JETSTREAM_WEBSOCKET_PATHS`).
