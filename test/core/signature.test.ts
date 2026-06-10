import { describe, it, expect } from "vitest";

import { buildSignature } from "../../src/core/signature.js";
import { escapePointer } from "../../src/core/json-pointer.js";
import type { Operation } from "../../src/store/store.js";

// Pointers are built here via escapePointer (the indexer's own helper), so
// resolving them in the builder dogfoods the RFC 6901 round-trip.

function makeOp(method: string, path: string, over: Partial<Operation> = {}): Operation {
  const base = `/paths/${escapePointer(path)}/${method.toLowerCase()}`;
  return {
    spec_id: "s", version_id: "v",
    operation_key: `${method.toUpperCase()}:${path}`,
    operation_id: null, summary: null, description: null, tags: [], deprecated: false,
    openapi: {
      method: method.toUpperCase(),
      path,
      pointers: { params: `${base}/parameters`, requestBody: `${base}/requestBody`, responses: `${base}/responses` },
    },
    ...over,
  };
}

const PET = {
  type: "object",
  required: ["id", "name"],
  properties: { id: { type: "integer" }, name: { type: "string" } },
};

describe("buildSignature — exact contract", () => {
  const doc = {
    openapi: "3.1.0",
    paths: {
      "/pets": {
        post: {
          operationId: "createPet",
          summary: "Create a pet",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } },
          responses: { "201": { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } } },
          security: [{ apiKey: [] }],
        },
      },
    },
    components: { schemas: { Pet: PET } },
    security: [{ globalAuth: [] }],
  };
  const op = makeOp("POST", "/pets", { operation_id: "createPet", summary: "Create a pet" });

  it("returns method/path/operationId/summary/deprecation from the indexed row", () => {
    const sig = buildSignature(doc, op);
    expect(sig.method).toBe("POST");
    expect(sig.path).toBe("/pets");
    expect(sig.operation_id).toBe("createPet");
    expect(sig.summary).toBe("Create a pet");
    expect(sig.deprecated).toBe(false);
  });

  it("expands the requestBody schema $ref inline with required flag", () => {
    const sig = buildSignature(doc, op);
    expect(sig.requestBody?.required).toBe(true);
    expect(sig.requestBody?.content["application/json"]!.schema).toEqual(PET);
  });

  it("expands response schemas keyed by status + content-type", () => {
    const sig = buildSignature(doc, op);
    expect(sig.responses["201"]!.description).toBe("Created");
    expect(sig.responses["201"]!.content!["application/json"]!.schema).toEqual(PET);
  });

  it("reports op-level security names only, overriding root", () => {
    expect(buildSignature(doc, op).security).toEqual(["apiKey"]);
  });

  it("no truncation on a small contract", () => {
    expect(buildSignature(doc, op).truncated_paths).toEqual([]);
  });

  it("omits requestBody when the operation has none (GET)", () => {
    const getDoc = { ...doc, paths: { "/pets": { get: { operationId: "listPets", responses: { "200": { description: "OK" } } } } } };
    const sig = buildSignature(getDoc, makeOp("GET", "/pets", { operation_id: "listPets" }));
    expect(sig.requestBody).toBeUndefined();
    expect(sig.responses["200"]!.description).toBe("OK");
  });
});

describe("buildSignature — security ?? root fallback", () => {
  const base = { openapi: "3.1.0", components: { schemas: {} }, security: [{ globalAuth: [] }] };
  it("falls back to root security when the op omits the key", () => {
    const doc = { ...base, paths: { "/x": { get: { responses: {} } } } };
    expect(buildSignature(doc, makeOp("GET", "/x")).security).toEqual(["globalAuth"]);
  });
  it("an explicit empty op security overrides root (opt-out), not falls back", () => {
    const doc = { ...base, paths: { "/x": { get: { security: [], responses: {} } } } };
    expect(buildSignature(doc, makeOp("GET", "/x")).security).toEqual([]);
  });
});

