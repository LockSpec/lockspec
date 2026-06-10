import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { loadSpecTool, slugifyTitle } from "../../src/tools/load_spec.js";
import { listSpecsTool } from "../../src/tools/list_specs.js";
import { InMemoryStore } from "../helpers/in-memory-store.js";
import type { ToolDeps } from "../../src/tools/index.js";

// Also the home of the spec-ingestion determinism tier: a re-serialization of the
// same logical spec → same content_hash → reload no-op.

function run(args: unknown, store = new InMemoryStore()) {
  const deps: ToolDeps = { store };
  return loadSpecTool.handler(args, deps);
}
function payloadOf(result: { content: Array<{ type: string; text?: string }> }): any {
  return JSON.parse(result.content[0]!.text!);
}
function summaryOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[1]?.text ?? "";
}

// Coercion-safe (quoted version → stays a string under YAML parsing).
const INLINE = `
openapi: 3.1.0
info:
  title: Widget API
  version: "1.0.0"
paths:
  /widgets:
    get:
      operationId: listWidgets
      responses:
        '200':
          description: OK
`;

describe("load_spec — size guard", () => {
  it("inline source over the cap → size_limit (rejected before parse)", async () => {
    const deps: ToolDeps = { store: new InMemoryStore(), maxSpecBytes: 50 };
    const big = "#".repeat(200); // content irrelevant — the byte count is what's rejected
    const p = payloadOf(await loadSpecTool.handler({ source: big, source_type: "inline" }, deps));
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("size_limit");
    expect(p.error.message).toMatch(/16|MiB|limit|bytes/i);
  });

  it("file larger than the cap → size_limit before readFileSync (statSync guard)", async () => {
    const deps: ToolDeps = { store: new InMemoryStore(), maxSpecBytes: 50 };
    const f = join(mkdtempSync(join(tmpdir(), "lockspec-size-")), "big.yaml");
    writeFileSync(f, "#".repeat(200));
    const p = payloadOf(await loadSpecTool.handler({ source: f, source_type: "file" }, deps));
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("size_limit");
  });

  it("input under the cap still loads (ok:true)", async () => {
    const deps: ToolDeps = { store: new InMemoryStore(), maxSpecBytes: 10 * 1024 * 1024 };
    const p = payloadOf(await loadSpecTool.handler({ source: INLINE, source_type: "inline" }, deps));
    expect(p.ok).toBe(true);
  });
});

describe("load_spec — happy path", () => {
  it("loads an inline spec: persisted, active, expected output shape", async () => {
    const store = new InMemoryStore();
    const p = payloadOf(await run({ source: INLINE }, store));

    expect(p.ok).toBe(true);
    expect(p.spec_id).toBe("widget-api"); // slug of info.title
    expect(p.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/); // prefix added at tool layer
    expect(p.spec_format).toBe("openapi");
    expect(p.format_version).toBe("3.1.0");
    expect(p.version_label).toBe("1.0.0");
    expect(p.activated).toBe(true);
    expect(p.was_existing).toBe(false);
    // One operation (GET:/widgets), no named schemas.
    expect(p.stats).toEqual({ operations: 1, type_defs: 0, warnings: [] });

    expect(store.getActiveVersion("widget-api")?.version_id).toBe(p.version_id);
    expect(store.getOperations("widget-api", p.version_id).map((o) => o.operation_key)).toEqual([
      "GET:/widgets",
    ]);
    expect(store.loadSnapshot(p.content_hash.slice("sha256:".length))).toBeDefined();
  });

  it("loads from a file and records file provenance", async () => {
    const store = new InMemoryStore();
    const file = join(import.meta.dirname, "../../fixtures/openapi/clean/petstore-3.1.yaml");
    const p = payloadOf(await run({ source: file, source_type: "file" }, store));

    expect(p.ok).toBe(true);
    expect(p.spec_id).toBe("petstore");
    const version = store.getVersion("petstore", p.version_id);
    expect(version?.provenance.source_type).toBe("file");
    expect(version?.provenance.source_uri).toContain("petstore-3.1.yaml");
  });

  it("loads a clean 3.0 fixture end-to-end; format_version reports the SOURCE dialect", async () => {
    // The reconciler rewrites schema semantics to 3.1/2020-12, but format_version
    // must still report the source dialect (3.0.3), not the reconciled target.
    const store = new InMemoryStore();
    const file = join(import.meta.dirname, "../../fixtures/openapi/clean/petstore-3.0.yaml");
    const p = payloadOf(await run({ source: file, source_type: "file" }, store));

    expect(p.ok).toBe(true);
    expect(p.spec_id).toBe("petstore");
    expect(p.spec_format).toBe("openapi");
    expect(p.format_version).toBe("3.0.3"); // source dialect, not silently "3.1.0"
    expect(store.getActiveVersion("petstore")?.version_id).toBe(p.version_id);
    expect(store.loadSnapshot(p.content_hash.slice("sha256:".length))).toBeDefined();
  });

  it("activate:false loads without activating", async () => {
    const store = new InMemoryStore();
    const p = payloadOf(await run({ source: INLINE, activate: false }, store));

    expect(p.activated).toBe(false);
    expect(store.getActiveVersion("widget-api")).toBeUndefined();
    expect(store.getVersion("widget-api", p.version_id)).toBeDefined();
  });
});

