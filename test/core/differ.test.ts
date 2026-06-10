import { describe, it, expect } from "vitest";

import { diffOperations, diffTypes, classifyDiff, classifyTypes, type VersionSide, type DiffSummary, type DiffOptions } from "../../src/core/differ.js";
import { normalize } from "../../src/core/normalizer.js";
import { escapePointer } from "../../src/core/json-pointer.js";
import type { NormalizedDoc, Operation, TypeDef } from "../../src/store/store.js";

// Pure-unit: inline literal docs + hand-built Operation/TypeDef rows (the
// indexer's shape). Classification and tool wiring live in separate test files.

// An Operation row matching the indexer's output (operation_key + the openapi
// binding's method/path/pointers); only what the differ reads.
function makeOp(method: string, path: string, operation_id: string | null): Operation {
  const base = `/paths/${escapePointer(path)}/${method.toLowerCase()}`;
  return {
    spec_id: "s",
    version_id: "v",
    operation_key: `${method.toUpperCase()}:${path}`,
    operation_id,
    summary: null,
    description: null,
    tags: [],
    deprecated: false,
    openapi: {
      method: method.toUpperCase(),
      path,
      pointers: { params: `${base}/parameters`, requestBody: `${base}/requestBody`, responses: `${base}/responses` },
    },
  };
}

// Build a VersionSide from a `paths` object: the doc is a minimal normalized doc,
// and the Operation rows are derived from the path/method keys (operationId read
// from each op object when present). `typeDefs` defaults to [].
function side(
  paths: Record<string, Record<string, { operationId?: string } & Record<string, unknown>>>,
  typeDefs: TypeDef[] = [],
): VersionSide {
  const doc = { openapi: "3.1.0", info: { title: "T", version: "1" }, paths } as NormalizedDoc;
  const operations: Operation[] = [];
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(methods)) {
      operations.push(makeOp(method, path, op.operationId ?? null));
    }
  }
  return { doc, operations, typeDefs };
}

const ok = { responses: { "200": { description: "OK" } } };

describe("diffOperations — operation-level diff", () => {
  it("D1: identical inputs → empty diff", () => {
    const s = side({ "/a": { get: { operationId: "getA", ...ok } }, "/b": { post: { operationId: "createB", ...ok } } });
    // Two independent sides built from the same shape (distinct objects, equal content).
    const other = side({ "/a": { get: { operationId: "getA", ...ok } }, "/b": { post: { operationId: "createB", ...ok } } });
    expect(diffOperations(s, other)).toEqual({ added: [], removed: [], changed: [] });
  });

  it("D2: an operation only in `to` → added", () => {
    const from = side({ "/a": { get: { operationId: "getA", ...ok } } });
    const to = side({ "/a": { get: { operationId: "getA", ...ok } }, "/b": { post: { operationId: "createB", ...ok } } });
    expect(diffOperations(from, to)).toEqual({
      added: [{ operation_key: "POST:/b", method: "POST", path: "/b", operation_id: "createB" }],
      removed: [],
      changed: [],
    });
  });

  it("D3: an operation only in `from` → removed", () => {
    const from = side({ "/a": { get: { operationId: "getA", ...ok } }, "/b": { post: { operationId: "createB", ...ok } } });
    const to = side({ "/a": { get: { operationId: "getA", ...ok } } });
    expect(diffOperations(from, to)).toEqual({
      added: [],
      removed: [{ operation_key: "POST:/b", method: "POST", path: "/b", operation_id: "createB" }],
      changed: [],
    });
  });

  it("D4: a shared op whose subtree differs → changed; a byte-identical shared op → not changed", () => {
    const from = side({
      "/a": { get: { operationId: "getA", responses: { "200": { description: "OK" } } } },
      "/c": { get: { operationId: "getC", ...ok } },
    });
    const to = side({
      "/a": { get: { operationId: "getA", responses: { "200": { description: "OK" }, "404": { description: "Not found" } } } },
      "/c": { get: { operationId: "getC", ...ok } },
    });
    const diff = diffOperations(from, to);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.operation_key).toBe("GET:/a");
    // response 404 is added — itemized
    expect(diff.changed[0]!.changes).toContainEqual({ kind: "response_added", pointer: "/404" });
    // /c is byte-identical → not in changed
    expect(diff.changed.map((c) => c.operation_key)).not.toContain("GET:/c");
  });

  it("D5: the same logical API in 3.0 vs 3.1, both normalized → empty diff (the seam)", async () => {
    const raw30 = {
      openapi: "3.0.3",
      info: { title: "S", version: "1" },
      paths: { "/x": { post: { operationId: "op", requestBody: { content: { "application/json": { schema: { type: "object", properties: { s: { type: "string", nullable: true } } } } } }, ...ok } } },
    };
    const raw31 = {
      openapi: "3.1.0",
      info: { title: "S", version: "1" },
      paths: { "/x": { post: { operationId: "op", requestBody: { content: { "application/json": { schema: { type: "object", properties: { s: { type: ["string", "null"] } } } } } }, ...ok } } },
    };
    const from: VersionSide = { doc: (await normalize(raw30)).doc, operations: [makeOp("POST", "/x", "op")], typeDefs: [] };
    const to: VersionSide = { doc: (await normalize(raw31)).doc, operations: [makeOp("POST", "/x", "op")], typeDefs: [] };
    expect(diffOperations(from, to)).toEqual({ added: [], removed: [], changed: [] });
  });

  it("D_struct: a doc-only change (summary/description/tags/x-ext, op + param level) is NOT changed", () => {
    const from = side({ "/a": { get: { operationId: "getA", summary: "Old", description: "old", tags: ["A"], "x-owner": "team1", parameters: [{ name: "q", in: "query", required: false, description: "old", schema: { type: "string" } }], ...ok } } });
    const to = side({ "/a": { get: { operationId: "getA", summary: "New", description: "new", tags: ["B"], "x-owner": "team2", parameters: [{ name: "q", in: "query", required: false, description: "new", schema: { type: "string" } }], ...ok } } });
    expect(diffOperations(from, to)).toEqual({ added: [], removed: [], changed: [] });
  });

  it("a structural change to a body property NAMED 'description' is still detected (no over-strip)", () => {
    const from = side({ "/a": { post: { operationId: "createA", requestBody: { content: { "application/json": { schema: { type: "object", properties: { description: { type: "string" } } } } } }, ...ok } } });
    const to = side({ "/a": { post: { operationId: "createA", requestBody: { content: { "application/json": { schema: { type: "object", properties: { description: { type: "integer" } } } } } }, ...ok } } });
    expect(diffOperations(from, to).changed.map((c) => c.operation_key)).toEqual(["POST:/a"]);
  });

  it("a structural change (operationId rename) IS changed even with descriptions stripped", () => {
    const from = side({ "/a": { get: { operationId: "getA", description: "same", ...ok } } });
    const to = side({ "/a": { get: { operationId: "fetchA", description: "same", ...ok } } });
    expect(diffOperations(from, to).changed.map((c) => c.operation_key)).toEqual(["GET:/a"]);
  });

  it("D6: added + removed + changed compose in one diff", () => {
    const from = side({
      "/a": { get: { operationId: "getA", ...ok } },                                  // unchanged
      "/b": { post: { operationId: "createB", responses: { "200": { description: "OK" } } } }, // changed
      "/c": { delete: { operationId: "deleteC", ...ok } },                            // removed
    });
    const to = side({
      "/a": { get: { operationId: "getA", ...ok } },
      "/b": { post: { operationId: "createB", responses: { "201": { description: "Created" } } } },
      "/d": { get: { operationId: "getD", ...ok } },                                  // added
    });
    const diff = diffOperations(from, to);
    expect(diff.added).toEqual([{ operation_key: "GET:/d", method: "GET", path: "/d", operation_id: "getD" }]);
    expect(diff.removed).toEqual([{ operation_key: "DELETE:/c", method: "DELETE", path: "/c", operation_id: "deleteC" }]);
    // POST:/b changed 200→201; itemized
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.operation_key).toBe("POST:/b");
    expect(diff.changed[0]!.changes).toContainEqual({ kind: "response_removed", pointer: "/200" });
    expect(diff.changed[0]!.changes).toContainEqual({ kind: "response_added", pointer: "/201" });
  });
});

