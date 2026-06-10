import { afterAll, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { searchEndpoints } from "../../src/core/search.js";
import { LocalStore } from "../../src/store/local-store.js";
import type { Operation, PutVersionInput } from "../../src/store/store.js";

// The headline measurement: "create an invoice" → POST:/v1/invoices ranks first.
// BM25 *ordering* needs the real FTS5 index, so this test drives a LocalStore
// (unlike core unit tests which use the in-memory fake). Synthetic ops via
// putVersion give full decoy control with real bm25 — no fixture file. The
// decoy set discriminates token weight, so a flipped bm25 sign or a wrong sort
// would fail it.

const roots: string[] = [];
const stores: LocalStore[] = [];
afterAll(() => {
  for (const s of stores) try { s.close(); } catch { /* already closed */ }
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function freshStore(): LocalStore {
  const root = mkdtempSync(join(tmpdir(), "lockspec-bm25-"));
  roots.push(root);
  const s = new LocalStore(root);
  stores.push(s);
  return s;
}

function op(method: string, path: string, operation_id: string, summary: string): Operation {
  return {
    spec_id: "billing", version_id: "v1",
    operation_key: `${method}:${path}`,
    operation_id, summary, description: null, tags: [], deprecated: false,
    openapi: { method, path, pointers: { params: "", requestBody: "", responses: "" } },
  };
}

function seedBilling(): LocalStore {
  const store = freshStore();
  // Decoys discriminate by matching-token count against the query
  // {create, an, invoice}. Summaries are kept SINGULAR and free of "create"/"an"
  // on the one-token decoys, because unicode61 does no stemming — "invoices"
  // (plural) would NOT match the query term "invoice".
  const operations = [
    op("POST", "/v1/invoices", "createInvoice", "Create an invoice"), // create+an+invoice = 3 (target)
    op("POST", "/v1/customers", "createCustomer", "Create a customer"), // create = 1 (create-only decoy)
    op("GET", "/v1/invoices", "listInvoices", "Retrieve invoice"), // invoice = 1 (invoice-only decoy)
    op("DELETE", "/v1/invoices/{id}", "deleteInvoice", "Remove invoice"), // invoice = 1 (invoice-only decoy)
  ];
  const input: PutVersionInput = {
    spec: { spec_id: "billing", label: "Billing" },
    version: {
      version_id: "v1", content_hash: "hash-billing", version_label: "1",
      spec_format: "openapi", format_version: "3.1.0",
      provenance: { source_type: "inline", source_uri: null, fetched_at: "x", original_byte_size: 1, external_sources: [] },
    },
    operations, typeDefs: [],
  };
  store.putVersion(input);
  return store;
}

describe("searchEndpoints — BM25 intent ranking (LocalStore)", () => {
  it('"create an invoice" ranks POST:/v1/invoices first, above the create-customer decoy', () => {
    const store = seedBilling();
    const { results } = searchEndpoints(store, { spec_id: "billing", version_id: "v1" }, { query: "create an invoice" });

    const keys = results.map((r) => r.operation_key);
    // The headline: the two-token match wins.
    expect(keys[0]).toBe("POST:/v1/invoices");
    // Two-token (create+invoice) strictly outranks one-token (create only) —
    // proves bm25 is wired with the right sign, not just that the target appears.
    expect(keys.indexOf("POST:/v1/invoices")).toBeLessThan(keys.indexOf("POST:/v1/customers"));

    // Scores are a non-increasing sequence within (0,1].
    const scores = results.map((r) => r.score);
    for (const s of scores) expect(s).toBeGreaterThan(0), expect(s).toBeLessThanOrEqual(1);
    for (let i = 1; i < scores.length; i++) expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!);
  });
});