describe("load_spec — identity & versioning", () => {
  it("identical reload is a no-op returning the existing version", async () => {
    const store = new InMemoryStore();
    const a = payloadOf(await run({ source: INLINE }, store));
    const b = payloadOf(await run({ source: INLINE }, store));

    expect(b.was_existing).toBe(true);
    expect(b.version_id).toBe(a.version_id);
    expect(store.listVersions("widget-api").map((v) => v.version_id)).toEqual([a.version_id]);
  });

  it("reloading a version persisted with an empty index backfills it", async () => {
    // The identical-reload path returns the stored version WITHOUT putVersion,
    // so a version persisted with an empty index would stay unindexed. Reload
    // must reindex-if-missing.
    const store = new InMemoryStore();
    const a = payloadOf(await run({ source: INLINE }, store));
    // Simulate a pre-indexer version: wipe its index rows in place.
    store.reindexVersion("widget-api", a.version_id, [], []);
    expect(store.getOperations("widget-api", a.version_id)).toEqual([]);

    const b = payloadOf(await run({ source: INLINE }, store));

    // Same version (no new one, no new snapshot) — the dedup no-op still holds...
    expect(b.was_existing).toBe(true);
    expect(b.version_id).toBe(a.version_id);
    expect(store.listVersions("widget-api")).toHaveLength(1);
    // ...but the empty index has been backfilled, and stats report the truth.
    expect(store.getOperations("widget-api", a.version_id).map((o) => o.operation_key)).toEqual([
      "GET:/widgets",
    ]);
    expect(b.stats.operations).toBe(1);
  });

  it("a re-serialized logical spec hashes the same → reload no-op (determinism tier)", async () => {
    // Same logical spec, keys reordered — canonicalization must make this identical.
    const reordered = `
paths:
  /widgets:
    get:
      responses:
        '200':
          description: OK
      operationId: listWidgets
info:
  version: "1.0.0"
  title: Widget API
openapi: 3.1.0
`;
    const store = new InMemoryStore();
    const a = payloadOf(await run({ source: INLINE }, store));
    const b = payloadOf(await run({ source: reordered }, store));

    expect(b.content_hash).toBe(a.content_hash);
    expect(b.version_id).toBe(a.version_id);
    expect(b.was_existing).toBe(true);
    expect(store.listVersions("widget-api")).toHaveLength(1);
  });

  it("new content under the same spec_id coexists; newest becomes active", async () => {
    const store = new InMemoryStore();
    const a = payloadOf(await run({ source: INLINE }, store));
    const modified = INLINE.replace("listWidgets", "listAllWidgets");
    const b = payloadOf(await run({ source: modified }, store));

    expect(b.spec_id).toBe("widget-api"); // same title → same slug
    expect(b.content_hash).not.toBe(a.content_hash);
    expect(b.version_id).not.toBe(a.version_id);
    expect(b.was_existing).toBe(false);
    expect(store.listVersions("widget-api")).toHaveLength(2);
    expect(store.getActiveVersion("widget-api")?.version_id).toBe(b.version_id);
  });
});

describe("slugifyTitle — fixed algorithm", () => {
  it.each([
    // The two committed assertions — locked so the algorithm can't drift off them.
    ["Petstore", "petstore"],
    ["Widget API", "widget-api"],
    // Unicode: NFKD-fold diacritics to ASCII rather than dropping them.
    ["Café API", "cafe-api"],
    // Punctuation / symbol runs collapse to a single hyphen.
    ["v1: Orders!!", "v1-orders"],
    // Leading/trailing junk is trimmed.
    ["  -Foo-  ", "foo"],
    // Nothing usable → empty (caller routes to invalid_input).
    ["!!!", ""],
  ])("slugifies %j → %j", (input, expected) => {
    expect(slugifyTitle(input)).toBe(expected);
  });
});

