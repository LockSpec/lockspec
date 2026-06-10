import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { createStdioTransport } from "./stdio.js";
import { createHttpTransport } from "./http.js";

// Re-export so the server/index layer references our facade, not the SDK
// directly — keeps the transport seam swappable.
export type { Transport };

export type TransportKind = "stdio" | "http";

export interface TransportConfig {
  kind: TransportKind;
}

export const DEFAULT_TRANSPORT_CONFIG: TransportConfig = { kind: "stdio" };

// Selection/wiring only. stdio is the v1 binding; http is a future drop-in stub.
export function createTransport(config: TransportConfig = DEFAULT_TRANSPORT_CONFIG): Transport {
  switch (config.kind) {
    case "stdio":
      return createStdioTransport();
    case "http":
      return createHttpTransport();
  }
}