const baseBody = {
  required: true,
  content: { "application/json": { schema: { type: "object", properties: { amount: { type: "string" } } } } },
};

describe("diffOperations — change itemization", () => {
  it("C1: param added to 'to' → param_added entry in changes", () => {
    const from = side({ "/a": { get: { operationId: "getA", ...ok } } });
    const to = side({ "/a": { get: { operationId: "getA", parameters: [{ name: "q", in: "query", required: false, schema: { type: "string" } }], ...ok } } });
    const diff = diffOperations(from, to);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.changes).toContainEqual({ kind: "param_added", pointer: "/q", required: false });
  });

  it("C2: param removed from 'to' → param_removed entry in changes", () => {
    const from = side({ "/a": { get: { operationId: "getA", parameters: [{ name: "q", in: "query", required: false, schema: { type: "string" } }], ...ok } } });
    const to = side({ "/a": { get: { operationId: "getA", ...ok } } });
    expect(diffOperations(from, to).changed[0]!.changes).toContainEqual({ kind: "param_removed", pointer: "/q", required: false });
  });

  it("C3: inline request body — new optional field → request_field_added{required:false}", () => {
    const from = side({ "/a": { post: { operationId: "createA", requestBody: baseBody, ...ok } } });
    const to = side({ "/a": { post: { operationId: "createA", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { amount: { type: "string" }, metadata: { type: "object" } } } } } }, ...ok } } });
    expect(diffOperations(from, to).changed[0]!.changes).toContainEqual({ kind: "request_field_added", pointer: "/metadata", required: false });
  });

  it("C4: inline request body — new required field → request_field_added{required:true}", () => {
    const from = side({ "/a": { post: { operationId: "createA", requestBody: baseBody, ...ok } } });
    const to = side({ "/a": { post: { operationId: "createA", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { amount: { type: "string" }, idempotency_key: { type: "string" } }, required: ["idempotency_key"] } } } }, ...ok } } });
    expect(diffOperations(from, to).changed[0]!.changes).toContainEqual({ kind: "request_field_added", pointer: "/idempotency_key", required: true });
  });

  it("C5: existing field gains required → required_added; loses it → required_removed", () => {
    const v1 = side({ "/a": { post: { operationId: "createA", requestBody: { content: { "application/json": { schema: { type: "object", properties: { amount: { type: "string" } } } } } }, ...ok } } });
    const v2 = side({ "/a": { post: { operationId: "createA", requestBody: { content: { "application/json": { schema: { type: "object", properties: { amount: { type: "string" } }, required: ["amount"] } } } }, ...ok } } });
    expect(diffOperations(v1, v2).changed[0]!.changes).toContainEqual({ kind: "required_added", pointer: "/amount" });
    expect(diffOperations(v2, v1).changed[0]!.changes).toContainEqual({ kind: "required_removed", pointer: "/amount" });
  });

  it("C6: shared field type narrows → type_changed{from, to}", () => {
    const fromSide = side({ "/a": { post: { operationId: "createA", requestBody: { content: { "application/json": { schema: { type: "object", properties: { amount: { type: "string" } } } } } }, ...ok } } });
    const toSide = side({ "/a": { post: { operationId: "createA", requestBody: { content: { "application/json": { schema: { type: "object", properties: { amount: { type: "integer" } } } } } }, ...ok } } });
    expect(diffOperations(fromSide, toSide).changed[0]!.changes).toContainEqual({ kind: "type_changed", pointer: "/amount", from: "string", to: "integer" });
  });

  it("C7: response status added → response_added; removed → response_removed", () => {
    const v1 = side({ "/a": { get: { operationId: "getA", responses: { "200": { description: "OK" } } } } });
    const v2 = side({ "/a": { get: { operationId: "getA", responses: { "200": { description: "OK" }, "404": { description: "Not found" } } } } });
    expect(diffOperations(v1, v2).changed[0]!.changes).toContainEqual({ kind: "response_added", pointer: "/404" });
    expect(diffOperations(v2, v1).changed[0]!.changes).toContainEqual({ kind: "response_removed", pointer: "/404" });
  });

  it("C8: $ref'd request body with unchanged ref string → op NOT in changed (field changes route to types)", () => {
    // The $ref string is identical on both sides; Invoice schema differs only in components.
    // diffOperations must NOT flag the op as changed — only diffTypes will.
    const paths = { "/a": { post: { operationId: "createA", requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Invoice" } } } }, responses: { "200": { description: "OK" } } } } };
    const fromDoc = { openapi: "3.1.0", info: { title: "T", version: "1" }, paths, components: { schemas: { Invoice: { type: "object", properties: { id: { type: "string" } } } } } } as NormalizedDoc;
    const toDoc = { openapi: "3.1.0", info: { title: "T", version: "1" }, paths, components: { schemas: { Invoice: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } } } } as NormalizedDoc;
    const op = makeOp("POST", "/a", "createA");
    const fromSide: VersionSide = { doc: fromDoc, operations: [op], typeDefs: [] };
    const toSide: VersionSide = { doc: toDoc, operations: [op], typeDefs: [] };
    expect(diffOperations(fromSide, toSide).changed.map((c) => c.operation_key)).not.toContain("POST:/a");
  });

  it("C9: multiple changes on one op are deterministically ordered by (pointer, kind)", () => {
    const fromSide = side({
      "/a": { get: { operationId: "getA", parameters: [{ name: "b", in: "query", schema: { type: "string" } }, { name: "a", in: "query", schema: { type: "string" } }], responses: { "200": { description: "OK" } } } },
    });
    const toSide = side({
      "/a": { get: { operationId: "getA", parameters: [{ name: "a", in: "query", schema: { type: "string" } }, { name: "c", in: "query", schema: { type: "string" } }], responses: { "200": { description: "OK" }, "404": { description: "Not found" } } } },
    });
    const changes = diffOperations(fromSide, toSide).changed[0]!.changes;
    const pointers = changes.map((c) => c.pointer);
    // All expected kinds present
    expect(pointers).toContain("/b");   // param_removed
    expect(pointers).toContain("/c");   // param_added
    expect(pointers).toContain("/404"); // response_added
    // Ordered: pointer sort is lexicographic; "/404" < "/b" < "/c"
    expect(pointers).toEqual([...pointers].sort());
  });

  it("Guard: a changed op whose delta is outside the kind menu (security toggle) stays in changed with changes:[]", () => {
    // Security is structural (not stripped) so the op IS in changed, but it's not
    // itemized — changes stays []. This guard ensures non-itemizable ops aren't silently dropped.
    const fromSide = side({ "/a": { get: { operationId: "getA", security: [], ...ok } } });
    const toSide = side({ "/a": { get: { operationId: "getA", security: [{ apiKey: [] }], ...ok } } });
    const diff = diffOperations(fromSide, toSide);
    expect(diff.changed.map((c) => c.operation_key)).toContain("GET:/a");
    expect(diff.changed.find((c) => c.operation_key === "GET:/a")!.changes).toEqual([]);
  });
});

