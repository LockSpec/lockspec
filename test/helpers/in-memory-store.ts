import type {
  NormalizedDoc,
  Operation,
  OperationSearchHit,
  PutVersionInput,
  Spec,
  SpecVersion,
  Store,
  TypeDef,
} from "../../src/store/store.js";

// Persistence semantics only — no resolution/ranking (those compose over the Store
// in core).

function rowKey(spec_id: string, version_id: string): string {
  return `${spec_id} ${version_id}`;
}

export class InMemoryStore implements Store {
  private readonly specs = new Map<string, Spec>();
  private readonly versions = new Map<string, Map<string, SpecVersion>>();
  private readonly operations = new Map<string, Operation[]>();
  private readonly typeDefs = new Map<string, TypeDef[]>();
  private readonly snapshots = new Map<string, NormalizedDoc>();

  // Deterministic monotonic clock so created_at/updated_at are stable across runs.
  private clock = 0;
  private now(): string {
    return new Date(this.clock++).toISOString();
  }

  getSpec(spec_id: string): Spec | undefined {
    return this.specs.get(spec_id);
  }

  listSpecs(): Spec[] {
    return [...this.specs.values()];
  }

  putVersion(input: PutVersionInput): SpecVersion {
    const { spec, version, operations, typeDefs } = input;

    // Dedup by content_hash within the spec_id (the load_spec no-op path).
    const existing = this.getVersionByHash(spec.spec_id, version.content_hash);
    if (existing) return existing;

    // Create the Spec on first sight.
    if (!this.specs.has(spec.spec_id)) {
      const ts = this.now();
      this.specs.set(spec.spec_id, {
        spec_id: spec.spec_id,
        label: spec.label,
        active_version_id: null,
        created_at: ts,
        updated_at: ts,
      });
      this.versions.set(spec.spec_id, new Map());
    }

    const created: SpecVersion = {
      version_id: version.version_id,
      spec_id: spec.spec_id,
      content_hash: version.content_hash,
      version_label: version.version_label,
      spec_format: version.spec_format,
      format_version: version.format_version,
      provenance: version.provenance,
      created_at: this.now(),
    };

    this.versions.get(spec.spec_id)!.set(created.version_id, created);
    this.operations.set(rowKey(spec.spec_id, created.version_id), [...operations]);
    this.typeDefs.set(rowKey(spec.spec_id, created.version_id), [...typeDefs]);

    const specRow = this.specs.get(spec.spec_id)!;
    specRow.updated_at = this.now();

    return created;
  }

  reindexVersion(
    spec_id: string,
    version_id: string,
    operations: Operation[],
    typeDefs: TypeDef[],
  ): void {
    // Replace the version's index rows in place (the load_spec backfill path). No
    // FTS — that's a LocalStore-internal detail; the fake honors the behavioral
    // contract via getOperations/getTypeDefs.
    this.operations.set(rowKey(spec_id, version_id), [...operations]);
    this.typeDefs.set(rowKey(spec_id, version_id), [...typeDefs]);
  }

  getVersion(spec_id: string, version_id: string): SpecVersion | undefined {
    return this.versions.get(spec_id)?.get(version_id);
  }

  getVersionByHash(spec_id: string, content_hash: string): SpecVersion | undefined {
    const byVersion = this.versions.get(spec_id);
    if (!byVersion) return undefined;
    for (const v of byVersion.values()) {
      if (v.content_hash === content_hash) return v;
    }
    return undefined;
  }

  listVersions(spec_id: string): SpecVersion[] {
    const byVersion = this.versions.get(spec_id);
    return byVersion ? [...byVersion.values()] : [];
  }

  getActiveVersion(spec_id: string): SpecVersion | undefined {
    const active = this.specs.get(spec_id)?.active_version_id;
    return active ? this.getVersion(spec_id, active) : undefined;
  }

  setActive(spec_id: string, version_id: string): void {
    const specRow = this.specs.get(spec_id);
    if (!specRow) return;
    specRow.active_version_id = version_id;
    specRow.updated_at = this.now();
  }

  writeSnapshot(content_hash: string, doc: NormalizedDoc): void {
    // Content-addressed: identical hash ⇒ identical bytes, so writing an
    // already-present hash is a no-op (never overwrite).
    if (!this.snapshots.has(content_hash)) {
      this.snapshots.set(content_hash, doc);
    }
  }

  loadSnapshot(content_hash: string): NormalizedDoc | undefined {
    return this.snapshots.get(content_hash);
  }

  getOperations(spec_id: string, version_id: string): Operation[] {
    return this.operations.get(rowKey(spec_id, version_id)) ?? [];
  }

  getTypeDefs(spec_id: string, version_id: string): TypeDef[] {
    return this.typeDefs.get(rowKey(spec_id, version_id)) ?? [];
  }

  searchOps(spec_id: string, version_id: string, query: string): OperationSearchHit[] {
    // A plausible candidate set, NOT a BM25 approximation: any op in this version
    // sharing ≥1 query token, scored by distinct-token overlap. Honest fake —
    // core/search tests assert membership/count/tier here, never score-order
    // (BM25 ranking quality is tested against the real LocalStore).
    const qTokens = new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    if (qTokens.size === 0) return [];
    const hits: OperationSearchHit[] = [];
    for (const op of this.getOperations(spec_id, version_id)) {
      const text = [op.operation_id, op.openapi?.path, op.summary, op.description, ...op.tags]
        .filter((s): s is string => typeof s === "string")
        .join(" ")
        .toLowerCase();
      const opTokens = new Set(text.match(/[a-z0-9]+/g) ?? []);
      let overlap = 0;
      for (const t of qTokens) if (opTokens.has(t)) overlap++;
      if (overlap > 0) hits.push({ operation_key: op.operation_key, score: overlap });
    }
    hits.sort((a, b) => b.score - a.score || a.operation_key.localeCompare(b.operation_key));
    return hits;
  }

  removeVersion(spec_id: string, version_id: string): void {
    // Capture the hash before the row goes; GC the snapshot after (mirrors
    // LocalStore — global ref-count, no-op on an absent snapshot).
    const hash = this.getVersion(spec_id, version_id)?.content_hash;
    this.versions.get(spec_id)?.delete(version_id);
    this.operations.delete(rowKey(spec_id, version_id));
    this.typeDefs.delete(rowKey(spec_id, version_id));
    const specRow = this.specs.get(spec_id);
    if (specRow?.active_version_id === version_id) {
      specRow.active_version_id = null;
      specRow.updated_at = this.now();
    }
    if (hash) this.gcSnapshot(hash);
  }

  removeSpec(spec_id: string): void {
    const hashes = new Set(this.listVersions(spec_id).map((v) => v.content_hash));
    for (const version_id of this.versions.get(spec_id)?.keys() ?? []) {
      this.operations.delete(rowKey(spec_id, version_id));
      this.typeDefs.delete(rowKey(spec_id, version_id));
    }
    this.versions.delete(spec_id);
    this.specs.delete(spec_id);
    for (const hash of hashes) this.gcSnapshot(hash);
  }

  // Global ref-count GC, mirroring LocalStore: delete the snapshot only when no
  // remaining version anywhere references the hash. Map.delete no-ops if absent.
  private gcSnapshot(content_hash: string): void {
    for (const byVersion of this.versions.values()) {
      for (const v of byVersion.values()) {
        if (v.content_hash === content_hash) return;
      }
    }
    this.snapshots.delete(content_hash);
  }

  close(): void {
    // No resources to release for the in-memory fake.
  }
}
