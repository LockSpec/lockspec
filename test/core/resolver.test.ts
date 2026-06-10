import { describe, it, expect } from "vitest";

import { resolveTarget, resolveVersionRef, locateOperation, formatVersionHandle } from "../../src/core/resolver.js";
import { InMemoryStore } from "../helpers/in-memory-store.js";
import type { Operation, PutVersionInput } from "../../src/store/store.js";

function putV(
  store: InMemoryStore,
  over: { version_id: string; version_label: string | null; spec_id?: string },
) {
  const spec_id = over.spec_id ?? "billing-api";
  const input: PutVersionInput = {
    spec: { spec_id, label: spec_id },
    version: {
      version_id: over.version_id,
      content_hash: `hash-${over.version_id}`,
      version_label: over.version_label,
      spec_format: "openapi",
      format_version: "3.1.0",
      provenance: { source_type: "inline", source_uri: null, fetched_at: "2026-06-03T00:00:00.000Z", original_byte_size: 1, external_sources: [] },
    },
    operations: [],
    typeDefs: [],
  };
  store.putVersion(input);
}

describe("resolveVersionRef", () => {
  it("resolves by version_id (id-first)", () => {
    const store = new InMemoryStore();
    putV(store, { version_id: "sv_1", version_label: "1.0.0" });

    const r = resolveVersionRef(store, "billing-api", "sv_1");
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.version.version_id).toBe("sv_1");
  });

  it("resolves by version_label when no id matches", () => {
    const store = new InMemoryStore();
    putV(store, { version_id: "sv_1", version_label: "2.3.0" });

    const r = resolveVersionRef(store, "billing-api", "2.3.0");
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.version.version_id).toBe("sv_1");
  });

  it("returns not_found when neither id nor label matches", () => {
    const store = new InMemoryStore();
    putV(store, { version_id: "sv_1", version_label: "1.0.0" });

    const r = resolveVersionRef(store, "billing-api", "nope");
    expect(r).toMatchObject({ ok: false, code: "not_found" });
    if (!r.ok) expect(r.message).toMatch(/nope/);
  });

  it("returns ambiguous (listing candidate version_ids) when a label matches multiple versions", () => {
    // version_label is non-unique metadata — a label can match many.
    const store = new InMemoryStore();
    putV(store, { version_id: "sv_1", version_label: "dup" });
    putV(store, { version_id: "sv_2", version_label: "dup" });

    const r = resolveVersionRef(store, "billing-api", "dup");
    expect(r).toMatchObject({ ok: false, code: "ambiguous" });
    if (!r.ok) {
      expect(r.message).toContain("sv_1");
      expect(r.message).toContain("sv_2");
    }
  });
});

