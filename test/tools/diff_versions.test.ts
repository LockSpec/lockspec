import { describe, it, expect } from "vitest";
import { join } from "node:path";

import { diffVersionsTool } from "../../src/tools/diff_versions.js";
import { loadSpecTool } from "../../src/tools/load_spec.js";
import { InMemoryStore } from "../helpers/in-memory-store.js";
import type { ToolDeps } from "../../src/tools/index.js";

// Core diff correctness lives in differ.test.ts + differ.fixture.test.ts; here we
// prove the WIRING: resolution, scope filter, include_descriptions, same-version
// fast-path, structured errors.

function payloadOf(result: { content: Array<{ type: string; text?: string }> }): unknown {
  return JSON.parse(result.content[0]!.text!);
}
function summaryOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[1]?.text ?? "";
}
function dv(store: InMemoryStore, args: Record<string, unknown>) {
  const deps: ToolDeps = { store };
  return diffVersionsTool.handler(args, deps);
}
const loadFile = (store: InMemoryStore, path: string) =>
  loadSpecTool.handler({ source: path, source_type: "file" }, { store });
const loadInline = (store: InMemoryStore, spec: object, specId?: string) =>
  loadSpecTool.handler({ source: JSON.stringify(spec), source_type: "inline", ...(specId ? { spec_id: specId } : {}) }, { store });

const BILLING_V1 = join(import.meta.dirname, "../../fixtures/openapi/versions/billing-v1.yaml");
const BILLING_V2 = join(import.meta.dirname, "../../fixtures/openapi/versions/billing-v2.yaml");

function inlineSpec(title: string, version: string, paths: object) {
  return { openapi: "3.1.0", info: { title, version }, paths };
}

// Two resolvable versions with DIFFERENT content_hash (so the same-hash fast path
// is skipped) and no snapshots written — to exercise the missing-snapshot branch.
function seedTwoNoSnapshot(store: InMemoryStore) {
  const provenance = { source_type: "inline" as const, source_uri: null, fetched_at: "2026-06-05T00:00:00Z", original_byte_size: 1, external_sources: [] };
  for (const [version_id, content_hash] of [["v1", "hash-v1"], ["v2", "hash-v2"]] as const) {
    store.putVersion({
      spec: { spec_id: "snap-api", label: "Snap API" },
      version: { version_id, content_hash, version_label: version_id, spec_format: "openapi", format_version: "3.1.0", provenance },
      operations: [], typeDefs: [],
    });
  }
}

