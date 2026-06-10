// Future drop-in (Streamable HTTP/SSE). No v1 implementation; the facade selects
// it only if explicitly configured, and it fails loudly.
export function createHttpTransport(): never {
  throw new Error("HTTP transport is not implemented in v1.");
}
