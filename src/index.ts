#!/usr/bin/env node
import { runServer } from "./server.js";

void runServer().catch((error: unknown) => {
  console.error("[aos-mcp] fatal:", error);
  process.exit(1);
});
