import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ErrorCode =
  | "not_found"
  | "ambiguous"
  | "parse_error"
  | "unsupported_spec"
  | "collision"
  | "invalid_input"
  | "size_limit"
  | "io_error"
  | "internal_error"; // unanticipated throw caught by the boundary wrapper in registerAllTools

export interface ToolError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export interface FailPayload {
  ok: false;
  error: ToolError;
}

export function fail(code: ErrorCode, message: string, details?: unknown): FailPayload {
  const error: ToolError = { code, message };
  if (details !== undefined) error.details = details;
  return { ok: false, error };
}

/**
 * Wrap a JSON-serializable payload as an MCP tool result: the JSON as the first
 * text block (machine-readable, parse `content[0]`), plus an optional
 * human-readable summary line as a second text block. `isError` is intentionally
 * left unset — a domain `ok:false` is a normal, actionable result, not a
 * protocol/execution failure.
 */
export function toCallToolResult(payload: unknown, summary?: string): CallToolResult {
  const content: CallToolResult["content"] = [
    { type: "text", text: JSON.stringify(payload, null, 2) },
  ];
  if (summary) content.push({ type: "text", text: summary });
  return { content };
}

/** Map a core resolver/locator typed failure (`{code,message,details?}`) to its
 *  tool result — the structured payload with the message echoed as the summary.
 *  `details` rides through when present (only strict resolution attaches it). */
export function toErrorResult(error: { code: ErrorCode; message: string; details?: unknown }): CallToolResult {
  return toCallToolResult(fail(error.code, error.message, error.details), error.message);
}

export function snapshotMissing(spec_id: string, version_id: string): CallToolResult {
  const message = `Snapshot for ${spec_id} ${version_id} is missing.`;
  return toCallToolResult(fail("io_error", message), message);
}
