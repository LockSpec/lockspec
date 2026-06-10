import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { indexDoc } from "../../src/core/indexer.js";
import { normalize } from "../../src/core/normalizer.js";

// Indexed against the real normalized output (not a stub) so the rows match what
// get_signature/search read from the same snapshot.

const FIX = join(import.meta.dirname, "../../fixtures/openapi");
const read = (p: string) => readFileSync(join(FIX, p), "utf8");

async function indexFixture(p: string) {
  const { doc } = await normalize(read(p));
  return indexDoc(doc, { spec_id: "petstore", version_id: "v1", specFormat: "openapi" });
}

async function indexInline(text: string) {
  const { doc } = await normalize(text);
  return indexDoc(doc, { spec_id: "s", version_id: "v1", specFormat: "openapi" });
}

describe("indexDoc — operations from paths", () => {
  it("extracts one Operation per (path, HTTP method) with neutral fields", async () => {
    const { operations } = await indexFixture("clean/petstore-3.0.yaml");

    expect(operations.map((o) => o.operation_key).sort()).toEqual([
      "GET:/pets",
      "GET:/pets/{petId}",
      "POST:/pets",
    ]);

    const create = operations.find((o) => o.operation_key === "POST:/pets")!;
    expect(create.spec_id).toBe("petstore");
    expect(create.version_id).toBe("v1");
    expect(create.operation_id).toBe("createPet");
    expect(create.summary).toBe("Create a pet");
    expect(create.tags).toEqual(["Pets"]);
    expect(create.deprecated).toBe(false);
  });

  it("builds the tagged openapi binding: uppercase method, raw path, escaped pointers", async () => {
    const { operations } = await indexFixture("clean/petstore-3.0.yaml");
    const create = operations.find((o) => o.operation_key === "POST:/pets")!;

    expect(create.openapi).toEqual({
      method: "POST",
      path: "/pets",
      pointers: {
        // path segment escaped (/ → ~1); method key stays lowercase (literal doc key).
        params: "/paths/~1pets/post/parameters",
        requestBody: "/paths/~1pets/post/requestBody",
        responses: "/paths/~1pets/post/responses",
      },
    });
  });

  it("defaults operation_id to null and tags to [] when absent", async () => {
    const { operations } = await indexInline(
      "openapi: 3.1.0\ninfo:\n  title: T\n  version: '1'\npaths:\n  /x:\n    get:\n      responses:\n        '200':\n          description: OK\n",
    );
    expect(operations).toHaveLength(1);
    expect(operations[0]!.operation_id).toBeNull();
    expect(operations[0]!.tags).toEqual([]);
    expect(operations[0]!.deprecated).toBe(false);
  });

  it("ignores non-operation path-item keys (parameters/summary/$ref), not just any key", async () => {
    // A shared path-level `parameters` array and a `summary` must NOT be read as
    // operations — only the fixed HTTP-method allowlist counts.
    const { operations } = await indexInline(
      [
        "openapi: 3.1.0",
        "info: { title: T, version: '1' }",
        "paths:",
        "  /x:",
        "    summary: a path",
        "    parameters:",
        "      - name: q",
        "        in: query",
        "        schema: { type: string }",
        "    get:",
        "      responses: { '200': { description: OK } }",
        "",
      ].join("\n"),
    );
    expect(operations.map((o) => o.operation_key)).toEqual(["GET:/x"]);
  });
});

describe("indexDoc — typedefs from components/schemas", () => {
  it("extracts one TypeDef per named schema with a JSON-Pointer", async () => {
    const { typeDefs } = await indexFixture("clean/petstore-3.0.yaml");
    expect(typeDefs).toEqual([
      { spec_id: "petstore", version_id: "v1", name: "Pet", kind: "object", pointer: "/components/schemas/Pet" },
    ]);
  });
});

describe("indexDoc — kind derivation (free-form, display-only)", () => {
  const withSchemas = (body: string) =>
    `openapi: 3.1.0\ninfo: { title: T, version: '1' }\npaths: {}\ncomponents:\n  schemas:\n${body}`;

  it("enum present → 'enum'; string type → 'string'; type array → first non-null; else 'object'", async () => {
    const { typeDefs } = await indexInline(
      withSchemas(
        [
          "    Status:",
          "      type: string",
          "      enum: [a, b]",
          "    Name:",
          "      type: string",
          "    Nullable:",
          "      type: [string, 'null']",
          "    Bag:",
          "      properties: { a: { type: string } }",
          "",
        ].join("\n"),
      ),
    );
    const kindOf = (name: string) => typeDefs.find((t) => t.name === name)!.kind;
    expect(kindOf("Status")).toBe("enum");
    expect(kindOf("Name")).toBe("string");
    expect(kindOf("Nullable")).toBe("string"); // first non-null member of the type array
    expect(kindOf("Bag")).toBe("object"); // no type keyword → object fallback
  });
});

describe("indexDoc — JSON-Pointer escaping (RFC 6901)", () => {
  it("escapes ~ before / in path-derived pointers (order matters)", async () => {
    const { operations } = await indexInline(
      [
        "openapi: 3.1.0",
        "info: { title: T, version: '1' }",
        "paths:",
        "  /a~b/c:",
        "    get:",
        "      responses: { '200': { description: OK } }",
        "",
      ].join("\n"),
    );
    const op = operations[0]!;
    // operation_key carries the RAW path; only the pointer is escaped.
    expect(op.operation_key).toBe("GET:/a~b/c");
    expect(op.openapi!.pointers.params).toBe("/paths/~1a~0b~1c/get/parameters");
  });
});

describe("indexDoc — tolerates a sparse doc", () => {
  it("returns empty arrays when paths have no operations and components are absent", async () => {
    // A path item with no HTTP methods produces zero operations/typeDefs.
    // `paths: {}` (empty) fails the 3.1 meta-schema ("at least one entry"); an
    // empty path ITEM (/stub: {}) satisfies it while still yielding no index rows.
    const { operations, typeDefs } = await indexInline(
      "openapi: 3.1.0\ninfo: { title: T, version: '1' }\npaths:\n  /stub: {}\n",
    );
    expect(operations).toEqual([]);
    expect(typeDefs).toEqual([]);
  });
});
