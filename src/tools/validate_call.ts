import type { ToolDeps, ToolModule } from "./index.js";
import { validateCallInputSchema, validateCallInputSchemaRefined } from "../schemas/validate_call.js";
import { OPERATION_REF_MESSAGE } from "../schemas/operation_ref.js";
import { fail, toCallToolResult, toErrorResult, snapshotMissing } from "./result.js";
import { resolveTarget, locateOperation } from "../core/resolver.js";
import { createSpecValidator, validateBody, validateParams, type DraftParams, type Violation, type SpecValidator } from "../core/validator.js";
import type { ValidateFunction } from "ajv/dist/2020.js";
import type { Operation } from "../store/store.js";

// `ok` = the tool ran; `valid` = the draft passed — distinct outcomes.

type Request = ReturnType<typeof validateCallInputSchemaRefined.parse>["request"];

function handle(args: unknown, deps: ToolDeps) {
  const parsed = validateCallInputSchemaRefined.safeParse(args);
  if (!parsed.success) {
    // The XOR refinement is the common, actionable failure.
    return toCallToolResult(fail("invalid_input", OPERATION_REF_MESSAGE), OPERATION_REF_MESSAGE);
  }
  const { store } = deps;
  const input = parsed.data;

  // Write-adjacent (the pre-finalize gate) → strict: >1 loaded version + omitted
  // `version` → ambiguous (with loaded_versions in details), never guess.
  const resolved = resolveTarget(store, { spec_id: input.spec_id, version: input.version }, "strict");
  if (!resolved.ok) return toErrorResult(resolved);
  const { spec_id, version } = resolved;

  const found = locateOperation(store.getOperations(spec_id, version.version_id), input);
  if (!found.ok) return toErrorResult(found);
  const operation = found.operation;

  const doc = store.loadSnapshot(version.content_hash);
  if (doc === undefined) return snapshotMissing(spec_id, version.version_id);

  // Compile + validate. Ajv can throw at COMPILE on a malformed/unresolvable
  // schema; validate-time fn(data) returns a bool and won't. Wrap the whole block.
  let errors: Violation[];
  let warnings: string[];
  try {
    const validator = createSpecValidator(doc);
    const ctMap = validator.compileBody(operation);
    const paramFns = validator.compileParams(operation);
    const body = validateRequestBody(validator, operation, ctMap, input.request);
    errors = [...body.errors, ...validateParams(paramFns, toDraftParams(input.request))];
    warnings = body.warnings;
  } catch (e) {
    const msg = `Could not compile schemas for ${operation.operation_key}: ${e instanceof Error ? e.message : String(e)}`;
    return toCallToolResult(fail("parse_error", msg), msg);
  }

  const valid = errors.length === 0;
  const payload = {
    ok: true as const,
    valid,
    spec_id,
    version_id: version.version_id,
    operation_key: operation.operation_key,
    errors,
    warnings,
  };
  const summary = valid
    ? `valid — draft for ${operation.operation_key} passed (${spec_id}).`
    : `invalid — ${errors.length} violation(s) for ${operation.operation_key} (${spec_id}).`;
  return toCallToolResult(payload, summary);
}

// Request field names → the core DraftParams `in`-keys (not 1:1).
function toDraftParams(request: Request): DraftParams {
  const dp: DraftParams = {};
  if (request.path_params) dp.path = request.path_params;
  if (request.query_params) dp.query = request.query_params;
  if (request.headers) dp.header = request.headers;
  if (request.cookie_params) dp.cookie = request.cookie_params;
  return dp;
}

// Body validation + content-type selection. An empty ctMap means no
// validatable body schema (no requestBody, or media-types without a schema) — a
// supplied body is then a warning, not a violation (nothing to validate against).
function validateRequestBody(
  validator: SpecValidator,
  operation: Operation,
  ctMap: Map<string, ValidateFunction>,
  request: Request,
): { errors: Violation[]; warnings: string[] } {
  const errors: Violation[] = [];
  const warnings: string[] = [];
  const hasBody = request.body !== undefined;

  if (ctMap.size === 0) {
    if (hasBody) warnings.push("Operation defines no validatable request-body schema; body not validated.");
    return { errors, warnings };
  }

  const requested = request.content_type ?? "application/json";
  if (hasBody) {
    const fn = ctMap.get(requested);
    if (fn === undefined) {
      const defined = [...ctMap.keys()].join(", ");
      errors.push({ location: "body", pointer: "", code: "content_type", message: `Operation does not define request body content-type '${requested}'. Defined: ${defined}.` });
    } else {
      errors.push(...validateBody(fn, request.body));
    }
  } else if (validator.requestBodyRequired(operation)) {
    errors.push({ location: "body", pointer: "", code: "required", message: "Request body is required." });
  }
  return { errors, warnings };
}

export const validateCallTool: ToolModule = {
  name: "validate_call",
  title: "Validate call",
  description:
    "Deterministic structural validation of a draft request against the pinned spec: " +
    "missing required fields, wrong types, enums, formats, unknown/missing params — all " +
    "violations at once, JSON-Pointer located. Pass parameter and body values as typed " +
    "JSON (e.g. 5, not \"5\"); values are checked against the spec's declared types without coercion.",
  inputSchema: validateCallInputSchema, // base for SDK registration; handler parses the refined XOR
  handler: handle,
};
