import type { Operation, SpecVersion, Store } from "../store/store.js";

/** Return the label-first display handle for a version in the context of its
 *  spec's currently-loaded versions. Shows version_label only when it uniquely
 *  identifies the version within loadedSiblings — which is the exact condition
 *  under which the label round-trips through resolveVersionRef as valid input
 *  (shared matchVersion predicate). loadedSiblings must include version itself. */
export function formatVersionHandle(version: SpecVersion, loadedSiblings: SpecVersion[]): string {
  if (version.version_label !== null && matchVersion(loadedSiblings, version.version_label).length === 1) {
    return version.version_label;
  }
  return version.version_id;
}

/** Filter versions by label — the single source of "label matches" truth shared
 *  by formatVersionHandle and resolveVersionRef. */
function matchVersion(versions: SpecVersion[], label: string): SpecVersion[] {
  return versions.filter((v) => v.version_label === label);
}

export type VersionRefResult =
  | { ok: true; version: SpecVersion }
  | { ok: false; code: "not_found" | "ambiguous"; message: string };

/** Resolution policy when a spec has >1 loaded version and `version` is omitted.
 *  `strict` (write-adjacent tools) → `ambiguous` + loaded_versions, never guess;
 *  `lenient` (read discovery) → active + a version_warning. With one loaded
 *  version, or an explicit `version`, the two behave identically. */
export type ResolveMode = "strict" | "lenient";

/** A loaded version offered to the agent in an ambiguous error (strict) or named
 *  in a version_warning (lenient). Minimal & pickable — no content_hash (not
 *  actionable for picking; omitted to respect the context budget). */
export interface LoadedVersion {
  /** Pass this back as `version` to pin the call. */
  version_id: string;
  /** Human hint; non-unique metadata, never identity. */
  version_label: string | null;
  active: boolean;
}

/** Resolution outcome for the read tools. Codes are a subset of ErrorCode,
 *  mapped straight through by the caller. `version_warning` is present only on a
 *  lenient multi-version success; `details.loaded_versions` only on a strict
 *  multi-version ambiguity. */
export type ResolveResult =
  | { ok: true; spec_id: string; version: SpecVersion; version_warning?: string }
  | {
      ok: false;
      code: "not_found" | "ambiguous";
      message: string;
      details?: { loaded_versions: LoadedVersion[] };
    };

export function resolveTarget(
  store: Store,
  ref: { spec_id?: string; version?: string },
  mode: ResolveMode,
): ResolveResult {
  let spec_id: string;
  if (ref.spec_id != null) {
    if (!store.getSpec(ref.spec_id)) {
      return { ok: false, code: "not_found", message: `No spec ${JSON.stringify(ref.spec_id)} is loaded.` };
    }
    spec_id = ref.spec_id;
  } else {
    const specs = store.listSpecs();
    if (specs.length === 0) {
      return { ok: false, code: "not_found", message: "No specs loaded — load one with load_spec first." };
    }
    if (specs.length > 1) {
      const candidates = specs.map((s) => s.spec_id).sort().join(", ");
      return {
        ok: false,
        code: "ambiguous",
        message: `Multiple specs loaded (${candidates}) — pass spec_id to choose one.`,
      };
    }
    spec_id = specs[0]!.spec_id;
  }

  if (ref.version != null) {
    const resolved = resolveVersionRef(store, spec_id, ref.version);
    return resolved.ok ? { ok: true, spec_id, version: resolved.version } : resolved;
  }

  // version omitted → active. Nothing active = nothing to default to (an
  // activate:false load, or the active version was removed).
  const active = store.getActiveVersion(spec_id);
  if (!active) {
    return {
      ok: false,
      code: "not_found",
      message: `Spec ${JSON.stringify(spec_id)} has no active version — pass an explicit version (version_id or version_label).`,
    };
  }

  // >1 loaded + omitted: ambiguous. Sorted for determinism — listVersions order
  // is store-defined (mirrors the spec-ambiguous case above).
  const loaded = store.listVersions(spec_id);
  if (loaded.length > 1) {
    const sorted = [...loaded].sort((a, b) => a.version_id.localeCompare(b.version_id));
    const candidates = sorted.map<LoadedVersion>((v) => ({
      version_id: v.version_id,
      version_label: v.version_label,
      active: v.version_id === active.version_id,
    }));
    const handles = sorted.map((v) => formatVersionHandle(v, loaded)).join(", ");
    if (mode === "strict") {
      return {
        ok: false,
        code: "ambiguous",
        message: `Spec ${JSON.stringify(spec_id)} has ${loaded.length} loaded versions (${handles}) — pass version (version_id or version_label) to choose one.`,
        details: { loaded_versions: candidates },
      };
    }
    return {
      ok: true,
      spec_id,
      version: active,
      version_warning: `${loaded.length} versions of ${JSON.stringify(spec_id)} are loaded (${handles}); used ${formatVersionHandle(active, loaded)} (active). Pass version to query another.`,
    };
  }

  return { ok: true, spec_id, version: active };
}

export type LocateResult =
  | { ok: true; operation: Operation }
  | { ok: false; code: "not_found" | "ambiguous"; message: string };

/**
 * Locate one operation by `operation_key` (PK-unique) or `operation_id` (should be
 * unique but specs lie → `ambiguous`, listing candidate keys). Exactly one of the
 * two is set (the caller's XOR-refined schema guarantees it). Shared by
 * get_signature and validate_call.
 */
export function locateOperation(
  ops: Operation[],
  input: { operation_id?: string; operation_key?: string },
): LocateResult {
  if (input.operation_key != null) {
    const match = ops.find((o) => o.operation_key === input.operation_key);
    return match
      ? { ok: true, operation: match }
      : { ok: false, code: "not_found", message: `No operation ${JSON.stringify(input.operation_key)} in this version.` };
  }
  const byId = ops.filter((o) => o.operation_id === input.operation_id);
  if (byId.length === 0) {
    return { ok: false, code: "not_found", message: `No operation with operationId ${JSON.stringify(input.operation_id)} in this version.` };
  }
  if (byId.length > 1) {
    const keys = byId.map((o) => o.operation_key).join(", ");
    return {
      ok: false,
      code: "ambiguous",
      message: `operationId ${JSON.stringify(input.operation_id)} is non-unique — matches: ${keys}. Pass operation_key instead.`,
    };
  }
  return { ok: true, operation: byId[0]! };
}

/**
 * Resolve `ref` against `spec_id`: a `version_id` wins outright (id first),
 * else match by `version_label` (non-unique metadata — may be ambiguous).
 * The spec is assumed to exist; the caller checks that and maps its own not_found.
 */
export function resolveVersionRef(store: Store, spec_id: string, ref: string): VersionRefResult {
  const byId = store.getVersion(spec_id, ref);
  if (byId) return { ok: true, version: byId };

  const byLabel = matchVersion(store.listVersions(spec_id), ref);
  if (byLabel.length === 1) return { ok: true, version: byLabel[0]! };
  if (byLabel.length === 0) {
    return {
      ok: false,
      code: "not_found",
      message: `No version ${JSON.stringify(ref)} in spec ${JSON.stringify(spec_id)} (matched as neither version_id nor version_label).`,
    };
  }
  const candidates = byLabel.map((v) => v.version_id).join(", ");
  return {
    ok: false,
    code: "ambiguous",
    message: `version_label ${JSON.stringify(ref)} is ambiguous in spec ${JSON.stringify(spec_id)} — matches version_ids: ${candidates}. Pass a version_id.`,
  };
}
