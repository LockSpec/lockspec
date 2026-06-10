import type { ToolDeps, ToolModule } from "./index.js";
import { removeSpecInputSchema } from "../schemas/remove_spec.js";
import { fail, toCallToolResult, toErrorResult } from "./result.js";
import { resolveVersionRef, formatVersionHandle } from "../core/resolver.js";

function handle(args: unknown, deps: ToolDeps) {
  const parsed = removeSpecInputSchema.safeParse(args);
  if (!parsed.success) {
    const msg = "Invalid remove_spec input (confirm must be literally true).";
    return toCallToolResult(fail("invalid_input", msg), msg);
  }
  const { store } = deps;
  const { spec_id, version } = parsed.data;

  const spec = store.getSpec(spec_id);
  if (!spec) {
    const msg = `No spec ${JSON.stringify(spec_id)} is loaded.`;
    return toCallToolResult(fail("not_found", msg), msg);
  }

  // Candidate hashes captured BEFORE removal (the Store GCs them; we then report
  // which are gone via loadSnapshot — works for shared and unshared snapshots).
  let scope: "version" | "spec";
  let removedVersionIds: string[];
  let candidateHashes: string[];

  if (version != null) {
    const resolved = resolveVersionRef(store, spec_id, version);
    if (!resolved.ok) return toErrorResult(resolved);
    if (resolved.version.version_id === spec.active_version_id) {
      const handle = formatVersionHandle(resolved.version, store.listVersions(spec_id));
      const msg =
        `Version ${JSON.stringify(handle)} is the active version of ${JSON.stringify(spec_id)}. ` +
        `Activate another version first (activate_version), or omit \`version\` to remove the whole spec.`;
      return toCallToolResult(fail("invalid_input", msg), msg);
    }
    candidateHashes = [resolved.version.content_hash];
    removedVersionIds = [resolved.version.version_id];
    store.removeVersion(spec_id, resolved.version.version_id);
    scope = "version";
  } else {
    const versions = store.listVersions(spec_id);
    candidateHashes = [...new Set(versions.map((v) => v.content_hash))];
    removedVersionIds = versions.map((v) => v.version_id);
    store.removeSpec(spec_id);
    scope = "spec";
  }

  const snapshots_deleted = candidateHashes.filter((h) => store.loadSnapshot(h) === undefined);
  const remaining_versions = store.listVersions(spec_id).map((v) => v.version_id);
  const payload = {
    ok: true as const,
    removed: { spec_id, scope, version_ids: removedVersionIds, snapshots_deleted },
    remaining_versions,
  };
  const summary =
    scope === "spec"
      ? `Removed spec ${spec_id} (${removedVersionIds.length} version(s), ${snapshots_deleted.length} snapshot(s) reclaimed).`
      : `Removed version ${removedVersionIds[0]} from ${spec_id}.`;
  return toCallToolResult(payload, summary);
}

export const removeSpecTool: ToolModule = {
  name: "remove_spec",
  title: "Remove spec",
  description: "Remove a spec version (or the whole spec); requires confirm:true.",
  inputSchema: removeSpecInputSchema,
  handler: handle,
};
