export type SourceType = "file" | "url" | "inline";

export interface Provenance {
  source_type: SourceType;
  /** Absent for inline sources. */
  source_uri: string | null;
  /** ISO-8601 timestamp. */
  fetched_at: string;
  original_byte_size: number;
  /** Resolved external $ref URIs bundled at load time. Empty for specs with no
   *  external refs. Persisted so provenance is self-contained after load. */
  external_sources: string[];
}

export interface Spec {
  /** Stable slug, e.g. `billing-api`. */
  spec_id: string;
  label: string;
  /** Exactly one active at a time; null when none is active yet. */
  active_version_id: string | null;
  /** ISO-8601. */
  created_at: string;
  /** ISO-8601. */
  updated_at: string;
}

/**
 * Source contract format of a SpecVersion. One member in v1 (OpenAPI only);
 * extended when GraphQL/Protobuf land — the field keeps the normalized model
 * format-neutral.
 */
export type SpecFormat = "openapi";

/** An immutable normalized snapshot of a spec at a point in time. */
export interface SpecVersion {
  version_id: string;
  spec_id: string;
  /**
   * sha256 of the normalized spec bytes — the canonical identity. Bare hex
   * digest; the `sha256:` prefix in tool outputs is added at the tool layer.
   * Unique within a spec_id.
   */
  content_hash: string;
  /** Non-unique metadata; default from `info.version`. Never identity. */
  version_label: string | null;
  spec_format: SpecFormat;
  /** Dialect within the format, e.g. `3.0.3`/`3.1.0` for OpenAPI. */
  format_version: string;
  provenance: Provenance;
  /** ISO-8601. */
  created_at: string;
}

/** JSON-Pointers into the normalized snapshot for an operation's sub-shapes. */
export interface OperationPointers {
  params: string;
  requestBody: string;
  responses: string;
}

/**
 * OpenAPI/HTTP-specific operation detail. Present when `spec_format` is
 * `"openapi"`; future formats add their own tagged binding.
 */
export interface OpenApiOperationBinding {
  method: string;
  path: string;
  pointers: OperationPointers;
}

/** An indexed API operation. Top-level fields are format-neutral; format-specific
 *  detail lives in a tagged binding. */
export interface Operation {
  spec_id: string;
  version_id: string;
  /**
   * Stable, unique identity within a version. For OpenAPI: `${method}:${path}`,
   * e.g. `POST:/v1/invoices`.
   */
  operation_key: string;
  /** Format-provided stable id; may be absent. */
  operation_id: string | null;
  summary?: string | null;
  description?: string | null;
  tags: string[];
  deprecated: boolean;
  /** Set for `spec_format === "openapi"`. */
  openapi?: OpenApiOperationBinding;
}

export interface OperationSearchHit {
  operation_key: string;
  score: number;
}

export interface TypeDef {
  spec_id: string;
  version_id: string;
  name: string;
  /** e.g. `object`, `enum` — kept free-form (not enumerated) in v1. */
  kind: string;
  /** JSON-Pointer into the normalized JSON snapshot. */
  pointer: string;
}

/**
 * A normalized contract document (JSON) — the snapshot persisted content-addressed
 * by hash. Bundled (external $refs internalized) with internal $refs preserved as
 * pointers; ref expansion + `{$circular}` cycle tagging happen at query time in
 * get_signature, keeping the snapshot bounded.
 */
export type NormalizedDoc = unknown;

export interface PutVersionInput {
  spec: {
    spec_id: string;
    label: string;
  };
  version: {
    version_id: string;
    content_hash: string;
    version_label: string | null;
    spec_format: SpecFormat;
    format_version: string;
    provenance: Provenance;
  };
  operations: Operation[];
  typeDefs: TypeDef[];
}

/** The persistence boundary. Provides persistence + the raw FTS-query primitive
 *  (`searchOps`). Resolution (core/resolver) and ranking (core/search) compose
 *  over it but are not part of this interface. */
export interface Store {
  getSpec(spec_id: string): Spec | undefined;
  listSpecs(): Spec[];

  /**
   * Atomic ingest: create the Spec if new, create the SpecVersion, and persist
   * its Operation[] + TypeDef[] index rows. Dedups by content_hash within a
   * spec_id — on a hash hit, returns the existing version unchanged. Does NOT
   * write the snapshot (see writeSnapshot).
   */
  putVersion(input: PutVersionInput): SpecVersion;

  /**
   * Replace an existing version's index rows in place — the reload-backfill path:
   * a version persisted with an empty/stale index gets re-indexed without creating
   * a new version or touching the active pointer.
   */
  reindexVersion(
    spec_id: string,
    version_id: string,
    operations: Operation[],
    typeDefs: TypeDef[],
  ): void;

  getVersion(spec_id: string, version_id: string): SpecVersion | undefined;
  /** load_spec's no-op short-circuit: skip extraction on a known hash. */
  getVersionByHash(spec_id: string, content_hash: string): SpecVersion | undefined;
  listVersions(spec_id: string): SpecVersion[];
  getActiveVersion(spec_id: string): SpecVersion | undefined;
  setActive(spec_id: string, version_id: string): void;

  /** Idempotent write-if-absent, keyed by content_hash (dedup). */
  writeSnapshot(content_hash: string, doc: NormalizedDoc): void;
  loadSnapshot(content_hash: string): NormalizedDoc | undefined;

  getOperations(spec_id: string, version_id: string): Operation[];
  getTypeDefs(spec_id: string, version_id: string): TypeDef[];

  /**
   * Raw lexical-search primitive over the operations index, scoped to one version.
   * Returns FTS hits with a relevance `score` (higher = better); an empty/no-match
   * query yields `[]`. Tier-merging + ranking across exact/prefix/fuzzy lives in
   * core/search. LocalStore backs it with FTS5/bm25.
   */
  searchOps(spec_id: string, version_id: string, query: string): OperationSearchHit[];

  // Each impl GCs the content-addressed snapshot on last dereference as an internal
  // side effect. Observable via loadSnapshot returning undefined.
  removeVersion(spec_id: string, version_id: string): void;
  removeSpec(spec_id: string): void;

  close(): void;
}