describe("resolveTarget — (spec_id?, version?) defaulting", () => {
  it("defaults spec_id to the sole loaded spec and version to its active version", () => {
    const store = new InMemoryStore();
    putV(store, { version_id: "sv_1", version_label: "1.0.0" });
    store.setActive("billing-api", "sv_1");

    const r = resolveTarget(store, {}, "lenient");
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.spec_id).toBe("billing-api");
      expect(r.version.version_id).toBe("sv_1");
    }
  });

  it("no spec_id and no specs loaded → not_found", () => {
    const r = resolveTarget(new InMemoryStore(), {}, "lenient");
    expect(r).toMatchObject({ ok: false, code: "not_found" });
  });

  it("no spec_id and more than one spec loaded → ambiguous, listing candidate spec_ids", () => {
    const store = new InMemoryStore();
    putV(store, { spec_id: "alpha-api", version_id: "sv_a", version_label: "1" });
    putV(store, { spec_id: "beta-api", version_id: "sv_b", version_label: "1" });

    const r = resolveTarget(store, {}, "lenient");
    expect(r).toMatchObject({ ok: false, code: "ambiguous" });
    if (!r.ok) {
      expect(r.message).toContain("alpha-api");
      expect(r.message).toContain("beta-api");
    }
  });

  it("explicit unknown spec_id → not_found", () => {
    const store = new InMemoryStore();
    putV(store, { version_id: "sv_1", version_label: "1.0.0" });

    const r = resolveTarget(store, { spec_id: "nope" }, "lenient");
    expect(r).toMatchObject({ ok: false, code: "not_found" });
    if (!r.ok) expect(r.message).toMatch(/nope/);
  });

  it("resolves an explicit version by version_id", () => {
    const store = new InMemoryStore();
    putV(store, { version_id: "sv_1", version_label: "1.0.0" });
    putV(store, { version_id: "sv_2", version_label: "2.0.0" });
    store.setActive("billing-api", "sv_2");

    const r = resolveTarget(store, { spec_id: "billing-api", version: "sv_1" }, "lenient");
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.version.version_id).toBe("sv_1");
  });

  it("resolves an explicit version by version_label", () => {
    const store = new InMemoryStore();
    putV(store, { version_id: "sv_1", version_label: "2.3.0" });
    store.setActive("billing-api", "sv_1");

    const r = resolveTarget(store, { spec_id: "billing-api", version: "2.3.0" }, "lenient");
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.version.version_id).toBe("sv_1");
  });

  it("ambiguous version_label → ambiguous (delegated to resolveVersionRef)", () => {
    const store = new InMemoryStore();
    putV(store, { version_id: "sv_1", version_label: "dup" });
    putV(store, { version_id: "sv_2", version_label: "dup" });

    const r = resolveTarget(store, { spec_id: "billing-api", version: "dup" }, "lenient");
    expect(r).toMatchObject({ ok: false, code: "ambiguous" });
    if (!r.ok) {
      expect(r.message).toContain("sv_1");
      expect(r.message).toContain("sv_2");
    }
  });

  it("unknown explicit version → not_found (delegated)", () => {
    const store = new InMemoryStore();
    putV(store, { version_id: "sv_1", version_label: "1.0.0" });
    store.setActive("billing-api", "sv_1");

    const r = resolveTarget(store, { spec_id: "billing-api", version: "nope" }, "lenient");
    expect(r).toMatchObject({ ok: false, code: "not_found" });
  });

  it("spec with no active version, version omitted → not_found (null-active edge)", () => {
    // activate:false on load (or removing the active version) leaves active null.
    const store = new InMemoryStore();
    putV(store, { version_id: "sv_1", version_label: "1.0.0" }); // never setActive

    const r = resolveTarget(store, { spec_id: "billing-api" }, "lenient");
    expect(r).toMatchObject({ ok: false, code: "not_found" });
    if (!r.ok) expect(r.message).toMatch(/active/i);
  });

  it("multi-spec: an explicit spec_id scopes resolution to that spec's active version", () => {
    // Each spec has ONE version → version defaults to active in both modes (this
    // is multi-SPEC, not multi-version — the >1-loaded gate is per-spec).
    const store = new InMemoryStore();
    putV(store, { spec_id: "alpha-api", version_id: "sv_a", version_label: "1" });
    putV(store, { spec_id: "beta-api", version_id: "sv_b", version_label: "1" });
    store.setActive("alpha-api", "sv_a");
    store.setActive("beta-api", "sv_b");

    const r = resolveTarget(store, { spec_id: "beta-api" }, "lenient");
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.spec_id).toBe("beta-api");
      expect(r.version.version_id).toBe("sv_b");
    }
  });

  it("lenient: >1 loaded version, version omitted → active + version_warning naming the candidates", () => {
    const store = new InMemoryStore();
    putV(store, { version_id: "sv_1", version_label: "1.0.0" });
    putV(store, { version_id: "sv_2", version_label: "2.0.0" });
    store.setActive("billing-api", "sv_2");

    const r = resolveTarget(store, { spec_id: "billing-api" }, "lenient");
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.version.version_id).toBe("sv_2"); // still defaults to active
      expect(r.version_warning).toBeDefined();
      expect(r.version_warning).toContain("1.0.0");
      expect(r.version_warning).toContain("2.0.0");
    }
  });

  it("strict: >1 loaded version, version omitted → ambiguous + details.loaded_versions", () => {
    const store = new InMemoryStore();
    putV(store, { version_id: "sv_1", version_label: "1.0.0" });
    putV(store, { version_id: "sv_2", version_label: "2.0.0" });
    store.setActive("billing-api", "sv_2");

    const r = resolveTarget(store, { spec_id: "billing-api" }, "strict");
    expect(r).toMatchObject({ ok: false, code: "ambiguous" });
    if (!r.ok) {
      expect(r.message).toContain("1.0.0");
      expect(r.message).toContain("2.0.0");
      expect(r.details?.loaded_versions).toHaveLength(2);
      const byId = Object.fromEntries(
        (r.details?.loaded_versions ?? []).map((v) => [v.version_id, v]),
      );
      expect(byId.sv_2).toMatchObject({ version_id: "sv_2", version_label: "2.0.0", active: true });
      expect(byId.sv_1).toMatchObject({ version_id: "sv_1", version_label: "1.0.0", active: false });
    }
  });

  it("strict: a single loaded version, version omitted → active (the >1 gate does not trip)", () => {
    const store = new InMemoryStore();
    putV(store, { version_id: "sv_1", version_label: "1.0.0" });
    store.setActive("billing-api", "sv_1");

    const r = resolveTarget(store, { spec_id: "billing-api" }, "strict");
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.version.version_id).toBe("sv_1");
  });

  it("lenient: a single loaded version, version omitted → active with NO version_warning", () => {
    const store = new InMemoryStore();
    putV(store, { version_id: "sv_1", version_label: "1.0.0" });
    store.setActive("billing-api", "sv_1");

    const r = resolveTarget(store, { spec_id: "billing-api" }, "lenient");
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.version.version_id).toBe("sv_1");
      expect(r.version_warning).toBeUndefined();
    }
  });

  it("lenient: >1 loaded version but no active, version omitted → not_found (nothing to default to)", () => {
    const store = new InMemoryStore();
    putV(store, { version_id: "sv_1", version_label: "1.0.0" });
    putV(store, { version_id: "sv_2", version_label: "2.0.0" }); // never setActive

    const r = resolveTarget(store, { spec_id: "billing-api" }, "lenient");
    expect(r).toMatchObject({ ok: false, code: "not_found" });
    if (!r.ok) expect(r.message).toMatch(/active/i);
  });
});

