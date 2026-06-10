import type { NormalizedDoc, Operation, TypeDef } from "../store/store.js";
import { canonicalize } from "./hashing.js";
import {
  resolvePointer,
  isObj,
  asObj,
  refTarget,
  deref,
  stripSuffix,
  type Obj,
} from "./json-pointer.js";
import { mergeParameters } from "./params.js";

export interface OperationRef {
  operation_key: string;
  method: string;
  path: string;
  operation_id: string | null;
}

export type ChangeKind =
  | "param_added" | "param_removed"
  | "param_type_changed" | "param_required_added" | "param_required_removed"
  | "request_field_added" | "request_field_removed"
  | "required_added" | "required_removed"
  | "type_changed"
  | "ref_changed"
  | "response_added" | "response_removed"
  | "response_field_added" | "response_field_removed"
  | "response_field_type_changed" | "response_ref_changed"
  | "response_required_added" | "response_required_removed"
  | "operation_deprecated";

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
  /** The `type` keyword before and after the change — set only for `type_changed`
   *  and `param_type_changed`. */
  from?: unknown;
  to?: unknown;
  /** True when the TO request-body schema declares `additionalProperties: false` and
   *  the removed field (`request_field_removed`) was optional — the field will now be
   *  *rejected* by the new spec even though it was only optional before. */
  closedSchema?: boolean;
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

/** Classification summary. Operation and type changes both count (the tool folds
 *  the types dimension in for scope:'all' via classifyTypes). `unknown` is non-zero
 *  only for unrecognized future kinds. */
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

/** One changed TypeDef, itemized into field changes by the recursive schema engine
 *  (request kind-set — a component schema has no intrinsic direction). */
export interface ChangedType {
  name: string;
  changes: OperationChange[];
}

