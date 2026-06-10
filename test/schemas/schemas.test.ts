import { describe, it, expect } from "vitest";
import type { ZodType } from "zod";

import { loadSpecInputSchema } from "../../src/schemas/load_spec.js";
import { findEndpointInputSchema } from "../../src/schemas/find_endpoint.js";
import { findTypeInputSchema } from "../../src/schemas/find_type.js";
import { getSignatureInputSchemaRefined } from "../../src/schemas/get_signature.js";
import { validateCallInputSchemaRefined } from "../../src/schemas/validate_call.js";
import { diffVersionsInputSchema } from "../../src/schemas/diff_versions.js";
import { listSpecsInputSchema } from "../../src/schemas/list_specs.js";
import { activateVersionInputSchema } from "../../src/schemas/activate_version.js";
import { removeSpecInputSchema } from "../../src/schemas/remove_spec.js";

// The base z.object is the canonical validation schema, except get_signature/
// validate_call use the *refined* variant carrying the operation_id/operation_key
// XOR (the base shape registers with the SDK; the refined is what the handler
// validates against).

const cases: Array<{
  name: string;
  schema: ZodType;
  valid: unknown;
  invalid: unknown;
}> = [
  { name: "load_spec", schema: loadSpecInputSchema, valid: { source: "./api.yaml" }, invalid: {} },
  { name: "find_endpoint", schema: findEndpointInputSchema, valid: { query: "invoice" }, invalid: {} },
  { name: "find_type", schema: findTypeInputSchema, valid: { query: "Invoice" }, invalid: { query: 123 } },
  { name: "get_signature", schema: getSignatureInputSchemaRefined, valid: { operation_id: "createInvoice" }, invalid: {} },
  { name: "validate_call", schema: validateCallInputSchemaRefined, valid: { operation_id: "x", request: {} }, invalid: { operation_id: "x" } },
  { name: "diff_versions", schema: diffVersionsInputSchema, valid: { from: { version: "a" }, to: { version: "b" } }, invalid: { from: {}, to: { version: "b" } } },
  { name: "list_specs", schema: listSpecsInputSchema, valid: {}, invalid: { spec_id: 123 } },
  { name: "activate_version", schema: activateVersionInputSchema, valid: { spec_id: "x", version: "v" }, invalid: { spec_id: "x" } },
  { name: "remove_spec", schema: removeSpecInputSchema, valid: { spec_id: "x", confirm: true }, invalid: { spec_id: "x", confirm: false } },
];

describe("input schemas: accept valid, reject malformed", () => {
  it.each(cases)("$name accepts a valid sample", ({ schema, valid }) => {
    expect(schema.safeParse(valid).success).toBe(true);
  });
  it.each(cases)("$name rejects a malformed sample", ({ schema, invalid }) => {
    expect(schema.safeParse(invalid).success).toBe(false);
  });
});

describe("operation_id/operation_key XOR (get_signature, validate_call)", () => {
  it("get_signature: exactly one accepted; both or neither rejected", () => {
    expect(getSignatureInputSchemaRefined.safeParse({ operation_id: "a" }).success).toBe(true);
    expect(getSignatureInputSchemaRefined.safeParse({ operation_key: "GET:/x" }).success).toBe(true);
    expect(getSignatureInputSchemaRefined.safeParse({ operation_id: "a", operation_key: "GET:/x" }).success).toBe(false);
    expect(getSignatureInputSchemaRefined.safeParse({}).success).toBe(false);
  });
  it("validate_call: exactly one accepted; both or neither rejected", () => {
    const req = { request: {} };
    expect(validateCallInputSchemaRefined.safeParse({ operation_id: "a", ...req }).success).toBe(true);
    expect(validateCallInputSchemaRefined.safeParse({ operation_key: "GET:/x", ...req }).success).toBe(true);
    expect(validateCallInputSchemaRefined.safeParse({ operation_id: "a", operation_key: "GET:/x", ...req }).success).toBe(false);
    expect(validateCallInputSchemaRefined.safeParse({ ...req }).success).toBe(false);
  });
});

describe("remove_spec.confirm must be literally true", () => {
  it("accepts confirm:true; rejects false or missing", () => {
    expect(removeSpecInputSchema.safeParse({ spec_id: "x", confirm: true }).success).toBe(true);
    expect(removeSpecInputSchema.safeParse({ spec_id: "x", confirm: false }).success).toBe(false);
    expect(removeSpecInputSchema.safeParse({ spec_id: "x" }).success).toBe(false);
  });
});

describe("enum fields reject unknown members", () => {
  it("load_spec.source_type", () => {
    expect(loadSpecInputSchema.safeParse({ source: "x", source_type: "inline" }).success).toBe(true);
    expect(loadSpecInputSchema.safeParse({ source: "x", source_type: "ftp" }).success).toBe(false);
  });
  it("diff_versions.scope", () => {
    const base = { from: { version: "a" }, to: { version: "b" } };
    expect(diffVersionsInputSchema.safeParse({ ...base, scope: "all" }).success).toBe(true);
    expect(diffVersionsInputSchema.safeParse({ ...base, scope: "bogus" }).success).toBe(false);
  });
});

describe("find_endpoint.limit bounds (1..50, integer)", () => {
  const ok = (limit: unknown) =>
    findEndpointInputSchema.safeParse({ query: "x", limit }).success;
  it("accepts an in-range integer; rejects 0 / 51 / non-integer", () => {
    expect(ok(10)).toBe(true);
    expect(ok(0)).toBe(false);
    expect(ok(51)).toBe(false);
    expect(ok(2.5)).toBe(false);
  });
});
