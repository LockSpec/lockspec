import { describe, it, expect } from "vitest";

import {
  isObj,
  asObj,
  asArray,
  escapePointer,
  resolvePointer,
  refTarget,
  deref,
  stripSuffix,
  parentPointer,
} from "../../src/core/json-pointer.js";

// Direct unit tests for the shared JSON value-guards + pointer/$ref helpers. The
// consumer suites (signature/validator/differ) exercise the happy paths; these
// pin the contract edges they don't — where a wrong consolidation would surface.

describe("escapePointer / round-trip", () => {
  it.each([
    ["plain", "plain"],
    ["~", "~0"],
    ["/", "~1"],
    ["a/b~c", "a~1b~0c"],
    ["~/", "~0~1"], // ~ escaped BEFORE /, so the ~1's ~ is not re-escaped
  ])("escapes %j → %j", (input, expected) => {
    expect(escapePointer(input)).toBe(expected);
  });

  it("round-trips a key with both reserved chars through resolvePointer", () => {
    const doc = { "a/b": { "~x": 5 } };
    expect(resolvePointer(doc, `/${escapePointer("a/b")}/${escapePointer("~x")}`)).toBe(5);
  });
});

describe("resolvePointer", () => {
  const doc = { a: { b: 1 }, list: [10, 20] };

  it("returns the whole doc for the empty and '#' pointers", () => {
    expect(resolvePointer(doc, "")).toBe(doc);
    expect(resolvePointer(doc, "#")).toBe(doc);
  });

  it("resolves with and without a leading '#' identically (the deref equivalence)", () => {
    expect(resolvePointer(doc, "#/a/b")).toBe(1);
    expect(resolvePointer(doc, "/a/b")).toBe(1);
  });

  it("returns undefined for a non-absolute pointer", () => {
    expect(resolvePointer(doc, "a/b")).toBeUndefined();
  });

  it("returns undefined for a missing object key", () => {
    expect(resolvePointer(doc, "/a/missing")).toBeUndefined();
  });

  it("walks arrays by index and rejects out-of-range / non-integer / negative", () => {
    expect(resolvePointer(doc, "/list/1")).toBe(20);
    expect(resolvePointer(doc, "/list/5")).toBeUndefined();
    expect(resolvePointer(doc, "/list/x")).toBeUndefined();
    expect(resolvePointer(doc, "/list/-1")).toBeUndefined();
  });

  it("returns undefined when a segment descends into a primitive", () => {
    expect(resolvePointer(doc, "/a/b/c")).toBeUndefined();
  });
});

describe("value guards", () => {
  it("isObj is true only for plain objects", () => {
    expect(isObj({})).toBe(true);
    expect(isObj([])).toBe(false);
    expect(isObj(null)).toBe(false);
    expect(isObj("s")).toBe(false);
    expect(isObj(1)).toBe(false);
    expect(isObj(undefined)).toBe(false);
  });

  it("asObj passes objects through and nullifies non-objects", () => {
    const o = { a: 1 };
    expect(asObj(o)).toBe(o);
    expect(asObj([])).toBeUndefined();
    expect(asObj(null)).toBeUndefined();
  });

  it("asArray passes arrays through and defaults non-arrays to []", () => {
    const a = [1, 2];
    expect(asArray(a)).toBe(a);
    expect(asArray({})).toEqual([]);
    expect(asArray(null)).toEqual([]);
  });
});

describe("refTarget — internal '#' refs only", () => {
  it("returns the target of an internal ref", () => {
    expect(refTarget({ $ref: "#/components/schemas/Pet" })).toBe("#/components/schemas/Pet");
  });

  it("ignores external / relative refs (not '#'-prefixed)", () => {
    expect(refTarget({ $ref: "https://x.test/a.yaml#/Pet" })).toBeUndefined();
    expect(refTarget({ $ref: "./other.yaml#/Pet" })).toBeUndefined();
  });

  it("ignores a non-string $ref, a missing $ref, and non-objects", () => {
    expect(refTarget({ $ref: 5 })).toBeUndefined();
    expect(refTarget({ type: "object" })).toBeUndefined();
    expect(refTarget("#/x")).toBeUndefined();
    expect(refTarget(null)).toBeUndefined();
  });
});

describe("deref — one structural hop", () => {
  const doc = { a: { b: 1 } };

  it("follows an internal ref one hop", () => {
    expect(deref(doc, { $ref: "#/a" })).toEqual({ b: 1 });
  });

  it("passes a non-ref node through unchanged", () => {
    const node = { type: "object" };
    expect(deref(doc, node)).toBe(node);
    expect(deref(doc, 5)).toBe(5);
  });

  it("passes an external ref through unchanged (not a '#' ref)", () => {
    const node = { $ref: "http://x.test#/y" };
    expect(deref(doc, node)).toBe(node);
  });

  it("returns undefined for an unresolvable internal ref", () => {
    expect(deref(doc, { $ref: "#/missing" })).toBeUndefined();
  });
});

describe("pointer-string helpers", () => {
  it("stripSuffix removes a matching suffix, else leaves the string", () => {
    expect(stripSuffix("/paths/~1pets/get/parameters", "/parameters")).toBe("/paths/~1pets/get");
    expect(stripSuffix("/a/b", "/c")).toBe("/a/b");
  });

  it.each([
    ["/paths/~1pets/get", "/paths/~1pets"],
    ["/a/b/c", "/a/b"],
    ["/x", ""], // single top-level segment → root
    ["", ""],
  ])("parentPointer(%j) → %j", (input, expected) => {
    expect(parentPointer(input)).toBe(expected);
  });
});
