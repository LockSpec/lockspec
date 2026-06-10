import Database from "better-sqlite3";
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  NormalizedDoc,
  Operation,
  OperationSearchHit,
  PutVersionInput,
  Spec,
  SpecFormat,
  SpecVersion,
  Store,
  TypeDef,
} from "./store.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS specs (
  spec_id           TEXT PRIMARY KEY,
  label             TEXT NOT NULL,
  active_version_id TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spec_versions (
  version_id     TEXT PRIMARY KEY,
  spec_id        TEXT NOT NULL REFERENCES specs(spec_id),
  content_hash   TEXT NOT NULL,
  version_label  TEXT,
  spec_format    TEXT NOT NULL,
  format_version TEXT NOT NULL,
  provenance     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE (spec_id, content_hash)
);
CREATE TABLE IF NOT EXISTS operations (
  spec_id       TEXT NOT NULL,
  version_id    TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  operation_id  TEXT,
  summary       TEXT,
  description   TEXT,
  tags          TEXT NOT NULL,
  deprecated    INTEGER NOT NULL,
  openapi       TEXT,
  PRIMARY KEY (spec_id, version_id, operation_key)
);
CREATE TABLE IF NOT EXISTS typedefs (
  spec_id     TEXT NOT NULL,
  version_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  pointer     TEXT NOT NULL,
  description TEXT,
  PRIMARY KEY (spec_id, version_id, name)
);
-- FTS5 index over operations for find_endpoint's BM25 pass.
-- Indexed columns carry searchable text; identity columns are UNINDEXED so a
-- MATCH hit can resolve back to the operation row without a join.
-- Tokenizer: unicode61, diacritics folded.
CREATE VIRTUAL TABLE IF NOT EXISTS operations_fts USING fts5(
  operation_id, path, summary, description, tags,
  spec_id UNINDEXED, version_id UNINDEXED, operation_key UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

interface SpecRow {
  spec_id: string;
  label: string;
  active_version_id: string | null;
  created_at: string;
  updated_at: string;
}
interface VersionRow {
  version_id: string;
  spec_id: string;
  content_hash: string;
  version_label: string | null;
  spec_format: string;
  format_version: string;
  provenance: string;
  created_at: string;
}
interface OpRow {
  spec_id: string;
  version_id: string;
  operation_key: string;
  operation_id: string | null;
  summary: string | null;
  description: string | null;
  tags: string;
  deprecated: number;
  openapi: string | null;
}
interface TdRow {
  spec_id: string;
  version_id: string;
  name: string;
  kind: string;
  pointer: string;
  description: string | null;
}

function toSpec(r: SpecRow): Spec {
  return {
    spec_id: r.spec_id,
    label: r.label,
    active_version_id: r.active_version_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}
function toVersion(r: VersionRow): SpecVersion {
  return {
    version_id: r.version_id,
    spec_id: r.spec_id,
    content_hash: r.content_hash,
    version_label: r.version_label,
    spec_format: r.spec_format as SpecFormat,
    format_version: r.format_version,
    provenance: JSON.parse(r.provenance) as SpecVersion["provenance"],
    created_at: r.created_at,
  };
}
function toOperation(r: OpRow): Operation {
  return {
    spec_id: r.spec_id,
    version_id: r.version_id,
    operation_key: r.operation_key,
    operation_id: r.operation_id,
    summary: r.summary,
    description: r.description,
    tags: JSON.parse(r.tags) as string[],
    deprecated: r.deprecated !== 0,
    openapi: r.openapi === null ? undefined : (JSON.parse(r.openapi) as Operation["openapi"]),
  };
}
function toTypeDef(r: TdRow): TypeDef {
  return { spec_id: r.spec_id, version_id: r.version_id, name: r.name, kind: r.kind, pointer: r.pointer, description: r.description ?? null };
}

export class LocalStore implements Store {
  private readonly db: Database.Database;
  private readonly snapshotsDir: string;
  private closed = false;

  constructor(root: string = join(homedir(), ".lockspec")) {
    this.snapshotsDir = join(root, "snapshots");
    mkdirSync(this.snapshotsDir, { recursive: true }); // also creates root
    this.db = new Database(join(root, "lockspec.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  getSpec(spec_id: string): Spec | undefined {
    const row = this.db.prepare("SELECT * FROM specs WHERE spec_id = ?").get(spec_id) as
      | SpecRow
      | undefined;
    return row ? toSpec(row) : undefined;
  }

  listSpecs(): Spec[] {
    const rows = this.db.prepare("SELECT * FROM specs").all() as SpecRow[];
    return rows.map(toSpec);
  }

  putVersion(input: PutVersionInput): SpecVersion {
    const tx = this.db.transaction((i: PutVersionInput): SpecVersion => {
      const existing = this.getVersionByHash(i.spec.spec_id, i.version.content_hash);
      if (existing) return existing;

      const now = new Date().toISOString();
      if (!this.getSpec(i.spec.spec_id)) {
        this.db
          .prepare(
            "INSERT INTO specs (spec_id, label, active_version_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)",
          )
          .run(i.spec.spec_id, i.spec.label, now, now);
      }

      const v = i.version;
      this.db
        .prepare(
          `INSERT INTO spec_versions
             (version_id, spec_id, content_hash, version_label, spec_format, format_version, provenance, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          v.version_id,
          i.spec.spec_id,
          v.content_hash,
          v.version_label,
          v.spec_format,
          v.format_version,
          JSON.stringify(v.provenance),
          now,
        );

      this.insertOperations(i.operations);
      this.insertTypeDefs(i.typeDefs);

      this.db.prepare("UPDATE specs SET updated_at = ? WHERE spec_id = ?").run(now, i.spec.spec_id);

      return this.getVersion(i.spec.spec_id, v.version_id)!;
    });
    return tx(input);
  }

  reindexVersion(
    spec_id: string,
    version_id: string,
    operations: Operation[],
    typeDefs: TypeDef[],
  ): void {
    const tx = this.db.transaction(
      (sid: string, vid: string, ops: Operation[], tds: TypeDef[]) => {
        this.db.prepare("DELETE FROM operations WHERE spec_id = ? AND version_id = ?").run(sid, vid);
        this.db.prepare("DELETE FROM typedefs WHERE spec_id = ? AND version_id = ?").run(sid, vid);
        this.db.prepare("DELETE FROM operations_fts WHERE spec_id = ? AND version_id = ?").run(sid, vid);
        this.insertOperations(ops);
        this.insertTypeDefs(tds);
      },
    );
    tx(spec_id, version_id, operations, typeDefs);
  }

  getVersion(spec_id: string, version_id: string): SpecVersion | undefined {
    const row = this.db
      .prepare("SELECT * FROM spec_versions WHERE spec_id = ? AND version_id = ?")
      .get(spec_id, version_id) as VersionRow | undefined;
    return row ? toVersion(row) : undefined;
  }

  getVersionByHash(spec_id: string, content_hash: string): SpecVersion | undefined {
    const row = this.db
      .prepare("SELECT * FROM spec_versions WHERE spec_id = ? AND content_hash = ?")
      .get(spec_id, content_hash) as VersionRow | undefined;
    return row ? toVersion(row) : undefined;
  }

  listVersions(spec_id: string): SpecVersion[] {
    const rows = this.db
      .prepare("SELECT * FROM spec_versions WHERE spec_id = ?")
      .all(spec_id) as VersionRow[];
    return rows.map(toVersion);
  }

  getActiveVersion(spec_id: string): SpecVersion | undefined {
    const active = this.getSpec(spec_id)?.active_version_id;
    return active ? this.getVersion(spec_id, active) : undefined;
  }

  setActive(spec_id: string, version_id: string): void {
    this.db
      .prepare("UPDATE specs SET active_version_id = ?, updated_at = ? WHERE spec_id = ?")
      .run(version_id, new Date().toISOString(), spec_id);
  }

  writeSnapshot(content_hash: string, doc: NormalizedDoc): void {
    // Content-addressed: identical hash ⇒ identical bytes; skip if already present.
    const path = this.snapshotPath(content_hash);
    if (!existsSync(path)) writeFileSync(path, JSON.stringify(doc));
  }

  loadSnapshot(content_hash: string): NormalizedDoc | undefined {
    const path = this.snapshotPath(content_hash);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as NormalizedDoc) : undefined;
  }

  countOperations(spec_id: string, version_id: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM operations WHERE spec_id = ? AND version_id = ?")
      .get(spec_id, version_id) as { n: number };
    return row.n;
  }

  countTypeDefs(spec_id: string, version_id: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM typedefs WHERE spec_id = ? AND version_id = ?")
      .get(spec_id, version_id) as { n: number };
    return row.n;
  }

  hasSnapshot(content_hash: string): boolean {
    return existsSync(this.snapshotPath(content_hash));
  }

  getOperations(spec_id: string, version_id: string): Operation[] {
    const rows = this.db
      .prepare("SELECT * FROM operations WHERE spec_id = ? AND version_id = ?")
      .all(spec_id, version_id) as OpRow[];
    return rows.map(toOperation);
  }

  getTypeDefs(spec_id: string, version_id: string): TypeDef[] {
    const rows = this.db
      .prepare("SELECT * FROM typedefs WHERE spec_id = ? AND version_id = ?")
      .all(spec_id, version_id) as TdRow[];
    return rows.map(toTypeDef);
  }

  searchOps(spec_id: string, version_id: string, query: string): OperationSearchHit[] {
    // Sanitize into a safe FTS5 MATCH expression: extract word tokens, quote each
    // (so punctuation/operators can't break the syntax), OR them for recall.
    const tokens = query.toLowerCase().match(/[a-z0-9]+/g);
    if (!tokens || tokens.length === 0) return [];
    const match = tokens.map((t) => `"${t}"`).join(" OR ");

    // bm25() is negative with more-negative = better; negate so higher = better.
    const rows = this.db
      .prepare(
        `SELECT operation_key, -bm25(operations_fts) AS score
           FROM operations_fts
          WHERE operations_fts MATCH ? AND spec_id = ? AND version_id = ?
          ORDER BY score DESC`,
      )
      .all(match, spec_id, version_id) as Array<{ operation_key: string; score: number }>;
    return rows;
  }

  removeVersion(spec_id: string, version_id: string): void {
    // Capture content_hash before deleting rows, then GC the snapshot afterward.
    // Snapshot written before rows (in load_spec), so an orphan file on crash is
    // harmless — a row pointing at a missing file is not.
    const removed = this.getVersion(spec_id, version_id);
    const tx = this.db.transaction((sid: string, vid: string) => {
      this.db.prepare("DELETE FROM operations WHERE spec_id = ? AND version_id = ?").run(sid, vid);
      this.db.prepare("DELETE FROM typedefs WHERE spec_id = ? AND version_id = ?").run(sid, vid);
      this.db.prepare("DELETE FROM operations_fts WHERE spec_id = ? AND version_id = ?").run(sid, vid);
      this.db.prepare("DELETE FROM spec_versions WHERE spec_id = ? AND version_id = ?").run(sid, vid);
      this.db
        .prepare(
          "UPDATE specs SET active_version_id = NULL, updated_at = ? WHERE spec_id = ? AND active_version_id = ?",
        )
        .run(new Date().toISOString(), sid, vid);
    });
    tx(spec_id, version_id);
    if (removed) this.gcSnapshot(removed.content_hash);
  }

  removeSpec(spec_id: string): void {
    const hashes = [...new Set(this.listVersions(spec_id).map((v) => v.content_hash))];
    const tx = this.db.transaction((sid: string) => {
      this.db.prepare("DELETE FROM operations WHERE spec_id = ?").run(sid);
      this.db.prepare("DELETE FROM typedefs WHERE spec_id = ?").run(sid);
      this.db.prepare("DELETE FROM operations_fts WHERE spec_id = ?").run(sid);
      this.db.prepare("DELETE FROM spec_versions WHERE spec_id = ?").run(sid);
      this.db.prepare("DELETE FROM specs WHERE spec_id = ?").run(sid);
    });
    tx(spec_id);
    for (const h of hashes) this.gcSnapshot(h);
  }

  // GC-on-last-dereference: snapshots are content-addressed and shared across
  // spec_ids, so reference-counting is GLOBAL — delete the file only when no
  // spec_versions row anywhere references the hash.
  private gcSnapshot(content_hash: string): void {
    const stillReferenced = this.db
      .prepare("SELECT 1 FROM spec_versions WHERE content_hash = ? LIMIT 1")
      .get(content_hash);
    if (stillReferenced) return;
    const path = this.snapshotPath(content_hash);
    if (existsSync(path)) unlinkSync(path);
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  private snapshotPath(content_hash: string): string {
    return join(this.snapshotsDir, `${content_hash}.json`);
  }

  // Index-row inserts, shared by putVersion and reindexVersion.
  // Tags + the openapi binding are JSON columns (format-neutral storage).
  private insertOperations(operations: Operation[]): void {
    const insertOp = this.db.prepare(
      `INSERT INTO operations
         (spec_id, version_id, operation_key, operation_id, summary, description, tags, deprecated, openapi)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Mirror each operation into the FTS index; tags are space-joined so each
    // tag is its own token. The UNINDEXED identity columns let a MATCH hit
    // resolve the row.
    const insertFts = this.db.prepare(
      `INSERT INTO operations_fts
         (operation_id, path, summary, description, tags, spec_id, version_id, operation_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const op of operations) {
      insertOp.run(
        op.spec_id,
        op.version_id,
        op.operation_key,
        op.operation_id,
        op.summary ?? null,
        op.description ?? null,
        JSON.stringify(op.tags),
        op.deprecated ? 1 : 0,
        op.openapi === undefined ? null : JSON.stringify(op.openapi),
      );
      insertFts.run(
        op.operation_id,
        op.openapi?.path ?? null,
        op.summary ?? null,
        op.description ?? null,
        op.tags.join(" "),
        op.spec_id,
        op.version_id,
        op.operation_key,
      );
    }
  }

  private insertTypeDefs(typeDefs: TypeDef[]): void {
    const insertTd = this.db.prepare(
      "INSERT INTO typedefs (spec_id, version_id, name, kind, pointer, description) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const td of typeDefs) {
      insertTd.run(td.spec_id, td.version_id, td.name, td.kind, td.pointer, td.description);
    }
  }
}
