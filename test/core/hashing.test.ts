import { describe, it, expect } from "vitest";
import { canonicalize, contentHash } from "../../src/core/hashing.js";

describe("contentHash — determinism (key order is irrelevant)", () => {
  it("hashes the same regardless of top-level key insertion order", () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
  });

  it("hashes the same regardless of nested key insertion order", () => {
    const x = { outer: { p: 1, q: 2 }, list: [{ m: 1, n: 2 }] };
    const y = { list: [{ n: 2, m: 1 }], outer: { q: 2, p: 1 } };
    expect(contentHash(x)).toBe(contentHash(y));
  });
});

describe("contentHash — sensitivity (real content changes move the hash)", () => {
  it("differs when a value changes", () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });

  it("differs when a field is added", () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 1, b: 2 }));
  });

  it("distinguishes an explicit null from an absent key", () => {
    expect(contentHash({ a: null })).not.toBe(contentHash({}));
  });
});

describe("contentHash — array order is semantically significant", () => {
  it("differs when array elements are reordered (arrays are never sorted)", () => {
    expect(contentHash({ xs: [1, 2, 3] })).not.toBe(contentHash({ xs: [3, 2, 1] }));
  });
});

describe("contentHash — whitespace inside string values is preserved", () => {
  it("treats differing internal whitespace as different content", () => {
    // Only structural/serialization whitespace is canonicalized away; whitespace
    // inside a spec's string values is meaningful and must survive.
    expect(contentHash({ desc: "x y" })).not.toBe(contentHash({ desc: "x  y" }));
  });
});

describe("contentHash — number canonicalization", () => {
  it("treats 1.0 and 1 as the same content (JS number)", () => {
    expect(contentHash({ a: 1.0 })).toBe(contentHash({ a: 1 }));
  });
});

describe("contentHash — encoding contract", () => {
  it("returns a bare 64-char lowercase hex digest with no sha256: prefix", () => {
    // store.ts stores the bare digest; the `sha256:` prefix is a
    // tool-layer concern, not this function's.
    expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the golden vector (cross-machine algorithm anchor)", () => {
    // canonical form of { b: 1, a: [3, 2] } is `{"a":[3,2],"b":1}`.
    // If this digest ever changes, the canonicalization algorithm changed —
    // regenerate intentionally.
    expect(contentHash({ b: 1, a: [3, 2] })).toBe(
      "19cf31041077cbadd419a97f649b854a2b6f5c99f755221641224269a3aa79fc",
    );
  });
});

describe("canonicalize — canonical JSON form", () => {
  it("emits object keys in sorted order with arrays preserved", () => {
    expect(canonicalize({ b: 1, a: [3, 2] })).toBe('{"a":[3,2],"b":1}');
  });
});
