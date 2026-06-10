import { describe, it, expect } from "vitest";
import { join } from "node:path";

import { getSignatureTool } from "../../src/tools/get_signature.js";
import { loadSpecTool } from "../../src/tools/load_spec.js";
import { InMemoryStore } from "../helpers/in-memory-store.js";
import type { ToolDeps } from "../../src/tools/index.js";

// Wiring + the snapshot/pointer round-trip on a real loaded spec; expansion
// correctness lives in signature.test.ts.

function payloadOf(result: { content: Array<{ type: string; text?: string }> }): any {
  return JSON.parse(result.content[0]!.text!);
}
async function load(store: InMemoryStore, source: string, source_type?: string) {
  return loadSpecTool.handler({ source, ...(source_type ? { source_type } : {}) }, { store });
}
function sig(store: InMemoryStore, args: Record<string, unknown>) {
  const deps: ToolDeps = { store };
  return getSignatureTool.handler(args, deps);
}
const PETSTORE = join(import.meta.dirname, "../../fixtures/openapi/clean/petstore-3.0.yaml");
const CIRCULAR = join(import.meta.dirname, "../../fixtures/openapi/messy/circular-refs.yaml");

describe("get_signature — input XOR + resolution errors", () => {
  it("neither operation_id nor operation_key → invalid_input", async () => {
    const store = new InMemoryStore();
    await load(store, PETSTORE, "file");
    const p = payloadOf(await sig(store, {}));
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("invalid_input");
  });

  it("both operation_id and operation_key → invalid_input (XOR)", async () => {
    const store = new InMemoryStore();
    await load(store, PETSTORE, "file");
    const p = payloadOf(await sig(store, { operation_id: "createPet", operation_key: "POST:/pets" }));
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("invalid_input");
  });

  it("more than one spec and no spec_id → ambiguous (from resolveTarget)", async () => {
    const store = new InMemoryStore();
    await load(store, PETSTORE, "file");
    await load(store, "openapi: 3.1.0\ninfo: { title: Other, version: '1' }\npaths:\n  /ping: { get: { responses: { '200': { description: OK } } } }\n", "inline");
    const p = payloadOf(await sig(store, { operation_id: "createPet" }));
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("ambiguous");
  });

  it("unknown operation → not_found", async () => {
    const store = new InMemoryStore();
    await load(store, PETSTORE, "file");
    const p = payloadOf(await sig(store, { operation_key: "GET:/nope" }));
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("not_found");
    expect(p.error.message).toMatch(/GET:\/nope/); // names the target (stub can't)
  });

  it("a non-unique operationId → ambiguous, listing candidate operation_keys", async () => {
    // Duplicate operationIds within one spec load with a warning (not a hard error),
    // so this resolver path is reachable via normal load flow. Populated directly here
    // as a focused resolver unit (locateOperation() fires before any snapshot access,
    // so no snapshot is needed); the load-time path is covered in load_spec.test.ts.
    const store = new InMemoryStore();
    store.putVersion({
      spec: { spec_id: "dup-api", label: "Dup API" },
      version: {
        version_id: "v1", content_hash: "hash-dup", version_label: "1.0",
        spec_format: "openapi", format_version: "3.1.0",
        provenance: { source_type: "inline", source_uri: null, fetched_at: "2026-06-05T00:00:00Z", original_byte_size: 100, external_sources: [] },
      },
      operations: [
        { spec_id: "dup-api", version_id: "v1", operation_key: "GET:/a", operation_id: "dup",
          summary: "A", description: null, tags: [], deprecated: false,
          openapi: { method: "GET", path: "/a", pointers: { params: "p", requestBody: "rb", responses: "r" } } },
        { spec_id: "dup-api", version_id: "v1", operation_key: "GET:/b", operation_id: "dup",
          summary: "B", description: null, tags: [], deprecated: false,
          openapi: { method: "GET", path: "/b", pointers: { params: "p", requestBody: "rb", responses: "r" } } },
      ],
      typeDefs: [],
    });
    store.setActive("dup-api", "v1");
    const p = payloadOf(await sig(store, { operation_id: "dup" }));
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("ambiguous");
    expect(p.error.message).toMatch(/GET:\/a/);
    expect(p.error.message).toMatch(/GET:\/b/);
  });

  it("a resolvable version whose snapshot is missing → io_error", async () => {
    // Version row + operation index exist (so resolveTarget + locateOperation
    // succeed), but no snapshot was written for the hash — loadSnapshot returns
    // undefined. The data-integrity path: a GC race or a hand-deleted snapshot.
    const store = new InMemoryStore();
    store.putVersion({
      spec: { spec_id: "gone-api", label: "Gone API" },
      version: {
        version_id: "v1", content_hash: "missing-hash", version_label: "1.0",
        spec_format: "openapi", format_version: "3.1.0",
        provenance: { source_type: "inline", source_uri: null, fetched_at: "2026-06-05T00:00:00Z", original_byte_size: 1, external_sources: [] },
      },
      operations: [
        { spec_id: "gone-api", version_id: "v1", operation_key: "GET:/a", operation_id: "getA",
          summary: null, description: null, tags: [], deprecated: false,
          openapi: { method: "GET", path: "/a", pointers: { params: "p", requestBody: "rb", responses: "r" } } },
      ],
      typeDefs: [],
    });
    store.setActive("gone-api", "v1");
    const p = payloadOf(await sig(store, { operation_key: "GET:/a" }));
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("io_error");
    expect(p.error.message).toMatch(/is missing/);
  });
});

