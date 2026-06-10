import { describe, it, expect } from "vitest";

import { searchEndpoints, searchTypes } from "../../src/core/search.js";
import { InMemoryStore } from "../helpers/in-memory-store.js";
import type { Operation, PutVersionInput, TypeDef } from "../../src/store/store.js";

// Structural behavior only (tiers, filters, limit/truncated, fuzzy, output shape)
// against the in-memory fake: per its honest-candidate-set contract these assert
// MEMBERSHIP/COUNT/TIER, never BM25 score-order — that measurement is in
// search.bm25.test.ts (LocalStore-backed).

const SPEC = "api";
const VER = "v1";

function op(over: Partial<Operation>): Operation {
  const path = over.openapi?.path ?? "/x";
  const method = over.openapi?.method ?? "GET";
  return {
    spec_id: SPEC,
    version_id: VER,
    operation_key: `${method}:${path}`,
    operation_id: null,
    summary: null,
    description: null,
    tags: [],
    deprecated: false,
    ...over,
    openapi: { method, path, pointers: { params: "p", requestBody: "rb", responses: "r" }, ...over.openapi },
  };
}

function seed(ops: Operation[]): InMemoryStore {
  const store = new InMemoryStore();
  const input: PutVersionInput = {
    spec: { spec_id: SPEC, label: "API" },
    version: {
      version_id: VER,
      content_hash: "hash-1",
      version_label: "1",
      spec_format: "openapi",
      format_version: "3.1.0",
      provenance: { source_type: "inline", source_uri: null, fetched_at: "x", original_byte_size: 1, external_sources: [] },
    },
    operations: ops,
    typeDefs: [],
  };
  store.putVersion(input);
  return store;
}

const find = (store: InMemoryStore, opts: Parameters<typeof searchEndpoints>[2]) =>
  searchEndpoints(store, { spec_id: SPEC, version_id: VER }, opts);

describe("searchEndpoints — exact tier", () => {
  it("an exact operation_id match ranks first with score 1", () => {
    const store = seed([
      op({ operation_id: "createPet", openapi: { method: "POST", path: "/pets", pointers: { params: "", requestBody: "", responses: "" } } }),
      op({ operation_id: "listPets", summary: "Create things", openapi: { method: "GET", path: "/pets", pointers: { params: "", requestBody: "", responses: "" } } }),
    ]);
    const { results } = find(store, { query: "createPet" });
    expect(results[0]!.operation_key).toBe("POST:/pets");
    expect(results[0]!.score).toBe(1);
  });

  it("an exact method:path (operation_key) match ranks first", () => {
    const store = seed([
      op({ operation_id: "a", openapi: { method: "POST", path: "/pets", pointers: { params: "", requestBody: "", responses: "" } } }),
      op({ operation_id: "b", openapi: { method: "GET", path: "/pets", pointers: { params: "", requestBody: "", responses: "" } } }),
    ]);
    const { results } = find(store, { query: "POST:/pets" });
    expect(results[0]!.operation_key).toBe("POST:/pets");
  });

  it("an exact path match ranks first", () => {
    const store = seed([
      op({ operation_id: "getPet", openapi: { method: "GET", path: "/pets/{id}", pointers: { params: "", requestBody: "", responses: "" } } }),
      op({ operation_id: "listPets", openapi: { method: "GET", path: "/pets", pointers: { params: "", requestBody: "", responses: "" } } }),
    ]);
    const { results } = find(store, { query: "/pets" });
    expect(results[0]!.operation_key).toBe("GET:/pets");
  });
});

describe("searchEndpoints — FTS tier (membership, not score-order)", () => {
  it("returns ops whose summary matches the query tokens, excludes non-matches", () => {
    const store = seed([
      op({ operation_id: "a", summary: "Create a pet", openapi: { method: "POST", path: "/pets", pointers: { params: "", requestBody: "", responses: "" } } }),
      op({ operation_id: "b", summary: "Create a toy", openapi: { method: "POST", path: "/toys", pointers: { params: "", requestBody: "", responses: "" } } }),
      op({ operation_id: "c", summary: "List orders", openapi: { method: "GET", path: "/orders", pointers: { params: "", requestBody: "", responses: "" } } }),
    ]);
    const keys = find(store, { query: "create" }).results.map((r) => r.operation_key);
    expect(keys).toEqual(expect.arrayContaining(["POST:/pets", "POST:/toys"]));
    expect(keys).not.toContain("GET:/orders");
  });
});

