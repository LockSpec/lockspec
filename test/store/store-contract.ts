import { describe, it, expect } from "vitest";

import type {
  Operation,
  PutVersionInput,
  Store,
  TypeDef,
} from "../../src/store/store.js";

// Reusable behavioral contract for any Store implementation. Run against both the
// in-memory fake and the real LocalStore — same assertions, proving both honor
// the same surface. Imported by *.test.ts files (not itself a test file, so the
// runner doesn't pick it up directly).

function sampleOperation(over: Partial<Operation> = {}): Operation {
  return {
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
      pointers: {
        params: "/paths/~1v1~1invoices/post/parameters",
        requestBody: "/paths/~1v1~1invoices/post/requestBody",
        responses: "/paths/~1v1~1invoices/post/responses",
      },
    },
    ...over,
  };
}

function sampleTypeDef(over: Partial<TypeDef> = {}): TypeDef {
  return {
    spec_id: "billing-api",
    version_id: "v1",
    name: "Invoice",
    kind: "object",
    pointer: "/components/schemas/Invoice",
    ...over,
  };
}

function sampleInput(over: {
  spec_id?: string;
  version_id?: string;
  content_hash?: string;
} = {}): PutVersionInput {
  const spec_id = over.spec_id ?? "billing-api";
  const version_id = over.version_id ?? "v1";
  const content_hash = over.content_hash ?? "hash-aaa";
  return {
    spec: { spec_id, label: "Billing API" },
    version: {
      version_id,
      content_hash,
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
    operations: [sampleOperation({ spec_id, version_id })],
    typeDefs: [sampleTypeDef({ spec_id, version_id })],
  };
}

export function describeStoreContract(
  name: string,
  makeStore: () => Store,
): void {
  describe(`Store contract — ${name}`, () => {
    it("putVersion persists the spec, version, and index rows for retrieval", () => {
      const store = makeStore();
      const version = store.putVersion(sampleInput());

      expect(version.version_id).toBe("v1");
      expect(version.content_hash).toBe("hash-aaa");

      const spec = store.getSpec("billing-api");
      expect(spec?.spec_id).toBe("billing-api");
      expect(spec?.label).toBe("Billing API");
      expect(store.listSpecs().map((s) => s.spec_id)).toEqual(["billing-api"]);

      expect(store.getVersion("billing-api", "v1")?.content_hash).toBe("hash-aaa");
      // Format-neutral model: the format tag + dialect round-trip.
      expect(store.getVersion("billing-api", "v1")?.spec_format).toBe("openapi");
      expect(store.getVersion("billing-api", "v1")?.format_version).toBe("3.1.0");
      expect(store.listVersions("billing-api").map((v) => v.version_id)).toEqual([
        "v1",
      ]);
      expect(store.getOperations("billing-api", "v1").map((o) => o.operation_key)).toEqual([
        "POST:/v1/invoices",
      ]);
      expect(store.getTypeDefs("billing-api", "v1").map((t) => t.name)).toEqual([
        "Invoice",
      ]);
    });

    it("reindexVersion replaces a version's index rows (backfill path), not appends", () => {
      // A version persisted with an empty or stale index is re-indexed in place —
      // its rows are REPLACED, the spec_version row and active pointer untouched.
      const store = makeStore();
      store.putVersion(sampleInput());
      store.setActive("billing-api", "v1");

      store.reindexVersion(
        "billing-api",
        "v1",
        [
          sampleOperation({
            spec_id: "billing-api",
            version_id: "v1",
            operation_key: "GET:/v1/invoices",
            operation_id: "listInvoices",
          }),
        ],
        [sampleTypeDef({ spec_id: "billing-api", version_id: "v1", name: "InvoiceList" })],
      );

      // Replaced, not appended: only the new rows remain.
      expect(store.getOperations("billing-api", "v1").map((o) => o.operation_key)).toEqual([
        "GET:/v1/invoices",
      ]);
      expect(store.getTypeDefs("billing-api", "v1").map((t) => t.name)).toEqual(["InvoiceList"]);
      // The version row and active pointer are untouched.
      expect(store.getVersion("billing-api", "v1")?.content_hash).toBe("hash-aaa");
      expect(store.getActiveVersion("billing-api")?.version_id).toBe("v1");
    });

    it("searchOps returns FTS hits scoped to the (spec_id, version_id), or [] on no match", () => {
      // The raw FTS primitive: match/no-match/version-scoped. Ranking quality
      // (BM25 ordering) is core/search's concern, tested on LocalStore; here we
      // assert only the contract: a matching token returns the op, scoped.
      const store = makeStore();
      store.putVersion(sampleInput()); // v1: POST:/v1/invoices "Create an invoice"
      // A second version with a non-matching op, to prove scoping.
      store.putVersion({
        spec: { spec_id: "billing-api", label: "Billing API" },
        version: {
          version_id: "v2",
          content_hash: "hash-bbb",
          version_label: "2.4.0",
          spec_format: "openapi",
          format_version: "3.1.0",
          provenance: { source_type: "inline", source_uri: null, fetched_at: "x", original_byte_size: 1, external_sources: [] },
        },
        operations: [
          sampleOperation({
            spec_id: "billing-api",
            version_id: "v2",
            operation_key: "GET:/v1/refunds",
            operation_id: "listRefunds",
            summary: "List refunds",
          }),
        ],
        typeDefs: [],
      });

      const hits = store.searchOps("billing-api", "v1", "invoice");
      expect(hits.map((h) => h.operation_key)).toContain("POST:/v1/invoices");
      expect(typeof hits[0]!.score).toBe("number");

      // No match → empty.
      expect(store.searchOps("billing-api", "v1", "zzz-no-such-token")).toEqual([]);
      // Version-scoped: v1's token does not leak into v2, nor v2's into v1.
      expect(store.searchOps("billing-api", "v2", "invoice")).toEqual([]);
      expect(store.searchOps("billing-api", "v1", "refunds")).toEqual([]);
    });

    it("setActive is reflected by getActiveVersion and on the Spec", () => {
      const store = makeStore();
      store.putVersion(sampleInput());
      expect(store.getActiveVersion("billing-api")).toBeUndefined();
      expect(store.getSpec("billing-api")?.active_version_id).toBeNull();

      store.setActive("billing-api", "v1");

      expect(store.getActiveVersion("billing-api")?.version_id).toBe("v1");
      expect(store.getSpec("billing-api")?.active_version_id).toBe("v1");
    });

    it("writeSnapshot/loadSnapshot round-trips by content_hash; unknown hash → undefined", () => {
      const store = makeStore();
      const doc = { openapi: "3.1.0", paths: {} };
      store.writeSnapshot("hash-aaa", doc);

      expect(store.loadSnapshot("hash-aaa")).toEqual(doc);
      expect(store.loadSnapshot("hash-missing")).toBeUndefined();
    });

    it("writeSnapshot is an idempotent no-op for an already-present hash", () => {
      const store = makeStore();
      store.writeSnapshot("hash-aaa", { v: 1 });
      store.writeSnapshot("hash-aaa", { v: 2 });

      // Content-addressed: same hash ⇒ same bytes; the second write does not overwrite.
      expect(store.loadSnapshot("hash-aaa")).toEqual({ v: 1 });
    });

    it("putVersion dedups on identical content_hash within a spec_id (load_spec no-op)", () => {
      const store = makeStore();
      const first = store.putVersion(sampleInput());
      const again = store.putVersion(
        sampleInput({ version_id: "v2", content_hash: "hash-aaa" }),
      );

      expect(again.version_id).toBe(first.version_id); // existing returned, not the new id
      expect(store.listVersions("billing-api").map((v) => v.version_id)).toEqual([
        "v1",
      ]);
    });

    it("getVersionByHash finds a version by its content_hash within a spec_id", () => {
      const store = makeStore();
      store.putVersion(sampleInput());

      expect(store.getVersionByHash("billing-api", "hash-aaa")?.version_id).toBe("v1");
      expect(store.getVersionByHash("billing-api", "nope")).toBeUndefined();
    });

    it("removeVersion makes a version's rows no longer retrievable", () => {
      const store = makeStore();
      store.putVersion(sampleInput());
      store.removeVersion("billing-api", "v1");

      expect(store.getVersion("billing-api", "v1")).toBeUndefined();
      expect(store.listVersions("billing-api")).toEqual([]);
      expect(store.getOperations("billing-api", "v1")).toEqual([]);
    });

    it("removeSpec makes the spec and its versions no longer retrievable", () => {
      const store = makeStore();
      store.putVersion(sampleInput());
      store.removeSpec("billing-api");

      expect(store.getSpec("billing-api")).toBeUndefined();
      expect(store.listSpecs()).toEqual([]);
      expect(store.listVersions("billing-api")).toEqual([]);
    });

    it("removeVersion GCs the snapshot once nothing references its content_hash", () => {
      const store = makeStore();
      const doc = { openapi: "3.1.0", paths: {} };
      store.writeSnapshot("hash-aaa", doc);
      store.putVersion(sampleInput());

      store.removeVersion("billing-api", "v1");

      // Last (only) reference gone → the snapshot file is reclaimed.
      expect(store.loadSnapshot("hash-aaa")).toBeUndefined();
    });

    it("snapshot GC is by global ref-count: survives while another spec references the hash", () => {
      // Content-addressed snapshots are shared across spec_ids (same bytes, one
      // file). GC must count references globally, not within one spec_id.
      const store = makeStore();
      const doc = { openapi: "3.1.0", paths: {} };
      store.writeSnapshot("hash-shared", doc);
      store.putVersion(sampleInput({ spec_id: "api-a", version_id: "va", content_hash: "hash-shared" }));
      store.putVersion(sampleInput({ spec_id: "api-b", version_id: "vb", content_hash: "hash-shared" }));

      store.removeSpec("api-a");
      expect(store.loadSnapshot("hash-shared")).toEqual(doc); // api-b still references it

      store.removeSpec("api-b");
      expect(store.loadSnapshot("hash-shared")).toBeUndefined(); // last reference gone
    });
  });
}
