import { bundle, validate } from "@readme/openapi-parser";
import { parse as parseYaml } from "yaml";
import type { NormalizedDoc, SpecFormat } from "../store/store.js";
import { isObj, type Obj } from "./json-pointer.js";

// Cycle tagging happens at query time in get_signature, never here, so the
// snapshot stays bounded and the output is a finite JSON tree.

export type NormalizeErrorCode = "parse_error" | "unsupported_spec" | "io_error";

export class NormalizeError extends Error {
  readonly code: NormalizeErrorCode;
  readonly details?: unknown;
  constructor(code: NormalizeErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "NormalizeError";
    this.code = code;
    this.details = details;
  }
}

export interface NormalizeOptions {
  /** Source file path / base URL used to resolve external $refs (default: cwd). */
  basePath?: string;
}

export interface NormalizeResult {
  doc: NormalizedDoc;
  specFormat: SpecFormat;
  formatVersion: string;
  externalSources: string[];
  /** Non-fatal SOFT validation findings, surfaced via load_spec's stats.warnings. */
  warnings: string[];
}

// @readme/openapi-parser types only declare bundle(api, options?), but the
// underlying ref-parser also accepts a (baseDir, api) form to resolve external
// $refs relative to a base path. Local typed shim for that interop boundary.
type BundleFn = {
  (api: object): Promise<unknown>;
  (base: string, api: object): Promise<unknown>;
};
const bundleDoc = bundle as unknown as BundleFn;

// validate() takes the parser's own APIDocument type but our bundled doc is an
// opaque plain JSON object. Local shim; `options` carries parser rule overrides,
// `warnings` surfaces rules downgraded to "warning" severity.
type ValidateFn = (api: object, options?: unknown) => Promise<{
  valid: boolean;
  errors?: Array<{ message: string }>;
  warnings?: Array<{ message: string }>;
  additionalErrors?: number;
}>;
const validateDoc = validate as unknown as ValidateFn;

// Downgrade duplicate-operationId from a hard error to a warning: a spec with
// non-unique operationIds still indexes correctly by operation_key.
const DUP_OPID_AS_WARNING = {
  validate: { rules: { openapi: { "duplicate-operation-id": "warning" } } },
} as const;
const DUP_OPID_HINT =
  "— get_signature by operation_id will be ambiguous; use operation_key.";

export async function normalize(
  input: string | object,
  opts?: NormalizeOptions,
): Promise<NormalizeResult> {
  let parsed: unknown;
  if (typeof input === "string") {
    try {
      parsed = parseYaml(input);
    } catch (e) {
      // Thread line/col from the yaml parser's YAMLParseError into details so
      // agents can pinpoint the syntax error. linePos is yaml-specific.
      const linePos = (e as { linePos?: Array<{ line: number; col: number }> }).linePos?.[0];
      const details = linePos ? { line: linePos.line, col: linePos.col } : undefined;
      throw new NormalizeError("parse_error", `Could not parse spec as JSON/YAML: ${msg(e)}`, details);
    }
  } else {
    parsed = input;
  }
  if (!isObj(parsed)) {
    throw new NormalizeError("parse_error", "Spec did not parse to an object.");
  }

  const formatVersion = parsed.openapi;
  if (typeof formatVersion !== "string" || !/^3\.(0|1)\.\d+/.test(formatVersion)) {
    throw new NormalizeError(
      "unsupported_spec",
      `Expected OpenAPI 3.0.x or 3.1.x; got ${describeVersion(parsed)}.`,
    );
  }

  const externalSources = collectExternalRefs(parsed);

  let bundled: unknown;
  try {
    bundled = opts?.basePath
      ? await bundleDoc(opts.basePath, structuredClone(parsed))
      : await bundleDoc(structuredClone(parsed));
  } catch (e) {
    throw new NormalizeError(refResolutionCode(e), `Failed to resolve $refs: ${msg(e)}`);
  }

  // Validate BEFORE reconcile: reconcileDoc mutates 3.0 schemas into 2020-12
  // shapes while leaving the openapi:3.0.x version string, which confuses both
  // meta-schemas.
  const warnings = await validateStructure(bundled);

  reconcileDoc(bundled);

  return {
    doc: bundled as NormalizedDoc,
    specFormat: "openapi",
    formatVersion,
    externalSources,
    warnings,
  };
}

function describeVersion(spec: Obj): string {
  if (typeof spec.openapi === "string") return `openapi ${spec.openapi}`;
  if ("swagger" in spec) return `swagger ${String(spec.swagger)}`;
  return "no openapi field";
}

function msg(e: unknown): string {
  return e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e);
}

// @readme/openapi-parser throws typed objects with a `code` and, for
// filesystem/network failures, an `ioErrorCode` (the OS error code, e.g.
// ENOENT, ECONNREFUSED). We prefer these over the message text.
function refResolutionCode(e: unknown): NormalizeErrorCode {
  if (e !== null && typeof e === "object") {
    const ioCode = (e as { ioErrorCode?: unknown }).ioErrorCode;
    if (typeof ioCode === "string" && ioCode.length > 0) {
      return "io_error";
    }
  }
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return /enoent|eai_again|econnrefused|getaddrinfo|error opening file|cannot read|network/.test(m)
    ? "io_error"
    : "parse_error";
}