describe("searchEndpoints — fuzzy tier", () => {
  it("surfaces a typo'd operation_id, ranked below an exact match", () => {
    const store = seed([
      op({ operation_id: "createPet", openapi: { method: "POST", path: "/pets", pointers: { params: "", requestBody: "", responses: "" } } }),
      op({ operation_id: "createPit", openapi: { method: "POST", path: "/pits", pointers: { params: "", requestBody: "", responses: "" } } }),
    ]);
    const { results } = find(store, { query: "createPet" });
    const keys = results.map((r) => r.operation_key);
    expect(keys).toContain("POST:/pits"); // fuzzy neighbor surfaced
    expect(keys.indexOf("POST:/pets")).toBeLessThan(keys.indexOf("POST:/pits")); // exact above fuzzy
  });

  it("drops candidates below the fuzzy threshold", () => {
    const store = seed([
      op({ operation_id: "createPet", openapi: { method: "POST", path: "/pets", pointers: { params: "", requestBody: "", responses: "" } } }),
      op({ operation_id: "zzzzzzzz", summary: "unrelated", openapi: { method: "GET", path: "/qqq", pointers: { params: "", requestBody: "", responses: "" } } }),
    ]);
    const keys = find(store, { query: "createPet" }).results.map((r) => r.operation_key);
    expect(keys).not.toContain("GET:/qqq");
  });
});

describe("searchEndpoints — filters", () => {
  it("method filter keeps only that HTTP method (case-insensitive)", () => {
    const store = seed([
      op({ operation_id: "a", summary: "pet create", openapi: { method: "POST", path: "/pets", pointers: { params: "", requestBody: "", responses: "" } } }),
      op({ operation_id: "b", summary: "pet list", openapi: { method: "GET", path: "/pets", pointers: { params: "", requestBody: "", responses: "" } } }),
    ]);
    const { results } = find(store, { query: "pet", method: "get" });
    expect(results.every((r) => r.method === "GET")).toBe(true);
    expect(results.map((r) => r.operation_key)).toEqual(["GET:/pets"]);
  });

  it("tag filter keeps only ops carrying the tag", () => {
    const store = seed([
      op({ operation_id: "a", summary: "pet x", tags: ["Pets"], openapi: { method: "POST", path: "/pets", pointers: { params: "", requestBody: "", responses: "" } } }),
      op({ operation_id: "b", summary: "pet y", tags: ["Admin"], openapi: { method: "GET", path: "/pets", pointers: { params: "", requestBody: "", responses: "" } } }),
    ]);
    const { results } = find(store, { query: "pet", tag: "Pets" });
    expect(results.map((r) => r.operation_key)).toEqual(["POST:/pets"]);
  });

  it("excludes deprecated ops by default; include_deprecated surfaces them", () => {
    const store = seed([
      op({ operation_id: "a", summary: "pet new", openapi: { method: "POST", path: "/pets", pointers: { params: "", requestBody: "", responses: "" } } }),
      op({ operation_id: "b", summary: "pet old", deprecated: true, openapi: { method: "GET", path: "/pets", pointers: { params: "", requestBody: "", responses: "" } } }),
    ]);
    expect(find(store, { query: "pet" }).results.map((r) => r.operation_key)).toEqual(["POST:/pets"]);
    const withDep = find(store, { query: "pet", includeDeprecated: true }).results.map((r) => r.operation_key);
    expect(withDep).toEqual(expect.arrayContaining(["POST:/pets", "GET:/pets"]));
  });
});

describe("searchEndpoints — limit & output shape", () => {
  it("caps to limit and reports truncated", () => {
    const store = seed(
      Array.from({ length: 5 }, (_, i) =>
        op({ operation_id: `op${i}`, summary: "pet", openapi: { method: "GET", path: `/p${i}`, pointers: { params: "", requestBody: "", responses: "" } } }),
      ),
    );
    const out = find(store, { query: "pet", limit: 2 });
    expect(out.results).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });

  it("truncated is false when results fit", () => {
    const store = seed([op({ operation_id: "a", summary: "pet", openapi: { method: "GET", path: "/p", pointers: { params: "", requestBody: "", responses: "" } } })]);
    expect(find(store, { query: "pet", limit: 10 }).truncated).toBe(false);
  });

  it("rows carry the compact endpoint fields and a score in (0,1]", () => {
    const store = seed([
      op({ operation_id: "createPet", summary: "Create a pet", tags: ["Pets"], openapi: { method: "POST", path: "/pets", pointers: { params: "", requestBody: "", responses: "" } } }),
    ]);
    const row = find(store, { query: "createPet" }).results[0]!;
    expect(row).toEqual({
      operation_key: "POST:/pets",
      operation_id: "createPet",
      method: "POST",
      path: "/pets",
      summary: "Create a pet",
      tags: ["Pets"],
      deprecated: false,
      score: 1,
    });
  });

  it("no match → empty results, not truncated", () => {
    const store = seed([op({ operation_id: "a", summary: "pet", openapi: { method: "GET", path: "/p", pointers: { params: "", requestBody: "", responses: "" } } })]);
    expect(find(store, { query: "zzz-nothing-here" })).toEqual({ results: [], truncated: false });
  });
});

