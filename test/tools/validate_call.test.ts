import { describe, it, expect } from "vitest";
import { join } from "node:path";

import { validateCallTool } from "../../src/tools/validate_call.js";
import { loadSpecTool } from "../../src/tools/load_spec.js";
import { InMemoryStore } from "../helpers/in-memory-store.js";
import type { ToolDeps } from "../../src/tools/index.js";

// Ops are loaded as inline specs via load_spec — NOT hand-built docs — because the
// handler reads indexer-populated store.getOperations/loadSnapshot. Core validation
// correctness lives in validator.test.ts; here we prove the WIRING + ok-vs-valid.

function payloadOf(result: { content: Array<{ type: string; text?: string }> }): any {
  return JSON.parse(result.content[0]!.text!);
}
function vc(store: InMemoryStore, args: Record<string, unknown>) {
  const deps: ToolDeps = { store };
  return validateCallTool.handler(args, deps);
}
const loadInline = (store: InMemoryStore, spec: object) =>
  loadSpecTool.handler({ source: JSON.stringify(spec), source_type: "inline" }, { store });
const loadFile = (store: InMemoryStore, path: string) =>
  loadSpecTool.handler({ source: path, source_type: "file" }, { store });
const PETSTORE = join(import.meta.dirname, "../../fixtures/openapi/clean/petstore-3.0.yaml");

const inlineSpec = (title: string, paths: object, components?: object) => ({
  openapi: "3.1.0",
  info: { title, version: "1" },
  paths,
  ...(components ? { components } : {}),
});

