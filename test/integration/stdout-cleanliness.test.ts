import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer } from "../../src/server.js";
import { InMemoryStore } from "../helpers/in-memory-store.js";

// Under InMemoryTransport the SDK uses the in-memory pair, NOT process.stdout,
// so ANY process.stdout write during a real client↔server session is from our
// code (or a dependency) → assert zero. Behavioral counterpart to the static
// scan in test/architecture/stdout-cleanliness.test.ts: this also catches
// dependency writes, but only on the paths exercised below.

const SPEC =
  "openapi: 3.1.0\n" +
  "info: { title: Pets, version: '1' }\n" +
  "paths:\n" +
  "  /pets:\n" +
  "    post: { operationId: createPet, summary: Create a pet, responses: { '200': { description: OK } } }\n";

describe("stdout cleanliness under a tool session", () => {
  it("nothing routes to stdout during handshake + representative tool calls", async () => {
    // Watch BOTH channels: process.stdout.write (direct writes, incl. dependencies)
    // AND console.log/info/debug. The console spies are essential — Vitest
    // intercepts console.* and routes it through its own reporter, NOT through the
    // process.stdout.write we spy, so a stray console.log (the #1 danger) would slip
    // past a process.stdout-only spy. console.error/warn → stderr, intentionally not watched.
    const writes: string[] = [];
    const record = (label: string) => (...args: unknown[]): boolean => {
      writes.push(`${label}: ${args.map(String).join(" ")}`);
      return true; // swallow — we expect none; capture any for the assertion
    };
    const spies = [
      vi.spyOn(process.stdout, "write").mockImplementation(record("process.stdout.write") as never),
      vi.spyOn(console, "log").mockImplementation(record("console.log") as never),
      vi.spyOn(console, "info").mockImplementation(record("console.info") as never),
      vi.spyOn(console, "debug").mockImplementation(record("console.debug") as never),
    ];

    try {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "0.0.0" });
      await Promise.all([
        client.connect(clientTransport),
        buildServer({ store: new InMemoryStore() }).connect(serverTransport),
      ]);

      // Exercise representative paths: read, ingest, search, signature, error.
      await client.callTool({ name: "list_specs", arguments: {} });
      await client.callTool({ name: "load_spec", arguments: { source: SPEC, source_type: "inline" } });
      await client.callTool({ name: "find_endpoint", arguments: { query: "createPet" } });
      await client.callTool({ name: "get_signature", arguments: { operation_id: "createPet" } });
      await client.callTool({ name: "find_endpoint", arguments: {} }); // invalid args → structured error path
      await client.close();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }

    expect(writes).toEqual([]);
  });
});