// searchTypes: name-only ranking over TypeDefs (exact > prefix > fuzzy;
// no FTS — a TypeDef carries no rich text). All in-memory; no LocalStore needed.
function td(name: string, kind = "object", description: string | null = null): TypeDef {
  return { spec_id: SPEC, version_id: VER, name, kind, pointer: `/components/schemas/${name}`, description };
}
function seedTypes(typeDefs: TypeDef[]): InMemoryStore {
  const store = new InMemoryStore();
  store.putVersion({
    spec: { spec_id: SPEC, label: "API" },
    version: {
      version_id: VER, content_hash: "hash-t", version_label: "1",
      spec_format: "openapi", format_version: "3.1.0",
      provenance: { source_type: "inline", source_uri: null, fetched_at: "x", original_byte_size: 1, external_sources: [] },
    },
    operations: [], typeDefs,
  });
  return store;
}
const findT = (store: InMemoryStore, opts: Parameters<typeof searchTypes>[2]) =>
  searchTypes(store, { spec_id: SPEC, version_id: VER }, opts);

describe("searchTypes — name-based ranking", () => {
  it("an exact name match ranks first with score 1", () => {
    const store = seedTypes([td("Invoice"), td("InvoiceLine"), td("Customer")]);
    const { results } = findT(store, { query: "Invoice" });
    expect(results[0]!.name).toBe("Invoice");
    expect(results[0]!.score).toBe(1);
  });

  it("a prefix name match is returned and ranks below an exact one", () => {
    const store = seedTypes([td("Invoice"), td("InvoiceLine")]);
    const names = findT(store, { query: "Invoice" }).results.map((r) => r.name);
    expect(names[0]).toBe("Invoice"); // exact
    expect(names).toContain("InvoiceLine"); // prefix
    expect(names.indexOf("Invoice")).toBeLessThan(names.indexOf("InvoiceLine"));
  });

  it("a typo'd name is surfaced by the fuzzy tier, below an exact match", () => {
    const store = seedTypes([td("Invoice"), td("Invoyce")]);
    const names = findT(store, { query: "Invoice" }).results.map((r) => r.name);
    expect(names).toContain("Invoyce");
    expect(names.indexOf("Invoice")).toBeLessThan(names.indexOf("Invoyce"));
  });

  it("caps to limit and reports truncated", () => {
    const store = seedTypes(Array.from({ length: 5 }, (_, i) => td(`Inv${i}`)));
    const out = findT(store, { query: "Inv", limit: 2 });
    expect(out.results).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });

  it("an empty/whitespace query returns nothing (no match-everything)", () => {
    const store = seedTypes([td("Invoice"), td("Customer")]);
    expect(findT(store, { query: "   " })).toEqual({ results: [], truncated: false });
  });

  it("rows carry the compact type fields (name, kind, description, score) with score in (0,1]", () => {
    const store = seedTypes([td("Status", "enum")]);
    const row = findT(store, { query: "Status" }).results[0]!;
    expect(row).toEqual({ name: "Status", kind: "enum", description: null, score: 1 });
  });

  it("no match → empty results, not truncated", () => {
    const store = seedTypes([td("Invoice")]);
    expect(findT(store, { query: "zzz-nothing" })).toEqual({ results: [], truncated: false });
  });
});

describe("searchTypes — description matching", () => {
  // A realistic multi-sentence description: a whole-string trigram match against
  // it falls below FUZZY_THRESHOLD, so the term must be matched token-level.
  const DESC =
    "Represents a customer-facing receipt issued after a successful payment. " +
    "Carries the line items, totals, and tax breakdown for reconciliation.";

  it("a term present only in the description (absent from the name) surfaces the type", () => {
    const store = seedTypes([td("Ledger", "object", DESC), td("Customer")]);
    const names = findT(store, { query: "reconciliation" }).results.map((r) => r.name);
    expect(names).toContain("Ledger");
  });

  it("the matched description is returned in the row", () => {
    const store = seedTypes([td("Ledger", "object", DESC)]);
    const row = findT(store, { query: "reconciliation" }).results[0]!;
    expect(row.name).toBe("Ledger");
    expect(row.description).toBe(DESC);
  });

  it("name stays the strong tier: a name hit outranks a description-only hit", () => {
    // "Invoice" is the name of one type and a description term of another.
    const store = seedTypes([
      td("Invoice"),
      td("Receipt", "object", "An invoice issued to the customer at checkout."),
    ]);
    const names = findT(store, { query: "Invoice" }).results.map((r) => r.name);
    expect(names.indexOf("Invoice")).toBeLessThan(names.indexOf("Receipt"));
  });
});