describe("locateOperation", () => {
  const op = (operation_key: string, operation_id: string | null): Operation => {
    const [method, path] = operation_key.split(":") as [string, string];
    return {
      spec_id: "s", version_id: "v", operation_key, operation_id,
      summary: null, description: null, tags: [], deprecated: false,
      openapi: { method, path, pointers: { params: "p", requestBody: "rb", responses: "r" } },
    };
  };

  it("resolves by operation_key", () => {
    const r = locateOperation([op("GET:/a", "getA"), op("POST:/b", "createB")], { operation_key: "POST:/b" });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.operation.operation_key).toBe("POST:/b");
  });

  it("resolves a unique operation_id", () => {
    const r = locateOperation([op("GET:/a", "getA")], { operation_id: "getA" });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.operation.operation_key).toBe("GET:/a");
  });

  it("an unknown operation_id → not_found (names the id)", () => {
    const r = locateOperation([op("GET:/a", "getA")], { operation_id: "nope" });
    expect(r).toMatchObject({ ok: false, code: "not_found" });
    if (!r.ok) expect(r.message).toMatch(/nope/);
  });

  it("an unknown operation_key → not_found", () => {
    const r = locateOperation([op("GET:/a", "getA")], { operation_key: "GET:/nope" });
    expect(r).toMatchObject({ ok: false, code: "not_found" });
  });

  it("a non-unique operation_id → ambiguous, listing candidate keys", () => {
    const r = locateOperation([op("GET:/a", "dup"), op("GET:/b", "dup")], { operation_id: "dup" });
    expect(r).toMatchObject({ ok: false, code: "ambiguous" });
    if (!r.ok) {
      expect(r.message).toContain("GET:/a");
      expect(r.message).toContain("GET:/b");
    }
  });
});

