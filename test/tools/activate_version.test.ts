import { describe, it, expect } from "vitest";

import { activateVersionTool } from "../../src/tools/activate_version.js";
import { loadSpecTool } from "../../src/tools/load_spec.js";
import { InMemoryStore } from "../helpers/in-memory-store.js";
import type { ToolDeps } from "../../src/tools/index.js";

function payloadOf(result: { content: Array<{ type: string; text?: string }> }): any {
  return JSON.parse(result.content[0]!.text!);
}
function summaryOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[1]?.text ?? "";
}
// Distinct opId → distinct content → coexisting versions under one spec_id.
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

async function seed(verA: string, verB: string) {
  const deps: ToolDeps = { store: new InMemoryStore() };
  const a = payloadOf(await loadSpecTool.handler({ source: widget("a", verA) }, deps));
  const b = payloadOf(await loadSpecTool.handler({ source: widget("b", verB) }, deps));
  return { deps, a, b }; // b is active (newest-loaded default)
}

describe("activate_version", () => {
  it("flips the active version by version_id", async () => {
    const { deps, a, b } = await seed("1.0", "2.0");
    expect(deps.store.getActiveVersion("widget-api")?.version_id).toBe(b.version_id);

    const p = payloadOf(
      await activateVersionTool.handler({ spec_id: "widget-api", version: a.version_id }, deps),
    );

    expect(p.ok).toBe(true);
    expect(p.active_version_id).toBe(a.version_id);
    expect(deps.store.getActiveVersion("widget-api")?.version_id).toBe(a.version_id);
  });

  it("flips by version_label when it uniquely identifies a version", async () => {
    const { deps, a } = await seed("1.0", "2.0");
    const p = payloadOf(
      await activateVersionTool.handler({ spec_id: "widget-api", version: "1.0" }, deps),
    );

    expect(p.ok).toBe(true);
    expect(p.active_version_id).toBe(a.version_id);
    expect(p.version_label).toBe("1.0");
  });

  it("unknown version ref → not_found", async () => {
    const { deps } = await seed("1.0", "2.0");
    const p = payloadOf(
      await activateVersionTool.handler({ spec_id: "widget-api", version: "nope" }, deps),
    );
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("not_found");
  });

  it("ambiguous version_label → ambiguous (lists candidates)", async () => {
    const { deps } = await seed("dup", "dup"); // both versions labelled "dup"
    const p = payloadOf(
      await activateVersionTool.handler({ spec_id: "widget-api", version: "dup" }, deps),
    );
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("ambiguous");
  });

  it("unknown spec_id → not_found", async () => {
    const deps: ToolDeps = { store: new InMemoryStore() };
    const p = payloadOf(
      await activateVersionTool.handler({ spec_id: "ghost", version: "x" }, deps),
    );
    expect(p.ok).toBe(false);
    expect(p.error.code).toBe("not_found");
  });

  it("summary shows version_id when label is shared across siblings (non-unique fallback)", async () => {
    // Both versions share label "dup" → non-unique → fallback to version_id in summary
    const { deps, a } = await seed("dup", "dup");
    const result = await activateVersionTool.handler(
      { spec_id: "widget-api", version: a.version_id },
      deps,
    );
    const summary = summaryOf(result);
    expect(summary).toContain(a.version_id);
    expect(summary).not.toContain("dup");
  });

  it("summary shows version_label when it uniquely identifies the version", async () => {
    const { deps, a } = await seed("1.0", "2.0");
    const result = await activateVersionTool.handler(
      { spec_id: "widget-api", version: a.version_id },
      deps,
    );
    const summary = summaryOf(result);
    expect(summary).toContain("1.0");
    expect(summary).not.toContain(a.version_id);
  });
});
