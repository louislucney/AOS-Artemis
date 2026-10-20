#!/usr/bin/env node
import { CLI_NAME } from "./brand.js";
import { runServer } from "./server.js";

void runServer().catch((error: unknown) => {
  console.error(`[${CLI_NAME}] fatal:`, error);
  process.exit(1);
});
