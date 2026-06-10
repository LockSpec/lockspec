import { it, expect } from "vitest";
import { TOOLS } from "../../src/tools/index.js";

// Registry invariant: exactly the expected 9 tool names are registered.
// Catches accidental omissions or renames at the registration layer.
it("all 9 tools are registered", () => {
  const names = TOOLS.map((t) => t.name).sort();
  expect(names).toEqual([
    "activate_version",
    "diff_versions",
    "find_endpoint",
    "find_type",
    "get_signature",
    "list_specs",
    "load_spec",
    "remove_spec",
    "validate_call",
  ]);
});