describe("validate_call — ok-vs-valid + end-to-end", () => {
  it("R1: known-good draft → ok:true, valid:true, no errors/warnings", async () => {
    const store = new InMemoryStore();
    await loadFile(store, PETSTORE);
    const p = payloadOf(await vc(store, { operation_id: "createPet", request: { body: { id: 1, name: "Rex" } } }));
    expect(p.ok).toBe(true);
    expect(p.valid).toBe(true);
    expect(p.errors).toEqual([]);
    expect(p.warnings).toEqual([]);
    expect(p.operation_key).toBe("POST:/pets");
  });

  it("R2: known-bad draft assembles body AND param violations into one errors list", async () => {
    const store = new InMemoryStore();
    await loadInline(store, inlineSpec("R2 Assembly", {
      "/orders": {
        post: {
          operationId: "createOrder",
          parameters: [{ name: "region", in: "query", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["customer"], properties: { customer: { type: "string" } } } } } },
          responses: { "200": { description: "OK" } },
        },
      },
    }));
    const p = payloadOf(await vc(store, { operation_id: "createOrder", request: { body: {}, query_params: {} } }));
    expect(p.ok).toBe(true);
    expect(p.valid).toBe(false);
    expect(p.errors).toContainEqual({ location: "body", pointer: "/customer", code: "required", message: "Missing required property 'customer'." });
    expect(p.errors).toContainEqual({ location: "query", pointer: "/region", code: "required", message: "Missing required query parameter 'region'." });
  });

  it("R3: resolution failures → ok:false structured error, no valid field", async () => {
    const store = new InMemoryStore();
    await loadFile(store, PETSTORE);
    const nf = payloadOf(await vc(store, { operation_key: "GET:/nope", request: {} }));
    expect(nf.ok).toBe(false);
    expect(nf.error.code).toBe("not_found");
    expect(nf.valid).toBeUndefined();
    const xor = payloadOf(await vc(store, { request: {} }));
    expect(xor.ok).toBe(false);
    expect(xor.error.code).toBe("invalid_input");
  });

  it("R4a: explicit content_type the op does not define → content_type violation", async () => {
    const store = new InMemoryStore();
    await loadFile(store, PETSTORE);
    const p = payloadOf(await vc(store, { operation_id: "createPet", request: { body: { id: 1, name: "x" }, content_type: "application/xml" } }));
    expect(p.ok).toBe(true);
    expect(p.valid).toBe(false);
    const v = p.errors.find((e: any) => e.code === "content_type");
    expect(v).toBeDefined();
    expect(v.location).toBe("body");
    expect(v.pointer).toBe("");
    expect(v.message).toContain("application/xml");
    expect(v.message).toContain("application/json"); // lists what the op DOES define
  });

  it("R4b: body supplied to a body-less operation → warning, valid stays true", async () => {
    const store = new InMemoryStore();
    await loadFile(store, PETSTORE);
    const p = payloadOf(await vc(store, { operation_id: "listPets", request: { body: { x: 1 } } }));
    expect(p.ok).toBe(true);
    expect(p.valid).toBe(true);
    expect(p.errors).toEqual([]);
    expect(p.warnings.length).toBeGreaterThan(0);
  });

  it("R4c: required body omitted → required body violation at pointer ''", async () => {
    const store = new InMemoryStore();
    await loadFile(store, PETSTORE);
    const p = payloadOf(await vc(store, { operation_id: "createPet", request: {} }));
    expect(p.valid).toBe(false);
    expect(p.errors).toContainEqual({ location: "body", pointer: "", code: "required", message: "Request body is required." });
  });

  it("R5: param fields route to the right in-group (incl. cookie_params)", async () => {
    const store = new InMemoryStore();
    await loadInline(store, inlineSpec("R5 Routing", {
      "/x": {
        get: {
          operationId: "routeOp",
          parameters: [
            { name: "q", in: "query", schema: { type: "string" } },
            { name: "h", in: "header", schema: { type: "string" } },
            { name: "c", in: "cookie", schema: { type: "string" } },
          ],
          responses: { "200": { description: "OK" } },
        },
      },
    }));
    // wrong-typed value in each param field → a `type` violation at the matching location.
    // If a field weren't routed, its value would never be validated (no type violation).
    const p = payloadOf(await vc(store, { operation_id: "routeOp", request: { query_params: { q: 1 }, headers: { h: 2 }, cookie_params: { c: 3 } } }));
    const at = (loc: string) => p.errors.find((e: any) => e.location === loc);
    expect(at("query")).toMatchObject({ pointer: "/q", code: "type" });
    expect(at("header")).toMatchObject({ pointer: "/h", code: "type" });
    expect(at("cookie")).toMatchObject({ pointer: "/c", code: "type" });
  });

  it("R6: param values validated as typed JSON — no coercion (end-to-end)", async () => {
    const store = new InMemoryStore();
    await loadInline(store, inlineSpec("R6 NoCoerce", {
      "/y": { get: { operationId: "numOp", parameters: [{ name: "n", in: "query", schema: { type: "integer" } }], responses: { "200": { description: "OK" } } } },
    }));
    expect(payloadOf(await vc(store, { operation_id: "numOp", request: { query_params: { n: 5 } } })).valid).toBe(true);
    const bad = payloadOf(await vc(store, { operation_id: "numOp", request: { query_params: { n: "5" } } }));
    expect(bad.valid).toBe(false);
    expect(bad.errors).toContainEqual({ location: "query", pointer: "/n", code: "type", message: "Expected integer, got string.", expected: "integer", actual: "string" });
  });

  it("R7: a schema that throws at Ajv compile → structured parse_error (not thrown)", async () => {
    // An invalid regex `pattern` passes the lenient parser but throws
    // when Ajv compiles it — the boundary the handler's try/catch must hold.
    const store = new InMemoryStore();
    const load = payloadOf(await loadInline(store, inlineSpec(
      "R7 Malformed",
      { "/z": { post: { operationId: "badOp", requestBody: { content: { "application/json": { schema: { type: "object", properties: { s: { type: "string", pattern: "(" } } } } } }, responses: { "200": { description: "OK" } } } } },
    )));
    expect(load.ok).toBe(true); // loads fine — the bad regex only bites at compile
    const p = payloadOf(await vc(store, { operation_id: "badOp", request: { body: { s: "x" } } }));
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("parse_error");
  });
});

describe("validate_call — strict multi-version", () => {
  // Same title → same spec_id slug; different content → two coexisting versions,
  // newest active. validate_call is the pre-finalize gate → strict on version-omitted.
  const widget = (version: string, withPost: boolean) => ({
    openapi: "3.1.0",
    info: { title: "Widget API", version },
    paths: {
      "/widgets": {
        get: { operationId: "listWidgets", responses: { "200": { description: "OK" } } },
        ...(withPost ? { post: { operationId: "createWidget", responses: { "201": { description: "Created" } } } } : {}),
      },
    },
  });

  it("strict: >1 loaded version, version omitted → ambiguous + details.loaded_versions, no valid field", async () => {
    const store = new InMemoryStore();
    await loadInline(store, widget("1.0.0", false));
    await loadInline(store, widget("2.0.0", true));
    const p = payloadOf(await vc(store, { operation_key: "GET:/widgets", request: {} }));
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("ambiguous");
    expect(p.error.details.loaded_versions).toHaveLength(2);
    expect(p.valid).toBeUndefined();
  });

  it("explicit version still resolves on a multi-version spec (escape hatch)", async () => {
    const store = new InMemoryStore();
    const r1 = payloadOf(await loadInline(store, widget("1.0.0", false)));
    await loadInline(store, widget("2.0.0", true));
    const p = payloadOf(await vc(store, { operation_key: "GET:/widgets", version: r1.version_id, request: {} }));
    expect(p.ok).toBe(true);
    expect(p.valid).toBe(true);
  });
});