describe("diffOperations — recursive request-body schema diff (#6)", () => {
  const bodyOf = (schema: unknown) => ({ required: true, content: { "application/json": { schema } } });
  const post = (from: unknown, to: unknown) => {
    const fromSide = side({ "/a": { post: { operationId: "createA", requestBody: bodyOf(from), ...ok } } });
    const toSide = side({ "/a": { post: { operationId: "createA", requestBody: bodyOf(to), ...ok } } });
    return diffOperations(fromSide, toSide).changed[0]?.changes ?? [];
  };
  const obj = (properties: Record<string, unknown>, required?: string[]) => ({ type: "object", properties, ...(required ? { required } : {}) });

  it("a type change on a NESTED object property → type_changed with a deep pointer", () => {
    const from = obj({ user: obj({ age: { type: "string" } }) });
    const to = obj({ user: obj({ age: { type: "integer" } }) });
    expect(post(from, to)).toContainEqual({ kind: "type_changed", pointer: "/user/age", from: "string", to: "integer" });
  });

  it("a field added/removed on a nested object → request_field_added/removed with a deep pointer", () => {
    const from = obj({ user: obj({ name: { type: "string" } }) });
    const to = obj({ user: obj({ name: { type: "string" }, email: { type: "string" } }) });
    expect(post(from, to)).toContainEqual({ kind: "request_field_added", pointer: "/user/email", required: false });
    expect(post(to, from)).toContainEqual({ kind: "request_field_removed", pointer: "/user/email", required: false });
  });

  it("a required-flip on a nested field → required_added/removed with a deep pointer", () => {
    const from = obj({ user: obj({ age: { type: "integer" } }) });
    const to = obj({ user: obj({ age: { type: "integer" } }, ["age"]) });
    expect(post(from, to)).toContainEqual({ kind: "required_added", pointer: "/user/age" });
    expect(post(to, from)).toContainEqual({ kind: "required_removed", pointer: "/user/age" });
  });

  it("a property whose $ref target changes → ref_changed carrying from/to ref strings", () => {
    const from = obj({ pet: { $ref: "#/components/schemas/Cat" } });
    const to = obj({ pet: { $ref: "#/components/schemas/Dog" } });
    expect(post(from, to)).toContainEqual({ kind: "ref_changed", pointer: "/pet", from: "#/components/schemas/Cat", to: "#/components/schemas/Dog" });
  });

  it("a property reshaped between $ref and inline → ref_changed with a null on the inline side", () => {
    const from = obj({ pet: { $ref: "#/components/schemas/Cat" } });
    const to = obj({ pet: { type: "object" } });
    expect(post(from, to)).toContainEqual({ kind: "ref_changed", pointer: "/pet", from: "#/components/schemas/Cat", to: null });
  });

  it("a property with the SAME $ref on both sides → no ref_changed (the type dimension owns it)", () => {
    // The op is changed for another reason (a sibling field) so it enters `changed`;
    // the unchanged $ref property must not itemize.
    const from = obj({ pet: { $ref: "#/components/schemas/Cat" }, n: { type: "string" } });
    const to = obj({ pet: { $ref: "#/components/schemas/Cat" }, n: { type: "integer" } });
    const changes = post(from, to);
    expect(changes.find((c) => c.pointer === "/pet")).toBeUndefined();
    expect(changes).toContainEqual({ kind: "type_changed", pointer: "/n", from: "string", to: "integer" });
  });

  it("recursion is depth-bounded: a within-bound deep change itemizes; a far-deeper one does not (op still changed)", () => {
    // Build a chain `l0.l1...lN.leaf`. A shallow change is itemized at its full
    // pointer; a change far below the depth cap is not itemized, but the op is
    // still flagged changed by the canonical compare (never silently dropped).
    const chain = (depth: number, leaf: unknown): unknown => {
      let node: unknown = leaf;
      for (let i = depth; i >= 0; i--) node = obj({ [`l${i}`]: node });
      return node;
    };
    const shallowFrom = chain(2, obj({ leaf: { type: "string" } }));
    const shallowTo = chain(2, obj({ leaf: { type: "integer" } }));
    expect(post(shallowFrom, shallowTo)).toContainEqual({ kind: "type_changed", pointer: "/l0/l1/l2/leaf", from: "string", to: "integer" });

    const deepFrom = chain(9, obj({ leaf: { type: "string" } }));
    const deepTo = chain(9, obj({ leaf: { type: "integer" } }));
    const deepChanges = post(deepFrom, deepTo);
    expect(deepChanges.find((c) => c.pointer.endsWith("/leaf"))).toBeUndefined();
    const fromSide = side({ "/a": { post: { operationId: "createA", requestBody: bodyOf(deepFrom), ...ok } } });
    const toSide = side({ "/a": { post: { operationId: "createA", requestBody: bodyOf(deepTo), ...ok } } });
    expect(diffOperations(fromSide, toSide).changed.map((c) => c.operation_key)).toContain("POST:/a");
  });
});

