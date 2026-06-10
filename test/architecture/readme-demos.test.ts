import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryStore } from "../helpers/in-memory-store.js";
import { loadSpecTool } from "../../src/tools/load_spec.js";
import { findEndpointTool } from "../../src/tools/find_endpoint.js";
import { getSignatureTool } from "../../src/tools/get_signature.js";
import { validateCallTool } from "../../src/tools/validate_call.js";
import type { ToolDeps } from "../../src/tools/index.js";

const README = join(import.meta.dirname, "../../README.md");
const BILLING_V1 = join(import.meta.dirname, "../../fixtures/openapi/versions/billing-v1.yaml");
const BILLING_V2 = join(import.meta.dirname, "../../fixtures/openapi/versions/billing-v2.yaml");
const PETSTORE_31 = join(import.meta.dirname, "../../fixtures/openapi/clean/petstore-3.1.yaml");

function payloadOf(result: { content: Array<{ type: string; text?: string }> }): any {
  return JSON.parse(result.content[0]!.text!);
}

function loadFile(store: InMemoryStore, path: string) {
  return loadSpecTool.handler({ source: path, source_type: "file" }, { store });
}

// Find the JSON fence block immediately following a named marker.
// Throws if the marker or its fence is absent — the RED trigger and a guard
// against block reordering.
function extractDemoBlock(readme: string, marker: string): unknown {
  const tag = `<!-- ${marker} -->`;
  const markerIdx = readme.indexOf(tag);
  if (markerIdx === -1) throw new Error(`README is missing anchor: ${tag}`);
  const after = readme.slice(markerIdx + tag.length);
  const fenceStart = after.indexOf("```json\n");
  if (fenceStart === -1) throw new Error(`No json fence found after anchor: ${tag}`);
  const bodyStart = fenceStart + "```json\n".length;
  const fenceEnd = after.indexOf("\n```", bodyStart);
  if (fenceEnd === -1) throw new Error(`Unclosed json fence after anchor: ${tag}`);
  return JSON.parse(after.slice(bodyStart, fenceEnd));
}

function sortErrors(errors: unknown[]): unknown[] {
  return [...errors].sort((a: any, b: any) => {
    const key = (e: any) => `${String(e.location)}\0${String(e.pointer)}\0${String(e.code)}`;
    return key(a).localeCompare(key(b));
  });
}

// Project a find_endpoint result row to only the columns the README shows.
// Trims score (internal rank), method and path (both encoded in operation_key), tags, deprecated.
function projectRow(row: any): Record<string, unknown> {
  return { operation_key: row.operation_key, operation_id: row.operation_id, summary: row.summary };
}

// Mask the one elided path in a get_signature payload so the test guards exactly what the README
// shows. The 201 response schema is byte-identical to the requestBody schema — both expand the
// same Pet $ref — so replacing it with "…" is provably lossless for the reader.
function maskPath(payload: any): any {
  const masked: any = JSON.parse(JSON.stringify(payload));
  masked.responses["201"].content["application/json"].schema = "…";
  return masked;
}

const STALE =
  " is stale — replace it with the live tool output printed above. " +
  "A dependency or normalization change likely moved the version hashes; re-paste the JSON verbatim.";

