import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Packaging smoke: the BUILT entrypoint runs as a real CLI over real stdio.
// Spawns `node dist/index.js` (the `bin` target), handshakes a real MCP Client over
// the spawned process's stdin/stdout, and asserts exactly the 9 tools. This is the
// one path the source-level tests can't cover: the actual StdioServerTransport over
// a real pipe (a stray stdout write would break the JSON-RPC handshake here).
//
// SELF-SKIPPING: skips if dist/ isn't built, so default `npm test` (pre-build) stays
// green; runs after `npm run build` / in CI.

const DIST_ENTRY = join(import.meta.dirname, "../../dist/index.js");
const built = existsSync(DIST_ENTRY);

const EXPECTED_TOOLS = [
  "load_spec",
  "find_endpoint",
  "find_type",
  "get_signature",
  "validate_call",
  "diff_versions",
  "list_specs",
  "activate_version",
  "remove_spec",
];

describe.skipIf(!built)("CLI smoke: built dist/index.js over real stdio", () => {
  it("starts as `node dist/index.js` and lists exactly the 9 tools", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [DIST_ENTRY] });
    const client = new Client({ name: "cli-smoke", version: "0.0.0" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(new Set(tools.map((t) => t.name))).toEqual(new Set(EXPECTED_TOOLS));
    } finally {
      await client.close();
    }
  }, 20_000);
});

// Makes the file meaningful (and loud) when dist is absent — names the prerequisite.
describe.skipIf(built)("CLI smoke (skipped — run `npm run build` first)", () => {
  it("is skipped until dist/ is built", () => {
    expect(built).toBe(false);
  });
});
