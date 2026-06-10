import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Construction is side-effect-free: the SDK does not touch stdin/stdout until
// the server connects and calls start().
export function createStdioTransport(): StdioServerTransport {
  return new StdioServerTransport();
}