describe("README demo blocks match live tool output", () => {
  it("demo:find_endpoint block matches find_endpoint for query 'create' against petstore", async () => {
    const store = new InMemoryStore();
    await loadFile(store, PETSTORE_31);
    const deps: ToolDeps = { store };
    const live = payloadOf(findEndpointTool.handler({ query: "create" }, deps) as any);

    const serialized = JSON.stringify(live);
    expect(serialized, "find_endpoint payload must not contain fetched_at").not.toContain("fetched_at");
    expect(serialized, "find_endpoint payload must not contain created_at").not.toContain("created_at");

    // Project each row to the shown columns before comparing.
    const projected = { ...live, results: live.results.map(projectRow) };
    const pinned = extractDemoBlock(readFileSync(README, "utf8"), "demo:find_endpoint");
    expect(pinned, "README demo block 'demo:find_endpoint'" + STALE).toEqual(projected);
  });

  it("demo:get_signature block matches get_signature for createPet with redundant response schema elided", async () => {
    const store = new InMemoryStore();
    await loadFile(store, PETSTORE_31);
    const deps: ToolDeps = { store };
    const live = payloadOf(getSignatureTool.handler({ operation_id: "createPet" }, deps) as any);

    const serialized = JSON.stringify(live);
    expect(serialized, "get_signature payload must not contain fetched_at").not.toContain("fetched_at");
    expect(serialized, "get_signature payload must not contain created_at").not.toContain("created_at");

    // Mask the one elided path in live before comparing — guards exactly what the reader sees.
    const masked = maskPath(live);
    const pinned = extractDemoBlock(readFileSync(README, "utf8"), "demo:get_signature");
    expect(pinned, "README demo block 'demo:get_signature'" + STALE).toEqual(masked);
  });

  it("demo:validate_call_pass block matches validate_call with a correct createPet body", async () => {
    const store = new InMemoryStore();
    await loadFile(store, PETSTORE_31);
    const deps: ToolDeps = { store };
    const live = payloadOf(
      validateCallTool.handler(
        { operation_id: "createPet", request: { body: { id: 1, name: "Rex" } } },
        deps,
      ) as any,
    );

    const serialized = JSON.stringify(live);
    expect(serialized, "validate_call_pass payload must not contain fetched_at").not.toContain("fetched_at");
    expect(serialized, "validate_call_pass payload must not contain created_at").not.toContain("created_at");

    const pinned = extractDemoBlock(readFileSync(README, "utf8"), "demo:validate_call_pass");
    expect(pinned, "README demo block 'demo:validate_call_pass'" + STALE).toEqual(live);
  });

  it("demo:ambiguous block matches get_signature with two versions loaded and version omitted", async () => {
    const store = new InMemoryStore();
    await loadFile(store, BILLING_V1);
    await loadFile(store, BILLING_V2);
    const deps: ToolDeps = { store };
    // operation_id must be present — the XOR parse gate fires before version resolution.
    const live = payloadOf(getSignatureTool.handler({ operation_id: "createInvoice" }, deps) as any);

    const serialized = JSON.stringify(live);
    expect(serialized, "ambiguous payload must not contain fetched_at").not.toContain("fetched_at");
    expect(serialized, "ambiguous payload must not contain created_at").not.toContain("created_at");

    const pinned = extractDemoBlock(readFileSync(README, "utf8"), "demo:ambiguous");
    expect(pinned, "README demo block 'demo:ambiguous'" + STALE).toEqual(live);
  });

  it("demo:validate_call block matches validate_call with missing-required, type, and enum violations", async () => {
    const store = new InMemoryStore();
    await loadFile(store, PETSTORE_31);
    const deps: ToolDeps = { store };
    const live = payloadOf(
      validateCallTool.handler(
        { operation_id: "createPet", request: { body: { id: "1", status: "unknown" } } },
        deps,
      ) as any,
    );

    const serialized = JSON.stringify(live);
    expect(serialized, "validate payload must not contain fetched_at").not.toContain("fetched_at");
    expect(serialized, "validate payload must not contain created_at").not.toContain("created_at");

    const readme = readFileSync(README, "utf8");
    const pinned = extractDemoBlock(readme, "demo:validate_call") as any;
    // Sort both sides to sever Ajv keyword-evaluation order coupling.
    const liveNorm = { ...live, errors: sortErrors(live.errors) };
    const pinnedNorm = { ...pinned, errors: sortErrors(pinned.errors ?? []) };
    expect(pinnedNorm, "README demo block 'demo:validate_call'" + STALE).toEqual(liveNorm);
  });
});
