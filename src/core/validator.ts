import type { NormalizedDoc, Operation } from "../store/store.js";

// Schemas arrive already reconciled to JSON Schema 2020-12 by core/normalizer, so
// the validator adds no 3.0-specific transforms. It deliberately does NOT reuse
// core/signature's expansion — that is lossy (truncation/{$circular}/DAG collapse),
// whereas Ajv needs complete schemas with $refs intact, resolved against the doc.

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsImport, { type FormatsPlugin } from "ajv-formats";

import {
  escapePointer,
  resolvePointer,
  isObj,
  refTarget,
  deref,
  stripSuffix,
  parentPointer,
  type Obj,
} from "./json-pointer.js";

// ajv-formats is CommonJS with a callable default export; NodeNext's default-
// import interop types it as the module namespace, so cast to the (callable)
// FormatsPlugin.
const addFormats = addFormatsImport as unknown as FormatsPlugin;

export interface SpecValidator {
  /** Compile the operation's request-body schema(s), keyed by content-type.
   *  Empty map when the operation has no requestBody. */
  compileBody(operation: Operation): Map<string, ValidateFunction>;

  /** Compile the operation's parameters into one synthetic object-schema per
   *  `in`-group (path/query/header/cookie), keyed by `in`. Each group's fn checks
   *  declared values + missing-required (+ unknowns for path/query).
   *  Empty map when the operation declares no parameters. */
  compileParams(operation: Operation): Map<string, ValidateFunction>;

  /** Whether the operation's requestBody is `required: true`. False when there
   *  is no requestBody. */
  requestBodyRequired(operation: Operation): boolean;
}

export type ViolationLocation = "body" | "path" | "query" | "header" | "cookie";

/** A single structural violation. `code` is a stable code we own (Ajv's keyword
 *  is an implementation detail); `pointer` is an RFC-6901 pointer into the
 *  instance (`""` = root). */
export interface Violation {
  location: ViolationLocation;
  pointer: string;
  code: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
}

/** Run a compiled request-body validate-fn against a draft body and return ALL
 *  structural violations. Pure; content-type selection + body-required policy
 *  are in the validate_call handler. */
export function validateBody(validate: ValidateFunction, body: unknown): Violation[] {
  // allErrors:true (construction-time) means a single call collects every violation.
  if (validate(body)) return [];
  return (validate.errors ?? []).map((e) => mapError(e, body, "body"));
}

/** A draft request's parameters, grouped by `in`. Values are already-typed JSON
 *  (no coercion — that would hide the `type` violations validate_call exists to
 *  catch). */
export interface DraftParams {
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  header?: Record<string, unknown>;
  cookie?: Record<string, unknown>;
}

/** Run the per-`in` param validate-fns against a draft request's params and
 *  return ALL violations. A missing `in`-group is validated as `{}`, so
 *  missing-required still fires. */
export function validateParams(compiled: Map<string, ValidateFunction>, params: DraftParams): Violation[] {
  const out: Violation[] = [];
  for (const [loc, fn] of compiled) {
    const instance = (params as Record<string, unknown>)[loc] ?? {};
    if (fn(instance)) continue;
    for (const e of fn.errors ?? []) out.push(mapError(e, instance, loc as ViolationLocation));
  }
  return out;
}

// Ajv keyword → owned violation code + composed message.
// Any unrecognized keyword falls through to `constraint` so collect-all never
// silently drops a structural violation.
function mapError(e: { keyword: string; instancePath: string; params: Record<string, unknown>; message?: string }, instance: unknown, location: ViolationLocation): Violation {
  const at = e.instancePath; // RFC-6901 pointer to the failing node
  const param = location !== "body";
  switch (e.keyword) {
    case "required": {
      const prop = String(e.params.missingProperty);
      const message = param ? `Missing required ${location} parameter '${prop}'.` : `Missing required property '${prop}'.`;
      return { location, pointer: `${at}/${escapePointer(prop)}`, code: "required", message };
    }
    case "type": {
      const expected = e.params.type;
      const actual = jsonType(resolvePointer(instance, at));
      return { location, pointer: at, code: "type", message: `Expected ${fmtType(expected)}, got ${actual}.`, expected, actual };
    }
    case "enum": {
      const allowed = (e.params.allowedValues as unknown[]) ?? [];
      return { location, pointer: at, code: "enum", message: `Value is not one of the allowed values [${allowed.join(", ")}].`, expected: allowed, actual: resolvePointer(instance, at) };
    }
    case "format": {
      const format = String(e.params.format);
      return { location, pointer: at, code: "format", message: `Value does not match format '${format}'.`, expected: format, actual: resolvePointer(instance, at) };
    }
    case "additionalProperties": {
      const prop = String(e.params.additionalProperty);
      const code = param ? "unknown_param" : "additional_properties";
      const message = param ? `Unknown ${location} parameter '${prop}'.` : `Unknown property '${prop}' is not allowed.`;
      return { location, pointer: `${at}/${escapePointer(prop)}`, code, message };
    }
    default:
      return { location, pointer: at, code: "constraint", message: `${e.keyword}: ${e.message ?? "constraint violated"}` };
  }
}

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

