import type { ToolDeps, ToolModule } from "./index.js";
import { findEndpointInputSchema } from "../schemas/find_endpoint.js";
import { fail, toCallToolResult, toErrorResult } from "./result.js";
import { resolveTarget } from "../core/resolver.js";
import { searchEndpoints } from "../core/search.js";

function handle(args: unknown, deps: ToolDeps) {
  const parsed = findEndpointInputSchema.safeParse(args);
  if (!parsed.success) {
    return toCallToolResult(fail("invalid_input", "Invalid find_endpoint input."), "Invalid find_endpoint input.");
  }
  const { store } = deps;
  const input = parsed.data;

  const resolved = resolveTarget(store, { spec_id: input.spec_id, version: input.version }, "lenient");
  if (!resolved.ok) return toErrorResult(resolved);

  const { spec_id, version } = resolved;
  const { results, truncated } = searchEndpoints(
    store,
    { spec_id, version_id: version.version_id },
    {
      query: input.query,
      method: input.method,
      tag: input.tag,
      includeDeprecated: input.include_deprecated,
      limit: input.limit,
    },
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
  const summary = `Found ${results.length} operation${results.length === 1 ? "" : "s"} for ${JSON.stringify(input.query)} in ${spec_id}${truncated ? " (truncated)" : ""}.`;
  return toCallToolResult(payload, summary);
}

export const findEndpointTool: ToolModule = {
  name: "find_endpoint",
  title: "Find endpoint",
  description: "Lexical/structured search for operations; returns compact ranked rows.",
  inputSchema: findEndpointInputSchema,
  handler: handle,
};
