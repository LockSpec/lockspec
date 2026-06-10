import type { ToolDeps, ToolModule } from "./index.js";
import { listSpecsInputSchema } from "../schemas/list_specs.js";
import { fail, toCallToolResult } from "./result.js";
import type { Spec, Store } from "../store/store.js";

// An explicit spec_id that's missing → not_found (more actionable than an empty list).

function specView(store: Store, spec: Spec) {
  const active = spec.active_version_id;
  const versions = store.listVersions(spec.spec_id).map((v) => ({
    version_id: v.version_id,
    version_label: v.version_label,
    spec_format: v.spec_format,
    format_version: v.format_version,
    active: v.version_id === active,
    provenance: v.provenance,
    stats: {
      operations: store.countOperations(spec.spec_id, v.version_id),
      type_defs: store.countTypeDefs(spec.spec_id, v.version_id),
    },
  }));
  return { spec_id: spec.spec_id, label: spec.label, active_version_id: active, versions };
}

function handle(args: unknown, deps: ToolDeps) {
  const parsed = listSpecsInputSchema.safeParse(args);
  if (!parsed.success) {
    return toCallToolResult(fail("invalid_input", "Invalid list_specs input."), "Invalid list_specs input.");
  }
  const { store } = deps;
  const { spec_id } = parsed.data;

  let specs: Spec[];
  if (spec_id != null) {
    const one = store.getSpec(spec_id);
    if (!one) {
      const msg = `No spec ${JSON.stringify(spec_id)} is loaded.`;
      return toCallToolResult(fail("not_found", msg), msg);
    }
    specs = [one];
  } else {
    specs = store.listSpecs();
  }

  const payload = { ok: true as const, specs: specs.map((s) => specView(store, s)) };
  const summary =
    payload.specs.length === 0
      ? "No specs loaded."
      : `${payload.specs.length} spec(s): ${payload.specs.map((s) => s.spec_id).join(", ")}.`;
  return toCallToolResult(payload, summary);
}

export const listSpecsTool: ToolModule = {
  name: "list_specs",
  title: "List specs",
  description: "List loaded specs with their versions, active version, and index stats.",
  inputSchema: listSpecsInputSchema,
  handler: handle,
};
