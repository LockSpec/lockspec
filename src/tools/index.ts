import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodObject } from "zod";

import type { Store } from "../store/store.js";
import { fail, toCallToolResult } from "./result.js";
import { loadSpecTool } from "./load_spec.js";
import { findEndpointTool } from "./find_endpoint.js";
import { findTypeTool } from "./find_type.js";
import { getSignatureTool } from "./get_signature.js";
import { validateCallTool } from "./validate_call.js";
import { diffVersionsTool } from "./diff_versions.js";
import { listSpecsTool } from "./list_specs.js";
import { activateVersionTool } from "./activate_version.js";
import { removeSpecTool } from "./remove_spec.js";

export interface ToolDeps {
  store: Store;
  /**
   * Max raw spec byte size accepted by `load_spec` before `size_limit`.
   * Optional; defaults to `MAX_SPEC_BYTES` in load_spec.
   */
  maxSpecBytes?: number;
}

export interface ToolModule {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodObject<any>;
  handler: (args: unknown, deps: ToolDeps) => CallToolResult | Promise<CallToolResult>;
}

export const TOOLS: ToolModule[] = [
  loadSpecTool,
  findEndpointTool,
  findTypeTool,
  getSignatureTool,
  validateCallTool,
  diffVersionsTool,
  listSpecsTool,
  activateVersionTool,
  removeSpecTool,
];

/**
 * Single-point guarantee that no exception crosses the tool boundary.
 * Any throw a handler doesn't map to a specific code escapes to here and
 * becomes a structured `internal_error`. Per-handler catches remain only for
 * specific codes (e.g. load_spec's NormalizeError→parse_error).
 *
 * `await` makes this catch both synchronous throws and rejected promises.
 */
export function withErrorBoundary(
  handler: ToolModule["handler"],
  deps: ToolDeps,
): (args: unknown) => Promise<CallToolResult> {
  return async (args: unknown) => {
    try {
      return await handler(args, deps);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return toCallToolResult(fail("internal_error", message), message);
    }
  };
}

export function registerAllTools(server: McpServer, deps: ToolDeps): void {
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema.shape,
      },
      withErrorBoundary(tool.handler, deps),
    );
  }
}
