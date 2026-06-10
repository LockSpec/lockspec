import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalize, NormalizeError } from "../../src/core/normalizer.js";
import { contentHash } from "../../src/core/hashing.js";

const FIX = join(import.meta.dirname, "../../fixtures/openapi");
const read = (p: string) => readFileSync(join(FIX, p), "utf8");

const petSchema = (doc: any) => doc.components.schemas.Pet;

describe("normalize — parse", () => {
  it("parses a YAML string into the doc", async () => {
    const r = await normalize(read("clean/petstore-3.0.yaml"));
    expect((r.doc as any).info.title).toBe("Petstore");
  });

  it("parses a JSON string into the doc", async () => {
    const r = await normalize('{"openapi":"3.0.0","info":{"title":"J","version":"1"},"paths":{}}');
    expect((r.doc as any).info.title).toBe("J");
  });
});

describe("normalize — format detection", () => {
  it("detects 3.0 format_version + spec_format", async () => {
    const r = await normalize(read("clean/petstore-3.0.yaml"));
    expect(r.specFormat).toBe("openapi");
    expect(r.formatVersion).toBe("3.0.3");
  });

  it("detects 3.1 format_version", async () => {
    const r = await normalize(read("clean/petstore-3.1.yaml"));
    expect(r.formatVersion).toBe("3.1.0");
  });

  it("rejects non-3.x with unsupported_spec", async () => {
    await expect(
      normalize('{"swagger":"2.0","info":{"title":"S","version":"1"},"paths":{}}'),
    ).rejects.toMatchObject({ code: "unsupported_spec" });
  });
});

describe("normalize — bundling (external refs internalized, internal refs preserved)", () => {
  it("internalizes an external $ref and records the external source", async () => {
    const r = await normalize(read("messy/external-refs/root.yaml"), {
      basePath: join(FIX, "messy/external-refs/root.yaml"),
    });
    const schema = (r.doc as any).paths["/pets"].get.responses["200"].content["application/json"].schema;
    // external $ref is gone — its content is now in the snapshot (self-contained)
    expect(JSON.stringify(schema)).not.toContain("pet.yaml");
    expect(schema.properties.id).toBeDefined();
    expect(r.externalSources).toContain("./components/pet.yaml");
  });

  it("preserves internal $refs as pointers (does not inline)", async () => {
    const r = await normalize(read("clean/petstore-3.1.yaml"));
    const body = (r.doc as any).paths["/pets"].post.requestBody.content["application/json"].schema;
    expect(body).toEqual({ $ref: "#/components/schemas/Pet" });
  });
});

describe("normalize — 3.0↔3.1 reconciliation (to JSON Schema 2020-12)", () => {
  it("reconciles a 3.0 schema to its 3.1 equivalent (parity)", async () => {
    const r30 = await normalize(read("clean/petstore-3.0.yaml"));
    const r31 = await normalize(read("clean/petstore-3.1.yaml"));
    expect(petSchema(r30.doc)).toEqual(petSchema(r31.doc));
  });

  it("converts nullable:true into a 'null' type union", async () => {
    const r = await normalize(read("clean/petstore-3.0.yaml"));
    expect(petSchema(r.doc).properties.tag).toEqual({ type: ["string", "null"] });
  });

  it("converts boolean exclusiveMinimum into the numeric form", async () => {
    const r = await normalize(read("clean/petstore-3.0.yaml"));
    expect(petSchema(r.doc).properties.weight).toEqual({ type: "number", exclusiveMinimum: 0 });
  });

  it("converts schema-level example into examples[]", async () => {
    const r = await normalize(read("clean/petstore-3.0.yaml"));
    expect(petSchema(r.doc).examples).toEqual([{ id: 1, name: "Rex", status: "available" }]);
    expect("example" in petSchema(r.doc)).toBe(false);
  });
});

describe("normalize — preserves vendor extensions", () => {
  it("keeps x-* extensions in the normalized doc", async () => {
    const r = await normalize(read("messy/vendor-extensions.yaml"));
    expect((r.doc as any).info["x-logo"]).toBeDefined();
    expect((r.doc as any).components.schemas.Thing["x-table-name"]).toBe("things");
  });
});

describe("normalize — determinism (output feeds contentHash)", () => {
  it("produces a stable content_hash across repeated normalization", async () => {
    const a = await normalize(read("clean/petstore-3.1.yaml"));
    const b = await normalize(read("clean/petstore-3.1.yaml"));
    expect(contentHash(a.doc)).toBe(contentHash(b.doc));
  });

  it("produces a JSON-serializable (finite) doc", async () => {
    const r = await normalize(read("clean/petstore-3.1.yaml"));
    expect(() => JSON.stringify(r.doc)).not.toThrow();
  });
});

