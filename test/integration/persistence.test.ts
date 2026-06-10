import { afterAll, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalStore } from "../../src/store/local-store.js";
import { loadSpecTool } from "../../src/tools/load_spec.js";
import { listSpecsTool } from "../../src/tools/list_specs.js";
import { activateVersionTool } from "../../src/tools/activate_version.js";
import { removeSpecTool } from "../../src/tools/remove_spec.js";

// Persistence across restart: state written through the tool handlers via one
// LocalStore survives and reads back through a FRESH LocalStore at the same root
// — the real path the server uses (a "restart" is exactly `new LocalStore(root)`,
// src/index.ts). Proven end-to-end through load_spec/list_specs/activate_version/
// remove_spec. The negative control (test D: a different root sees nothing)
// proves the other tests aren't vacuous.

// Isolation: every store gets a fresh temp root via mkdtemp — the real ~/.lockspec
// is NEVER touched; all stores closed and roots removed in afterAll.
const roots: string[] = [];
const stores: LocalStore[] = [];
function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lockspec-persist-"));
  roots.push(root);
  return root;
}
function open(root: string): LocalStore {
  const store = new LocalStore(root);
  stores.push(store);
  return store;
}
afterAll(() => {
  for (const s of stores) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function payloadOf(result: { content: Array<{ type: string; text?: string }> }): any {
  return JSON.parse(result.content[0]!.text!);
}
const bareHash = (h: string) => h.replace(/^sha256:/, "");
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

describe("persistence across restart (Phase 1 exit criterion)", () => {
  it("A — load_spec's snapshot + version + activation survive a restart (read via list_specs)", async () => {
    const root = freshRoot();

    const writer = open(root);
    const loaded = payloadOf(await loadSpecTool.handler({ source: widget("a", "1.0") }, { store: writer }));
    writer.close(); // simulate process exit

    const reader = open(root); // restart
    const list = payloadOf(await listSpecsTool.handler({}, { store: reader }));
    const spec = list.specs.find((s: any) => s.spec_id === "widget-api");
    expect(spec).toBeDefined();
    expect(spec.versions.map((v: any) => v.version_id)).toEqual([loaded.version_id]);
    expect(spec.versions[0].active).toBe(true);

    expect(reader.getActiveVersion("widget-api")?.version_id).toBe(loaded.version_id);
    expect(reader.loadSnapshot(bareHash(loaded.content_hash))).toBeDefined();
  });

  it("B — an activation performed after a restart itself persists across a further restart", async () => {
    const root = freshRoot();

    const writer = open(root);
    const v1 = payloadOf(await loadSpecTool.handler({ source: widget("a", "1.0") }, { store: writer }));
    const v2 = payloadOf(await loadSpecTool.handler({ source: widget("b", "2.0") }, { store: writer }));
    writer.close();
    expect(v2.version_id).not.toBe(v1.version_id);

    const r1 = open(root); // restart
    expect(r1.getActiveVersion("widget-api")?.version_id).toBe(v2.version_id); // newest-loaded default survived
    await activateVersionTool.handler({ spec_id: "widget-api", version: v1.version_id }, { store: r1 });
    r1.close();

    const r2 = open(root); // restart again
    expect(r2.getActiveVersion("widget-api")?.version_id).toBe(v1.version_id); // the cutover stuck
  });

  it("C — a removal persists across a restart (completes load→…→remove survives)", async () => {
    const root = freshRoot();

    const writer = open(root);
    await loadSpecTool.handler({ source: widget("a", "1.0") }, { store: writer });
    await removeSpecTool.handler({ spec_id: "widget-api", confirm: true }, { store: writer });
    writer.close();

    const reader = open(root); // restart
    expect(reader.getSpec("widget-api")).toBeUndefined();
    expect(payloadOf(await listSpecsTool.handler({}, { store: reader })).specs).toEqual([]);
  });

  it("D — negative control: a restart at a DIFFERENT root sees nothing (proves the above aren't vacuous)", async () => {
    const writer = open(freshRoot());
    await loadSpecTool.handler({ source: widget("a", "1.0") }, { store: writer });
    writer.close();

    const elsewhere = open(freshRoot()); // a different root — not where the data went
    expect(payloadOf(await listSpecsTool.handler({}, { store: elsewhere })).specs).toEqual([]);
  });
});
