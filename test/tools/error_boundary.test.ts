import { describe, it, expect } from "vitest";

import { registerAllTools, TOOLS } from "../../src/tools/index.js";
import type { Store } from "../../src/store/store.js";

// Error-boundary guarantee: NO exception crosses the tool boundary. Drives the
// ACTUAL registerAllTools wiring via a fake server that captures each registered
// callback, then invokes every tool with a Store whose every method throws. Each
// must RESOLVE to a structured {ok:false,error:{code}}, never throw/reject.
// Parametrized over TOOLS, so it also guards future tools.

// Every store method throws — worst-case Store failure (SQLite/FS down).
const throwingStore = new Proxy(
  {},
  { get: () => () => { throw new Error("store boom"); } },
) as unknown as Store;

// Capture the callbacks registerAllTools registers on the server.
const captured: Record<string, (args: unknown) => unknown> = {};
const fakeServer = {
  registerTool: (name: string, _meta: unknown, fn: (args: unknown) => unknown) => {
    captured[name] = fn;
  },
} as unknown as Parameters<typeof registerAllTools>[0];
registerAllTools(fakeServer, { store: throwingStore });

// Minimal valid args per tool — must pass each tool's Zod safeParse so execution
// reaches the store calls (where the throw happens).
const ARGS: Record<string, unknown> = {
  load_spec: {
    source: "openapi: 3.1.0\ninfo: { title: T, version: '1' }\npaths:\n  /p: { get: { responses: { '200': { description: OK } } } }\n",
    source_type: "inline",
  },
  find_endpoint: { query: "x" },
  find_type: { query: "x" },
  get_signature: { operation_id: "x" },
  validate_call: { operation_id: "x", request: {} },
  diff_versions: { from: { version: "v1" }, to: { version: "v2" } },
  list_specs: {},
  activate_version: { spec_id: "s", version: "v" },
  remove_spec: { spec_id: "s", version: "v", confirm: true },
};

function payloadOf(result: { content: Array<{ type: string; text?: string }> }): any {
  return JSON.parse(result.content[0]!.text!);
}

async function callTool(name: string) {
  const result = (await captured[name]!(ARGS[name])) as {
    content: Array<{ type: string; text?: string }>;
  };
  return payloadOf(result);
}

describe("no throw crosses the tool boundary", () => {
  it.each(TOOLS.map((t) => t.name))(
    "%s returns a structured ok:false on a store throw, never throws",
    async (name) => {
      const payload = await callTool(name);
      expect(payload.ok).toBe(false);
      expect(payload.error.code).toEqual(expect.any(String));
    },
  );

  // Pin the chosen decision (internal_error + unify): an UNGUARDED handler's
  // escaping store throw lands at the wrapper as exactly internal_error.
  it.each(["list_specs", "activate_version"])(
    "%s (no specific catch) → internal_error via the boundary wrapper",
    async (name) => {
      expect((await callTool(name)).error.code).toBe("internal_error");
    },
  );

  // ...but a handler with a SPECIFIC catch keeps its own code (here load_spec's
  // fallback → io_error). This pins the "except where a specific catch is correct"
  // half — the wrapper does NOT flatten everything to internal_error.
  it("load_spec keeps its specific code (io_error), not internal_error", async () => {
    expect((await callTool("load_spec")).error.code).toBe("io_error");
  });
});