describe("resolveTarget — non-unique-label message fallback", () => {
  it("strict: >1 versions sharing a label → message lists version_ids (label not unique, so id fallback)", () => {
    const store = new InMemoryStore();
    putV(store, { version_id: "sv_1", version_label: "dup" });
    putV(store, { version_id: "sv_2", version_label: "dup" });
    store.setActive("billing-api", "sv_2");

    const r = resolveTarget(store, { spec_id: "billing-api" }, "strict");
    expect(r).toMatchObject({ ok: false, code: "ambiguous" });
    if (!r.ok) {
      // Labels are non-unique → fallback to ids in the message
      expect(r.message).toContain("sv_1");
      expect(r.message).toContain("sv_2");
    }
  });
});

describe("formatVersionHandle", () => {
  it("returns version_label when it uniquely identifies the version among siblings", () => {
    const store = new InMemoryStore();
    putV(store, { version_id: "sv_1", version_label: "1.0.0" });
    putV(store, { version_id: "sv_2", version_label: "2.0.0" });
    const siblings = store.listVersions("billing-api");
    const v = siblings.find((s) => s.version_id === "sv_1")!;
    expect(formatVersionHandle(v, siblings)).toBe("1.0.0");
  });

  it("returns version_id when the label is shared by another sibling (non-unique)", () => {
    const store = new InMemoryStore();
    putV(store, { version_id: "sv_1", version_label: "dup" });
    putV(store, { version_id: "sv_2", version_label: "dup" });
    const siblings = store.listVersions("billing-api");
    const v = siblings.find((s) => s.version_id === "sv_1")!;
    expect(formatVersionHandle(v, siblings)).toBe("sv_1");
  });

  it("returns version_id when version_label is null", () => {
    const store = new InMemoryStore();
    putV(store, { version_id: "sv_1", version_label: null });
    const siblings = store.listVersions("billing-api");
    expect(formatVersionHandle(siblings[0]!, siblings)).toBe("sv_1");
  });
});

describe("formatVersionHandle / resolveVersionRef consistency", () => {
  it("shown as label iff resolveVersionRef resolves to that exact version (consistency property)", () => {
    // sv_1: unique label; sv_2+sv_3: shared label; sv_4: null label
    const store = new InMemoryStore();
    putV(store, { version_id: "sv_1", version_label: "1.0.0" });
    putV(store, { version_id: "sv_2", version_label: "dup" });
    putV(store, { version_id: "sv_3", version_label: "dup" });
    putV(store, { version_id: "sv_4", version_label: null });
    const siblings = store.listVersions("billing-api");

    for (const v of siblings) {
      const handle = formatVersionHandle(v, siblings);
      if (handle === v.version_label) {
        // Label was shown — must resolve uniquely to this version
        const resolved = resolveVersionRef(store, "billing-api", handle);
        expect(resolved.ok).toBe(true);
        if (resolved.ok) expect(resolved.version.version_id).toBe(v.version_id);
      } else {
        // Id was shown — either label is null or non-unique
        expect(handle).toBe(v.version_id);
        if (v.version_label !== null) {
          const resolved = resolveVersionRef(store, "billing-api", v.version_label);
          expect(resolved.ok).toBe(false);
          if (!resolved.ok) expect(resolved.code).toBe("ambiguous");
        }
      }
    }
  });
});
