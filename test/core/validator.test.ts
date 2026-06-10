import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createSpecValidator, validateBody, validateParams, type Violation, type DraftParams } from "../../src/core/validator.js";
import { normalize } from "../../src/core/normalizer.js";
import { escapePointer } from "../../src/core/json-pointer.js";
import type { NormalizedDoc, Operation } from "../../src/store/store.js";

// Runs against real normalized snapshots (real reconciliation), both 3.0- and
// 3.1-origin.

const FIX = join(import.meta.dirname, "../../fixtures/openapi");
const read = (p: string) => readFileSync(join(FIX, p), "utf8");
const docOf = async (p: string): Promise<NormalizedDoc> => (await normalize(read(p))).doc;

// Build an Operation row with the indexer's stored pointers (escapePointer dogfoods
// the same pointer the validator resolves).
function makeOp(method: string, path: string, over: Partial<Operation> = {}): Operation {
  const base = `/paths/${escapePointer(path)}/${method.toLowerCase()}`;
  return {
    spec_id: "s", version_id: "v",
    operation_key: `${method.toUpperCase()}:${path}`,
    operation_id: null, summary: null, description: null, tags: [], deprecated: false,
    openapi: {
      method: method.toUpperCase(), path,
      pointers: { params: `${base}/parameters`, requestBody: `${base}/requestBody`, responses: `${base}/responses` },
    },
    ...over,
  };
}

describe("createSpecValidator.compileBody — both versions compile", () => {
  it("compiles the 3.0-origin petstore POST /pets body schema", async () => {
    const v = createSpecValidator(await docOf("clean/petstore-3.0.yaml"));
    const fn = v.compileBody(makeOp("POST", "/pets", { operation_id: "createPet" })).get("application/json")!;
    expect(fn).toBeTypeOf("function");
    // Discrimination: the $ref resolved to the real Pet schema (id+name required),
    // not a vacuous/misresolved one — the whole risk the $ref resolution carries.
    expect(fn({ id: 1, name: "x" })).toBe(true);
    expect(fn({})).toBe(false);
  });

  it("compiles the 3.1-origin petstore POST /pets body schema", async () => {
    const v = createSpecValidator(await docOf("clean/petstore-3.1.yaml"));
    const fns = v.compileBody(makeOp("POST", "/pets", { operation_id: "createPet" }));
    expect(fns.get("application/json")).toBeTypeOf("function");
  });

  it("returns an empty map for an operation with no request body (GET)", async () => {
    const v = createSpecValidator(await docOf("clean/petstore-3.0.yaml"));
    const fns = v.compileBody(makeOp("GET", "/pets/{petId}", { operation_id: "getPet" }));
    expect(fns.size).toBe(0);
  });
});

describe("createSpecValidator.compileBody — Ajv resolves refs itself (not buildSignature)", () => {
  // A recursive body schema at a brace path. buildSignature would tag {$circular};
  // Ajv compiles the recursive $ref natively without infinite loop. Literal doc —
  // validate_call validates requests, so the cycle lives in a request body here.
  const recursiveDoc = (): NormalizedDoc => ({
    openapi: "3.1.0",
    info: { title: "T", version: "1" },
    paths: {
      "/a~b/{id}": {
        post: {
          operationId: "createNode",
          requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } } },
          responses: { "200": { description: "OK" } },
        },
      },
    },
    components: {
      schemas: {
        Node: {
          type: "object",
          properties: { id: { type: "string" }, children: { type: "array", items: { $ref: "#/components/schemas/Node" } } },
        },
      },
    },
  });

  it("compiles a recursive $ref body at a brace path without infinite loop", async () => {
    const v = createSpecValidator(recursiveDoc());
    const fns = v.compileBody(makeOp("POST", "/a~b/{id}", { operation_id: "createNode" }));
    const fn = fns.get("application/json");
    expect(fn).toBeTypeOf("function");
    // Smoke only (compilation correctness): a nested instance validates.
    expect(fn!({ id: "1", children: [{ id: "2", children: [] }] })).toBe(true);
  });

  it("compiles an INLINE body at a brace path (addresses the schema by its doc pointer)", async () => {
    // The body schema is inline (no $ref), so it's compiled via the operation's own
    // document pointer — `/paths/~1a~0b~1{id}/post/requestBody/content/.../schema` —
    // which carries the `{id}` braces in the URI fragment handed to Ajv. This is the
    // only path that exercises the inline (non-$ref) branch.
    const doc = {
      openapi: "3.1.0",
      info: { title: "T", version: "1" },
      paths: {
        "/a~b/{id}": {
          post: {
            operationId: "inlineOp",
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", required: ["name"], properties: { name: { type: "string" } }, additionalProperties: false },
                },
              },
            },
            responses: { "200": { description: "OK" } },
          },
        },
      },
      components: { schemas: {} },
    } as NormalizedDoc;
    const v = createSpecValidator(doc);
    const fn = v.compileBody(makeOp("POST", "/a~b/{id}", { operation_id: "inlineOp" })).get("application/json")!;
    expect(fn).toBeTypeOf("function");
    expect(fn({ name: "x" })).toBe(true);
    expect(fn({})).toBe(false); // required `name` missing → the inline schema bound, not a vacuous one
  });
});