describe("get_signature — pipeline (snapshot/pointer round-trip)", () => {
  it("by operation_id: petstore createPet → exact body schema expanded with required fields", async () => {
    const store = new InMemoryStore();
    await load(store, PETSTORE, "file");
    const p = payloadOf(await sig(store, { operation_id: "createPet" }));
    expect(p.ok).toBe(true);
    expect(p.operation_key).toBe("POST:/pets");
    expect(p.method).toBe("POST");
    expect(p.path).toBe("/pets");
    const schema = p.requestBody.content["application/json"].schema;
    expect(schema.required).toEqual(expect.arrayContaining(["id", "name"]));
    expect(schema.properties.id).toBeDefined();
    expect(p.truncated_paths).toEqual([]);
  });

  it("by operation_key resolves the same operation", async () => {
    const store = new InMemoryStore();
    await load(store, PETSTORE, "file");
    const p = payloadOf(await sig(store, { operation_key: "POST:/pets" }));
    expect(p.ok).toBe(true);
    expect(p.operation_id).toBe("createPet");
  });

  it("circular-refs: a self-cycle is tagged {$circular}, never infinite (and ~-path round-trips)", async () => {
    const store = new InMemoryStore();
    await load(store, CIRCULAR, "file");
    const p = payloadOf(await sig(store, { operation_key: "GET:/a~b/{id}" }));
    expect(p.ok).toBe(true);
    const node = p.responses["200"].content["application/json"].schema;
    expect(node.properties.children.items).toEqual({ $circular: "#/components/schemas/Node" });
  });
});

describe("get_signature — strict multi-version", () => {
  // Same title → same spec_id slug; different content → two coexisting versions,
  // newest active. get_signature is write-adjacent → strict on version-omitted.
  const WIDGET_V1 =
    "openapi: 3.1.0\ninfo: { title: Widget API, version: '1.0.0' }\npaths:\n  /widgets: { get: { operationId: listWidgets, responses: { '200': { description: OK } } } }\n";
  const WIDGET_V2 =
    "openapi: 3.1.0\ninfo: { title: Widget API, version: '2.0.0' }\npaths:\n  /widgets:\n    get: { operationId: listWidgets, responses: { '200': { description: OK } } }\n    post: { operationId: createWidget, responses: { '201': { description: Created } } }\n";
  async function loadTwo(store: InMemoryStore) {
    await load(store, WIDGET_V1, "inline");
    await load(store, WIDGET_V2, "inline");
  }

  it("strict: >1 loaded version, version omitted → ambiguous + details.loaded_versions", async () => {
    const store = new InMemoryStore();
    await loadTwo(store);
    const p = payloadOf(await sig(store, { operation_key: "GET:/widgets" }));
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("ambiguous");
    expect(p.error.details.loaded_versions).toHaveLength(2);
    expect(p.error.details.loaded_versions.some((v: any) => v.active === true)).toBe(true);
  });

  it("explicit version still resolves on a multi-version spec (escape hatch)", async () => {
    const store = new InMemoryStore();
    await loadTwo(store);
    const p = payloadOf(await sig(store, { operation_key: "GET:/widgets", version: "1.0.0" }));
    expect(p.ok).toBe(true);
    expect(p.operation_key).toBe("GET:/widgets");
  });
});
