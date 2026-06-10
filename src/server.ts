import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerAllTools, type ToolDeps } from "./tools/index.js";

// Workflow guidance surfaced to the agent at initialize.
export const SERVER_INSTRUCTIONS =
  "LockSpec serves version-pinned API contracts. Workflow: call `list_specs` to " +
  "see what's loaded; `find_endpoint`/`find_type` to locate operations/types; " +
  "`get_signature` before writing a call; `validate_call` on the draft before " +
  "finalizing (pass parameter/body values as typed JSON — 5, not \"5\"); " +
  "`diff_versions` to compare versions. Pass `spec_id` only when multiple specs " +
  "are loaded. With one loaded version, `version` defaults to it; with multiple " +
  "loaded, `get_signature` and `validate_call` require an explicit `version` " +
  "(else they return an `ambiguous` error listing the loaded versions), while " +
  "`find_endpoint` and `find_type` use the active version and report which.";

// Transport-free and testable: the entrypoint connects the transport, and the
// Store is injected so tests can supply a fake/temp store.
export function buildServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: "lockspec", version: "0.0.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerAllTools(server, deps);
  return server;
}