// Body validation: run a compiled body validate-fn against a draft body and map
// Ajv's errors to the violation shape. Codes/messages are OURS (Ajv's
// keyword/message are implementation detail). Collect ALL violations. Schemas
// are literal inline docs; the enum case is reconciled from 3.0 (real normalizer).

// A literal 2020-12 doc with one inline request body at POST /t.
function docWithBody(schema: unknown): NormalizedDoc {
  return {
    openapi: "3.1.0",
    info: { title: "T", version: "1" },
    paths: {
      "/t": {
        post: {
          operationId: "op",
          requestBody: { content: { "application/json": { schema } } },
          responses: { "200": { description: "OK" } },
        },
      },
    },
    components: { schemas: {} },
  } as NormalizedDoc;
}

// Compile the POST /t body fn for a given (already-normalized) doc.
function bodyFnOf(doc: NormalizedDoc) {
  return createSpecValidator(doc).compileBody(makeOp("POST", "/t", { operation_id: "op" })).get("application/json")!;
}
// Compile + validate in one step for a literal 2020-12 body schema.
const validateLiteral = (schema: unknown, body: unknown): Violation[] => validateBody(bodyFnOf(docWithBody(schema)), body);
const codes = (vs: Violation[]) => vs.map((v) => v.code).sort();

describe("validateBody — maps Ajv errors to violations", () => {
  it("collects ALL violations at once, not just the first (collect-all + mapping)", () => {
    const schema = {
      type: "object",
      required: ["customer", "amount"],
      properties: { amount: { type: "integer" }, status: { enum: ["a", "b"] } },
      additionalProperties: false,
    };
    const vs = validateLiteral(schema, { amount: "x", status: "z", extra: 1 });
    expect(codes(vs)).toEqual(["additional_properties", "enum", "required", "type"]);
    expect(vs.find((v) => v.code === "required")?.pointer).toBe("/customer");
    expect(vs.find((v) => v.code === "type")?.pointer).toBe("/amount");
    expect(vs.find((v) => v.code === "enum")?.pointer).toBe("/status");
    expect(vs.find((v) => v.code === "additional_properties")?.pointer).toBe("/extra");
  });

  it("required → code + pointer at the missing property", () => {
    const vs = validateLiteral({ type: "object", required: ["customer"], properties: { customer: { type: "string" } } }, {});
    expect(vs).toEqual([
      { location: "body", pointer: "/customer", code: "required", message: "Missing required property 'customer'." },
    ]);
  });

  it("type → expected/actual JSON types + message", () => {
    const vs = validateLiteral({ type: "object", properties: { amount: { type: "integer" } } }, { amount: "x" });
    expect(vs).toEqual([
      { location: "body", pointer: "/amount", code: "type", message: "Expected integer, got string.", expected: "integer", actual: "string" },
    ]);
  });

  it("format → asserts (ajv-formats) and maps to code format", () => {
    const vs = validateLiteral({ type: "object", properties: { email: { type: "string", format: "email" } } }, { email: "nope" });
    expect(vs).toEqual([
      { location: "body", pointer: "/email", code: "format", message: "Value does not match format 'email'.", expected: "email", actual: "nope" },
    ]);
  });

  it("additionalProperties:false → reports the unknown property; silent schema does NOT (structural-only)", () => {
    const strict = { type: "object", properties: { name: { type: "string" } }, additionalProperties: false };
    expect(validateLiteral(strict, { name: "x", extra: 1 })).toEqual([
      { location: "body", pointer: "/extra", code: "additional_properties", message: "Unknown property 'extra' is not allowed." },
    ]);
    // No additionalProperties declared → unknown fields pass; we invent no strictness.
    const lenient = { type: "object", properties: { name: { type: "string" } } };
    expect(validateLiteral(lenient, { name: "x", extra: 1 })).toEqual([]);
  });

  it("unmapped keyword → reported as code constraint, never dropped (defends collect-all)", () => {
    const vs = validateLiteral({ type: "object", properties: { name: { type: "string", minLength: 3 } } }, { name: "a" });
    expect(vs).toHaveLength(1);
    expect(vs[0]?.code).toBe("constraint");
    expect(vs[0]?.pointer).toBe("/name");
    expect(vs[0]?.message).toContain("minLength");
  });

  it("nested violation → RFC-6901 pointer with the array index", () => {
    const schema = {
      type: "object",
      properties: { items: { type: "array", items: { type: "object", required: ["name"], properties: { name: { type: "string" } } } } },
    };
    const vs = validateLiteral(schema, { items: [{ name: "ok" }, {}] });
    expect(vs).toEqual([
      { location: "body", pointer: "/items/1/name", code: "required", message: "Missing required property 'name'." },
    ]);
  });

  it("a clean body → zero violations", () => {
    expect(validateLiteral({ type: "object", required: ["name"], properties: { name: { type: "string" } } }, { name: "x" })).toEqual([]);
  });

  // A 3.0 {nullable:true, enum:[...]} reconciles to {type:[T,"null"], enum:[...]},
  // which REJECTS null — spec-faithful: 3.0 requires null be listed in the enum
  // to be valid (OAI #1900). No normalizer change needed.
  it("enum (reconciled from 3.0 nullable-enum): rejects out-of-set AND null, accepts a listed member", async () => {
    const doc = (
      await normalize({
        openapi: "3.0.3",
        info: { title: "T", version: "1" },
        paths: {
          "/t": {
            post: {
              operationId: "op",
              requestBody: { content: { "application/json": { schema: { type: "object", properties: { status: { type: "string", nullable: true, enum: ["a", "b"] } } } } } },
              responses: { "200": { description: "OK" } },
            },
          },
        },
      })
    ).doc;
    const fn = bodyFnOf(doc);
    expect(validateBody(fn, { status: "z" })).toEqual([
      { location: "body", pointer: "/status", code: "enum", message: "Value is not one of the allowed values [a, b].", expected: ["a", "b"], actual: "z" },
    ]);
    expect(validateBody(fn, { status: "a" })).toEqual([]);
    // null rejected — the reconciliation is faithful (null not in the enum).
    expect(validateBody(fn, { status: null })).toEqual([
      { location: "body", pointer: "/status", code: "enum", message: "Value is not one of the allowed values [a, b].", expected: ["a", "b"], actual: null },
    ]);
  });
});

