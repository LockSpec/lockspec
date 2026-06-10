import { createHash } from "node:crypto";

// The digest must be stable and reproducible across machines. Input is an
// already-normalized, finite JSON tree (internal $refs preserved as string
// nodes; expansion/cycle-tagging happen later in get_signature).
//
// Canonicalization rules:
//  - Object keys sorted by code-unit order (`Array.prototype.sort`, NOT
//    locale-aware `localeCompare`, which would vary across machines).
//  - Array order is preserved — semantically meaningful in OpenAPI.
//  - Only structural/serialization whitespace removed; content whitespace survives.
//  - Numbers are JS doubles via JSON (so `1.0` ≡ `1`).
//
// The `sha256:` prefix in tool outputs is added at the tool layer.

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      result[key] = canonicalValue(source[key]);
    }
    return result;
  }
  return value;
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalValue(value)) ?? "null";
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}
