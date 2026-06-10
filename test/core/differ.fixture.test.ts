import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { diffOperations, diffTypes, classifyDiff, type VersionSide } from "../../src/core/differ.js";
import { normalize } from "../../src/core/normalizer.js";
import { indexDoc } from "../../src/core/indexer.js";

// Integration tier (vs the unit precision in differ.test.ts): the full
// normalize → index → diff pipeline over real billing-v1/v2 YAML fixtures.

const FIXTURES = join(import.meta.dirname, "../../fixtures/openapi/versions");
async function loadSide(file: string): Promise<VersionSide> {
  const raw = parseYaml(readFileSync(join(FIXTURES, file), "utf8")) as object;
  const { doc } = await normalize(raw);
  const { operations, typeDefs } = indexDoc(doc, { spec_id: "s", version_id: "v", specFormat: "openapi" });
  return { doc, operations, typeDefs };
}

describe("differ fixture integration — billing-v1 → billing-v2", () => {
  it("operations dimension: added, removed, and itemized changes are correct", async () => {
    const from = await loadSide("billing-v1.yaml");
    const to = await loadSide("billing-v2.yaml");
    const diff = diffOperations(from, to);

    // GET /v1/invoices/{id} is new in v2
    expect(diff.added.map((a) => a.operation_key)).toContain("GET:/v1/invoices/{id}");
    // DELETE /v1/invoices/{id} is removed in v2
    expect(diff.removed.map((r) => r.operation_key)).toContain("DELETE:/v1/invoices/{id}");
    // GET /v1/invoices (listInvoices) is unchanged
    expect(diff.changed.map((c) => c.operation_key)).not.toContain("GET:/v1/invoices");

    // POST /v1/invoices (createInvoice) is changed — inline body changes
    const createChange = diff.changed.find((c) => c.operation_key === "POST:/v1/invoices");
    expect(createChange).toBeDefined();
    const changes = createChange!.changes;

    // new optional field `metadata`
    expect(changes).toContainEqual({ kind: "request_field_added", pointer: "/metadata", required: false });
    // new required field `idempotency_key`
    expect(changes).toContainEqual({ kind: "request_field_added", pointer: "/idempotency_key", required: true });
    // `amount` type narrowed from string to integer
    expect(changes).toContainEqual({ kind: "type_changed", pointer: "/amount", from: "string", to: "integer" });

    // changes are sorted by pointer: /amount < /idempotency_key < /metadata
    const pointers = changes.map((c) => c.pointer);
    expect(pointers).toEqual([...pointers].sort());
  });

  it("types dimension: Invoice changed in v2 (field + type), no spurious changes", async () => {
    const from = await loadSide("billing-v1.yaml");
    const to = await loadSide("billing-v2.yaml");
    const types = diffTypes(from, to);

    expect(types.added).toEqual([]);
    expect(types.removed).toEqual([]);
    expect(types.changed).toEqual([
      {
        name: "Invoice",
        changes: [
          { kind: "type_changed", pointer: "/amount", from: "string", to: "integer" },
          { kind: "request_field_added", pointer: "/status", required: false },
        ],
      },
    ]);
  });

  // Exact-snapshot baseline (vs the loose toContainEqual assertions above): pins
  // the COMPLETE current itemization so an additive carry that perturbs an existing
  // surface is caught, not just a missing entry. billing's request bodies are flat
  // and its response schemas are all $ref, so the recursive-schema and response-body
  // carries add nothing here; the per-type carry flips `types.changed`.
  it("characterization: complete classified ops diff + types diff (current behavior)", async () => {
    const from = await loadSide("billing-v1.yaml");
    const to = await loadSide("billing-v2.yaml");
    const classified = classifyDiff(diffOperations(from, to));

    expect(classified.added).toEqual([
      { operation_key: "GET:/v1/invoices/{id}", method: "GET", path: "/v1/invoices/{id}", operation_id: "getInvoice" },
    ]);
    expect(classified.removed).toEqual([
      { operation_key: "DELETE:/v1/invoices/{id}", method: "DELETE", path: "/v1/invoices/{id}", operation_id: "deleteInvoice" },
    ]);
    expect(classified.changed).toEqual([
      {
        operation_key: "POST:/v1/invoices",
        method: "POST",
        path: "/v1/invoices",
        operation_id: "createInvoice",
        changes: [
          { kind: "type_changed", pointer: "/amount", from: "string", to: "integer", classification: "breaking" },
          { kind: "request_field_added", pointer: "/idempotency_key", required: true, classification: "breaking" },
          { kind: "request_field_added", pointer: "/metadata", required: false, classification: "non_breaking" },
        ],
      },
    ]);
    expect(classified.summary).toEqual({ breaking: 3, non_breaking: 2, unknown: 0 });

    expect(diffTypes(from, to)).toEqual({
      added: [],
      removed: [],
      changed: [
        {
          name: "Invoice",
          changes: [
            { kind: "type_changed", pointer: "/amount", from: "string", to: "integer" },
            { kind: "request_field_added", pointer: "/status", required: false },
          ],
        },
      ],
    });
  });

  it("classified diff: correct summary for billing-v1 → billing-v2", async () => {
    const from = await loadSide("billing-v1.yaml");
    const to = await loadSide("billing-v2.yaml");
    const result = classifyDiff(diffOperations(from, to));

    // POST /v1/invoices changes with classification
    const createChange = result.changed.find((c) => c.operation_key === "POST:/v1/invoices");
    expect(createChange).toBeDefined();
    const changes = createChange!.changes;

    // metadata (optional) → non_breaking
    expect(changes.find((c) => c.pointer === "/metadata")).toMatchObject({ classification: "non_breaking" });
    // idempotency_key (required) → breaking
    expect(changes.find((c) => c.pointer === "/idempotency_key")).toMatchObject({ classification: "breaking" });
    // amount type_changed → breaking
    expect(changes.find((c) => c.kind === "type_changed" && c.pointer === "/amount")).toMatchObject({ classification: "breaking" });

    // Summary: 1 (DELETE removed) + 1 (idempotency_key) + 1 (type_changed) = 3 breaking
    //          1 (GET added) + 1 (metadata) = 2 non_breaking
    expect(result.summary).toEqual({ breaking: 3, non_breaking: 2, unknown: 0 });
  });
});