describe("diffOperations — array-valued `type` equality (no false-positive type_changed)", () => {
  const obj = (properties: Record<string, unknown>, required?: string[]) => ({ type: "object", properties, ...(required ? { required } : {}) });
  const bodyOf = (schema: unknown) => ({ required: true, content: { "application/json": { schema } } });

  it("an unchanged union/nullable field (`type:[...]`) is not flagged type_changed", () => {
    // `["string","null"]` is two distinct array objects across the two docs;
    // a reference compare would spuriously flag it breaking.
    const from = obj({ a: { type: ["string", "null"] }, b: { type: "string" } });
    const to = obj({ a: { type: ["string", "null"] }, b: { type: "integer" } });
    const fromSide = side({ "/a": { post: { operationId: "createA", requestBody: bodyOf(from), ...ok } } });
    const toSide = side({ "/a": { post: { operationId: "createA", requestBody: bodyOf(to), ...ok } } });
    const changes = diffOperations(fromSide, toSide).changed[0]!.changes;
    expect(changes.find((c) => c.pointer === "/a")).toBeUndefined();
    expect(changes).toContainEqual({ kind: "type_changed", pointer: "/b", from: "string", to: "integer" });
  });

  it("through the real normalizer: a 3.0 nullable nested field that only changes elsewhere is not spuriously flagged", async () => {
    // normalize turns `nullable:true` into `type:["string","null"]`; the nested
    // `profile.nickname` is unchanged, only `profile.age` changes.
    const spec = (ageType: string) => ({
      openapi: "3.0.3",
      info: { title: "S", version: "1" },
      paths: { "/u": { post: { operationId: "createU", requestBody: { content: { "application/json": { schema: { type: "object", properties: { profile: { type: "object", properties: { nickname: { type: "string", nullable: true }, age: { type: ageType } } } } } } } }, ...ok } } },
    });
    const from: VersionSide = { doc: (await normalize(spec("string"))).doc, operations: [makeOp("POST", "/u", "createU")], typeDefs: [] };
    const to: VersionSide = { doc: (await normalize(spec("integer"))).doc, operations: [makeOp("POST", "/u", "createU")], typeDefs: [] };
    const changes = diffOperations(from, to).changed[0]!.changes;
    expect(changes.find((c) => c.pointer === "/profile/nickname")).toBeUndefined();
    expect(changes).toContainEqual({ kind: "type_changed", pointer: "/profile/age", from: "string", to: "integer" });
  });

  it("an unchanged union-typed param is not flagged param_type_changed", () => {
    const param = (name: string, type: unknown) => ({ name, in: "query", required: false, schema: { type } });
    const fromSide = side({ "/a": { get: { operationId: "getA", parameters: [param("a", ["string", "null"]), param("b", "string")], ...ok } } });
    const toSide = side({ "/a": { get: { operationId: "getA", parameters: [param("a", ["string", "null"]), param("b", "integer")], ...ok } } });
    const changes = diffOperations(fromSide, toSide).changed[0]!.changes;
    expect(changes.find((c) => c.kind === "param_type_changed" && c.pointer === "/a")).toBeUndefined();
    expect(changes).toContainEqual({ kind: "param_type_changed", pointer: "/b", from: "string", to: "integer" });
  });
});

describe("classifyDiff — ref_changed classification (#6)", () => {
  it("a ref_changed is breaking (the referenced shape changed identity)", () => {
    const fromSide = side({ "/a": { post: { operationId: "createA", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { pet: { $ref: "#/components/schemas/Cat" } } } } } }, ...ok } } });
    const toSide = side({ "/a": { post: { operationId: "createA", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { pet: { $ref: "#/components/schemas/Dog" } } } } } }, ...ok } } });
    const change = classifyDiff(diffOperations(fromSide, toSide)).changed[0]!.changes.find((c) => c.kind === "ref_changed")!;
    expect(change.classification).toBe("breaking");
  });
});