describe("load_spec — spec_id derivation & collision", () => {
  // Same logical shape, parameterized title + operationId so two loads produce
  // distinct content (different hash) under whatever title we choose.
  const spec = (title: string, opId: string) => `
openapi: 3.1.0
info:
  title: "${title}"
  version: "1.0.0"
paths:
  /widgets:
    get:
      operationId: ${opId}
      responses:
        '200':
          description: OK
`;

  it("a derived slug aliasing a DIFFERENT title errors `collision`", async () => {
    const store = new InMemoryStore();
    await run({ source: spec("Widget API", "listWidgets") }, store); // → widget-api
    // "Widget-API" slugs to the same "widget-api" but is a different raw title,
    // with different content — a genuine title-slug collision (not a new version).
    const p = payloadOf(await run({ source: spec("Widget-API", "listGadgets") }, store));

    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("collision");
    expect(p.error.message).toMatch(/spec_id/); // actionable: tells the agent what to supply
    // The colliding slug is left untouched — no phantom version grafted on.
    expect(store.listVersions("widget-api")).toHaveLength(1);
  });

  it("an explicit spec_id bypasses the collision check (caller owns the namespace)", async () => {
    const store = new InMemoryStore();
    await run({ source: spec("Widget API", "listWidgets") }, store);
    const p = payloadOf(
      await run({ source: spec("Widget-API", "listGadgets"), spec_id: "widget-api-2" }, store),
    );

    expect(p.ok).toBe(true);
    expect(p.spec_id).toBe("widget-api-2");
    expect(store.listSpecs().map((s) => s.spec_id).sort()).toEqual(["widget-api", "widget-api-2"]);
  });

  it("a spec with nothing to index (empty paths, no webhooks/components) → `parse_error`", async () => {
    // Empty `paths: {}` with no webhooks/components is a HARD violation — there is
    // nothing to index. Missing info is SOFT (warn+load), so the failure here is
    // the empty-paths rule, not absent info.
    const p = payloadOf(
      await run({ source: "openapi: 3.1.0\npaths: {}", source_type: "inline" }),
    );

    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("parse_error");
    expect(p.error.details).toMatchObject({ count: expect.any(Number), errors: expect.any(Array) });
  });

  it("missing info.title with an indexable path but no explicit spec_id → `invalid_input`", async () => {
    // Missing info.title is SOFT (warn+load), but load_spec still can't derive a
    // spec_id without a title — so with no explicit spec_id it routes to invalid_input.
    // The warning never surfaces (error returns first).
    const p = payloadOf(
      await run({
        source:
          "openapi: 3.1.0\ninfo: { version: '1' }\npaths:\n  /p: { get: { responses: { '200': { description: OK } } } }\n",
        source_type: "inline",
      }),
    );

    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("invalid_input");
    expect(p.error.message).toMatch(/spec_id/);
  });

  it("a non-sluggable title with no explicit spec_id → `invalid_input` (not collision)", async () => {
    // "!!!" slugs to "" — an input gap, not a title collision.
    const p = payloadOf(await run({ source: spec("!!!", "listWidgets") }));

    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("invalid_input");
    expect(p.error.message).toMatch(/spec_id/);
  });
});

describe("load_spec — structured errors, never throws", () => {
  it("malformed source → parse_error", async () => {
    const p = payloadOf(await run({ source: "{ : not valid yaml", source_type: "inline" }));
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("parse_error");
  });

  it("non-3.x spec → unsupported_spec", async () => {
    const p = payloadOf(
      await run({
        source: '{"swagger":"2.0","info":{"title":"X","version":"1"},"paths":{}}',
        source_type: "inline",
      }),
    );
    expect(p.error.code).toBe("unsupported_spec");
  });

  it("missing file → io_error", async () => {
    const p = payloadOf(
      await run({ source: "fixtures/openapi/does-not-exist.yaml", source_type: "file" }),
    );
    expect(p.error.code).toBe("io_error");
  });
});

