import type { NormalizedDoc, Operation, TypeDef } from "../store/store.js";
import { canonicalize } from "./hashing.js";
import {
  resolvePointer,
  isObj,
  asObj,
  asArray,
  refTarget,
  deref,
  stripSuffix,
  parentPointer,
  type Obj,
} from "./json-pointer.js";

export interface OperationRef {
  operation_key: string;
  method: string;
  path: string;
  operation_id: string | null;
}

export type ChangeKind =
  | "param_added" | "param_removed"
  | "request_field_added" | "request_field_removed"
  | "required_added" | "required_removed"
  | "type_changed"
  | "response_added" | "response_removed";

// Conservative three-value classification. `unknown` is the forward-compat
// default for unrecognized kinds.
export type Classification = "breaking" | "non_breaking" | "unknown";

// One itemized change inside a changed operation. `kind` is the discriminant; it
// decides which of the fields below carry a value.
export interface OperationChange {
  kind: ChangeKind;
  /** JSON Pointer to where the change is. It points into the request body for a
   *  field change (e.g. `/metadata`), to a parameter by name (`/<name>`), or to a
   *  response status code (`/<status>`). */
  pointer: string;
  /** Whether the affected field/parameter is required. Set only for the field- and
   *  param-add/remove kinds; always true for a path parameter. */
  required?: boolean;
  /** The `type` keyword before and after the change — set only for `type_changed`. */
  from?: unknown;
  to?: unknown;
  /** breaking / non_breaking verdict, added by `classifyDiff`; absent on the raw
   *  `diffOperations` output, present once classified. */
  classification?: Classification;
}

export interface ChangedOperation extends OperationRef {
  changes: OperationChange[];
}

export interface OperationsDiff {
  added: OperationRef[];
  removed: OperationRef[];
  changed: ChangedOperation[];
}

/** Classification summary. Types dimension not counted (deferred with per-type
 *  field itemization). `unknown` is non-zero only for unrecognized future kinds. */
export interface DiffSummary {
  breaking: number;
  non_breaking: number;
  unknown: number;
}

export interface ClassifiedDiff {
  added: OperationRef[];
  removed: OperationRef[];
  changed: ChangedOperation[];
  summary: DiffSummary;
}

export interface DiffOptions {
  /** When true, skip stripNonStructural — doc-only changes are treated as
   *  structural and trigger "changed". Default: false. */
  includeDescriptions?: boolean;
}

/** Added/removed/changed TypeDef names (flag-only). */
export interface TypesDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface VersionSide {
  operations: Operation[];
  typeDefs: TypeDef[];
  doc: NormalizedDoc;
}

// STRUCTURAL compare strips these non-structural operation-object fields before
// canonicalize so doc-only edits (description typo, tag re-org, vendor-ext bump)
// are not flagged as "changed". Scoped to the operation + parameter OBJECT level —
// NOT recursed into schema bodies — so a user-defined schema property named
// `description`/`summary`/`tags` is never deleted.
const OP_NON_STRUCTURAL = new Set(["summary", "description", "externalDocs", "tags"]);
const isExtension = (k: string): boolean => k.startsWith("x-");

function stripNonStructural(op: unknown): unknown {
  if (!isObj(op)) return op;
  const out: Obj = {};
  for (const [k, v] of Object.entries(op)) {
    if (OP_NON_STRUCTURAL.has(k) || isExtension(k)) continue;
    out[k] = k === "parameters" && Array.isArray(v) ? v.map(stripParam) : v;
  }
  return out;
}
function stripParam(p: unknown): unknown {
  if (!isObj(p)) return p;
  const out: Obj = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === "description" || isExtension(k)) continue;
    out[k] = v;
  }
  return out;
}

const opRef = (o: Operation): OperationRef => ({
  operation_key: o.operation_key,
  method: o.openapi!.method,
  path: o.openapi!.path,
  operation_id: o.operation_id,
});

// The operation object's location in the snapshot: `/paths/<path>/<method>`.
const opSubtree = (side: VersionSide, o: Operation): unknown =>
  resolvePointer(side.doc, stripSuffix(o.openapi!.pointers.params, "/parameters"));

/** Sort changes deterministically by (pointer, kind) for stable assertions. */
function sortChanges(changes: OperationChange[]): OperationChange[] {
  return [...changes].sort((a, b) =>
    a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
  );
}

/** Merge path-item + op-level params keyed by `{in} {name}` (op-level wins),
 *  matching the OpenAPI Path Item Object rule. */