describe("diffOperations — response-body field itemization (#4)", () => {
  const obj = (properties: Record<string, unknown>, required?: string[]) => ({ type: "object", properties, ...(required ? { required } : {}) });
  const resp = (schema: unknown) => ({ "200": { description: "OK", content: { "application/json": { schema } } } });
  const get = (from: unknown, to: unknown) => {
    const fromSide = side({ "/a": { get: { operationId: "getA", responses: resp(from) } } });
    const toSide = side({ "/a": { get: { operationId: "getA", responses: resp(to) } } });
    return diffOperations(fromSide, toSide).changed[0]?.changes ?? [];
  };
  const classifyGet = (from: unknown, to: unknown) => {
    const fromSide = side({ "/a": { get: { operationId: "getA", responses: resp(from) } } });
    const toSide = side({ "/a": { get: { operationId: "getA", responses: resp(to) } } });
    return classifyDiff(diffOperations(fromSide, toSide)).changed[0]!.changes;
  };

  it("a field added to a response body → response_field_added at /<status>/<field>, non_breaking", () => {
    const changes = classifyGet(obj({ id: { type: "string" } }), obj({ id: { type: "string" }, name: { type: "string" } }));
    expect(changes).toContainEqual({ kind: "response_field_added", pointer: "/200/name", required: false, classification: "non_breaking" });
  });

  it("a field removed from a response body → response_field_removed, breaking (a caller relied on it)", () => {
    const changes = classifyGet(obj({ id: { type: "string" }, name: { type: "string" } }), obj({ id: { type: "string" } }));
    expect(changes).toContainEqual({ kind: "response_field_removed", pointer: "/200/name", required: false, classification: "breaking" });
  });

  it("a response field type change → response_field_type_changed, breaking", () => {
    const changes = classifyGet(obj({ amount: { type: "string" } }), obj({ amount: { type: "integer" } }));
    expect(changes).toContainEqual({ kind: "response_field_type_changed", pointer: "/200/amount", from: "string", to: "integer", classification: "breaking" });
  });

  it("response required flips invert the request semantics: added → non_breaking, removed → breaking", () => {
    const added = classifyGet(obj({ id: { type: "string" } }), obj({ id: { type: "string" } }, ["id"]));
    expect(added).toContainEqual({ kind: "response_required_added", pointer: "/200/id", classification: "non_breaking" });
    const removed = classifyGet(obj({ id: { type: "string" } }, ["id"]), obj({ id: { type: "string" } }));
    expect(removed).toContainEqual({ kind: "response_required_removed", pointer: "/200/id", classification: "breaking" });
  });

  it("a response field $ref-retarget → response_ref_changed, breaking", () => {
    const changes = classifyGet(obj({ pet: { $ref: "#/components/schemas/Cat" } }), obj({ pet: { $ref: "#/components/schemas/Dog" } }));
    expect(changes).toContainEqual({ kind: "response_ref_changed", pointer: "/200/pet", from: "#/components/schemas/Cat", to: "#/components/schemas/Dog", classification: "breaking" });
  });

  it("a $ref'd response body (whole schema is a $ref) is not itemized (routes to the types dimension)", () => {
    const changes = get({ $ref: "#/components/schemas/Invoice" }, { $ref: "#/components/schemas/Invoice" });
    expect(changes.filter((c) => c.pointer.startsWith("/200/"))).toEqual([]);
  });
});

describe("diffTypes — types dimension", () => {
  function td(name: string): TypeDef {
    return { spec_id: "s", version_id: "v", name, kind: "object", pointer: `/components/schemas/${name}`, description: null };
  }
  function typeSide(typeDefs: TypeDef[], schemas: Record<string, unknown> = {}): VersionSide {
    const doc = { openapi: "3.1.0", info: { title: "T", version: "1" }, paths: {}, components: { schemas } } as NormalizedDoc;
    return { doc, operations: [], typeDefs };
  }

  it("T1: TypeDef only in 'to' → types.added", () => {
    const from = typeSide([]);
    const to = typeSide([td("Invoice")], { Invoice: { type: "object" } });
    expect(diffTypes(from, to)).toEqual({ added: ["Invoice"], removed: [], changed: [] });
  });

  it("T2: TypeDef only in 'from' → types.removed", () => {
    const from = typeSide([td("Invoice")], { Invoice: { type: "object" } });
    const to = typeSide([]);
    expect(diffTypes(from, to)).toEqual({ added: [], removed: ["Invoice"], changed: [] });
  });

  it("T3: same-name TypeDef whose component subtree differs → types.changed, itemized", () => {
    const from = typeSide([td("Invoice")], { Invoice: { type: "object", properties: { id: { type: "string" } } } });
    const to = typeSide([td("Invoice")], { Invoice: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } });
    expect(diffTypes(from, to)).toEqual({ added: [], removed: [], changed: [{ name: "Invoice", changes: [{ kind: "request_field_added", pointer: "/name", required: false }] }] });
  });

  it("T4: description-only TypeDef change → NOT changed (structural strip holds)", () => {
    const from = typeSide([td("Invoice")], { Invoice: { type: "object", description: "old" } });
    const to = typeSide([td("Invoice")], { Invoice: { type: "object", description: "new" } });
    expect(diffTypes(from, to)).toEqual({ added: [], removed: [], changed: [] });
  });

  it("T5: a description-only TypeDef change IS changed when includeDescriptions is set", () => {
    const from = typeSide([td("Invoice")], { Invoice: { type: "object", description: "old" } });
    const to = typeSide([td("Invoice")], { Invoice: { type: "object", description: "new" } });
    // Flagged changed, but a description-only delta itemizes to nothing.
    expect(diffTypes(from, to, { includeDescriptions: true })).toEqual({ added: [], removed: [], changed: [{ name: "Invoice", changes: [] }] });
  });

  it("T6: a changed type is itemized into field changes via the recursive engine (#7)", () => {
    const from = typeSide([td("Invoice")], { Invoice: { type: "object", properties: { id: { type: "string" }, amount: { type: "string" } } } });
    const to = typeSide([td("Invoice")], { Invoice: { type: "object", properties: { id: { type: "string" }, amount: { type: "integer" }, status: { type: "string" } } } });
    const changed = diffTypes(from, to).changed;
    expect(changed).toEqual([
      {
        name: "Invoice",
        changes: [
          { kind: "type_changed", pointer: "/amount", from: "string", to: "integer" },
          { kind: "request_field_added", pointer: "/status", required: false },
        ],
      },
    ]);
  });
});

describe("classifyTypes — type classification + counts (#8)", () => {
  it("removed→breaking, added→non_breaking, changed-type changes counted by their classification", () => {
    const typesDiff = {
      added: ["NewType"],
      removed: ["OldType"],
      changed: [
        {
          name: "Invoice",
          changes: [
            { kind: "type_changed" as const, pointer: "/amount", from: "string", to: "integer" },
            { kind: "request_field_added" as const, pointer: "/status", required: false },
          ],
        },
      ],
    };
    const classified = classifyTypes(typesDiff);
    // removed OldType (breaking) + amount type_changed (breaking) = 2 breaking;
    // added NewType (non_breaking) + status added optional (non_breaking) = 2 non_breaking.
    expect(classified.summary).toEqual({ breaking: 2, non_breaking: 2, unknown: 0 });
    // Each itemized change carries its classification (consistent with operations).
    expect(classified.changed[0]!.changes).toContainEqual({ kind: "type_changed", pointer: "/amount", from: "string", to: "integer", classification: "breaking" });
    expect(classified.changed[0]!.changes).toContainEqual({ kind: "request_field_added", pointer: "/status", required: false, classification: "non_breaking" });
  });
});