describe("buildSignature — parameter merge (path-level + op-level)", () => {
  const doc = {
    openapi: "3.1.0",
    paths: {
      "/a~b/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: {
          operationId: "getTilde",
          parameters: [{ name: "verbose", in: "query", schema: { type: "boolean" } }],
          responses: { "200": { description: "OK" } },
        },
      },
    },
    components: { schemas: {} },
  };
  const op = makeOp("GET", "/a~b/{id}", { operation_id: "getTilde" });

  it("merges shared path-level params with op-level (and resolves the ~-escaped pointer)", () => {
    const params = buildSignature(doc, op).parameters;
    const byName = Object.fromEntries(params.map((p) => [p.name, p]));
    expect(byName.id).toMatchObject({ in: "path", required: true });
    expect(byName.verbose).toMatchObject({ in: "query", required: false });
  });

  it("op-level param overrides a path-level param of the same (name, in)", () => {
    const override = {
      ...doc,
      paths: {
        "/a~b/{id}": {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          get: {
            operationId: "getTilde",
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };
    const idParam = buildSignature(override, op).parameters.find((p) => p.name === "id")!;
    expect(idParam.schema).toEqual({ type: "integer" }); // op wins
    expect(buildSignature(override, op).parameters).toHaveLength(1); // not duplicated
  });

  it("Pin C: path param without required key → required forced to true in signature output", () => {
    const pinCDoc = {
      openapi: "3.1.0",
      paths: { "/items/{id}": { get: { operationId: "getItem", parameters: [{ name: "id", in: "path", schema: { type: "string" } }], responses: { "200": { description: "OK" } } } } },
      components: { schemas: {} },
    };
    const idParam = buildSignature(pinCDoc, makeOp("GET", "/items/{id}", { operation_id: "getItem" })).parameters.find((p) => p.name === "id")!;
    expect(idParam.required).toBe(true);
  });

  it("Pin D: parameter ORDER is path-item-first then op-level in sequence", () => {
    const pinDDoc = {
      openapi: "3.1.0",
      paths: {
        "/items/{id}": {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          get: {
            operationId: "getItemOrdered",
            parameters: [
              { name: "verbose", in: "query", schema: { type: "boolean" } },
              { name: "format", in: "query", schema: { type: "string" } },
            ],
            responses: { "200": { description: "OK" } },
          },
        },
      },
      components: { schemas: {} },
    };
    const sig = buildSignature(pinDDoc, makeOp("GET", "/items/{id}", { operation_id: "getItemOrdered" }));
    expect(sig.parameters.map((p) => p.name)).toEqual(["id", "verbose", "format"]);
  });
});

describe("buildSignature — ref expansion edges", () => {
  function withResponseSchema(schemas: Record<string, unknown>, schema: unknown) {
    return {
      openapi: "3.1.0",
      paths: { "/n": { get: { operationId: "g", responses: { "200": { description: "OK", content: { "application/json": { schema } } } } } } },
      components: { schemas },
    };
  }
  const op = makeOp("GET", "/n", { operation_id: "g" });
  const schemaOf = (sig: ReturnType<typeof buildSignature>) =>
    sig.responses["200"]!.content!["application/json"]!.schema as any;

  it("tags a self-cycle {$circular} at the back-edge, never infinite", () => {
    const doc = withResponseSchema(
      { Node: { type: "object", properties: { id: { type: "string" }, children: { type: "array", items: { $ref: "#/components/schemas/Node" } } } } },
      { $ref: "#/components/schemas/Node" },
    );
    const s = schemaOf(buildSignature(doc, op));
    expect(s.properties.children.items).toEqual({ $circular: "#/components/schemas/Node" });
    expect(s.properties.id).toEqual({ type: "string" }); // siblings still expand
  });

  it("expands a diamond/DAG twice, untagged (re-ref'd acyclic schema)", () => {
    const doc = withResponseSchema(
      {
        Leaf: { type: "object", properties: { value: { type: "string" } } },
        Diamond: { type: "object", properties: { left: { $ref: "#/components/schemas/Leaf" }, right: { $ref: "#/components/schemas/Leaf" } } },
      },
      { $ref: "#/components/schemas/Diamond" },
    );
    const s = schemaOf(buildSignature(doc, op));
    const leaf = { type: "object", properties: { value: { type: "string" } } };
    expect(s.properties.left).toEqual(leaf);
    expect(s.properties.right).toEqual(leaf); // both expanded, neither $circular
  });

  it("collapses past max_depth and records output-relative truncated_paths", () => {
    const doc = withResponseSchema(
      {
        Chain0: { type: "object", properties: { next: { $ref: "#/components/schemas/Chain1" } } },
        Chain1: { type: "object", properties: { next: { $ref: "#/components/schemas/Chain2" } } },
        Chain2: { type: "object", properties: { value: { type: "string" } } },
      },
      { $ref: "#/components/schemas/Chain0" },
    );
    const sig = buildSignature(doc, op, { maxDepth: 2 });
    const s = schemaOf(sig);
    expect(s.properties.next.properties.next).toEqual({ $ref: "#/components/schemas/Chain2" }); // collapsed
    expect(sig.truncated_paths).toEqual(["/responses/200/content/application~1json/schema/properties/next/properties/next"]);
  });

  it("collapses on the size guard (tiny maxBytes) and records truncated_paths", () => {
    const doc = withResponseSchema({ Pet: PET }, { $ref: "#/components/schemas/Pet" });
    const sig = buildSignature(doc, op, { maxBytes: 0 });
    expect(schemaOf(sig)).toEqual({ $ref: "#/components/schemas/Pet" }); // never expanded
    expect(sig.truncated_paths).toEqual(["/responses/200/content/application~1json/schema"]);
  });

  it("expand_refs:false leaves $refs intact with no truncation", () => {
    const doc = withResponseSchema({ Pet: PET }, { $ref: "#/components/schemas/Pet" });
    const sig = buildSignature(doc, op, { expandRefs: false });
    expect(schemaOf(sig)).toEqual({ $ref: "#/components/schemas/Pet" });
    expect(sig.truncated_paths).toEqual([]);
  });
});
