import type { ToolModule, ToolDeps } from "./index.js";
import { diffVersionsInputSchema } from "../schemas/diff_versions.js";
import { fail, toCallToolResult, toErrorResult, snapshotMissing } from "./result.js";
import { resolveTarget, formatVersionHandle } from "../core/resolver.js";
import { diffOperations, classifyDiff, diffTypes, type VersionSide } from "../core/differ.js";

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

  // Same content_hash → empty diff (identical content).
  if (fromVersion.content_hash === toVersion.content_hash) {
    const empty = {
      ok: true as const,
      from: { spec_id: fromRes.spec_id, version_id: fromVersion.version_id, version_label: fromVersion.version_label },
      to: { spec_id: toRes.spec_id, version_id: toVersion.version_id, version_label: toVersion.version_label },
      operations: { added: [], removed: [], changed: [] },
      types: { added: [], removed: [], changed: [] },
      summary: { breaking: 0, non_breaking: 0, unknown: 0 },
    };
    return toCallToolResult(empty, `empty diff — ${fromRes.spec_id} ${fromHandle} identical to ${toHandle}`);
  }

  const fromDoc = store.loadSnapshot(fromVersion.content_hash);
  if (fromDoc === undefined) return snapshotMissing(fromRes.spec_id, fromVersion.version_id);
  const toDoc = store.loadSnapshot(toVersion.content_hash);
  if (toDoc === undefined) return snapshotMissing(toRes.spec_id, toVersion.version_id);

  const fromSide: VersionSide = {
    doc: fromDoc,
    operations: store.getOperations(fromRes.spec_id, fromVersion.version_id),
    typeDefs: store.getTypeDefs(fromRes.spec_id, fromVersion.version_id),
  };
  const toSide: VersionSide = {
    doc: toDoc,
    operations: store.getOperations(toRes.spec_id, toVersion.version_id),
    typeDefs: store.getTypeDefs(toRes.spec_id, toVersion.version_id),
  };

  const opts = { includeDescriptions: include_descriptions };

  const payload: Record<string, unknown> = {
    ok: true,
    from: { spec_id: fromRes.spec_id, version_id: fromVersion.version_id, version_label: fromVersion.version_label },
    to: { spec_id: toRes.spec_id, version_id: toVersion.version_id, version_label: toVersion.version_label },
  };

  let breakingCount = 0;
  if (scope !== "types") {
    const opsDiff = diffOperations(fromSide, toSide, opts);
    const classified = classifyDiff(opsDiff);
    payload.operations = { added: classified.added, removed: classified.removed, changed: classified.changed };
    payload.summary = classified.summary;
    breakingCount = classified.summary.breaking;
  }

  if (scope !== "operations") {
    payload.types = diffTypes(fromSide, toSide, opts);
  }

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
    "(added/removed/changed component schemas, flag-only), and a summary of counts. " +
    "NOTE: summary counts operation-level changes only — read types.added/removed/changed " +
    "alongside summary to assess full impact (type changes are not yet classified). " +
    "Use scope:'operations' or 'types' to narrow the output; include_descriptions:true " +
    "to surface doc-only changes (summary/description edits) that are hidden by default.",
  inputSchema: diffVersionsInputSchema,
  handler: handle,
};