// Helper: build a one-op VersionSide for classification tests
function classifySide(paths: Record<string, Record<string, { operationId?: string } & Record<string, unknown>>>): VersionSide {
  return side(paths);
}

describe("classifyDiff — classification heuristic", () => {
  it("P1: param_added carries required:false for an optional param", () => {
    const from = classifySide({ "/a": { get: { operationId: "getA", ...ok } } });
    const to = classifySide({ "/a": { get: { operationId: "getA", parameters: [{ name: "q", in: "query", required: false, schema: { type: "string" } }], ...ok } } });
    const changes = diffOperations(from, to).changed[0]!.changes;
    expect(changes).toContainEqual({ kind: "param_added", pointer: "/q", required: false });
  });

  it("K1: required param added → breaking", () => {
    const from = classifySide({ "/a": { get: { operationId: "getA", ...ok } } });
    const to = classifySide({ "/a": { get: { operationId: "getA", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], ...ok } } });
    const classified = classifyDiff(diffOperations(from, to));
    const change = classified.changed[0]!.changes.find((c) => c.kind === "param_added")!;
    expect(change.classification).toBe("breaking");
  });

  it("K2: optional param added → non_breaking", () => {
    const from = classifySide({ "/a": { get: { operationId: "getA", ...ok } } });
    const to = classifySide({ "/a": { get: { operationId: "getA", parameters: [{ name: "q", in: "query", required: false, schema: { type: "string" } }], ...ok } } });
    const classified = classifyDiff(diffOperations(from, to));
    const change = classified.changed[0]!.changes.find((c) => c.kind === "param_added")!;
    expect(change.classification).toBe("non_breaking");
  });

  it("K3: param removed → non_breaking (regardless of required)", () => {
    const from = classifySide({ "/a": { get: { operationId: "getA", parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }], ...ok } } });
    const to = classifySide({ "/a": { get: { operationId: "getA", ...ok } } });
    const classified = classifyDiff(diffOperations(from, to));
    const change = classified.changed[0]!.changes.find((c) => c.kind === "param_removed")!;
    expect(change.classification).toBe("non_breaking");
  });

  it("K4: request_field_added{required:true} → breaking", () => {
    const from = classifySide({ "/a": { post: { operationId: "createA", requestBody: { content: { "application/json": { schema: { type: "object", properties: { amount: { type: "string" } } } } } }, ...ok } } });
    const to = classifySide({ "/a": { post: { operationId: "createA", requestBody: { content: { "application/json": { schema: { type: "object", properties: { amount: { type: "string" }, idempotency_key: { type: "string" } }, required: ["idempotency_key"] } } } }, ...ok } } });
    const classified = classifyDiff(diffOperations(from, to));
    const change = classified.changed[0]!.changes.find((c) => c.kind === "request_field_added" && c.pointer === "/idempotency_key")!;
    expect(change.classification).toBe("breaking");
  });

  it("K5: request_field_added{required:false} → non_breaking", () => {
    const from = classifySide({ "/a": { post: { operationId: "createA", requestBody: { content: { "application/json": { schema: { type: "object", properties: { amount: { type: "string" } } } } } }, ...ok } } });
    const to = classifySide({ "/a": { post: { operationId: "createA", requestBody: { content: { "application/json": { schema: { type: "object", properties: { amount: { type: "string" }, metadata: { type: "object" } } } } } }, ...ok } } });
    const classified = classifyDiff(diffOperations(from, to));
    const change = classified.changed[0]!.changes.find((c) => c.kind === "request_field_added" && c.pointer === "/metadata")!;
    expect(change.classification).toBe("non_breaking");
  });

  it("K6: request_field_removed{required:true} → breaking", () => {
    const from = classifySide({ "/a": { post: { operationId: "createA", requestBody: { content: { "application/json": { schema: { type: "object", properties: { amount: { type: "string" } }, required: ["amount"] } } } }, ...ok } } });
    const to = classifySide({ "/a": { post: { operationId: "createA", requestBody: { content: { "application/json": { schema: { type: "object", properties: {} } } } }, ...ok } } });
    const classified = classifyDiff(diffOperations(from, to));
    const change = classified.changed[0]!.changes.find((c) => c.kind === "request_field_removed" && c.pointer === "/amount")!;
    expect(change.classification).toBe("breaking");
  });

  it("K6b: request_field_removed{required:false} → non_breaking (an optional field dropped)", () => {
    // `amount` is NOT in `required` on `from`; removing it → request_field_removed{required:false}.
    const from = classifySide({ "/a": { post: { operationId: "createA", requestBody: { content: { "application/json": { schema: { type: "object", properties: { amount: { type: "string" } } } } } }, ...ok } } });
    const to = classifySide({ "/a": { post: { operationId: "createA", requestBody: { content: { "application/json": { schema: { type: "object", properties: {} } } } }, ...ok } } });
    const change = classifyDiff(diffOperations(from, to)).changed[0]!.changes.find((c) => c.kind === "request_field_removed")!;
    expect(change).toMatchObject({ pointer: "/amount", required: false, classification: "non_breaking" });
  });

  it("K7: required_added → breaking; required_removed → non_breaking", () => {
    const v1 = classifySide({ "/a": { post: { operationId: "createA", requestBody: { content: { "application/json": { schema: { type: "object", properties: { amount: { type: "string" } } } } } }, ...ok } } });
    const v2 = classifySide({ "/a": { post: { operationId: "createA", requestBody: { content: { "application/json": { schema: { type: "object", properties: { amount: { type: "string" } }, required: ["amount"] } } } }, ...ok } } });
    const addedClassification = classifyDiff(diffOperations(v1, v2)).changed[0]!.changes.find((c) => c.kind === "required_added")!.classification;
    const removedClassification = classifyDiff(diffOperations(v2, v1)).changed[0]!.changes.find((c) => c.kind === "required_removed")!.classification;
    expect(addedClassification).toBe("breaking");
    expect(removedClassification).toBe("non_breaking");
  });

  it("K8: type_changed → breaking", () => {
    const fromSide = classifySide({ "/a": { post: { operationId: "createA", requestBody: { content: { "application/json": { schema: { type: "object", properties: { amount: { type: "string" } } } } } }, ...ok } } });
    const toSide = classifySide({ "/a": { post: { operationId: "createA", requestBody: { content: { "application/json": { schema: { type: "object", properties: { amount: { type: "integer" } } } } } }, ...ok } } });
    const classified = classifyDiff(diffOperations(fromSide, toSide));
    const change = classified.changed[0]!.changes.find((c) => c.kind === "type_changed")!;
    expect(change.classification).toBe("breaking");
  });

  it("K9: response_added → non_breaking; response_removed → breaking", () => {
    const v1 = classifySide({ "/a": { get: { operationId: "getA", responses: { "200": { description: "OK" } } } } });
    const v2 = classifySide({ "/a": { get: { operationId: "getA", responses: { "200": { description: "OK" }, "404": { description: "Not found" } } } } });
    const addedClass = classifyDiff(diffOperations(v1, v2)).changed[0]!.changes.find((c) => c.kind === "response_added")!.classification;
    const removedClass = classifyDiff(diffOperations(v2, v1)).changed[0]!.changes.find((c) => c.kind === "response_removed")!.classification;
    expect(addedClass).toBe("non_breaking");
    expect(removedClass).toBe("breaking");
  });

  it("K10: removed op → counted as breaking in summary; added op → non_breaking in summary", () => {
    const from = classifySide({ "/a": { get: { operationId: "getA", ...ok } }, "/b": { post: { operationId: "createB", ...ok } } });
    const to = classifySide({ "/a": { get: { operationId: "getA", ...ok } }, "/c": { put: { operationId: "updateC", ...ok } } });
    const result = classifyDiff(diffOperations(from, to));
    // POST:/b removed → 1 breaking; PUT:/c added → 1 non_breaking
    expect(result.summary.breaking).toBeGreaterThanOrEqual(1);
    expect(result.summary.non_breaking).toBeGreaterThanOrEqual(1);
    expect(result.removed.map((r) => r.operation_key)).toContain("POST:/b");
    expect(result.added.map((a) => a.operation_key)).toContain("PUT:/c");
  });

  it("K11: changed op with changes:[] (non-itemizable delta) contributes 0 to summary counts", () => {
    // security toggle is structural but outside the kind menu → changes:[]
    const fromSide = classifySide({ "/a": { get: { operationId: "getA", security: [], ...ok } } });
    const toSide = classifySide({ "/a": { get: { operationId: "getA", security: [{ apiKey: [] }], ...ok } } });
    const result = classifyDiff(diffOperations(fromSide, toSide));
    // The op IS in changed with changes:[] — no contribution to any count
    expect(result.changed.map((c) => c.operation_key)).toContain("GET:/a");
    expect(result.summary.breaking).toBe(0);
    expect(result.summary.non_breaking).toBe(0);
    expect(result.summary.unknown).toBe(0);
  });

  it("Pin B: op-level param overrides path-item required in differ merge", () => {
    // side() iterates all path-item keys as methods — hand-build for path-item params.
    const fromDoc = {
      openapi: "3.1.0", info: { title: "T", version: "1" },
      paths: {
        "/a": {
          parameters: [{ name: "status", in: "query", required: false, schema: { type: "string" } }],
          get: { operationId: "getA", parameters: [{ name: "status", in: "query", required: true, schema: { type: "integer" } }], responses: { "200": { description: "OK" } } },
        },
      },
    } as NormalizedDoc;
    const fromSide: VersionSide = { doc: fromDoc, operations: [makeOp("get", "/a", "getA")], typeDefs: [] };
    const toSide = side({ "/a": { get: { operationId: "getA", ...ok } } });
    const changes = diffOperations(fromSide, toSide).changed[0]!.changes;
    expect(changes.find((c) => c.kind === "param_removed")).toMatchObject({ pointer: "/status", required: true });
  });

  it("Pin C: path param without required key → required forced to true in differ merge", () => {
    const from = classifySide({ "/a/{id}": { get: { operationId: "getA", parameters: [{ name: "id", in: "path", schema: { type: "string" } }], ...ok } } });
    const to = classifySide({ "/a/{id}": { get: { operationId: "getA", ...ok } } });
    const changes = diffOperations(from, to).changed[0]!.changes;
    expect(changes.find((c) => c.kind === "param_removed")).toMatchObject({ pointer: "/id", required: true });
  });

  it("K12: summary totals aggregate correctly across multiple changes on one op", () => {
    // POST:/a: metadata added (non_breaking) + idempotency_key required added (breaking) + amount type_changed (breaking)
    const fromSide = classifySide({ "/a": { post: { operationId: "createA", requestBody: { content: { "application/json": { schema: { type: "object", properties: { amount: { type: "string" } } } } } }, ...ok } } });
    const toSide = classifySide({ "/a": { post: { operationId: "createA", requestBody: { content: { "application/json": { schema: { type: "object", properties: { amount: { type: "integer" }, metadata: { type: "object" }, idempotency_key: { type: "string" } }, required: ["idempotency_key"] } } } }, ...ok } } });
    const result = classifyDiff(diffOperations(fromSide, toSide));
    // amount type_changed → breaking; idempotency_key request_field_added{required:true} → breaking
    // metadata request_field_added{required:false} → non_breaking
    expect(result.summary.breaking).toBe(2);
    expect(result.summary.non_breaking).toBe(1);
    expect(result.summary.unknown).toBe(0);
  });
});

