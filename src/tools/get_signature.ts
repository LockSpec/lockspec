import type { ToolDeps, ToolModule } from "./index.js";
import { getSignatureInputSchema, getSignatureInputSchemaRefined } from "../schemas/get_signature.js";
import { OPERATION_REF_MESSAGE } from "../schemas/operation_ref.js";
import { fail, toCallToolResult, toErrorResult, snapshotMissing } from "./result.js";
import { resolveTarget, locateOperation } from "../core/resolver.js";
import { buildSignature } from "../core/signature.js";

function handle(args: unknown, deps: ToolDeps) {
  const parsed = getSignatureInputSchemaRefined.safeParse(args);
  if (!parsed.success) {
    // The XOR refinement is the common failure; its message is the actionable one.
    return toCallToolResult(fail("invalid_input", OPERATION_REF_MESSAGE), OPERATION_REF_MESSAGE);
  }
  const { store } = deps;
  const input = parsed.data;

  // Write-adjacent → strict: >1 loaded version + omitted `version` → ambiguous
  // (with loaded_versions in details), never guess.
  const resolved = resolveTarget(store, { spec_id: input.spec_id, version: input.version }, "strict");
  if (!resolved.ok) return toErrorResult(resolved);
  const { spec_id, version } = resolved;

  const found = locateOperation(store.getOperations(spec_id, version.version_id), input);
  if (!found.ok) return toErrorResult(found);
  const operation = found.operation;

  const doc = store.loadSnapshot(version.content_hash);
  if (doc === undefined) return snapshotMissing(spec_id, version.version_id);

  const built = buildSignature(doc, operation, {
    expandRefs: input.expand_refs,
    maxDepth: input.max_depth,
  });

  const payload = {
    ok: true as const,
    spec_id,
    version_id: version.version_id,
    operation_key: operation.operation_key,
    ...built,
  };
  const summary = `Signature for ${operation.operation_key} in ${spec_id}${built.truncated_paths.length ? ` (${built.truncated_paths.length} path(s) truncated)` : ""}.`;
  return toCallToolResult(payload, summary);
}

export const getSignatureTool: ToolModule = {
  name: "get_signature",
  title: "Get signature",
  description:
    "Exact, complete contract for one operation: params, body, responses, required fields, types.",
  inputSchema: getSignatureInputSchema, // base (ZodObject) for SDK registration; handler parses the refined XOR
  handler: handle,
};