/** Added/removed TypeDef names + per-changed-type itemized field changes. */
export interface TypesDiff {
  added: string[];
  removed: string[];
  changed: ChangedType[];
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

// Value (not reference) inequality of two `type` keywords. A union type is an array
// (`["string","null"]`), distinct objects across the two docs — a `!==` compare would
// flag an unchanged union as changed; compare canonical form instead.
const typeChanged = (from: unknown, to: unknown): boolean => canonicalize(from) !== canonicalize(to);

// Bound on nested-property recursion. Mirrors buildSignature's depth cap. No cycle
// guard is needed: diffSchema never follows a $ref (a $ref-retarget is a string
// compare), so a property cycle cannot be entered.
const DIFF_MAX_DEPTH = 6;

// The per-direction kind-set diffSchema emits. Request and response field changes
// classify oppositely (a caller depends on the response), so each direction maps the
// same structural deltas to its own kinds — the inversion lives in classifyChange.
interface SchemaKinds {
  added: ChangeKind;
  removed: ChangeKind;
  typeChanged: ChangeKind;
  refChanged: ChangeKind;
  requiredAdded: ChangeKind;
  requiredRemoved: ChangeKind;
  /** Set `closedSchema:true` on an optional removal into a closed TO-schema — a
   *  request-only concern (the caller's now-rejected field); responses ignore it. */
  closedFlag: boolean;
}

const REQUEST_KINDS: SchemaKinds = {
  added: "request_field_added",
  removed: "request_field_removed",
  typeChanged: "type_changed",
  refChanged: "ref_changed",
  requiredAdded: "required_added",
  requiredRemoved: "required_removed",
  closedFlag: true,
};

const RESPONSE_KINDS: SchemaKinds = {
  added: "response_field_added",
  removed: "response_field_removed",
  typeChanged: "response_field_type_changed",
  refChanged: "response_ref_changed",
  requiredAdded: "response_required_added",
  requiredRemoved: "response_required_removed",
  closedFlag: false,
};

/** Recursively diff two INLINE object schemas: added/removed properties,
 *  required-membership changes, type-keyword changes, and `$ref`-retarget on shared
 *  properties — descending into nested inline objects (deep JSON Pointer). A `$ref`
 *  is never followed: same target → no change (the type dimension owns it); changed
 *  target or ref↔inline reshape → the kind-set's `refChanged`. `kinds` selects the
 *  request- or response-direction kinds; `prefix` carries the parent pointer. */
function diffSchema(from: unknown, to: unknown, kinds: SchemaKinds, depth = 0, prefix = ""): OperationChange[] {
  const fromObj = asObj(from) ?? {};
  const toObj = asObj(to) ?? {};
  const fromProps = asObj(fromObj.properties) ?? {};
  const toProps = asObj(toObj.properties) ?? {};
  const fromReq = new Set<string>(Array.isArray(fromObj.required) ? (fromObj.required as string[]) : []);
  const toReq = new Set<string>(Array.isArray(toObj.required) ? (toObj.required as string[]) : []);

  const changes: OperationChange[] = [];

  for (const name of Object.keys(toProps)) {
    if (!(name in fromProps)) {
      changes.push({ kind: kinds.added, pointer: `${prefix}/${name}`, required: toReq.has(name) });
    }
  }
  // When the TO-schema is closed (additionalProperties:false), an existing caller
  // still sending the removed optional field will be rejected by the new spec.
  const toIsClosed = toObj.additionalProperties === false;
  for (const name of Object.keys(fromProps)) {
    if (!(name in toProps)) {
      const required = fromReq.has(name);
      changes.push({
        kind: kinds.removed,
        pointer: `${prefix}/${name}`,
        required,
        ...(kinds.closedFlag && toIsClosed && !required ? { closedSchema: true } : {}),
      });
    }
  }
  for (const name of Object.keys(fromProps)) {
    if (!(name in toProps)) continue;
    const ptr = `${prefix}/${name}`;
    if (!fromReq.has(name) && toReq.has(name)) changes.push({ kind: kinds.requiredAdded, pointer: ptr });
    if (fromReq.has(name) && !toReq.has(name)) changes.push({ kind: kinds.requiredRemoved, pointer: ptr });

    const fromProp = fromProps[name];
    const toProp = toProps[name];
    const fromRef = refTarget(fromProp);
    const toRef = refTarget(toProp);
    if (fromRef !== toRef && (fromRef !== undefined || toRef !== undefined)) {
      // Retarget (#/A → #/B) or a ref↔inline reshape; the inline side reports null.
      changes.push({ kind: kinds.refChanged, pointer: ptr, from: fromRef ?? null, to: toRef ?? null });
      continue;
    }
    if (fromRef !== undefined) continue; // identical $ref both sides — type dimension owns any change

    const fromType = asObj(fromProp)?.type;
    const toType = asObj(toProp)?.type;
    if (fromType !== undefined && toType !== undefined && typeChanged(fromType, toType)) {
      changes.push({ kind: kinds.typeChanged, pointer: ptr, from: fromType, to: toType });
      continue; // shape diverged — don't descend into a now-mismatched node
    }
    if (depth < DIFF_MAX_DEPTH && isObj(asObj(fromProp)?.properties) && isObj(asObj(toProp)?.properties)) {
      changes.push(...diffSchema(fromProp, toProp, kinds, depth + 1, ptr));
    }
  }

  return changes;
}

/** The INLINE response schema for a status's primary content type, or null if
 *  absent/$ref'd ($ref'd response bodies route to diffTypes — same seam as request
 *  bodies in getInlineBodySchema). */
function getInlineResponseSchema(doc: NormalizedDoc, op: Operation, status: string): unknown | null {
  const responses = asObj(resolvePointer(doc, op.openapi!.pointers.responses));
  if (!responses) return null;
  const resp = asObj(deref(doc, responses[status]));
  if (!resp) return null;
  const content = asObj(resp.content);
  if (!content) return null;
  const ct = "application/json" in content ? "application/json" : (Object.keys(content)[0] ?? "");
  if (!ct) return null;
  const media = asObj(content[ct]);
  if (!media) return null;
  const schema = media.schema;
  if (refTarget(schema) !== undefined) return null;
  return schema ?? null;
}

function itemizeChangedOp(fromSide: VersionSide, toSide: VersionSide, fromOp: Operation, toOp: Operation): OperationChange[] {
  const changes: OperationChange[] = [];

  // Deprecated flag toggle — structural but not stripped, so the op hash already
  // differs when we reach here. Pointer /deprecated is unambiguous and carries from/to.
  const fromOpObj = asObj(opSubtree(fromSide, fromOp));
  const toOpObj = asObj(opSubtree(toSide, toOp));
  if (fromOpObj && toOpObj && fromOpObj.deprecated !== toOpObj.deprecated) {
    changes.push({ kind: "operation_deprecated", pointer: "/deprecated", from: fromOpObj.deprecated, to: toOpObj.deprecated });
  }

  const fromParams = mergeParameters(fromSide.doc, fromOp);
  const toParams = mergeParameters(toSide.doc, toOp);
  for (const [key, p] of toParams) {
    if (!fromParams.has(key)) changes.push({ kind: "param_added", pointer: `/${p.name}`, required: p.required });
  }
  for (const [key, p] of fromParams) {
    if (!toParams.has(key)) changes.push({ kind: "param_removed", pointer: `/${p.name}`, required: p.required });
  }
  // Shared params: detect type change and required flip.
  for (const [key, fp] of fromParams) {
    const tp = toParams.get(key);
    if (tp === undefined) continue;
    if (!fp.required && tp.required) changes.push({ kind: "param_required_added", pointer: `/${fp.name}` });
    if (fp.required && !tp.required) changes.push({ kind: "param_required_removed", pointer: `/${fp.name}` });
    const fromType = asObj(fp.param.schema)?.type;
    const toType = asObj(tp.param.schema)?.type;
    if (fromType !== undefined && toType !== undefined && typeChanged(fromType, toType)) {
      changes.push({ kind: "param_type_changed", pointer: `/${fp.name}`, from: fromType, to: toType });
    }
  }

  const fromBodySchema = getInlineBodySchema(fromSide.doc, fromOp);
  const toBodySchema = getInlineBodySchema(toSide.doc, toOp);
  if (fromBodySchema !== null && toBodySchema !== null) {
    changes.push(...diffSchema(fromBodySchema, toBodySchema, REQUEST_KINDS));
  }

  const fromStatuses = getResponseStatuses(fromSide.doc, fromOp);
  const toStatuses = getResponseStatuses(toSide.doc, toOp);
  for (const status of toStatuses) {
    if (!fromStatuses.has(status)) changes.push({ kind: "response_added", pointer: `/${status}` });
  }
  for (const status of fromStatuses) {
    if (!toStatuses.has(status)) changes.push({ kind: "response_removed", pointer: `/${status}` });
  }
  // Shared statuses: itemize the inline response body. Response fields classify
  // oppositely to request fields (RESPONSE_KINDS), pointer-prefixed by status.
  for (const status of fromStatuses) {
    if (!toStatuses.has(status)) continue;
    const fromResp = getInlineResponseSchema(fromSide.doc, fromOp, status);
    const toResp = getInlineResponseSchema(toSide.doc, toOp, status);
    if (fromResp !== null && toResp !== null) {
      changes.push(...diffSchema(fromResp, toResp, RESPONSE_KINDS, 0, `/${status}`));
    }
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
  const changed: ChangedType[] = [];
  for (const [name, fromTD] of fromByName) {
    const toTD = toByName.get(name);
    if (toTD === undefined) continue;
    const fromSubtree = resolvePointer(from.doc, fromTD.pointer);
    const toSubtree = resolvePointer(to.doc, toTD.pointer);
    if (canonicalize(strip(fromSubtree)) !== canonicalize(strip(toSubtree))) {
      // A component schema has no request/response direction; itemize with the
      // request kind-set. A non-itemizable delta (e.g. enum/description-only) keeps
      // the type in `changed` with `changes:[]` — never silently dropped.
      changed.push({ name, changes: sortChanges(diffSchema(fromSubtree, toSubtree, REQUEST_KINDS)) });
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
    case "param_type_changed":
      return "breaking";
    case "param_required_added":
      return "breaking";
    case "param_required_removed":
      return "non_breaking";
    case "operation_deprecated":
      return "non_breaking";
    case "request_field_added":
      return c.required ? "breaking" : "non_breaking";
    case "request_field_removed":
      // An optional removal is also breaking when the TO-schema is closed
      // (additionalProperties:false) — a caller sending the removed field is rejected.
      return c.required || c.closedSchema ? "breaking" : "non_breaking";
    case "required_added":
      return "breaking";
    case "required_removed":
      return "non_breaking";
    case "type_changed":
      // Conservative: any type change may narrow the accepted values.
      return "breaking";
    case "ref_changed":
      // The referenced shape changed identity (retarget) or a ref↔inline reshape.
      return "breaking";
    case "response_added":
      return "non_breaking";
    case "response_removed":
      // Conservative: documented response removed may indicate behavior change.
      return "breaking";
    // Response fields invert request semantics: a caller depends on the response, so
    // a field/required-ness the server REMOVES breaks them, one it ADDS does not.
    case "response_field_added":
      return "non_breaking";
    case "response_field_removed":
      return "breaking";
    case "response_field_type_changed":
      return "breaking";
    case "response_ref_changed":
      return "breaking";
    case "response_required_added":
      return "non_breaking";
    case "response_required_removed":
      return "breaking";
    default:
      return "unknown";
  }
}

/** A changed type with `classification` stamped on each itemized change. */
export interface ClassifiedChangedType {
  name: string;
  changes: OperationChange[];
}

export interface ClassifiedTypesDiff {
  added: string[];
  removed: string[];
  changed: ClassifiedChangedType[];
  summary: DiffSummary;
}

/** Classify the types dimension: removed types → breaking, added types →
 *  non_breaking, and each changed-type's itemized changes by their per-change
 *  classification. Stamps `classification` on every change (consistent with
 *  classifyDiff) and returns the aggregate summary. */
export function classifyTypes(diff: TypesDiff): ClassifiedTypesDiff {
  const summary: DiffSummary = { breaking: 0, non_breaking: 0, unknown: 0 };
  summary.breaking += diff.removed.length;
  summary.non_breaking += diff.added.length;

  const changed: ClassifiedChangedType[] = diff.changed.map((t) => ({
    name: t.name,
    changes: t.changes.map((c) => {
      const classification = classifyChange(c);
      summary[classification]++;
      return { ...c, classification };
    }),
  }));

  return { added: diff.added, removed: diff.removed, changed, summary };
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