const fmtType = (t: unknown): string => (Array.isArray(t) ? t.join("|") : String(t));

// The whole normalized doc is registered under this synthetic base so internal
// $refs (`#/components/schemas/...`, document-relative) resolve against it.
const DOC_ID = "lockspec://spec";

export function createSpecValidator(doc: NormalizedDoc): SpecValidator {
  // strict:false — tolerate OpenAPI vocabulary (discriminator/xml/externalDocs).
  // allErrors:true — collect every violation.
  // addFormats makes `format` assert (not just annotate).
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(doc as object, DOC_ID);

  const cache = new Map<string, ValidateFunction>();
  const compileRef = (uri: string): ValidateFunction => {
    const cached = cache.get(uri);
    if (cached !== undefined) return cached;
    const fn = ajv.compile({ $ref: uri });
    cache.set(uri, fn);
    return fn;
  };

  return {
    compileBody(operation: Operation): Map<string, ValidateFunction> {
      const result = new Map<string, ValidateFunction>();
      const rbPtr = operation.openapi?.pointers.requestBody;
      if (rbPtr === undefined) return result;

      // Follow a structural requestBody $ref (rare) one hop.
      const rb = deref(doc, resolvePointer(doc, rbPtr));
      const content = isObj(rb) ? rb.content : undefined;
      if (!isObj(content)) return result;

      for (const [ct, media] of Object.entries(content)) {
        const schema = isObj(media) ? media.schema : undefined;
        if (schema === undefined) continue;
        // A $ref body → compile the clean ref target ($ref starts with '#').
        // An inline body → address it by its document pointer.
        const ref = refTarget(schema);
        const uri =
          ref !== undefined
            ? DOC_ID + ref
            : `${DOC_ID}#${rbPtr}/content/${escapePointer(ct)}/schema`;
        result.set(ct, compileRef(uri));
      }
      return result;
    },

    compileParams(operation: Operation): Map<string, ValidateFunction> {
      const paramsPtr = operation.openapi?.pointers.params;
      if (paramsPtr === undefined) return new Map();
      const opBase = stripSuffix(paramsPtr, "/parameters"); // /paths/<path>/<method>
      const pathItemParamsPtr = `${parentPointer(opBase)}/parameters`; // path-item shared params

      // Merge path-item + op params, keyed by (in, name); op last → op wins on a
      // collision (OpenAPI Path Item Object rule). Each param records the pointer to
      // its value schema for a $ref into the registered doc.
      interface PInfo { name: string; in: string; required: boolean; schemaUri?: string }
      const byKey = new Map<string, PInfo>();
      const collect = (arrayPtr: string): void => {
        const arr = resolvePointer(doc, arrayPtr);
        if (!Array.isArray(arr)) return;
        arr.forEach((entry, i) => {
          // A param entry may be a structural $ref; resolve one hop to read it.
          const ref = refTarget(entry);
          const p = deref(doc, entry);
          if (!isObj(p) || typeof p.name !== "string" || typeof p.in !== "string") return;
          const base = ref !== undefined ? ref.slice(1) : `${arrayPtr}/${i}`;
          byKey.set(`${p.in} ${p.name}`, {
            name: p.name,
            in: p.in,
            required: p.required === true || p.in === "path",
            // No `schema` → presence only; property becomes `{}` (accept any).
            schemaUri: p.schema !== undefined ? `${DOC_ID}#${base}/schema` : undefined,
          });
        });
      };
      collect(pathItemParamsPtr);
      collect(paramsPtr);

      const groups = new Map<string, PInfo[]>();
      for (const info of byKey.values()) {
        const g = groups.get(info.in);
        if (g) g.push(info);
        else groups.set(info.in, [info]);
      }

      // One synthetic object schema per `in`-group. Build path+query always (so an
      // invented param is caught even when none are declared); header/cookie only
      // when declared (extras are allowed there, so an empty schema is a no-op).
      const result = new Map<string, ValidateFunction>();
      for (const inValue of new Set([...groups.keys(), "path", "query"])) {
        const members = groups.get(inValue) ?? [];
        if (members.length === 0 && !reportsUnknown(inValue)) continue;
        const properties: Obj = {};
        const required: string[] = [];
        for (const m of members) {
          properties[m.name] = m.schemaUri !== undefined ? { $ref: m.schemaUri } : {};
          if (m.required) required.push(m.name);
        }
        result.set(inValue, ajv.compile({ type: "object", properties, required, additionalProperties: !reportsUnknown(inValue) }));
      }
      return result;
    },

    requestBodyRequired(operation: Operation): boolean {
      const rbPtr = operation.openapi?.pointers.requestBody;
      if (rbPtr === undefined) return false;
      const rb = deref(doc, resolvePointer(doc, rbPtr));
      return isObj(rb) && rb.required === true;
    },
  };
}

// path/query report unknown params (closed declared set); header/cookie allow
// extras (HTTP carries Authorization/Content-Type/session cookies the spec never
// lists — flagging them is noise, not signal).
const reportsUnknown = (inValue: string): boolean => inValue === "path" || inValue === "query";
