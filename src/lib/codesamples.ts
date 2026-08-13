/**
 * Per-operation `x-codeSamples` for the OpenAPI spec.
 *
 * Generates a TypeScript snippet (using `@atproto/lex`'s `client.call`) and a Go
 * snippet (using the lexgen-generated wrappers in `indigo/api/*`) from each query
 * or procedure def. Both target the two reference SDKs the rest of the docs use,
 * so callers don't have to read httpsnippet's PHP/Ruby fallbacks.
 *
 * Function-name convention (indigo lexgen): the first two NSID segments form the
 * Go package (`bsky`, `atproto`, `chat`, `ozone`), and the remaining segments are
 * concatenated PascalCased. Query args are positional in alphabetical order;
 * procedures take a single `*<Fn>_Input` struct.
 */

type Sample = { lang: string; label: string; source: string };

interface Property {
  type?: string;
  format?: string;
  default?: unknown;
  description?: string;
  items?: { type?: string };
}

function pascal(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** `app.bsky.actor.getProfile` -> { pkg: 'appbsky', fn: 'ActorGetProfile', importPath } */
function goNames(id: string): { pkg: string; fn: string; importPath: string } | null {
  const parts = id.split(".");
  if (parts.length < 3) return null;
  const importMap: Record<string, { pkg: string; path: string }> = {
    "app.bsky": { pkg: "appbsky", path: "github.com/bluesky-social/indigo/api/bsky" },
    "com.atproto": { pkg: "comatproto", path: "github.com/bluesky-social/indigo/api/atproto" },
    "chat.bsky": { pkg: "chatbsky", path: "github.com/bluesky-social/indigo/api/chat" },
    "tools.ozone": { pkg: "toolsozone", path: "github.com/bluesky-social/indigo/api/ozone" },
  };
  const ns = `${parts[0]}.${parts[1]}`;
  const entry = importMap[ns];
  if (!entry) return null;
  const fn = parts.slice(2).map(pascal).join("");
  return { pkg: entry.pkg, fn, importPath: entry.path };
}

/** TS import line: `import * as app from './lexicons/app.js'` etc. */
function tsImport(id: string): { alias: string; line: string } {
  const root = id.split(".")[0];
  return { alias: root, line: `import * as ${root} from './lexicons/${root}.js'` };
}

/** Placeholder value for a Lexicon property, language-neutral-ish. */
function exampleString(name: string): string {
  switch (name) {
    case "actor":
    case "handle":
    case "repo":
      return "alice.bsky.social";
    case "did":
      return "did:plc:...";
    case "rkey":
      return "3jxf7z2k3q2";
    case "collection":
      return "app.bsky.feed.post";
    // Jetstream archive params (network.bsky.jetstream.*).
    case "segment":
      return "seg_000000002a.jss";
    case "blockIndex":
      return "0";
    case "cid":
      return "bafyrei...";
    case "uri":
      return "at://did:plc:.../app.bsky.feed.post/3jxf7z2k3q2";
    case "cursor":
      return "";
    case "lang":
      return "en";
    default:
      return "";
  }
}

function singleQuote(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function tsValue(name: string, prop: Property): string {
  switch (prop.type) {
    case "integer":
    case "number":
      if (typeof prop.default === "number") return String(prop.default);
      return name === "limit" ? "50" : "0";
    case "boolean":
      return prop.default === true ? "true" : "false";
    case "array":
      return "[]";
    case "string":
      return singleQuote(typeof prop.default === "string" ? prop.default : exampleString(name));
    default:
      // ref / object / unknown — leave a placeholder the user fills in.
      return "undefined";
  }
}

function goValue(name: string, prop: Property): string {
  switch (prop.type) {
    case "integer":
    case "number":
      if (typeof prop.default === "number") return String(prop.default);
      return name === "limit" ? "50" : "0";
    case "boolean":
      return prop.default === true ? "true" : "false";
    case "array":
      return "nil";
    case "string":
      return JSON.stringify(typeof prop.default === "string" ? prop.default : exampleString(name));
    default:
      return "nil";
  }
}

function tsObjectBody(props: Record<string, Property> | undefined, indent = "  "): string {
  if (!props || Object.keys(props).length === 0) return "";
  return Object.entries(props)
    .map(([name, p]) => `${indent}${name}: ${tsValue(name, p)},`)
    .join("\n");
}

function tsQuerySample(id: string, def: any): string {
  const { alias, line } = tsImport(id);
  const props: Record<string, Property> = def?.parameters?.properties ?? {};
  const body = tsObjectBody(props);
  const args = body ? `, {\n${body}\n}` : "";
  return `${line}\n\nconst result = await client.call(${alias}.${id.slice(alias.length + 1)}${args})`;
}

function tsProcedureSample(id: string, def: any): string {
  const { alias, line } = tsImport(id);
  const ref = `${alias}.${id.slice(alias.length + 1)}`;
  const encoding: string | undefined = def?.input?.encoding;
  if (encoding && encoding !== "application/json") {
    return `${line}\n\nconst result = await client.call(${ref}, {\n  // request body: ${encoding}\n})`;
  }
  const props: Record<string, Property> = def?.input?.schema?.properties ?? {};
  const body = tsObjectBody(props);
  const args = body ? `, {\n${body}\n}` : "";
  return `${line}\n\nconst result = await client.call(${ref}${args})`;
}

function goImports(pkg: string, path: string, extra: string[] = []): string {
  const lines = [`"context"`, ...extra, `${pkg} "${path}"`];
  return `import (\n${lines.map((l) => `\t${l}`).join("\n")}\n)`;
}

function goQuerySample(id: string, def: any): string {
  const names = goNames(id);
  if (!names) return "";
  const { pkg, fn, importPath } = names;
  const props: Record<string, Property> = def?.parameters?.properties ?? {};
  const ordered = Object.keys(props).sort();
  const argLines = ordered.map((name) => `\t${goValue(name, props[name])}, // ${name}`);
  const callArgs = argLines.length ? `,\n${argLines.join("\n")}\n` : "";
  return [
    goImports(pkg, importPath),
    "",
    "ctx := context.Background()",
    "",
    `out, err := ${pkg}.${fn}(ctx, client${callArgs})`,
  ].join("\n");
}

function shellValue(name: string, prop: Property): string {
  switch (prop.type) {
    case "integer":
    case "number":
      if (typeof prop.default === "number") return String(prop.default);
      return name === "limit" ? "50" : "0";
    case "boolean":
      return prop.default === true ? "true" : "false";
    case "string":
      return typeof prop.default === "string" ? prop.default : exampleString(name);
    default:
      return "";
  }
}

function proxyHeaderFor(id: string): string | null {
  if (id.startsWith("chat.bsky.")) return "did:web:api.bsky.chat#bsky_chat";
  if (id.startsWith("tools.ozone.")) return "did:plc:ar7c4by46qjdydhdevvrndac#atproto_labeler";
  return null;
}

/** Render a curl invocation with a trailing-backslash-joined header list. */
function curlWithHeaders(first: string, headers: string[]): string {
  if (headers.length === 0) return first;
  const lines = [`${first} \\`];
  headers.forEach((h, i) => {
    lines.push(`  -H '${h}'${i < headers.length - 1 ? " \\" : ""}`);
  });
  return lines.join("\n");
}

function curlQuerySample(id: string, def: any, host = "bsky.social", auth = true): string {
  const props: Record<string, Property> = def?.parameters?.properties ?? {};
  const entries = Object.entries(props);
  const qs = entries
    .map(([name, p]) => `${encodeURIComponent(name)}=${encodeURIComponent(shellValue(name, p))}`)
    .join("&");
  const url = `https://${host}/xrpc/${id}${qs ? `?${qs}` : ""}`;
  const headers: string[] = [];
  if (auth) headers.push("Authorization: Bearer <TOKEN>");
  const proxy = proxyHeaderFor(id);
  if (proxy) headers.push(`atproto-proxy: ${proxy}`);
  return curlWithHeaders(`curl '${url}'`, headers);
}

function curlProcedureSample(id: string, def: any, host = "bsky.social", auth = true): string {
  const url = `https://${host}/xrpc/${id}`;
  const proxy = proxyHeaderFor(id);
  const authHeaders: string[] = [];
  if (auth) authHeaders.push("Authorization: Bearer <TOKEN>");
  if (proxy) authHeaders.push(`atproto-proxy: ${proxy}`);
  const encoding: string | undefined = def?.input?.encoding;
  if (!encoding) {
    return curlWithHeaders(`curl -X POST '${url}'`, authHeaders);
  }
  if (encoding !== "application/json") {
    const lines = [`curl -X POST '${url}' \\`];
    authHeaders.forEach((h) => lines.push(`  -H '${h}' \\`));
    lines.push(`  -H 'Content-Type: ${encoding}' \\`, `  --data-binary @<file>`);
    return lines.join("\n");
  }
  const props: Record<string, Property> = def?.input?.schema?.properties ?? {};
  const body: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(props)) {
    switch (p.type) {
      case "string":
        body[name] = typeof p.default === "string" ? p.default : exampleString(name);
        break;
      case "integer":
      case "number":
        body[name] = typeof p.default === "number" ? p.default : (name === "limit" ? 50 : 0);
        break;
      case "boolean":
        body[name] = p.default === true;
        break;
      case "array":
        body[name] = [];
        break;
      default:
        body[name] = null;
    }
  }
  const json = Object.keys(body).length
    ? JSON.stringify(body, null, 2).replace(/'/g, "'\\''")
    : "{}";
  const lines = [`curl -X POST '${url}' \\`];
  authHeaders.forEach((h) => lines.push(`  -H '${h}' \\`));
  lines.push(`  -H 'Content-Type: application/json' \\`, `  -d '${json}'`);
  return lines.join("\n");
}

function goProcedureSample(id: string, def: any): string {
  const names = goNames(id);
  if (!names) return "";
  const { pkg, fn, importPath } = names;
  const encoding: string | undefined = def?.input?.encoding;
  if (encoding && encoding !== "application/json") {
    // Non-JSON procedures (e.g. uploadBlob) use a different indigo entry point;
    // point at the typed wrapper without inventing a body.
    return [
      goImports(pkg, importPath),
      "",
      "ctx := context.Background()",
      "",
      `// request body: ${encoding}`,
      `out, err := ${pkg}.${fn}(ctx, client, /* body */)`,
    ].join("\n");
  }
  const props: Record<string, Property> = def?.input?.schema?.properties ?? {};
  const fields = Object.entries(props)
    .map(([name, p]) => `\t${pascal(name)}: ${goValue(name, p)},`)
    .join("\n");
  const inputBody = fields ? `&${pkg}.${fn}_Input{\n${fields}\n}` : `&${pkg}.${fn}_Input{}`;
  return [
    goImports(pkg, importPath),
    "",
    "ctx := context.Background()",
    "",
    `input := ${inputBody}`,
    "",
    `out, err := ${pkg}.${fn}(ctx, client, input)`,
  ].join("\n");
}

/**
 * Options for code-sample generation.
 *
 * - `curlHost` overrides the host the curl sample targets. Defaults to
 *   `bsky.social` (the PDS), which is right for the SDK-backed namespaces.
 *   Jetstream's archive XRPC lives on its own host, so the build passes
 *   `jetstream.us-west.bsky.network`.
 * - `only` restricts the emitted languages. Used for namespaces that have no
 *   indigo/`@atproto/lex` codegen wrapper yet (e.g. `network.bsky.jetstream.*`),
 *   where the TypeScript/Go snippets would reference modules that don't exist —
 *   so the build asks for `["shell"]` only.
 */
export interface CodeSampleOptions {
  curlHost?: string;
  only?: Array<Sample["lang"]>;
  /** Include an `Authorization: Bearer` header in the curl sample. Defaults to
   *  true (SDK-backed PDS endpoints); set false for unauthenticated surfaces
   *  like the public Jetstream archive XRPC. */
  auth?: boolean;
}

export function codeSamplesFor(id: string, def: any, opts: CodeSampleOptions = {}): Sample[] {
  const isQuery = def?.type === "query";
  const auth = opts.auth ?? true;
  const ts = isQuery ? tsQuerySample(id, def) : tsProcedureSample(id, def);
  const go = isQuery ? goQuerySample(id, def) : goProcedureSample(id, def);
  const curl = isQuery
    ? curlQuerySample(id, def, opts.curlHost, auth)
    : curlProcedureSample(id, def, opts.curlHost, auth);
  const samples: Sample[] = [
    { lang: "typescript", label: "TypeScript (@atproto/lex)", source: ts },
  ];
  if (go) samples.push({ lang: "go", label: "Go (indigo)", source: go });
  samples.push({ lang: "shell", label: "Shell (curl)", source: curl });
  if (opts.only) return samples.filter((s) => opts.only!.includes(s.lang));
  return samples;
}
