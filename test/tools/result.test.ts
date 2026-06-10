import { describe, it, expect } from "vitest";

import { fail, toCallToolResult, toErrorResult, snapshotMissing } from "../../src/tools/result.js";

// The result helpers are exercised indirectly by every tool test; these pin the
// contract directly — especially toErrorResult's details forward/omit rule (the
// find_* vs strict-tool unification) and snapshotMissing's exact message.

const payloadOf = (r: { content: Array<{ type: string; text?: string }> }) => JSON.parse(r.content[0]!.text!);
const summaryOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content[1]?.text;

describe("fail", () => {
  it("omits details when undefined, includes them when set", () => {
    expect(fail("not_found", "gone")).toEqual({ ok: false, error: { code: "not_found", message: "gone" } });
    expect("details" in fail("not_found", "gone").error).toBe(false);
    expect(fail("ambiguous", "pick", { loaded_versions: [] }).error.details).toEqual({ loaded_versions: [] });
  });
});

describe("toCallToolResult", () => {
  it("puts the JSON payload in the first block and an optional summary in the second", () => {
    const withSummary = toCallToolResult({ ok: true, n: 1 }, "did a thing");
    expect(payloadOf(withSummary)).toEqual({ ok: true, n: 1 });
    expect(summaryOf(withSummary)).toBe("did a thing");
    expect(withSummary.content).toHaveLength(2);

    const noSummary = toCallToolResult({ ok: true });
    expect(noSummary.content).toHaveLength(1);
  });

  it("leaves isError unset — a domain ok:false is a normal result, not a protocol failure", () => {
    expect(toCallToolResult(fail("not_found", "x")).isError).toBeUndefined();
  });
});

describe("toErrorResult", () => {
  it("maps a typed failure to the fail payload with the message echoed as the summary", () => {
    const r = toErrorResult({ code: "not_found", message: "no spec" });
    expect(payloadOf(r)).toEqual({ ok: false, error: { code: "not_found", message: "no spec" } });
    expect(summaryOf(r)).toBe("no spec");
  });

  it("forwards details when present (strict resolution's loaded_versions)", () => {
    const details = { loaded_versions: [{ version_id: "sv_1", version_label: null, active: true }] };
    expect(payloadOf(toErrorResult({ code: "ambiguous", message: "pick one", details })).error.details).toEqual(details);
  });

  it("omits details when absent — byte-identical to the old inline find_* failure", () => {
    const r = payloadOf(toErrorResult({ code: "ambiguous", message: "pick one" }));
    expect("details" in r.error).toBe(false);
  });
});

describe("snapshotMissing", () => {
  it("produces an io_error with the exact missing-snapshot message in both blocks", () => {
    const r = snapshotMissing("billing-api", "sv_abc123");
    const message = "Snapshot for billing-api sv_abc123 is missing.";
    expect(payloadOf(r)).toEqual({ ok: false, error: { code: "io_error", message } });
    expect(summaryOf(r)).toBe(message);
  });
});
