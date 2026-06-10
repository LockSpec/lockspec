import type { ToolModule, ToolDeps } from "./index.js";
import { diffVersionsInputSchema } from "../schemas/diff_versions.js";
import { fail, toCallToolResult, toErrorResult, snapshotMissing } from "./result.js";
import { resolveTarget, formatVersionHandle } from "../core/resolver.js";
import { diffOperations, classifyDiff, classifyTypes, diffTypes, type DiffSummary, type VersionSide } from "../core/differ.js";

function handle(args: unknown, { store }: ToolDeps) {
  const parsed = diffVersionsInputSchema.safeParse(args);
  if (!parsed.success) {
    const msg = "Invalid input for diff_versions — check from/to {spec_id?, version} and scope/include_descriptions.";
    return toCallToolResult(fail("invalid_input", msg), msg);
  }

  const { from, to, scope = "all", include_descriptions = false } = parsed.data;

  // Resolve both sides independently. `version` is schema-required → always the
  // explicit branch, so the resolve mode is behaviorally inert here; pass
  // "lenient" (a comparison tool, not write-adjacent) to satisfy the signature.
  const fromRes = resolveTarget(store, { spec_id: from.spec_id, version: from.version }, "lenient");
  if (!fromRes.ok) return toErrorResult(fromRes);

  const toRes = resolveTarget(store, { spec_id: to.spec_id, version: to.version }, "lenient");
  if (!toRes.ok) return toErrorResult(toRes);

  const fromVersion = fromRes.version;
  const toVersion = toRes.version;

  // Build label-first handles for the summary string. Both from+to are the same
  // spec (the common case and what the summary format implies), so one sibling
  // set suffices — no redundant second listVersions call.
  const siblings = store.listVersions(fromRes.spec_id);
  const fromHandle = formatVersionHandle(fromVersion, siblings);
  const toHandle = formatVersionHandle(toVersion, siblings);

  // Same content_hash → empty diff (identical content). Mirror the slow-path's
  // scope gating so both paths emit the same output shape for a given scope.
  if (fromVersion.content_hash === toVersion.content_hash) {
    const empty: Record<string, unknown> = {
      ok: true,
      from: { spec_id: fromRes.spec_id, version_id: fromVersion.version_id, version_label: fromVersion.version_label },
      to: { spec_id: toRes.spec_id, version_id: toVersion.version_id, version_label: toVersion.version_label },
    };
    if (scope !== "types") {
      empty.operations = { added: [], removed: [], changed: [] };
      empty.summary = { breaking: 0, non_breaking: 0, unknown: 0 };
    }
    if (scope !== "operations") {
      empty.types = { added: [], removed: [], changed: [] };
    }
    return toCallToolResult(empty, `empty diff — ${fromRes.spec_id} ${fromHandle} identical to ${toHandle}`);
  }

  const fromDoc = store.loadSnapshot(fromVersion.content_hash);
  if (fromDoc === undefined) return snapshotMissing(fromRes.spec_id, fromVersion.version_id);
  const toDoc = store.loadSnapshot(toVersion.content_hash);
  if (toDoc === undefined) return snapshotMissing(toRes.spec_id, toVersion.version_id);

  const needOps = scope !== "types";
  const needTypes = scope !== "operations";
  const fromSide: VersionSide = {
    doc: fromDoc,
    operations: needOps ? store.getOperations(fromRes.spec_id, fromVersion.version_id) : [],
    typeDefs: needTypes ? store.getTypeDefs(fromRes.spec_id, fromVersion.version_id) : [],
  };
  const toSide: VersionSide = {
    doc: toDoc,
    operations: needOps ? store.getOperations(toRes.spec_id, toVersion.version_id) : [],
    typeDefs: needTypes ? store.getTypeDefs(toRes.spec_id, toVersion.version_id) : [],
  };

  const opts = { includeDescriptions: include_descriptions };

  const payload: Record<string, unknown> = {
    ok: true,
    from: { spec_id: fromRes.spec_id, version_id: fromVersion.version_id, version_label: fromVersion.version_label },
    to: { spec_id: toRes.spec_id, version_id: toVersion.version_id, version_label: toVersion.version_label },
  };

  // The summary folds in whatever is in scope: operations always, the types
  // dimension when types are also in scope (scope:'all'). A types-only scope keeps
  // the long-standing no-summary contract — the per-change classifications stand in.
  let summary: DiffSummary | undefined;
  if (scope !== "types") {
    const classified = classifyDiff(diffOperations(fromSide, toSide, opts));
    payload.operations = { added: classified.added, removed: classified.removed, changed: classified.changed };
    summary = classified.summary;
  }

  if (scope !== "operations") {
    const classifiedTypes = classifyTypes(diffTypes(fromSide, toSide, opts));
    payload.types = { added: classifiedTypes.added, removed: classifiedTypes.removed, changed: classifiedTypes.changed };
    if (summary) {
      summary = {
        breaking: summary.breaking + classifiedTypes.summary.breaking,
        non_breaking: summary.non_breaking + classifiedTypes.summary.non_breaking,
        unknown: summary.unknown + classifiedTypes.summary.unknown,
      };
    }
  }

  if (summary) payload.summary = summary;
  const breakingCount = summary?.breaking ?? 0;

  const summaryLine =
    scope === "types"
      ? `types diff — ${fromRes.spec_id} ${fromHandle} → ${toHandle}`
      : `${breakingCount} breaking change(s) — ${fromRes.spec_id} ${fromHandle} → ${toHandle}`;
  return toCallToolResult(payload, summaryLine);
}

export const diffVersionsTool: ToolModule = {
  name: "diff_versions",
  title: "Diff versions",
  description:
    "Structural diff of two spec versions with breaking/non-breaking classification. " +
    "Resolves `from`/`to` {spec_id?, version} refs, compares normalized " +
    "snapshots, and returns added/removed/changed operations each with per-change " +
    "classification ('breaking'|'non_breaking'|'unknown'), a types dimension " +
    "(added/removed component-schema names + per-changed-type itemized, classified field changes), " +
    "and a summary of counts that folds in the types dimension (scope:'all'). " +
    "NOTE: with scope:'operations' the summary is operation-only; scope:'types' returns the classified " +
    "type changes but no summary. " +
    "Use scope:'operations' or 'types' to narrow the output; include_descriptions:true " +
    "to surface doc-only changes (summary/description edits) that are hidden by default.",
  inputSchema: diffVersionsInputSchema,
  handler: handle,
};
