import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    // Tests live under test/** (incl. test/bench/ — the offline unit tests for the
    // bench/ harness). bench/** itself is the runnable harness (live model-API
    // calls via bench/run.ts) and is NOT part of the project test gate —
    // excluded belt-and-suspenders.
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "bench/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // The glob is the coverage universe: every src file is reported, so an
      // untested module surfaces as a gap rather than dropping from the denominator.
      include: ["src/**/*.ts"],
      // The bin entrypoint runs only in a spawned subprocess (cli-smoke), which
      // in-process coverage can't observe — excluding it keeps the gate honest.
      exclude: ["src/index.ts"],
      // A regression ratchet, not a target: set a few points under the current
      // numbers so a real coverage drop fails the gate while normal churn doesn't.
      thresholds: {
        statements: 92,
        branches: 83,
        functions: 95,
        lines: 95,
      },
    },
  },
});