// Param validation: validate path/query/header/cookie params against their
// declared schemas via one synthetic object-schema per `in`-group (props are
// $ref-by-pointer into the registered doc, so internal refs resolve). Ajv's
// `required`/`additionalProperties` give missing-required/unknown for free;
// value violations reuse the body mapping with location threaded through.

// Build a doc with op-level and/or path-item-level parameters at `path`.
function paramsDoc(opts: { opParams?: unknown[]; pathParams?: unknown[]; path?: string; components?: Record<string, unknown> }): NormalizedDoc {
  const path = opts.path ?? "/t";
  const pathItem: Record<string, unknown> = {
    ...(opts.pathParams ? { parameters: opts.pathParams } : {}),
    post: { operationId: "op", parameters: opts.opParams ?? [], responses: { "200": { description: "OK" } } },
  };
  return {
    openapi: "3.1.0",
    info: { title: "T", version: "1" },
    paths: { [path]: pathItem },
    components: opts.components ?? { schemas: {} },
  } as NormalizedDoc;
}
const validateParamsFor = (doc: NormalizedDoc, draft: DraftParams, path = "/t"): Violation[] =>
  validateParams(createSpecValidator(doc).compileParams(makeOp("POST", path, { operation_id: "op" })), draft);

describe("validateParams — param validation", () => {
  it("resolves a param schema that $refs a component (the $ref-by-pointer hop)", () => {
    const doc = paramsDoc({
      opParams: [{ name: "status", in: "query", schema: { $ref: "#/components/schemas/Status" } }],
      components: { schemas: { Status: { type: "string", enum: ["active", "closed"] } } },
    });
    expect(validateParamsFor(doc, { query: { status: "bogus" } })).toEqual([
      { location: "query", pointer: "/status", code: "enum", message: "Value is not one of the allowed values [active, closed].", expected: ["active", "closed"], actual: "bogus" },
    ]);
  });

  it("missing required param → required (query), and path params are always required", () => {
    const q = paramsDoc({ opParams: [{ name: "customer_id", in: "query", required: true, schema: { type: "string" } }] });
    expect(validateParamsFor(q, { query: {} })).toEqual([
      { location: "query", pointer: "/customer_id", code: "required", message: "Missing required query parameter 'customer_id'." },
    ]);
    const p = paramsDoc({ path: "/p/{id}", opParams: [{ name: "id", in: "path", schema: { type: "string" } }] });
    expect(validateParamsFor(p, { path: {} }, "/p/{id}")).toEqual([
      { location: "path", pointer: "/id", code: "required", message: "Missing required path parameter 'id'." },
    ]);
  });

  it("param value violation reuses the body violation mapping with the param's location", () => {
    const doc = paramsDoc({ opParams: [{ name: "limit", in: "query", schema: { type: "integer" } }] });
    expect(validateParamsFor(doc, { query: { limit: "x" } })).toEqual([
      { location: "query", pointer: "/limit", code: "type", message: "Expected integer, got string.", expected: "integer", actual: "string" },
    ]);
  });

  it("unknown param: reported for query/path, allowed (no violation) for header/cookie", () => {
    const q = paramsDoc({ opParams: [{ name: "limit", in: "query", schema: { type: "integer" } }] });
    expect(validateParamsFor(q, { query: { limit: 5, foo: 1 } })).toEqual([
      { location: "query", pointer: "/foo", code: "unknown_param", message: "Unknown query parameter 'foo'." },
    ]);
    const p = paramsDoc({ path: "/p/{id}", opParams: [{ name: "id", in: "path", schema: { type: "string" } }] });
    expect(validateParamsFor(p, { path: { id: "x", extra: "y" } }, "/p/{id}")).toEqual([
      { location: "path", pointer: "/extra", code: "unknown_param", message: "Unknown path parameter 'extra'." },
    ]);
    // header: declared value validated + extras allowed (no unknown), required still enforced.
    const h = paramsDoc({ opParams: [{ name: "X-Trace", in: "header", required: true, schema: { type: "string" } }] });
    expect(validateParamsFor(h, { header: { "X-Trace": "abc", Authorization: "Bearer z" } })).toEqual([]);
    expect(validateParamsFor(h, { header: {} })).toEqual([
      { location: "header", pointer: "/X-Trace", code: "required", message: "Missing required header parameter 'X-Trace'." },
    ]);
    // cookie: extras allowed too.
    const c = paramsDoc({ opParams: [{ name: "sid", in: "cookie", schema: { type: "string" } }] });
    expect(validateParamsFor(c, { cookie: { sid: "a", csrf: "b" } })).toEqual([]);
  });

  it("merge: op-level overrides a path-item param on (name,in); path-item-only params are included", () => {
    const override = paramsDoc({
      pathParams: [{ name: "x", in: "query", required: false, schema: { type: "string" } }],
      opParams: [{ name: "x", in: "query", required: true, schema: { type: "integer" } }],
    });
    expect(validateParamsFor(override, { query: {} })).toEqual([
      { location: "query", pointer: "/x", code: "required", message: "Missing required query parameter 'x'." },
    ]);
    expect(validateParamsFor(override, { query: { x: "5" } })).toEqual([
      { location: "query", pointer: "/x", code: "type", message: "Expected integer, got string.", expected: "integer", actual: "string" },
    ]);
    const pathOnly = paramsDoc({ pathParams: [{ name: "y", in: "query", required: true, schema: { type: "string" } }], opParams: [] });
    expect(validateParamsFor(pathOnly, { query: {} })).toEqual([
      { location: "query", pointer: "/y", code: "required", message: "Missing required query parameter 'y'." },
    ]);
  });

  it("clean params → zero violations", () => {
    const doc = paramsDoc({ path: "/p/{id}", opParams: [
      { name: "limit", in: "query", required: true, schema: { type: "integer" } },
      { name: "id", in: "path", schema: { type: "string" } },
    ] });
    expect(validateParamsFor(doc, { query: { limit: 5 }, path: { id: "abc" } }, "/p/{id}")).toEqual([]);
  });

  it("collects ALL param violations — across in-groups AND within a group (collect-all)", () => {
    // path `id` bad value + two missing required query params in one call: proves
    // the across-group accumulation loop AND the within-group allErrors pass.
    const doc = paramsDoc({ path: "/p/{id}", opParams: [
      { name: "id", in: "path", schema: { type: "integer" } },
      { name: "a", in: "query", required: true, schema: { type: "string" } },
      { name: "b", in: "query", required: true, schema: { type: "string" } },
    ] });
    const vs = validateParamsFor(doc, { path: { id: "x" }, query: {} }, "/p/{id}");
    expect(vs).toHaveLength(3);
    expect(vs).toContainEqual({ location: "path", pointer: "/id", code: "type", message: "Expected integer, got string.", expected: "integer", actual: "string" });
    expect(vs).toContainEqual({ location: "query", pointer: "/a", code: "required", message: "Missing required query parameter 'a'." });
    expect(vs).toContainEqual({ location: "query", pointer: "/b", code: "required", message: "Missing required query parameter 'b'." });
  });

  it("schemaless/content-typed param → no compile throw; presence checked, value not", () => {
    const doc = paramsDoc({ opParams: [
      { name: "filter", in: "query", required: true, content: { "application/json": { schema: { type: "object" } } } },
    ] });
    expect(validateParamsFor(doc, { query: {} })).toEqual([
      { location: "query", pointer: "/filter", code: "required", message: "Missing required query parameter 'filter'." },
    ]);
    expect(validateParamsFor(doc, { query: { filter: 12345 } })).toEqual([]); // value not checked (no schema)
  });
});