// Messy-spec fixture characterization: every fixture in fixtures/openapi/messy/
// loads or errors *gracefully* — no unhandled exception, always a structured
// ok:true or ok:false result. Cases that cannot fail naturally (circular-refs,
// vendor-extensions, missing-operationids) use the negative-control pattern to
// establish teeth: the suite would fail if the handler threw an unstructured
// exception.
describe("load_spec — messy-spec fixtures (graceful load or structured error)", () => {
  const FIX = join(import.meta.dirname, "../../fixtures/openapi");

  it("missing-operationids: loads ok, falls back to operation_key (never crashes)", async () => {
    // No operationId fields → indexer uses METHOD:path as operation_key. ok:true.
    // Negative-control teeth: the test would fail if the handler threw instead.
    const p = payloadOf(
      await run({
        source: join(FIX, "messy/missing-operationids.yaml"),
        source_type: "file",
        spec_id: "missing-opids",
      }),
    );
    expect(p.ok).toBe(true);
    expect(p.stats.operations).toBeGreaterThan(0);
  });

  it("missing-info + explicit spec_id → loads with warnings, version_label null", async () => {
    // Missing info.title/info.version is SOFT: with an explicit spec_id the spec
    // loads, version_label is null, and stats.warnings names both gaps.
    // (Without a spec_id it would be invalid_input — see the inline test above.)
    const p = payloadOf(
      await run({ source: join(FIX, "messy/missing-info.yaml"), source_type: "file", spec_id: "no-info" }),
    );
    expect(p.ok).toBe(true);
    expect(p.version_label).toBeNull();
    expect(p.stats.operations).toBeGreaterThan(0);
    expect(p.stats.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("info.title"),
        expect.stringContaining("info.version"),
      ]),
    );
  });

  it("duplicate operationId → loads with a warning", async () => {
    // A spec with non-unique operationIds loads; the duplicate is surfaced as a
    // warning. get_signature by operation_id stays query-time ambiguous.
    const dup =
      "openapi: 3.1.0\ninfo: { title: Dup, version: '1' }\npaths:\n" +
      "  /a: { get: { operationId: dup, responses: { '200': { description: OK } } } }\n" +
      "  /b: { get: { operationId: dup, responses: { '200': { description: OK } } } }\n";
    const p = payloadOf(await run({ source: dup, source_type: "inline" }));
    expect(p.ok).toBe(true);
    expect(p.stats.warnings.some((w: string) => w.includes("dup") && w.includes("operation_key"))).toBe(true);
  });

  it("webhooks-only 3.1 spec (no paths) → loads", async () => {
    // The parser accepts a 3.1 spec with webhooks and no `paths` key — the
    // empty-paths rule fires only when nothing is indexable. The fixture pins
    // the behavior.
    const p = payloadOf(
      await run({ source: join(FIX, "messy/webhooks-only.yaml"), source_type: "file" }),
    );
    expect(p.ok).toBe(true);
    expect(p.stats.warnings).toEqual([]);
  });

  it("malformed.yaml: invalid YAML → parse_error with line/col in details (no crash)", async () => {
    // malformed.yaml is invalid YAML; parse fails before any spec processing.
    // NormalizeError.details ({line, col}) must propagate through the error boundary.
    const p = payloadOf(
      await run({ source: join(FIX, "messy/malformed.yaml"), source_type: "file" }),
    );
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("parse_error");
    expect(p.error.details).toMatchObject({ line: expect.any(Number), col: expect.any(Number) });
  });

  it("vendor-extensions.yaml: x-* preserved, loads ok (no crash)", async () => {
    // Vendor extensions in paths/operations/schemas must not cause rejection.
    // Negative-control teeth.
    const p = payloadOf(
      await run({
        source: join(FIX, "messy/vendor-extensions.yaml"),
        source_type: "file",
        spec_id: "vendor-ext",
      }),
    );
    expect(p.ok).toBe(true);
    expect(p.stats.operations).toBeGreaterThan(0);
  });

  it("circular-refs.yaml: internal circular $refs load ok (no infinite loop, no crash)", async () => {
    // Internal $refs (including cycles) are preserved by the normalizer —
    // cycle-tagging is deferred to query time (get_signature). Load must succeed.
    // Negative-control teeth.
    const p = payloadOf(
      await run({
        source: join(FIX, "messy/circular-refs.yaml"),
        source_type: "file",
        spec_id: "circular",
      }),
    );
    expect(p.ok).toBe(true);
    expect(p.stats.operations).toBeGreaterThan(0);
  });

  it("external-refs/root.yaml: reachable external $ref bundled, loads ok", async () => {
    // External refs resolved and internalised at load time. Negative-control teeth.
    const p = payloadOf(
      await run({
        source: join(FIX, "messy/external-refs/root.yaml"),
        source_type: "file",
        spec_id: "ext-refs",
      }),
    );
    expect(p.ok).toBe(true);
  });
});

