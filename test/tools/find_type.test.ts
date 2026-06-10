import { describe, it, expect } from "vitest";
import { join } from "node:path";

import { findTypeTool } from "../../src/tools/find_type.js";
import { loadSpecTool } from "../../src/tools/load_spec.js";
import { InMemoryStore } from "../helpers/in-memory-store.js";
import type { ToolDeps } from "../../src/tools/index.js";

// Ranking lives in core (search.test.ts), not here.

function payloadOf(result: { content: Array<{ type: string; text?: string }> }): any {
  return JSON.parse(result.content[0]!.text!);
}
async function load(store: InMemoryStore, source: string) {
  return loadSpecTool.handler({ source }, { store });
}
function find(store: InMemoryStore, args: Record<string, unknown>) {
  const deps: ToolDeps = { store };
  return findTypeTool.handler(args, deps);
}

const BILLING = `
openapi: 3.1.0
info: { title: Billing, version: '1' }
paths: {}
components:
  schemas:
    Invoice:
      type: object
      properties: { id: { type: string } }
    Customer:
      type: object
`;

describe("find_type — wiring & resolution errors", () => {
  it("invalid input (missing query) → structured invalid_input", async () => {
    const p = payloadOf(await find(new InMemoryStore(), {}));
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("invalid_input");
  });

  it("more than one spec and no spec_id → ambiguous (from resolveTarget)", async () => {
    const store = new InMemoryStore();
    await load(store, BILLING);
    await load(store, BILLING.replace("title: Billing", "title: Shipping"));
    const p = payloadOf(await find(store, { query: "Invoice" }));
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("ambiguous");
  });

  it("unknown explicit spec_id → not_found naming the spec", async () => {
    const store = new InMemoryStore();
    await load(store, BILLING);
    const p = payloadOf(await find(store, { query: "Invoice", spec_id: "nope" }));
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("not_found");
    expect(p.error.message).toMatch(/nope/);
  });
});

describe("find_type — results", () => {
  it("an exact type-name query returns the matching schema as a compact row", async () => {
    const store = new InMemoryStore();
    await load(store, BILLING);
    const p = payloadOf(await find(store, { query: "Invoice" }));
    expect(p.ok).toBe(true);
    expect(p.spec_id).toBe("billing");
    expect(p.version_id).toBeDefined();
    expect(p.results[0]).toEqual({ name: "Invoice", kind: "object", description: null, score: 1 });
    expect(p.truncated).toBe(false);
  });

  it("matches a term in a schema's description and returns the description in the row", async () => {
    const store = new InMemoryStore();
    await load(
      store,
      BILLING.replace(
        "    Customer:\n      type: object",
        "    Customer:\n      type: object\n      description: The party billed for reconciliation purposes.",
      ),
    );
    const p = payloadOf(await find(store, { query: "reconciliation" }));
    expect(p.ok).toBe(true);
    const row = p.results.find((r: { name: string }) => r.name === "Customer");
    expect(row).toBeDefined();
    expect(row.description).toBe("The party billed for reconciliation purposes.");
  });

  it("a query that matches nothing → ok:true with empty results", async () => {
    const store = new InMemoryStore();
    await load(store, BILLING);
    const p = payloadOf(await find(store, { query: "zzz-nothing-matches" }));
    expect(p.ok).toBe(true);
    expect(p.results).toEqual([]);
    expect(p.truncated).toBe(false);
  });

  it("pipeline smoke: load petstore from file → find the Pet schema", async () => {
    const store = new InMemoryStore();
    const file = join(import.meta.dirname, "../../fixtures/openapi/clean/petstore-3.0.yaml");
    await loadSpecTool.handler({ source: file, source_type: "file" }, { store });
    const p = payloadOf(await find(store, { query: "Pet" }));
    expect(p.ok).toBe(true);
    expect(p.results[0].name).toBe("Pet");
  });
});

describe("find_type — lenient multi-version warning", () => {
  // Same title → same spec_id; different content → two coexisting versions, newest
  // active. find_type is read-only discovery → lenient (active + a warning).
  async function loadTwo(store: InMemoryStore) {
    await load(store, BILLING);
    await load(store, BILLING.replace("id: { type: string }", "id: { type: integer }"));
  }

  it("lenient: >1 loaded version, version omitted → ok:true against active + version_warning", async () => {
    const store = new InMemoryStore();
    await loadTwo(store);
    const p = payloadOf(await find(store, { query: "Invoice" }));
    expect(p.ok).toBe(true);
    expect(p.version_warning).toBeDefined();
    expect(p.version_warning).toMatch(/version/i);
    expect(p.results[0].name).toBe("Invoice");
  });

  it("single loaded version → no version_warning", async () => {
    const store = new InMemoryStore();
    await load(store, BILLING);
    const p = payloadOf(await find(store, { query: "Invoice" }));
    expect(p.ok).toBe(true);
    expect(p.version_warning).toBeUndefined();
  });
});