function mergeParams(doc: NormalizedDoc, op: Operation): Map<string, { name: string; in: string; required: boolean }> {
  const binding = op.openapi!;
  const opBase = stripSuffix(binding.pointers.params, "/parameters");
  const raw = [
    ...asArray(resolvePointer(doc, `${parentPointer(opBase)}/parameters`)),
    ...asArray(resolvePointer(doc, binding.pointers.params)),
  ];
  const byKey = new Map<string, { name: string; in: string; required: boolean }>();
  for (const entry of raw) {
    const p = asObj(deref(doc, entry));
    if (!p || typeof p.name !== "string" || typeof p.in !== "string") continue;
    // Path params are always required per OpenAPI spec.
    const required = p.required === true || p.in === "path";
    byKey.set(`${p.in as string} ${p.name as string}`, { name: p.name as string, in: p.in as string, required });
  }
  return byKey;
}

/** Return the INLINE request-body schema (not a $ref) for the primary content type,
 *  or null if absent/$ref'd ($ref'd bodies surface in diffTypes instead). */
function getInlineBodySchema(doc: NormalizedDoc, op: Operation): unknown | null {
  const rbRaw = resolvePointer(doc, op.openapi!.pointers.requestBody);
  const rb = asObj(deref(doc, rbRaw));
  if (!rb) return null;
  const content = asObj(rb.content);
  if (!content) return null;
  const ct = "application/json" in content ? "application/json" : (Object.keys(content)[0] ?? "");
  if (!ct) return null;
  const media = asObj(content[ct]);
  if (!media) return null;
  const schema = media.schema;
  if (refTarget(schema) !== undefined) return null;
  return schema ?? null;
}

function getResponseStatuses(doc: NormalizedDoc, op: Operation): Set<string> {
  const responses = resolvePointer(doc, op.openapi!.pointers.responses);
  return new Set(isObj(responses) ? Object.keys(responses) : []);
}

/** Diff two inline object schemas at ONE level: added/removed properties,
 *  required-membership changes, and type-keyword changes on shared properties. */
function diffSchema(from: unknown, to: unknown): OperationChange[] {
  const fromObj = asObj(from) ?? {};
  const toObj = asObj(to) ?? {};
  const fromProps = asObj(fromObj.properties) ?? {};
  const toProps = asObj(toObj.properties) ?? {};
  const fromReq = new Set<string>(Array.isArray(fromObj.required) ? (fromObj.required as string[]) : []);
  const toReq = new Set<string>(Array.isArray(toObj.required) ? (toObj.required as string[]) : []);

  const changes: OperationChange[] = [];

  for (const name of Object.keys(toProps)) {
    if (!(name in fromProps)) {
      changes.push({ kind: "request_field_added", pointer: `/${name}`, required: toReq.has(name) });
    }
  }
  for (const name of Object.keys(fromProps)) {
    if (!(name in toProps)) {
      changes.push({ kind: "request_field_removed", pointer: `/${name}`, required: fromReq.has(name) });
    }
  }
  for (const name of Object.keys(fromProps)) {
    if (!(name in toProps)) continue;
    const ptr = `/${name}`;
    if (!fromReq.has(name) && toReq.has(name)) changes.push({ kind: "required_added", pointer: ptr });
    if (fromReq.has(name) && !toReq.has(name)) changes.push({ kind: "required_removed", pointer: ptr });
    const fromType = asObj(fromProps[name])?.type;
    const toType = asObj(toProps[name])?.type;
    if (fromType !== undefined && toType !== undefined && fromType !== toType) {
      changes.push({ kind: "type_changed", pointer: ptr, from: fromType, to: toType });
    }
  }

  return changes;
}

function itemizeChangedOp(fromSide: VersionSide, toSide: VersionSide, fromOp: Operation, toOp: Operation): OperationChange[] {
  const changes: OperationChange[] = [];

  const fromParams = mergeParams(fromSide.doc, fromOp);
  const toParams = mergeParams(toSide.doc, toOp);
  for (const [key, p] of toParams) {
    if (!fromParams.has(key)) changes.push({ kind: "param_added", pointer: `/${p.name}`, required: p.required });
  }
  for (const [key, p] of fromParams) {
    if (!toParams.has(key)) changes.push({ kind: "param_removed", pointer: `/${p.name}`, required: p.required });
  }

  const fromBodySchema = getInlineBodySchema(fromSide.doc, fromOp);
  const toBodySchema = getInlineBodySchema(toSide.doc, toOp);
  if (fromBodySchema !== null && toBodySchema !== null) {
    changes.push(...diffSchema(fromBodySchema, toBodySchema));
  }

  const fromStatuses = getResponseStatuses(fromSide.doc, fromOp);
  const toStatuses = getResponseStatuses(toSide.doc, toOp);
  for (const status of toStatuses) {
    if (!fromStatuses.has(status)) changes.push({ kind: "response_added", pointer: `/${status}` });
  }
  for (const status of fromStatuses) {
    if (!toStatuses.has(status)) changes.push({ kind: "response_removed", pointer: `/${status}` });
  }

  return sortChanges(changes);
}

