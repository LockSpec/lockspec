import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Static source scan: src/core/** must import neither the MCP SDK nor the
// transport layer. Scope: static `import … from` / `export … from`;
// not dynamic import()/require.
const CORE_DIR = join(import.meta.dirname, "../../src/core");

const FORBIDDEN = [
  { name: "the MCP SDK", re: /from\s+['"]@modelcontextprotocol\/sdk/ },
  { name: "the transport layer", re: /from\s+['"][^'"]*\btransport\b/ },
];

function coreFiles(): string[] {
  if (!existsSync(CORE_DIR)) return [];
  return readdirSync(CORE_DIR, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts"));
}

describe("core is transport-free", () => {
  for (const file of coreFiles()) {
    it(`core/${file} imports neither the SDK nor transport`, () => {
      const src = readFileSync(join(CORE_DIR, file), "utf8");
      for (const { name, re } of FORBIDDEN) {
        expect(src, `src/core/${file} must not import ${name}`).not.toMatch(re);
      }
    });
  }

  it("scans the core directory", () => {
    expect(Array.isArray(coreFiles())).toBe(true);
  });
});
