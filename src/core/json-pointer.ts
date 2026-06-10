export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
export const asObj = (v: unknown): Obj | undefined => (isObj(v) ? v : undefined);
export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Escape one reference token for embedding in a JSON Pointer: `~` → `~0` BEFORE
 * `/` → `~1`, so a `/` the first pass introduces isn't re-escaped (RFC 6901).
 */
export function escapePointer(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Inverse of escapePointer: `~1` → `/` BEFORE `~0` → `~` (RFC 6901). Order is
 * the reverse of escaping, so a `~` produced by `~1`→`/`... is irrelevant — only
 * `~0` becomes `~`, after `~1`s are gone.
 */
function unescapePointer(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * Resolve a JSON Pointer (with or without a leading `#`) against `doc`, returning
 * the referenced node or `undefined` if any segment is missing. The empty pointer
 * (`""` / `"#"`) returns the whole doc (RFC 6901). Walks objects and arrays.
 */
export function resolvePointer(doc: unknown, pointer: string): unknown {
  let p = pointer;
  if (p.startsWith("#")) p = p.slice(1);
  if (p === "") return doc;
  if (!p.startsWith("/")) return undefined; // not a valid absolute pointer

  let node: unknown = doc;
  for (const raw of p.slice(1).split("/")) {
    const token = unescapePointer(raw);
    if (Array.isArray(node)) {
      const i = Number(token);
      if (!Number.isInteger(i) || i < 0 || i >= node.length) return undefined;
      node = node[i];
    } else if (isObj(node)) {
      if (!(token in node)) return undefined;
      node = node[token];
    } else {
      return undefined;
    }
  }
  return node;
}

// `#`-only: external refs are bundled away at load time, so an internal ref is
// the only kind left to follow.
export const refTarget = (v: unknown): string | undefined =>
  isObj(v) && typeof v.$ref === "string" && v.$ref.startsWith("#") ? v.$ref : undefined;

/** Follow a structural `$ref` (param/requestBody/response) one hop — distinct
 *  from signature's schema-ref expansion; pass-through if `node` is not a `#`-ref. */
export function deref(doc: unknown, node: unknown): unknown {
  const ref = refTarget(node);
  return ref !== undefined ? resolvePointer(doc, ref) : node;
}

export function stripSuffix(s: string, suffix: string): string {
  return s.endsWith(suffix) ? s.slice(0, -suffix.length) : s;
}

export function parentPointer(ptr: string): string {
  const i = ptr.lastIndexOf("/");
  return i <= 0 ? "" : ptr.slice(0, i);
}