describe("diff_versions", () => {
  it("W1: same-version on both sides → empty diff (same-hash fast-path)", async () => {
    const store = new InMemoryStore();
    const loaded = payloadOf(await loadFile(store, BILLING_V1)) as { spec_id: string; version_id: string };
    const result = payloadOf(await dv(store, {
      from: { spec_id: loaded.spec_id, version: loaded.version_id },
      to: { spec_id: loaded.spec_id, version: loaded.version_id },
    })) as any;

    expect(result.ok).toBe(true);
    expect(result.operations.added).toEqual([]);
    expect(result.operations.removed).toEqual([]);
    expect(result.operations.changed).toEqual([]);
    expect(result.types.added).toEqual([]);
    expect(result.types.removed).toEqual([]);
    expect(result.types.changed).toEqual([]);
    expect(result.summary).toEqual({ breaking: 0, non_breaking: 0, unknown: 0 });
  });

  it("W2: unresolvable `from` ref → not_found", async () => {
    const store = new InMemoryStore();
    await loadFile(store, BILLING_V1);
    const result = payloadOf(await dv(store, {
      from: { spec_id: "no-such-spec", version: "v0" },
      to: { spec_id: "billing-api", version: "some-version" },
    })) as any;
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("not_found");
  });

  it("W3: unresolvable `to` ref → not_found", async () => {
    const store = new InMemoryStore();
    const loaded = payloadOf(await loadFile(store, BILLING_V1)) as { spec_id: string; version_id: string };
    const result = payloadOf(await dv(store, {
      from: { spec_id: loaded.spec_id, version: loaded.version_id },
      to: { spec_id: loaded.spec_id, version: "no-such-version-id" },
    })) as any;
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("not_found");
  });

  it("W4: billing-v1 → billing-v2 full classified result", async () => {
    const store = new InMemoryStore();
    const v1 = payloadOf(await loadFile(store, BILLING_V1)) as { spec_id: string; version_id: string };
    const v2 = payloadOf(await loadFile(store, BILLING_V2)) as { spec_id: string; version_id: string };

    const result = payloadOf(await dv(store, {
      from: { spec_id: v1.spec_id, version: v1.version_id },
      to: { spec_id: v2.spec_id, version: v2.version_id },
    })) as any;

    expect(result.ok).toBe(true);

    // Operations: GET /v1/invoices/{id} added; DELETE /v1/invoices/{id} removed
    expect(result.operations.added.map((a: any) => a.operation_key)).toContain("GET:/v1/invoices/{id}");
    expect(result.operations.removed.map((r: any) => r.operation_key)).toContain("DELETE:/v1/invoices/{id}");

    // POST /v1/invoices: classified changes
    const createChange = result.operations.changed.find((c: any) => c.operation_key === "POST:/v1/invoices");
    expect(createChange).toBeDefined();
    expect(createChange.changes.find((ch: any) => ch.pointer === "/metadata")).toMatchObject({ classification: "non_breaking" });
    expect(createChange.changes.find((ch: any) => ch.pointer === "/idempotency_key")).toMatchObject({ classification: "breaking" });
    expect(createChange.changes.find((ch: any) => ch.kind === "type_changed" && ch.pointer === "/amount")).toMatchObject({ classification: "breaking" });

    // Types: Invoice changed
    expect(result.types.changed).toContain("Invoice");

    // Summary: 1 removed + 1 idempotency_key + 1 type_changed = 3 breaking;
    //          1 added + 1 metadata = 2 non_breaking
    expect(result.summary).toEqual({ breaking: 3, non_breaking: 2, unknown: 0 });
  });

  it("W5: scope:'operations' → has operations+summary; no types key", async () => {
    const store = new InMemoryStore();
    const v1 = payloadOf(await loadFile(store, BILLING_V1)) as { spec_id: string; version_id: string };
    const v2 = payloadOf(await loadFile(store, BILLING_V2)) as { spec_id: string; version_id: string };

    const result = payloadOf(await dv(store, {
      from: { spec_id: v1.spec_id, version: v1.version_id },
      to: { spec_id: v2.spec_id, version: v2.version_id },
      scope: "operations",
    })) as any;

    expect(result.ok).toBe(true);
    expect(result.operations).toBeDefined();
    expect(result.summary).toBeDefined();
    expect(result.types).toBeUndefined();
  });

  it("W6: scope:'types' → has types; no operations or summary keys", async () => {
    const store = new InMemoryStore();
    const v1 = payloadOf(await loadFile(store, BILLING_V1)) as { spec_id: string; version_id: string };
    const v2 = payloadOf(await loadFile(store, BILLING_V2)) as { spec_id: string; version_id: string };

    const result = payloadOf(await dv(store, {
      from: { spec_id: v1.spec_id, version: v1.version_id },
      to: { spec_id: v2.spec_id, version: v2.version_id },
      scope: "types",
    })) as any;

    expect(result.ok).toBe(true);
    expect(result.types).toBeDefined();
    expect(result.operations).toBeUndefined();
    expect(result.summary).toBeUndefined();
  });

  it("W7: include_descriptions:true surfaces a doc-only change absent by default", async () => {
    const store = new InMemoryStore();
    // Two versions of a minimal spec: only the operation description changes.
    const v1Spec = inlineSpec("Desc Test", "1", { "/a": { get: { operationId: "getA", description: "old", responses: { "200": { description: "OK" } } } } });
    const v2Spec = inlineSpec("Desc Test", "2", { "/a": { get: { operationId: "getA", description: "new", responses: { "200": { description: "OK" } } } } });
    const r1 = payloadOf(await loadInline(store, v1Spec, "desc-test")) as { spec_id: string; version_id: string };
    const r2 = payloadOf(await loadInline(store, v2Spec, "desc-test")) as { spec_id: string; version_id: string };

    // Default (include_descriptions:false): op NOT in changed
    const defResult = payloadOf(await dv(store, {
      from: { spec_id: r1.spec_id, version: r1.version_id },
      to: { spec_id: r2.spec_id, version: r2.version_id },
    })) as any;
    expect(defResult.ok).toBe(true);
    expect(defResult.operations.changed.map((c: any) => c.operation_key)).not.toContain("GET:/a");

    // With include_descriptions:true: op IS in changed
    const inclResult = payloadOf(await dv(store, {
      from: { spec_id: r1.spec_id, version: r1.version_id },
      to: { spec_id: r2.spec_id, version: r2.version_id },
      include_descriptions: true,
    })) as any;
    expect(inclResult.ok).toBe(true);
    expect(inclResult.operations.changed.map((c: any) => c.operation_key)).toContain("GET:/a");
  });

  it("W8: a resolvable `from` version whose snapshot is missing → io_error", async () => {
    const store = new InMemoryStore();
    seedTwoNoSnapshot(store); // neither snapshot written → `from` load fails first
    const result = payloadOf(await dv(store, {
      from: { spec_id: "snap-api", version: "v1" },
      to: { spec_id: "snap-api", version: "v2" },
    })) as any;
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("io_error");
    expect(result.error.message).toMatch(/is missing/);
  });

  it("W9: a resolvable `to` version whose snapshot is missing → io_error", async () => {
    const store = new InMemoryStore();
    seedTwoNoSnapshot(store);
    store.writeSnapshot("hash-v1", { openapi: "3.1.0" }); // `from` present, `to` missing
    const result = payloadOf(await dv(store, {
      from: { spec_id: "snap-api", version: "v1" },
      to: { spec_id: "snap-api", version: "v2" },
    })) as any;
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("io_error");
  });

  it("W10: summary line shows version_label when it uniquely identifies the version", async () => {
    const store = new InMemoryStore();
    await loadFile(store, BILLING_V1); // version_label: "1.0.0"
    await loadFile(store, BILLING_V2); // version_label: "2.0.0"
    const [fromVer, toVer] = store.listVersions("billing-api")
      .sort((a, b) => (a.version_label ?? "").localeCompare(b.version_label ?? ""));

    const result = await dv(store, {
      from: { spec_id: "billing-api", version: fromVer!.version_id },
      to: { spec_id: "billing-api", version: toVer!.version_id },
    });
    const summary = summaryOf(result);
    expect(summary).toContain("1.0.0");
    expect(summary).toContain("2.0.0");
    // Regression: not raw version_ids
    expect(summary).not.toContain(fromVer!.version_id);
    expect(summary).not.toContain(toVer!.version_id);
  });
});