describe("normalize — failure paths", () => {
  it("throws parse_error on malformed YAML", async () => {
    await expect(normalize("{ : not valid yaml")).rejects.toBeInstanceOf(NormalizeError);
    await expect(normalize("{ : not valid yaml")).rejects.toMatchObject({ code: "parse_error" });
  });

  it("parse_error carries line/col in details", async () => {
    // The yaml parser surfaces linePos on YAMLParseError; normalizer threads it
    // into NormalizeError.details so agents can pinpoint the syntax error.
    await expect(normalize("{ : not valid yaml")).rejects.toMatchObject({
      code: "parse_error",
      details: { line: expect.any(Number), col: expect.any(Number) },
    });
  });

  it("throws parse_error when the spec does not parse to an object", async () => {
    await expect(normalize("- just\n- a\n- list")).rejects.toMatchObject({ code: "parse_error" });
  });

  it("throws parse_error on a structurally-invalid spec", async () => {
    // valid YAML, valid 3.1 version field, but `responses` is a string — a
    // meta-schema violation that rejects with parse_error + details carrying
    // the errors array and count.
    const bad =
      "openapi: 3.1.0\ninfo: { title: T, version: '1' }\n" +
      "paths:\n  /p:\n    get:\n      responses: nope\n";
    await expect(normalize(bad)).rejects.toMatchObject({
      code: "parse_error",
      details: { count: expect.any(Number), errors: expect.any(Array) },
    });
  });
});

// HARD (correctness-breaking) violations stay parse_error (covered above); SOFT
// (technically-invalid but usable) violations no longer fail — normalize()
// resolves and surfaces a warning in NormalizeResult.warnings.
describe("normalize — severity split (SOFT warn+load)", () => {
  const op = "get: { responses: { '200': { description: OK } } }";

  it("missing info.title → resolves with a warning (was parse_error)", async () => {
    const r = await normalize(`openapi: 3.1.0\ninfo: { version: '1' }\npaths:\n  /p: { ${op} }\n`);
    expect(r.warnings).toEqual(expect.arrayContaining([expect.stringContaining("info.title")]));
    expect((r.doc as any).info.title).toBeUndefined(); // real doc keeps the gap (clone-only injection)
  });

  it("missing info.version → resolves with a warning (was parse_error)", async () => {
    const r = await normalize(`openapi: 3.1.0\ninfo: { title: T }\npaths:\n  /p: { ${op} }\n`);
    expect(r.warnings).toEqual(expect.arrayContaining([expect.stringContaining("info.version")]));
    expect((r.doc as any).info.version).toBeUndefined();
  });

  it("duplicate operationId → resolves with a warning naming the id + operation_key hint", async () => {
    const dup =
      "openapi: 3.1.0\ninfo: { title: T, version: '1' }\npaths:\n" +
      `  /a: { get: { operationId: dup, responses: { '200': { description: OK } } } }\n` +
      `  /b: { get: { operationId: dup, responses: { '200': { description: OK } } } }\n`;
    const r = await normalize(dup);
    expect(r.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("dup")]),
    );
    expect(r.warnings.some((w) => w.includes("operation_key"))).toBe(true);
  });

  it("info present-but-not-an-object → stays parse_error (HARD, not masked)", async () => {
    const bad = `openapi: 3.1.0\ninfo: notanobject\npaths:\n  /p: { ${op} }\n`;
    await expect(normalize(bad)).rejects.toMatchObject({ code: "parse_error" });
  });

  it("empty/null info → SOFT (resolves with title+version warnings, like absent info)", async () => {
    // YAML `info:` with no value parses to null — morally the same as absent info
    // (both SOFT per the review). title+version both injected into the clone; the
    // real doc keeps the null info.
    const r = await normalize(`openapi: 3.1.0\ninfo:\npaths:\n  /p: { ${op} }\n`);
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("info.title"),
        expect.stringContaining("info.version"),
      ]),
    );
  });
});

// Each test drives normalize() with a basePath so bundle() resolves external
// refs relative to the fixture directory.
describe("normalize — external-$ref failure paths", () => {
  const EXT = join(FIX, "messy/external-refs");

  it("unreachable external file → io_error", async () => {
    // root-broken.yaml references a file that doesn't exist.
    const src = readFileSync(join(EXT, "root-broken.yaml"), "utf8");
    await expect(
      normalize(src, { basePath: join(EXT, "root-broken.yaml") }),
    ).rejects.toMatchObject({ code: "io_error" });
  });

  it("malformed external content → parse_error", async () => {
    // root-malformed-ext.yaml references an external file containing invalid YAML.
    const src = readFileSync(join(EXT, "root-malformed-ext.yaml"), "utf8");
    await expect(
      normalize(src, { basePath: join(EXT, "root-malformed-ext.yaml") }),
    ).rejects.toMatchObject({ code: "parse_error" });
  });

  it("cyclic external refs → bundled successfully (no hang, no error)", async () => {
    // Two files that $ref each other: bundle() resolves them into internal refs
    // (no infinite loop, no error) — cross-file cycles internalized transparently.
    const src = readFileSync(join(EXT, "root-cyclic.yaml"), "utf8");
    const result = await normalize(src, { basePath: join(EXT, "root-cyclic.yaml") });
    expect(result.doc).toBeDefined();
    // No $ref in the bundled snapshot still points to the external file —
    // all cross-file refs have been internalized (the info.description text
    // mentions the filename but that's not a $ref).
    const allRefs: string[] = [];
    const collectRefs = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(collectRefs);
      } else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (k === "$ref" && typeof v === "string") allRefs.push(v);
          else collectRefs(v);
        }
      }
    };
    collectRefs(result.doc);
    expect(allRefs.every((r) => !r.includes("cyclic-partner.yaml"))).toBe(true);
    // The bundled doc has schemas (Partner was inlined under Node's partner prop)
    expect((result.doc as any).components?.schemas?.Node).toBeDefined();
  });
});
