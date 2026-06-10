import { afterAll, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { LocalStore } from "../../src/store/local-store.js";
import { describeStoreContract } from "./store-contract.js";
import type { PutVersionInput } from "../../src/store/store.js";

// Test isolation: every store gets a fresh temp root via mkdtemp — the real
// ~/.lockspec is NEVER touched. All roots are removed in afterAll.
const roots: string[] = [];
const stores: LocalStore[] = [];

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lockspec-"));
  roots.push(root);
  return root;
}
function track(store: LocalStore): LocalStore {
  stores.push(store);
  return store;
}

afterAll(() => {
  for (const s of stores) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function makeInput(): PutVersionInput {
  return {
    spec: { spec_id: "billing-api", label: "Billing API" },
    version: {
      version_id: "v1",
      content_hash: "hash-aaa",
      version_label: "2.3.0",
      spec_format: "openapi",
      format_version: "3.1.0",
      provenance: {
        source_type: "inline",
        source_uri: null,
        fetched_at: "2026-06-02T00:00:00.000Z",
        original_byte_size: 1234,
        external_sources: [],
      },
    },
    operations: [
      {
        spec_id: "billing-api",
        version_id: "v1",
        operation_key: "POST:/v1/invoices",
        operation_id: "createInvoice",
        summary: "Create an invoice",
        description: null,
        tags: ["Invoices"],
        deprecated: false,
        openapi: {
          method: "POST",
          path: "/v1/invoices",
          pointers: { params: "p", requestBody: "rb", responses: "r" },
        },
      },
    ],
    typeDefs: [
      {
        spec_id: "billing-api",
        version_id: "v1",
        name: "Invoice",
        kind: "object",
        pointer: "/components/schemas/Invoice",
      },
    ],
  };
}

// The real LocalStore satisfies the SAME behavioral contract the in-memory fake
// passes — proof both implementations honor the Store seam.
describeStoreContract("LocalStore", () => track(new LocalStore(freshRoot())));

// LocalStore-specific behavior, beyond the shared contract.
describe("LocalStore — persistence & content-addressing", () => {
  it("persists across instances at the same root", () => {
    const root = freshRoot();
    const snap = { openapi: "3.1.0", paths: {} };

    const writer = track(new LocalStore(root));
    writer.putVersion(makeInput());
    writer.setActive("billing-api", "v1");
    writer.writeSnapshot("hash-aaa", snap);
    writer.close();

    const reader = track(new LocalStore(root));
    expect(reader.getVersion("billing-api", "v1")?.content_hash).toBe("hash-aaa");
    expect(reader.getActiveVersion("billing-api")?.version_id).toBe("v1");
    expect(reader.getOperations("billing-api", "v1").map((o) => o.operation_key)).toEqual([
      "POST:/v1/invoices",
    ]);
    expect(reader.loadSnapshot("hash-aaa")).toEqual(snap);
  });

  it("writes one content-addressed file and never overwrites a present hash", () => {
    const root = freshRoot();
    const store = track(new LocalStore(root));
    store.writeSnapshot("hash-xyz", { v: 1 });
    store.writeSnapshot("hash-xyz", { v: 2 });

    const files = readdirSync(join(root, "snapshots"));
    expect(files).toEqual(["hash-xyz.json"]);
    const onDisk = JSON.parse(readFileSync(join(root, "snapshots", "hash-xyz.json"), "utf8"));
    expect(onDisk).toEqual({ v: 1 });
  });

  it("isolates data between separate roots", () => {
    const a = track(new LocalStore(freshRoot()));
    const b = track(new LocalStore(freshRoot()));
    a.putVersion(makeInput());

    expect(a.getSpec("billing-api")).toBeDefined();
    expect(b.getSpec("billing-api")).toBeUndefined();
  });

  it("close() is safe to call more than once", () => {
    const store = track(new LocalStore(freshRoot()));
    expect(() => {
      store.close();
      store.close();
    }).not.toThrow();
  });
});

// FK enforcement — a LocalStore-specific invariant (no FK semantics in InMemoryStore).
describe("LocalStore — foreign-key enforcement", () => {
  it("rejects a spec_versions row whose spec_id has no matching specs row", () => {
    const store = track(new LocalStore(freshRoot()));
    // Reach the live connection directly. Note: better-sqlite3 ≥ 12.x enables
    // foreign_keys by default, so LocalStore's explicit pragma is belt-and-suspenders;
    // this test locks the behavioral contract regardless of library-default changes.
    const db = (store as unknown as { db: Database.Database }).db;
    const insert = db.prepare(
      `INSERT INTO spec_versions
         (version_id, spec_id, content_hash, version_label, spec_format, format_version, provenance, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    expect(() =>
      insert.run("v-orphan", "no-such-spec", "hash-x", null, "openapi", "3.1.0", "{}", "2026-06-10T00:00:00.000Z"),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});

// FTS5 search index — a LocalStore-internal detail (not in the Store contract).
// Inspected directly via a second raw better-sqlite3 handle to the same root,
// since the column design is what search ranking depends on.
describe("LocalStore — operations_fts population", () => {
  // Read the FTS table out-of-band through a fresh handle on the same db file.
  function ftsQuery<T>(root: string, sql: string, ...params: unknown[]): T[] {
    const raw = new Database(join(root, "lockspec.db"));
    try {
      return raw.prepare(sql).all(...params) as T[];
    } finally {
      raw.close();
    }
  }

  it("populates operations_fts on putVersion; token search returns the identity columns", () => {
    const root = freshRoot();
    const store = track(new LocalStore(root));
    // makeInput()'s op: summary "Create an invoice", path "/v1/invoices".
    store.putVersion(makeInput());

    const rows = ftsQuery<{ spec_id: string; version_id: string; operation_key: string; operation_id: string }>(
      root,
      "SELECT spec_id, version_id, operation_key, operation_id FROM operations_fts WHERE operations_fts MATCH ?",
      "invoice",
    );
    expect(rows).toEqual([
      { spec_id: "billing-api", version_id: "v1", operation_key: "POST:/v1/invoices", operation_id: "createInvoice" },
    ]);
  });

  it("re-populates operations_fts on reindexVersion (replace, not append)", () => {
    const root = freshRoot();
    const store = track(new LocalStore(root));
    store.putVersion(makeInput());
    store.reindexVersion(
      "billing-api",
      "v1",
      [
        {
          spec_id: "billing-api",
          version_id: "v1",
          operation_key: "GET:/v1/refunds",
          operation_id: "listRefunds",
          summary: "List refunds",
          description: null,
          tags: [],
          deprecated: false,
          openapi: { method: "GET", path: "/v1/refunds", pointers: { params: "p", requestBody: "rb", responses: "r" } },
        },
      ],
      [],
    );

    // The old token is gone; the new one resolves.
    expect(ftsQuery(root, "SELECT operation_key FROM operations_fts WHERE operations_fts MATCH ?", "invoice")).toEqual([]);
    expect(
      ftsQuery<{ operation_key: string }>(root, "SELECT operation_key FROM operations_fts WHERE operations_fts MATCH ?", "refunds"),
    ).toEqual([{ operation_key: "GET:/v1/refunds" }]);
  });

  it("clears the version's operations_fts rows on removeVersion", () => {
    const root = freshRoot();
    const store = track(new LocalStore(root));
    store.putVersion(makeInput());
    store.removeVersion("billing-api", "v1");

    const n = ftsQuery<{ n: number }>(root, "SELECT count(*) AS n FROM operations_fts");
    expect(n[0]!.n).toBe(0);
  });
});
