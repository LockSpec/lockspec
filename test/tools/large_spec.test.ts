import { describe, it, expect, beforeAll } from "vitest";

import { loadSpecTool } from "../../src/tools/load_spec.js";
import { findEndpointTool } from "../../src/tools/find_endpoint.js";
import { getSignatureTool } from "../../src/tools/get_signature.js";
import { InMemoryStore } from "../helpers/in-memory-store.js";
import { makeLargeSpec } from "../helpers/large-spec.js";
import type { ToolDeps } from "../../src/tools/index.js";

// Large-spec benchmark: a synthetic generated spec (test/helpers/large-spec.ts)
// — no third-party vendoring. Proves scale (thousands of ops load without OOM,
// bounded payloads) and pins a few STABLE recall assertions. This is
// characterization, NOT a threshold gate: the recall baseline is not asserted
// here (lexical recall is fuzzy; a heap/percentage gate would flake). Recall
// here is ranking-correctness at scale, not real-world paraphrase recall.

function payloadOf(result: { content: Array<{ type: string; text?: string }> }): any {
  return JSON.parse(result.content[0]!.text!);
}

describe("large spec — scale + recall", () => {
  // One load shared across the recall assertions (load is the expensive step).
  // beforeAll makes the dependency explicit (recall tests read this store) and
  // independent of test definition-order / sequence.shuffle.
  const store = new InMemoryStore();
  const deps: ToolDeps = { store };
  let loaded: any;

  beforeAll(async () => {
    const json = JSON.stringify(makeLargeSpec());
    loaded = payloadOf(await loadSpecTool.handler({ source: json, source_type: "inline" }, deps));
  }, 30_000);

  it("a ~3000-operation spec loads ok within the size cap", () => {
    expect(loaded.ok).toBe(true);
    expect(loaded.stats.operations).toBeGreaterThan(3000);
    expect(loaded.stats.warnings).toEqual([]); // a clean generated spec emits no SOFT warnings
  });

  // Distinctive anchor intent → expected operation ranked #1. Stable because the
  // anchor nouns are unique tokens (see LARGE_SPEC_ANCHORS).
  it.each([
    ["create a telescope", "POST:/telescopes"],
    ["list umbrellas", "GET:/umbrellas"],
    ["delete a volcano", "DELETE:/volcanos/{id}"],
    ["update lighthouse", "PUT:/lighthouses/{id}"],
    ["get a kangaroo by id", "GET:/kangaroos/{id}"],
  ])("ranks %j → %j first", async (query, expectedKey) => {
    const p = payloadOf(await findEndpointTool.handler({ query }, deps));
    expect(p.ok).toBe(true);
    expect(p.results[0].operation_key).toBe(expectedKey);
  });

  it("get_signature on a large-spec operation stays bounded", async () => {
    const p = payloadOf(await getSignatureTool.handler({ operation_id: "createTelescope" }, deps));
    expect(p.ok).toBe(true);
    expect(p.operation_key).toBe("POST:/telescopes");
    expect(Array.isArray(p.truncated_paths)).toBe(true);
  });
});
