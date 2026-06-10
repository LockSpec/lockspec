import { describe, it, expect } from "vitest";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createTransport } from "../../src/transport/facade.js";

// Tests OUR selection/wiring logic, not the SDK's transport. The factory picks
// a transport for a given config; stdio is the v1 binding, http is a future
// drop-in (stub for now).
describe("transport facade factory", () => {
  it("returns a stdio transport by default", () => {
    expect(createTransport()).toBeInstanceOf(StdioServerTransport);
  });

  it("returns a stdio transport for stdio config", () => {
    expect(createTransport({ kind: "stdio" })).toBeInstanceOf(StdioServerTransport);
  });

  it("throws for the not-yet-implemented http transport", () => {
    expect(() => createTransport({ kind: "http" })).toThrow(/not implemented/i);
  });
});
