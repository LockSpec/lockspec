#!/usr/bin/env node
import { buildServer } from "./server.js";
import { createTransport } from "./transport/facade.js";
import { LocalStore } from "./store/local-store.js";

// Under stdio, stdout is the JSON-RPC channel — owned by the SDK, never written
// to directly; diagnostics go to stderr.
async function main(): Promise<void> {
  const store = new LocalStore();
  const server = buildServer({ store });
  const transport = createTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error("lockspec: fatal error during startup:", err);
  process.exit(1);
});
