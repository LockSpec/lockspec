import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer } from "../../src/server.js";
import { InMemoryStore } from "../helpers/in-memory-store.js";

// A real MCP Client handshakes with the server over an in-memory linked
// transport pair and lists exactly the 9 tools. The only place the SDK is
// exercised end-to-end.

// The 9-tool contract — hardcoded here on purpose so this asserts the
// registration against a fixed list, not against the server's own tool list.
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

describe("MCP server handshake (integration)", () => {
  let client: Client;

  beforeAll(async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      buildServer({ store: new InMemoryStore() }).connect(serverTransport),
    ]);
  });

  afterAll(async () => {
    await client.close();
  });

  it("lists exactly the 9 tools (no more, no less)", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toHaveLength(EXPECTED_TOOLS.length);
    expect(new Set(names)).toEqual(new Set(EXPECTED_TOOLS));
  });

  it("exposes workflow instructions", () => {
    const instructions = client.getInstructions();
    expect(instructions).toBeTruthy();
    expect(instructions).toContain("list_specs");
  });

  it("instructs version pinning under multi-version (no unconditional active default)", () => {
    const instructions = client.getInstructions() ?? "";
    // No longer claims `version` unconditionally defaults to the active version.
    expect(instructions).not.toContain("defaults to the active version");
    // Teaches the agent to pin when multiple versions of a spec are loaded.
    expect(instructions).toMatch(/multiple/i);
    expect(instructions).toContain("get_signature");
    expect(instructions).toContain("validate_call");
    expect(instructions).toContain("explicit");
    expect(instructions).toContain("ambiguous");
  });

  it("a tool call returns a structured result over the protocol", async () => {
    // A real tool call round-trips a structured payload through the SDK. Against the
    // empty in-memory store find_endpoint resolves to not_found — the point here is
    // the structured-result-over-protocol path, not the specific code.
    const result = await client.callTool({ name: "find_endpoint", arguments: { query: "x" } });
    const content = result.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0]!.text);
    expect(payload).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});
