import type { ToolDeps, ToolModule } from "./index.js";
import { findTypeInputSchema } from "../schemas/find_type.js";
import { fail, toCallToolResult, toErrorResult } from "./result.js";
import { resolveTarget } from "../core/resolver.js";
import { searchTypes } from "../core/search.js";

function handle(args: unknown, deps: ToolDeps) {
  const parsed = findTypeInputSchema.safeParse(args);
  if (!parsed.success) {
    return toCallToolResult(fail("invalid_input", "Invalid find_type input."), "Invalid find_type input.");
  }
  const { store } = deps;
  const input = parsed.data;

  const resolved = resolveTarget(store, { spec_id: input.spec_id, version: input.version }, "lenient");
  if (!resolved.ok) return toErrorResult(resolved);

  const { spec_id, version } = resolved;
  const { results, truncated } = searchTypes(
    store,
    { spec_id, version_id: version.version_id },
    { query: input.query, limit: input.limit },
  );

  const payload = {
    ok: true as const,
    spec_id,
    version_id: version.version_id,
    results,
    truncated,
    // Lenient resolution: present only when >1 version is loaded and `version`
    // was omitted — names the version used + the others. Absent
    // otherwise (never version_warning:undefined).
    ...(resolved.version_warning ? { version_warning: resolved.version_warning } : {}),
  };
  const summary = `Found ${results.length} type${results.length === 1 ? "" : "s"} for ${JSON.stringify(input.query)} in ${spec_id}${truncated ? " (truncated)" : ""}.`;
  return toCallToolResult(payload, summary);
}

export const findTypeTool: ToolModule = {
  name: "find_type",
  title: "Find type",
  description: "Lexical/structured search over named schemas/components; compact ranked rows.",
  inputSchema: findTypeInputSchema,
  handler: handle,
};