export function diffOperations(from: VersionSide, to: VersionSide, opts?: DiffOptions): OperationsDiff {
  const fromByKey = new Map(from.operations.map((o) => [o.operation_key, o]));
  const toByKey = new Map(to.operations.map((o) => [o.operation_key, o]));

  const added: OperationRef[] = [];
  for (const [key, o] of toByKey) if (!fromByKey.has(key)) added.push(opRef(o));

  const removed: OperationRef[] = [];
  for (const [key, o] of fromByKey) if (!toByKey.has(key)) removed.push(opRef(o));

  const strip = opts?.includeDescriptions ? (x: unknown): unknown => x : stripNonStructural;
  const changed: ChangedOperation[] = [];
  for (const [key, fromOp] of fromByKey) {
    const toOp = toByKey.get(key);
    if (toOp === undefined) continue;
    if (canonicalize(strip(opSubtree(from, fromOp))) !== canonicalize(strip(opSubtree(to, toOp)))) {
      changed.push({ ...opRef(toOp), changes: itemizeChangedOp(from, to, fromOp, toOp) });
    }
  }

  return { added, removed, changed };
}

/** Types dimension: added/removed/changed TypeDef names (flag-only).
 *  Changed = the component subtree (resolved via TypeDef.pointer) differs by
 *  canonical structural compare. */
export function diffTypes(from: VersionSide, to: VersionSide, opts?: DiffOptions): TypesDiff {
  const fromByName = new Map(from.typeDefs.map((t) => [t.name, t]));
  const toByName = new Map(to.typeDefs.map((t) => [t.name, t]));

  const added: string[] = [];
  for (const [name] of toByName) if (!fromByName.has(name)) added.push(name);

  const removed: string[] = [];
  for (const [name] of fromByName) if (!toByName.has(name)) removed.push(name);

  const strip = opts?.includeDescriptions ? (x: unknown): unknown => x : stripNonStructural;
  const changed: string[] = [];
  for (const [name, fromTD] of fromByName) {
    const toTD = toByName.get(name);
    if (toTD === undefined) continue;
    const fromSubtree = resolvePointer(from.doc, fromTD.pointer);
    const toSubtree = resolvePointer(to.doc, toTD.pointer);
    if (canonicalize(strip(fromSubtree)) !== canonicalize(strip(toSubtree))) {
      changed.push(name);
    }
  }

  return { added, removed, changed };
}

function classifyChange(c: OperationChange): Classification {
  switch (c.kind) {
    case "param_added":
      return c.required ? "breaking" : "non_breaking";
    case "param_removed":
      // A removed param can't break an existing caller (they were sending it; server ignores).
      return "non_breaking";
    case "request_field_added":
      return c.required ? "breaking" : "non_breaking";
    case "request_field_removed":
      // additionalProperties:false edge: optional-removal can still break — a documented carry.
      return c.required ? "breaking" : "non_breaking";
    case "required_added":
      return "breaking";
    case "required_removed":
      return "non_breaking";
    case "type_changed":
      // Conservative: any type change may narrow the accepted values.
      return "breaking";
    case "response_added":
      return "non_breaking";
    case "response_removed":
      // Conservative: documented response removed may indicate behavior change.
      return "breaking";
    default:
      return "unknown";
  }
}

/** Stamp `classification` on every OperationChange and compute summary counts.
 *  Removed ops → breaking; added ops → non_breaking; per-change entries by their
 *  classification. Changed ops with changes:[] contribute 0. */
export function classifyDiff(diff: OperationsDiff): ClassifiedDiff {
  const summary: DiffSummary = { breaking: 0, non_breaking: 0, unknown: 0 };

  summary.breaking += diff.removed.length;
  summary.non_breaking += diff.added.length;

  const changed: ChangedOperation[] = diff.changed.map((op) => ({
    ...op,
    changes: op.changes.map((c) => {
      const classification = classifyChange(c);
      summary[classification]++;
      return { ...c, classification };
    }),
  }));

  return { added: diff.added, removed: diff.removed, changed, summary };
}
