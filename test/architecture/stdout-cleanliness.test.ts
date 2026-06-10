import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Static source scan: forbid `process.stdout` and any `console.<method>`
// except error/warn (which go to stderr — allowed) from our src/ code.
// Complements the runtime spy in test/integration/stdout-cleanliness.test.ts
// (which catches deps on exercised paths); this scan covers ALL of src/,
// including unexercised paths.
const SRC_DIR = join(import.meta.dirname, "../../src");

const FORBIDDEN = [
  // console.log/info/debug/dir/table/… (anything but error/warn → stderr is fine).
  { name: "a stdout-routing console method (use console.error/warn → stderr)", re: /console\.(?!error|warn)\w+/ },
  { name: "process.stdout (corrupts the JSON-RPC stream)", re: /process\.stdout/ },
];

function srcFiles(): string[] {
  return readdirSync(SRC_DIR, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts"));
}

describe("no stdout writes from our code", () => {
  for (const file of srcFiles()) {
    it(`src/${file} writes no diagnostics to stdout`, () => {
      const src = readFileSync(join(SRC_DIR, file), "utf8");
      for (const { name, re } of FORBIDDEN) {
        expect(src, `src/${file} must not use ${name}`).not.toMatch(re);
      }
    });
  }

  it("scans the src directory", () => {
    expect(srcFiles().length).toBeGreaterThan(0);
  });
});
