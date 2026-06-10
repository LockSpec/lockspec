import { describe, it, expect } from "vitest";

import { listSpecsTool } from "../../src/tools/list_specs.js";
import { loadSpecTool } from "../../src/tools/load_spec.js";
import { InMemoryStore } from "../helpers/in-memory-store.js";
import type { ToolDeps } from "../../src/tools/index.js";

// Populated via the real load_spec handler so provenance/format/labels are realistic.

function payloadOf(result: { content: Array<{ type: string; text?: string }> }): any {
  return JSON.parse(result.content[0]!.text!);
}
const spec = (title: string, opId: string) => `
openapi: 3.1.0
info:
  title: "${title}"
  version: "1.0.0"
paths:
  /w:
    get:
      operationId: ${opId}
      responses:
        '200':
          description: OK
`;

async function seedTwo(): Promise<ToolDeps> {
  const deps: ToolDeps = { store: new InMemoryStore() };
  await loadSpecTool.handler({ source: spec("Alpha API", "a") }, deps);
  await loadSpecTool.handler({ source: spec("Beta API", "b") }, deps);
  return deps;
}

describe("list_specs", () => {
  it("empty store → ok with no specs", async () => {
    const p = payloadOf(await listSpecsTool.handler({}, { store: new InMemoryStore() }));
    expect(p.ok).toBe(true);
    expect(p.specs).toEqual([]);
  });

  it("lists each spec with versions, active flag, provenance, format, stats", async () => {
    const deps = await seedTwo();
    const p = payloadOf(await listSpecsTool.handler({}, deps));

    expect(p.ok).toBe(true);
    expect(p.specs.map((s: any) => s.spec_id).sort()).toEqual(["alpha-api", "beta-api"]);

    const alpha = p.specs.find((s: any) => s.spec_id === "alpha-api");
    expect(alpha.label).toBe("Alpha API");
    expect(alpha.versions).toHaveLength(1);
    const v = alpha.versions[0];
    expect(v.active).toBe(true); // activate-on-load default
    expect(alpha.active_version_id).toBe(v.version_id);
    expect(v.spec_format).toBe("openapi");
    expect(v.format_version).toBe("3.1.0");
    expect(v.version_label).toBe("1.0.0");
    expect(v.provenance.source_type).toBe("inline");
    expect(v.stats).toEqual({ operations: 1, type_defs: 0 }); // real index counts
  });

  it("scoped to one spec_id returns just that spec", async () => {
    const deps = await seedTwo();
    const p = payloadOf(await listSpecsTool.handler({ spec_id: "beta-api" }, deps));
    expect(p.specs.map((s: any) => s.spec_id)).toEqual(["beta-api"]);
  });

  it("scoped to a missing spec_id → not_found", async () => {
    const p = payloadOf(await listSpecsTool.handler({ spec_id: "ghost" }, { store: new InMemoryStore() }));
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("not_found");
  });
});
