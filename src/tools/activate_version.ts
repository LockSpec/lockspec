import type { ToolDeps, ToolModule } from "./index.js";
import { activateVersionInputSchema } from "../schemas/activate_version.js";
import { fail, toCallToolResult, toErrorResult } from "./result.js";
import { resolveVersionRef, formatVersionHandle } from "../core/resolver.js";

function handle(args: unknown, deps: ToolDeps) {
  const parsed = activateVersionInputSchema.safeParse(args);
  if (!parsed.success) {
    return toCallToolResult(
      fail("invalid_input", "Invalid activate_version input."),
      "Invalid activate_version input.",
    );
  }
  const { store } = deps;
  const { spec_id, version } = parsed.data;

  if (!store.getSpec(spec_id)) {
    const msg = `No spec ${JSON.stringify(spec_id)} is loaded.`;
    return toCallToolResult(fail("not_found", msg), msg);
  }
  const resolved = resolveVersionRef(store, spec_id, version);
  if (!resolved.ok) return toErrorResult(resolved);

  store.setActive(spec_id, resolved.version.version_id);
  const payload = {
    ok: true as const,
    spec_id,
    active_version_id: resolved.version.version_id,
    version_label: resolved.version.version_label,
  };
  const summary = `Activated ${spec_id} ${formatVersionHandle(resolved.version, store.listVersions(spec_id))}.`;
  return toCallToolResult(payload, summary);
}

export const activateVersionTool: ToolModule = {
  name: "activate_version",
  title: "Activate version",
  description: "Set the active version for a spec (the manual cutover lever).",
  inputSchema: activateVersionInputSchema,
  handler: handle,
};
