import { describe, it, expect } from "vitest";
import { join } from "node:path";

import { findEndpointTool } from "../../src/tools/find_endpoint.js";
import { loadSpecTool } from "../../src/tools/load_spec.js";
import { InMemoryStore } from "../helpers/in-memory-store.js";
import type { ToolDeps } from "../../src/tools/index.js";

// Ranking quality lives in core (search.bm25.test.ts), not here.

function payloadOf(result: { content: Array<{ type: string; text?: string }> }): any {
  return JSON.parse(result.content[0]!.text!);
}
async function load(store: InMemoryStore, source: string) {
  return loadSpecTool.handler({ source }, { store });
}
function find(store: InMemoryStore, args: Record<string, unknown>) {
  const deps: ToolDeps = { store };
  return findEndpointTool.handler(args, deps);
}

const BILLING = `
openapi: 3.1.0
info: { title: Billing, version: '1' }
paths:
  /invoices:
    post:
      operationId: createInvoice
      summary: Create an invoice
      responses: { '200': { description: OK } }
    get:
      operationId: listInvoices
      summary: List invoices
      responses: { '200': { description: OK } }
`;

describe("find_endpoint — wiring & resolution errors", () => {
  it("invalid input (missing query) → structured invalid_input", async () => {
    const p = payloadOf(await find(new InMemoryStore(), {}));
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("invalid_input");
  });

  it("more than one spec and no spec_id → ambiguous (from resolveTarget)", async () => {
    const store = new InMemoryStore();
    await load(store, BILLING);
    await load(store, BILLING.replace("title: Billing", "title: Shipping"));
    const p = payloadOf(await find(store, { query: "createInvoice" }));
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("ambiguous");
  });

  it("unknown explicit spec_id → not_found naming the spec", async () => {
    const store = new InMemoryStore();
    await load(store, BILLING);
    const p = payloadOf(await find(store, { query: "createInvoice", spec_id: "nope" }));
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("not_found");
    expect(p.error.message).toMatch(/nope/);
  });
});

describe("find_endpoint — results", () => {
  it("an exact operationId query returns the matching op as a compact row", async () => {
    const store = new InMemoryStore();
    await load(store, BILLING);
    const p = payloadOf(await find(store, { query: "createInvoice" }));
    expect(p.ok).toBe(true);
    expect(p.spec_id).toBe("billing");
    expect(p.version_id).toBeDefined();
    expect(p.results[0]).toMatchObject({
      operation_key: "POST:/invoices",
      operation_id: "createInvoice",
      method: "POST",
      path: "/invoices",
    });
    expect(p.truncated).toBe(false);
  });

  it("a query that matches nothing → ok:true with empty results", async () => {
    const store = new InMemoryStore();
    await load(store, BILLING);
    const p = payloadOf(await find(store, { query: "zzz-nothing-matches" }));
    expect(p.ok).toBe(true);
    expect(p.results).toEqual([]);
    expect(p.truncated).toBe(false);
  });

  it("pipeline smoke: load petstore from file → find by operationId", async () => {
    const store = new InMemoryStore();
    const file = join(import.meta.dirname, "../../fixtures/openapi/clean/petstore-3.0.yaml");
    await loadSpecTool.handler({ source: file, source_type: "file" }, { store });
    const p = payloadOf(await find(store, { query: "createPet" }));
    expect(p.ok).toBe(true);
    expect(p.results[0].operation_key).toBe("POST:/pets");
  });
});

describe("find_endpoint — lenient multi-version warning", () => {
  // Same title → same spec_id; different content → two coexisting versions, newest
  // active. find_endpoint is read-only discovery → lenient (active + a warning).
  async function loadTwo(store: InMemoryStore) {
    await load(store, BILLING);
    await load(store, BILLING.replace("List invoices", "List all invoices"));
  }

  it("lenient: >1 loaded version, version omitted → ok:true against active + version_warning", async () => {
    const store = new InMemoryStore();
    await loadTwo(store);
    const p = payloadOf(await find(store, { query: "createInvoice" }));
    expect(p.ok).toBe(true);
    expect(p.version_warning).toBeDefined();
    expect(p.version_warning).toMatch(/version/i);
    expect(p.results[0].operation_key).toBe("POST:/invoices");
  });

  it("single loaded version → no version_warning", async () => {
    const store = new InMemoryStore();
    await load(store, BILLING);
    const p = payloadOf(await find(store, { query: "createInvoice" }));
    expect(p.ok).toBe(true);
    expect(p.version_warning).toBeUndefined();
  });
});
