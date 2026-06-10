import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Drift guard: server.json and package.json must stay in sync on the five fields
// the MCP registry enforces at publish time. A mismatch here means the published
// npm package and the registry entry would point at different names or versions.

const ROOT = join(import.meta.dirname, "../..");
const serverJson = JSON.parse(readFileSync(join(ROOT, "server.json"), "utf8")) as Record<string, unknown>;
const pkgJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Record<string, unknown>;

describe("registry metadata consistency", () => {
  it("package.json.mcpName equals server.json.name", () => {
    expect(pkgJson.mcpName).toBe(serverJson.name);
  });

  it("server.json packages[0].registryType is npm", () => {
    const pkg = (serverJson.packages as unknown[])[0] as Record<string, unknown>;
    expect(pkg.registryType).toBe("npm");
  });

  it("server.json packages[0].identifier equals package.json.name", () => {
    const pkg = (serverJson.packages as unknown[])[0] as Record<string, unknown>;
    expect(pkg.identifier).toBe(pkgJson.name);
  });

  it("server.json packages[0].version equals package.json.version", () => {
    const pkg = (serverJson.packages as unknown[])[0] as Record<string, unknown>;
    expect(pkg.version).toBe(pkgJson.version);
  });

  it("server.json.version equals package.json.version", () => {
    expect(serverJson.version).toBe(pkgJson.version);
  });
});
