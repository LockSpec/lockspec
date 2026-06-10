import type { NormalizedDoc, Operation } from "../store/store.js";
import { resolvePointer, isObj, refTarget, deref, stripSuffix, parentPointer, type Obj } from "./json-pointer.js";

export interface MergedParam {
  name: string;
  in: string;
  required: boolean;
  /** Resolved parameter object — schema and description live here. */
  param: Obj;
  /**
   * Ref-aware source pointer (no leading `#`): `ref.slice(1)` when the entry
   * is a `{$ref}`, else `${arrayPtr}/${i}` using the per-source-array index.
   * The validator uses this to build `schemaUri = DOC_ID + "#" + base + "/schema"`.
   * Two collect() passes (not a concat loop) keep this index correct for each array.
   */
  base: string;
}

/**
 * Merge path-item and op-level parameters per the OpenAPI Path Item Object rule:
 * key by `{in} {name}`, op-level wins (Map last-write), path params forced required.
 * Returns an ordered Map — insertion order is path-item-first, then op-level.
 */
export function mergeParameters(doc: NormalizedDoc, op: Operation): Map<string, MergedParam> {
  const paramsPtr = op.openapi!.pointers.params;
  const opBase = stripSuffix(paramsPtr, "/parameters");
  const pathItemParamsPtr = `${parentPointer(opBase)}/parameters`;

  const byKey = new Map<string, MergedParam>();
  const collect = (arrayPtr: string): void => {
    const arr = resolvePointer(doc, arrayPtr);
    if (!Array.isArray(arr)) return;
    arr.forEach((entry, i) => {
      const ref = refTarget(entry);
      const p = deref(doc, entry);
      if (!isObj(p) || typeof p.name !== "string" || typeof p.in !== "string") return;
      byKey.set(`${p.in} ${p.name}`, {
        name: p.name,
        in: p.in,
        required: p.required === true || p.in === "path",
        param: p,
        base: ref !== undefined ? ref.slice(1) : `${arrayPtr}/${i}`,
      });
    });
  };
  collect(pathItemParamsPtr);
  collect(paramsPtr);
  return byKey;
}
