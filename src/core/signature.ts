import type { NormalizedDoc, Operation } from "../store/store.js";
import {
  escapePointer,
  resolvePointer,
  isObj,
  asObj,
  refTarget,
  deref,
  stripSuffix,
  type Obj,
} from "./json-pointer.js";
import { mergeParameters } from "./params.js";

export interface SignatureOptions {
  /** Default true. False → schemas keep their $refs intact (no inlining). */
  expandRefs?: boolean;
  /** Max $ref-follow depth per branch before collapsing. Default 6. */
  maxDepth?: number;
  /** Soft serialized-size guard in chars. Injectable for tests. Default ~16KB. */
  maxBytes?: number;
}

export interface SignatureParam {
  name: string;
  in: string;
  required: boolean;
  schema: unknown;
  description?: string;
}

export interface BuiltSignature {
  method: string;
  path: string;
  operation_id: string | null;
  summary: string | null;
  deprecated: boolean;
  parameters: SignatureParam[];
  requestBody?: { required: boolean; content: Record<string, { schema: unknown }> };
  responses: Record<string, { description?: string; content?: Record<string, { schema: unknown }> }>;
  security?: string[];
  truncated_paths: string[];
}

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_BYTES = 16384;

interface Ctx {
  doc: unknown;
  maxDepth: number;
  maxBytes: number;
  expandRefs: boolean;
  bytes: number;
  truncated: string[];
}

export function buildSignature(
  doc: NormalizedDoc,
  operation: Operation,
  opts: SignatureOptions = {},
): BuiltSignature {
  const ctx: Ctx = {
    doc,
    maxDepth: opts.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
    expandRefs: opts.expandRefs ?? true,
    bytes: 0,
    truncated: [],
  };
  const binding = operation.openapi!; // present for spec_format === "openapi" (v1)
  const { requestBody: rbPtr, responses: respPtr } = binding.pointers;
  const opBase = stripSuffix(binding.pointers.params, "/parameters"); // /paths/<path>/<method>
  const opObj = asObj(resolvePointer(doc, opBase));

  const sig: BuiltSignature = {
    method: binding.method,
    path: binding.path,
    operation_id: operation.operation_id,
    summary: operation.summary ?? null,
    deprecated: operation.deprecated,
    parameters: buildParameters(ctx, operation),
    responses: buildResponses(ctx, respPtr),
    truncated_paths: ctx.truncated,
  };
  const requestBody = buildRequestBody(ctx, rbPtr);
  if (requestBody) sig.requestBody = requestBody;
  const security = buildSecurity(opObj, asObj(doc));
  if (security) sig.security = security;
  return sig;
}

function buildParameters(ctx: Ctx, operation: Operation): SignatureParam[] {
  // Map-iteration index i drives /parameters/${i}/schema — independent of MergedParam.base.
  return [...mergeParameters(ctx.doc, operation).values()].map((m, i) => {
    const param: SignatureParam = {
      name: m.name,
      in: m.in,
      required: m.required,
      schema: expand(ctx, m.param.schema, new Set(), 0, `/parameters/${i}/schema`),
    };
    if (typeof m.param.description === "string") param.description = m.param.description;
    return param;
  });
}

function buildRequestBody(ctx: Ctx, ptr: string): BuiltSignature["requestBody"] | undefined {
  const rb = asObj(deref(ctx.doc, resolvePointer(ctx.doc, ptr)));
  if (!rb) return undefined;
  const content: Record<string, { schema: unknown }> = {};
  for (const [ct, media] of Object.entries(asObj(rb.content) ?? {})) {
    content[ct] = {
      schema: expand(ctx, asObj(media)?.schema, new Set(), 0, `/requestBody/content/${escapePointer(ct)}/schema`),
    };
  }
  return { required: rb.required === true, content };
}

function buildResponses(ctx: Ctx, ptr: string): BuiltSignature["responses"] {
  const responses: BuiltSignature["responses"] = {};
  for (const [status, raw] of Object.entries(asObj(resolvePointer(ctx.doc, ptr)) ?? {})) {
    const r = asObj(deref(ctx.doc, raw));
    if (!r) continue;
    const entry: BuiltSignature["responses"][string] = {};
    if (typeof r.description === "string") entry.description = r.description;
    const rc = asObj(r.content);
    if (rc) {
      const content: Record<string, { schema: unknown }> = {};
      for (const [ct, media] of Object.entries(rc)) {
        content[ct] = {
          schema: expand(ctx, asObj(media)?.schema, new Set(), 0, `/responses/${status}/content/${escapePointer(ct)}/schema`),
        };
      }
      entry.content = content;
    }
    responses[status] = entry;
  }
  return responses;
}

// op-level security overrides root; `??` (not `||`) so an explicit `[]` opt-out
// is honored, only an absent key falls back. Names only, deduped.
function buildSecurity(opObj: Obj | undefined, root: Obj | undefined): string[] | undefined {
  const sec = opObj?.security ?? root?.security;
  if (!Array.isArray(sec)) return undefined;
  const names = new Set<string>();
  for (const req of sec) if (isObj(req)) for (const k of Object.keys(req)) names.add(k);
  return [...names];
}

// The one expansion routine, applied at every schema position. Cycle (ancestor on
// THIS branch) → {$circular}; depth/size cap → collapse {$ref} + truncated_paths.
// activePath is an immutable per-branch set, so sibling re-refs (DAGs) expand.
function expand(ctx: Ctx, node: unknown, activePath: Set<string>, depth: number, outPath: string): unknown {
  if (!ctx.expandRefs) return node; // false → leave $refs intact, no truncation

  const ref = refTarget(node);
  if (ref !== undefined) {
    const ptr = ref.slice(1); // strip leading '#'
    if (activePath.has(ptr)) return { $circular: ref };
    if (depth >= ctx.maxDepth || ctx.bytes >= ctx.maxBytes) {
      ctx.truncated.push(outPath);
      return { $ref: ref };
    }
    const target = resolvePointer(ctx.doc, ptr);
    if (target === undefined) return { $ref: ref }; // unresolvable — leave as-is
    return expand(ctx, target, new Set([...activePath, ptr]), depth + 1, outPath);
  }

  if (Array.isArray(node)) {
    return node.map((el, i) => expand(ctx, el, activePath, depth, `${outPath}/${i}`));
  }
  if (isObj(node)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(node)) {
      ctx.bytes += k.length;
      out[k] = expand(ctx, v, activePath, depth, `${outPath}/${escapePointer(k)}`);
    }
    return out;
  }
  ctx.bytes += String(node).length;
  return node;
}