// validate() dereferences $refs in-place and we inject SOFT placeholders, so both
// run on a structuredClone to keep `bundled` pristine for reconcile.
async function validateStructure(bundled: unknown): Promise<string[]> {
  const warnings: string[] = [];
  const clone = structuredClone(bundled) as Obj;
  fillMissingInfo(clone, warnings);

  let result: {
    valid: boolean;
    errors?: Array<{ message: string }>;
    warnings?: Array<{ message: string }>;
    additionalErrors?: number;
  };
  try {
    result = await validateDoc(clone, DUP_OPID_AS_WARNING);
  } catch (e) {
    throw new NormalizeError("parse_error", `Spec failed OpenAPI schema validation: ${msg(e)}`);
  }

  for (const w of result.warnings ?? []) {
    warnings.push(`${String(w.message).split("\n")[0]} ${DUP_OPID_HINT}`);
  }

  if (!result.valid) {
    const all = (result.errors ?? []).map((e) => String(e.message).split("\n")[0]);
    const count = all.length + (result.additionalErrors ?? 0);
    throw new NormalizeError(
      "parse_error",
      `Spec is not a valid OpenAPI document: ${all[0] ?? "schema validation failed"}`,
      { errors: all.slice(0, 10), count },
    );
  }
  return warnings;
}

// Inject placeholders into the validation clone for missing info.title/version
// so validate() still catches HARD violations; record each gap as a warning.
// Only an ABSENT key is SOFT — present-but-wrong-type is left for validate().
// Uses `== null` (not `=== undefined`) to also catch YAML empty `info:` → null.
function fillMissingInfo(clone: Obj, warnings: string[]): void {
  if (clone.info == null) clone.info = {};
  if (!isObj(clone.info)) return;
  const info = clone.info;
  if (info.title == null) {
    warnings.push("Spec is missing info.title (an OpenAPI required field).");
    info.title = "untitled";
  }
  if (info.version == null) {
    warnings.push("Spec is missing info.version (an OpenAPI required field); version_label is null.");
    info.version = "0";
  }
}

function collectExternalRefs(node: unknown, acc = new Set<string>()): string[] {
  if (Array.isArray(node)) {
    for (const v of node) collectExternalRefs(v, acc);
  } else if (isObj(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string" && !v.startsWith("#")) acc.add(v);
      else collectExternalRefs(v, acc);
    }
  }
  return [...acc];
}

// Scoping reconciliation to real Schema Objects (under `schema` keys + the
// schemas/$defs/definitions maps) keeps `example`/`examples` on media-type and
// parameter objects untouched — there `examples` is a map, not an array.

const SCHEMA_MAP_KEYS = new Set(["schemas", "$defs", "definitions"]);

function reconcileDoc(node: unknown): void {
  if (Array.isArray(node)) {
    for (const v of node) reconcileDoc(v);
  } else if (isObj(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === "schema" && isObj(v)) reconcileSchema(v);
      else if (SCHEMA_MAP_KEYS.has(k) && isObj(v)) {
        for (const s of Object.values(v)) if (isObj(s)) reconcileSchema(s);
      } else reconcileDoc(v);
    }
  }
}

const SUBSCHEMA_OBJ = ["items", "not", "additionalProperties", "additionalItems", "contains", "if", "then", "else", "propertyNames"];
const SUBSCHEMA_ARR = ["allOf", "anyOf", "oneOf", "prefixItems"];
const SUBSCHEMA_MAP = ["properties", "patternProperties", "$defs", "definitions"];

function reconcileSchema(s: Obj): void {
  // nullable:true → add "null" to the type union; drop nullable either way.
  if (s.nullable === true) addNullType(s);
  if ("nullable" in s) delete s.nullable;

  // boolean exclusiveMinimum/Maximum (3.0) → numeric form (2020-12).
  reconcileExclusive(s, "exclusiveMinimum", "minimum");
  reconcileExclusive(s, "exclusiveMaximum", "maximum");

  // schema-level example → examples[] (only when examples isn't already present).
  if ("example" in s && !("examples" in s)) {
    s.examples = [s.example];
    delete s.example;
  }

  for (const k of SUBSCHEMA_OBJ) if (isObj(s[k])) reconcileSchema(s[k] as Obj);
  for (const k of SUBSCHEMA_ARR) if (Array.isArray(s[k])) for (const e of s[k] as unknown[]) if (isObj(e)) reconcileSchema(e);
  for (const k of SUBSCHEMA_MAP) if (isObj(s[k])) for (const e of Object.values(s[k] as Obj)) if (isObj(e)) reconcileSchema(e);
}

function addNullType(s: Obj): void {
  if (typeof s.type === "string") s.type = [s.type, "null"];
  else if (Array.isArray(s.type) && !s.type.includes("null")) s.type = [...s.type, "null"];
  // no `type` to widen → nothing expressible; leave as-is.
}

function reconcileExclusive(s: Obj, exclusiveKey: string, boundKey: string): void {
  if (s[exclusiveKey] === true) {
    if (typeof s[boundKey] === "number") {
      s[exclusiveKey] = s[boundKey];
      delete s[boundKey];
    } else {
      delete s[exclusiveKey];
    }
  } else if (s[exclusiveKey] === false) {
    delete s[exclusiveKey];
  }
}
