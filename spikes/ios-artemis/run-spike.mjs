#!/usr/bin/env node
/**
 * Phase 0 spike launcher: fake device RPC + Python driver/controller probe.
 * Throwaway; no production code is imported by the service.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const python = path.join(repo, "artemis", ".venv", "bin", "python");
const port = process.env.SPIKE_RPC_PORT ?? "15190";
const url = `http://127.0.0.1:${port}/rpc`;

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repo,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (options.onStdout) options.onStdout(stdout);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: String(error) }));
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (options.onChild) options.onChild(child);
  });
}

const server = spawn(process.execPath, [path.join(here, "fake_device_rpc.mjs")], {
  cwd: repo,
  env: { ...process.env, SPIKE_RPC_PORT: port },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOut = "";
let serverErr = "";
let ready = false;
let resolveReady;
const readyPromise = new Promise((resolve) => {
  resolveReady = resolve;
});
server.stdout.on("data", (chunk) => {
  serverOut += chunk.toString();
  if (!ready && serverOut.includes("listening")) {
    ready = true;
    resolveReady();
  }
});
server.stderr.on("data", (chunk) => {
  serverErr += chunk.toString();
});

await Promise.race([
  readyPromise,
  new Promise((_, reject) => setTimeout(() => reject(new Error("fake RPC not ready")), 5000))
]);

const result = await run(python, [path.join(here, "spike_controller.py")], {
  env: { SPIKE_RPC_URL: url }
});

server.kill("SIGTERM");
await new Promise((resolve) => server.on("exit", resolve));

console.log("===== Python spike report =====");
console.log(result.stdout.trim() || "(no stdout)");
if (result.stderr.trim()) {
  console.log("===== Python stderr =====");
  console.log(result.stderr.trim());
}
console.log("===== Fake RPC actions =====");
const actionLine = serverOut
  .split("\n")
  .find((line) => line.startsWith("[fake-rpc] actions="));
console.log(actionLine ? actionLine.replace("[fake-rpc] actions=", "") : "(no action log)");
if (serverErr.trim()) {
  console.log("===== Fake RPC stderr =====");
  console.log(serverErr.trim());
}
process.exitCode = result.code;