// External-$ref failure paths through the tool layer.
describe("load_spec — external-$ref failure paths", () => {
  const EXT = join(import.meta.dirname, "../../fixtures/openapi/messy/external-refs");

  it("unreachable external file → io_error (no crash, structured result)", async () => {
    const p = payloadOf(
      await run({ source: join(EXT, "root-broken.yaml"), source_type: "file" }),
    );
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("io_error");
  });

  it("malformed external content → parse_error (no crash, structured result)", async () => {
    const p = payloadOf(
      await run({ source: join(EXT, "root-malformed-ext.yaml"), source_type: "file" }),
    );
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("parse_error");
  });

  it("cyclic external refs → loads ok (bundler internalizes cycle)", async () => {
    const p = payloadOf(
      await run({
        source: join(EXT, "root-cyclic.yaml"),
        source_type: "file",
        spec_id: "cyclic-ext",
      }),
    );
    expect(p.ok).toBe(true);
    expect(p.stats.operations).toBeGreaterThan(0);
  });
});

// External-source provenance persistence.
describe("load_spec — external-source provenance persistence", () => {
  it("loading a spec with external $refs records resolved URIs in provenance.external_sources", async () => {
    const store = new InMemoryStore();
    const deps: ToolDeps = { store };

    // Load the reachable external-refs fixture
    const extRefsRoot = join(
      import.meta.dirname,
      "../../fixtures/openapi/messy/external-refs/root.yaml",
    );
    const loadResult = payloadOf(
      await loadSpecTool.handler(
        { source: extRefsRoot, source_type: "file", spec_id: "ext-provenance" },
        deps,
      ),
    );
    expect(loadResult.ok).toBe(true);

    // list_specs should show the external source URI in provenance
    const listResult = payloadOf(await listSpecsTool.handler({}, deps));
    expect(listResult.ok).toBe(true);
    const version = listResult.specs[0].versions[0];
    // external_sources must be an array containing the resolved relative URI
    expect(version.provenance.external_sources).toBeDefined();
    expect(Array.isArray(version.provenance.external_sources)).toBe(true);
    expect(version.provenance.external_sources.length).toBeGreaterThan(0);
    // The recorded source should reference the pet.yaml component file
    expect(
      version.provenance.external_sources.some((s: string) => s.includes("pet.yaml")),
    ).toBe(true);
  });

  it("loading a spec with no external $refs records an empty external_sources array", async () => {
    // Inline/clean spec → external_sources should be [] not undefined
    const store = new InMemoryStore();
    const deps: ToolDeps = { store };
    const loadResult = payloadOf(await loadSpecTool.handler({ source: INLINE }, deps));
    expect(loadResult.ok).toBe(true);

    const listResult = payloadOf(await listSpecsTool.handler({}, deps));
    const version = listResult.specs[0].versions[0];
    expect(Array.isArray(version.provenance.external_sources)).toBe(true);
    expect(version.provenance.external_sources).toHaveLength(0);
  });
});

describe("load_spec — label-first summary", () => {
  it("summary shows version_label when unique; falls back to version_id when label collides", async () => {
    const store = new InMemoryStore();
    const v1Result = await run({ source: INLINE }, store); // label "1.0.0", first load
    const v1Summary = summaryOf(v1Result);
    // Single version → label is unique → summary shows label
    expect(v1Summary).toContain("1.0.0");
    expect(v1Summary).not.toContain(payloadOf(v1Result).version_id);

    // Second load with different content but the same label → non-unique after this load
    const v2Result = await run({ source: INLINE.replace("listWidgets", "listAll") }, store);
    const v2Summary = summaryOf(v2Result);
    const v2Id = payloadOf(v2Result).version_id;
    // Two versions both labelled "1.0.0" → non-unique → fallback to version_id
    expect(v2Summary).toContain(v2Id);
    expect(v2Summary).not.toMatch(/^Loaded widget-api 1\.0\.0 /);
  });
});