describe("T10 characterization — diff classification baseline before itemization carries", () => {
  it("Char-1 (updated by carry #1): optional request_field_removed when TO-schema has additionalProperties:false → breaking", () => {
    // When the TO-schema is closed (additionalProperties:false), a caller still sending
    // the removed optional field will be rejected by the new spec — breaking.
    // The OperationChange carries closedSchema:true so classifyChange can see it.
    const from = classifySide({ "/a": { post: { operationId: "createA",
      requestBody: { content: { "application/json": { schema: {
        type: "object", properties: { amount: { type: "string" }, metadata: { type: "object" } },
      } } } }, ...ok } } });
    const to = classifySide({ "/a": { post: { operationId: "createA",
      requestBody: { content: { "application/json": { schema: {
        type: "object", properties: { amount: { type: "string" } }, additionalProperties: false,
      } } } }, ...ok } } });
    const classified = classifyDiff(diffOperations(from, to));
    const change = classified.changed[0]!.changes.find((c) => c.kind === "request_field_removed" && c.pointer === "/metadata")!;
    expect(change).toBeDefined();
    expect(change.classification).toBe("breaking");
    expect((change as any).closedSchema).toBe(true); // context threaded from diffSchema
  });

  it("Char-1b: optional removal from open TO schema (no additionalProperties:false) → still non_breaking", () => {
    // Invariant: the baseline non_breaking case must not change after carry #1.
    const from = classifySide({ "/a": { post: { operationId: "createA",
      requestBody: { content: { "application/json": { schema: {
        type: "object", properties: { amount: { type: "string" }, metadata: { type: "object" } },
      } } } }, ...ok } } });
    const to = classifySide({ "/a": { post: { operationId: "createA",
      requestBody: { content: { "application/json": { schema: {
        type: "object", properties: { amount: { type: "string" } },
        // NO additionalProperties:false — open schema
      } } } }, ...ok } } });
    const change = classifyDiff(diffOperations(from, to)).changed[0]!.changes
      .find((c) => c.kind === "request_field_removed" && c.pointer === "/metadata")!;
    expect(change).toBeDefined();
    expect(change.classification).toBe("non_breaking");
    expect((change as any).closedSchema).toBeUndefined();
  });

  it("Char-3a (updated by carry #3): shared param type change → param_type_changed, breaking", () => {
    const from = classifySide({
      "/a": { get: { operationId: "getA",
        parameters: [{ name: "limit", in: "query", schema: { type: "string" } }], ...ok } },
    });
    const to = classifySide({
      "/a": { get: { operationId: "getA",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }], ...ok } },
    });
    const classified = classifyDiff(diffOperations(from, to));
    const change = classified.changed.find((c) => c.operation_key === "GET:/a")!
      .changes.find((c) => c.kind === "param_type_changed")!;
    expect(change).toBeDefined();
    expect(change.pointer).toBe("/limit");
    expect(change.from).toBe("string");
    expect(change.to).toBe("integer");
    expect(change.classification).toBe("breaking");
  });

  it("Char-3b (updated by carry #3): shared param optional→required flip → param_required_added, breaking", () => {
    const from = classifySide({
      "/a": { get: { operationId: "getA",
        parameters: [{ name: "q", in: "query", required: false, schema: { type: "string" } }], ...ok } },
    });
    const to = classifySide({
      "/a": { get: { operationId: "getA",
        parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }], ...ok } },
    });
    const classified = classifyDiff(diffOperations(from, to));
    const change = classified.changed.find((c) => c.operation_key === "GET:/a")!
      .changes.find((c) => c.kind === "param_required_added")!;
    expect(change).toBeDefined();
    expect(change.pointer).toBe("/q");
    expect(change.classification).toBe("breaking");
  });

  it("Char-3c: shared param required→optional flip → param_required_removed, non_breaking", () => {
    const from = classifySide({
      "/a": { get: { operationId: "getA",
        parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }], ...ok } },
    });
    const to = classifySide({
      "/a": { get: { operationId: "getA",
        parameters: [{ name: "q", in: "query", required: false, schema: { type: "string" } }], ...ok } },
    });
    const classified = classifyDiff(diffOperations(from, to));
    const change = classified.changed.find((c) => c.operation_key === "GET:/a")!
      .changes.find((c) => c.kind === "param_required_removed")!;
    expect(change).toBeDefined();
    expect(change.pointer).toBe("/q");
    expect(change.classification).toBe("non_breaking");
  });

  it("Char-3d: shared param with NO type change → no param_type_changed (no spurious detection)", () => {
    const from = classifySide({
      "/a": { get: { operationId: "getA",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }], ...ok } },
    });
    const to = classifySide({
      "/a": { get: { operationId: "getA",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }], ...ok } },
    });
    const diff = diffOperations(from, to);
    expect(diff.changed).toEqual([]); // identical → not in changed
  });

  it("Char-5 (updated by carry #5): deprecated false→true → operation_deprecated, non_breaking", () => {
    const from = classifySide({ "/a": { get: { operationId: "getA", deprecated: false, ...ok } } });
    const to = classifySide({ "/a": { get: { operationId: "getA", deprecated: true, ...ok } } });
    const classified = classifyDiff(diffOperations(from, to));
    const change = classified.changed.find((c) => c.operation_key === "GET:/a")!
      .changes.find((c) => c.kind === "operation_deprecated")!;
    expect(change).toBeDefined();
    expect(change.pointer).toBe("/deprecated");
    expect(change.from).toBe(false);
    expect(change.to).toBe(true);
    expect(change.classification).toBe("non_breaking");
  });

  it("Char-5b: deprecated true→false (un-deprecate) → operation_deprecated, non_breaking", () => {
    const from = classifySide({ "/a": { get: { operationId: "getA", deprecated: true, ...ok } } });
    const to = classifySide({ "/a": { get: { operationId: "getA", deprecated: false, ...ok } } });
    const classified = classifyDiff(diffOperations(from, to));
    const change = classified.changed.find((c) => c.operation_key === "GET:/a")!
      .changes.find((c) => c.kind === "operation_deprecated")!;
    expect(change).toBeDefined();
    expect(change.from).toBe(true);
    expect(change.to).toBe(false);
    expect(change.classification).toBe("non_breaking");
  });

  it("Char-5c: deprecated flag unchanged (false→false) → op NOT in changed", () => {
    const from = classifySide({ "/a": { get: { operationId: "getA", deprecated: false, ...ok } } });
    const to = classifySide({ "/a": { get: { operationId: "getA", deprecated: false, ...ok } } });
    expect(diffOperations(from, to).changed).toEqual([]);
  });
});

describe("diffOperations — include_descriptions flag", () => {
  it("D_include: a doc-only change with includeDescriptions:true → op IN changed", () => {
    const from = side({ "/a": { get: { operationId: "getA", description: "old", ...ok } } });
    const to = side({ "/a": { get: { operationId: "getA", description: "new", ...ok } } });
    // Default (false): op NOT in changed (D_struct already proves this)
    expect(diffOperations(from, to).changed.map((c) => c.operation_key)).not.toContain("GET:/a");
    // With includeDescriptions:true: op IS in changed (description is no longer stripped)
    const opts: DiffOptions = { includeDescriptions: true };
    expect(diffOperations(from, to, opts).changed.map((c) => c.operation_key)).toContain("GET:/a");
  });
});
