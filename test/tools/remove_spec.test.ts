import { describe, it, expect } from "vitest";

import { removeSpecTool } from "../../src/tools/remove_spec.js";
import { loadSpecTool } from "../../src/tools/load_spec.js";
import { InMemoryStore } from "../helpers/in-memory-store.js";
import type { ToolDeps } from "../../src/tools/index.js";

function payloadOf(result: { content: Array<{ type: string; text?: string }> }): any {
  return JSON.parse(result.content[0]!.text!);
}
function summaryOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[1]?.text ?? "";
}
const bareHash = (content_hash: string) => content_hash.replace(/^sha256:/, "");
const widget = (opId: string, ver: string) => `
openapi: 3.1.0
info:
  title: Widget API
  version: "${ver}"
paths:
  /w:
    get:
      operationId: ${opId}
      responses:
        '200':
          description: OK
`;

describe("remove_spec — snapshot GC (last-dereference)", () => {
  it("keeps a shared snapshot until the last referencing spec is removed", async () => {
    // Same source under two explicit spec_ids → identical content_hash → one
    // shared snapshot (the only tool path that shares a snapshot, since the hash
    // includes info.title).
    const deps: ToolDeps = { store: new InMemoryStore() };
    const src = widget("a", "1.0");
    const a = payloadOf(await loadSpecTool.handler({ source: src, spec_id: "api-a" }, deps));
    const b = payloadOf(await loadSpecTool.handler({ source: src, spec_id: "api-b" }, deps));
    const hash = bareHash(a.content_hash);
    expect(bareHash(b.content_hash)).toBe(hash); // shared

    payloadOf(await removeSpecTool.handler({ spec_id: "api-a", confirm: true }, deps));
    expect(deps.store.loadSnapshot(hash)).toBeDefined(); // api-b still references it

    const p = payloadOf(await removeSpecTool.handler({ spec_id: "api-b", confirm: true }, deps));
    expect(deps.store.loadSnapshot(hash)).toBeUndefined(); // last reference gone
    expect(p.removed.snapshots_deleted).toContain(hash);
  });
});

describe("remove_spec — version vs whole spec", () => {
  it("removes one (non-active) version; the other survives", async () => {
    const deps: ToolDeps = { store: new InMemoryStore() };
    const v1 = payloadOf(await loadSpecTool.handler({ source: widget("a", "1.0") }, deps));
    const v2 = payloadOf(await loadSpecTool.handler({ source: widget("b", "2.0") }, deps)); // active

    const p = payloadOf(
      await removeSpecTool.handler({ spec_id: "widget-api", version: v1.version_id, confirm: true }, deps),
    );

    expect(p.ok).toBe(true);
    expect(p.removed.scope).toBe("version");
    expect(deps.store.listVersions("widget-api").map((v) => v.version_id)).toEqual([v2.version_id]);
    expect(deps.store.loadSnapshot(bareHash(v1.content_hash))).toBeUndefined(); // GC'd
    expect(deps.store.loadSnapshot(bareHash(v2.content_hash))).toBeDefined(); // kept
  });

  it("removes the whole spec when version is omitted", async () => {
    const deps: ToolDeps = { store: new InMemoryStore() };
    await loadSpecTool.handler({ source: widget("a", "1.0") }, deps);
    await loadSpecTool.handler({ source: widget("b", "2.0") }, deps);

    const p = payloadOf(await removeSpecTool.handler({ spec_id: "widget-api", confirm: true }, deps));

    expect(p.ok).toBe(true);
    expect(p.removed.scope).toBe("spec");
    expect(deps.store.getSpec("widget-api")).toBeUndefined();
    expect(deps.store.listSpecs()).toEqual([]);
  });
});

describe("remove_spec — guards & errors", () => {
  it("refuses to remove the active version singly → invalid_input with guidance", async () => {
    const deps: ToolDeps = { store: new InMemoryStore() };
    const v1 = payloadOf(await loadSpecTool.handler({ source: widget("a", "1.0") }, deps)); // active

    const p = payloadOf(
      await removeSpecTool.handler({ spec_id: "widget-api", version: v1.version_id, confirm: true }, deps),
    );

    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("invalid_input");
    expect(p.error.message).toMatch(/activate|whole spec|omit/i);
    expect(deps.store.getVersion("widget-api", v1.version_id)).toBeDefined(); // untouched
  });

  it("unknown spec_id → not_found", async () => {
    const deps: ToolDeps = { store: new InMemoryStore() };
    const p = payloadOf(await removeSpecTool.handler({ spec_id: "ghost", confirm: true }, deps));
    expect(p.error.code).toBe("not_found");
  });

  it("unknown version ref → not_found", async () => {
    const deps: ToolDeps = { store: new InMemoryStore() };
    await loadSpecTool.handler({ source: widget("a", "1.0") }, deps);
    const p = payloadOf(
      await removeSpecTool.handler({ spec_id: "widget-api", version: "nope", confirm: true }, deps),
    );
    expect(p.error.code).toBe("not_found");
  });

  it("active-version rejection names the label when it is unique among siblings", async () => {
    // Single version with label "1.0" → unique → rejection message uses "1.0"
    const deps: ToolDeps = { store: new InMemoryStore() };
    const v1 = payloadOf(await loadSpecTool.handler({ source: widget("a", "1.0") }, deps));

    const result = await removeSpecTool.handler(
      { spec_id: "widget-api", version: v1.version_id, confirm: true },
      deps,
    );
    const p = payloadOf(result);
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("invalid_input");
    // Label "1.0" is unique → message names the label, not the raw version_id
    expect(p.error.message).toContain('"1.0"');
    expect(p.error.message).not.toContain(v1.version_id);
  });
});
