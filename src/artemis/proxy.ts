import type { Readable } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import type { ChildSpec } from "./assembly.js";
import { AOS_MCP_VERSION, errorMessage, log, terminateProcess, terminateProcessSync, withTimeout } from "../util.js";

export interface ProxiedTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface ProxyStatus {
  running: boolean;
  pid: number | null;
  restarts: number;
  lastError: string | null;
  stderrTail: string[];
}

/** Test seam: the runtime depends on this interface, not on the concrete class. */
export interface ArtemisProxyLike {
  isRunning(): boolean;
  ensureStarted(): Promise<void>;
  listTools(force?: boolean): Promise<ProxiedTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  status(): ProxyStatus;
  markForRestart(): Promise<void>;
  dispose(): Promise<void>;
  disposeSync(): void;
}

export interface ArtemisProxyOptions {
  /** Called on every (re)spawn — returns the child spec with fresh env/fingerprint. */
  prepare: () => ChildSpec;
  onSpawned?: (info: { pid: number | null; fingerprint: string }) => void;
  onExit?: (info: { expected: boolean }) => void;
  connectTimeoutMs?: number;
}

const STDERR_RING_MAX_LINES = 200;
const STDERR_LINE_MAX_CHARS = 8192;

export class ArtemisProxy implements ArtemisProxyLike {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private cachedTools: ProxiedTool[] | null = null;
  private starting: Promise<void> | null = null;
  private stderrTail: string[] = [];
  private stderrRemainder = "";
  private restarts = 0;
  private lastError: string | null = null;
  private expectedClose = false;

  constructor(private readonly options: ArtemisProxyOptions) {}

  isRunning(): boolean {
    return this.client !== null;
  }

  status(): ProxyStatus {
    return {
      running: this.client !== null,
      pid: this.transport?.pid ?? null,
      restarts: this.restarts,
      lastError: this.lastError,
      stderrTail: [...this.stderrTail]
    };
  }

  async ensureStarted(): Promise<void> {
    if (this.client) return;
    if (this.starting) return this.starting;

    this.starting = this.startInternal().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startInternal(): Promise<void> {
    const spec = this.options.prepare();
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      env: spec.env,
      stderr: "pipe"
    });
    const client = new Client({ name: "aos-mcp", version: AOS_MCP_VERSION });

    this.attachStderr(transport);
    this.expectedClose = false;

    try {
      await withTimeout(
        client.connect(transport),
        this.options.connectTimeoutMs ?? 90_000,
        `artemis mcp_server 连接超时（${spec.command} -m mcp_server）`
      );
    } catch (error) {
      this.lastError = errorMessage(error);
      try {
        await client.close();
      } catch {
        /* best effort */
      }
      const pid = transport.pid;
      if (typeof pid === "number") void terminateProcess(pid, 1000);
      throw error;
    }

    client.onclose = () => {
      const expected = this.expectedClose;
      if (this.client === client) {
        this.client = null;
        this.transport = null;
        this.cachedTools = null;
      }
      if (!expected) {
        this.restarts += 1;
        log("artemis mcp_server child exited unexpectedly; it will be respawned on the next call");
      }
      this.options.onExit?.({ expected });
    };

    this.client = client;
    this.transport = transport;
    this.cachedTools = null;
    this.lastError = null;
    this.options.onSpawned?.({ pid: transport.pid, fingerprint: spec.fingerprint });
  }

  private attachStderr(transport: StdioClientTransport): void {
    let stream: Readable | null = null;
    try {
      stream = (transport.stderr as Readable | null) ?? null;
    } catch {
      stream = null;
    }
    if (!stream) return;
    stream.setEncoding("utf-8");
    stream.on("data", (chunk: string) => {
      this.ingestStderr(chunk);
    });
  }

  private ingestStderr(chunk: string): void {
    this.stderrRemainder += chunk;
    let index = this.stderrRemainder.indexOf("\n");
    while (index >= 0) {
      this.pushStderrLine(this.stderrRemainder.slice(0, index));
      this.stderrRemainder = this.stderrRemainder.slice(index + 1);
      index = this.stderrRemainder.indexOf("\n");
    }
    if (this.stderrRemainder.length > STDERR_LINE_MAX_CHARS) {
      this.pushStderrLine(this.stderrRemainder);
      this.stderrRemainder = "";
    }
  }

  private pushStderrLine(line: string): void {
    const trimmed = line.length > STDERR_LINE_MAX_CHARS ? line.slice(0, STDERR_LINE_MAX_CHARS) : line;
    this.stderrTail.push(trimmed);
    if (this.stderrTail.length > STDERR_RING_MAX_LINES) {
      this.stderrTail.splice(0, this.stderrTail.length - STDERR_RING_MAX_LINES);
    }
  }

  async listTools(force = false): Promise<ProxiedTool[]> {
    await this.ensureStarted();
    if (this.cachedTools && !force) return this.cachedTools;
    const response = await this.client!.listTools();
    this.cachedTools = response.tools.map((tool: Tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }));
    return this.cachedTools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    await this.ensureStarted();
    const result = await this.client!.callTool({ name, arguments: args });
    return result as CallToolResult;
  }

  /** Gracefully stop the direct child; the next call respawns lazily with fresh env.
   * Detached task-runner processes are intentionally left untouched. */
  async markForRestart(): Promise<void> {
    this.restarts += 1;
    await this.dispose();
  }

  async dispose(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    if (!client && !transport) return;

    this.expectedClose = true;
    const pid = transport?.pid ?? null;

    try {
      await client?.close();
    } catch (error) {
      log(`child close failed: ${errorMessage(error)}`);
    }
    if (typeof pid === "number") {
      await terminateProcess(pid, 2000);
    }

    if (this.client === client) {
      this.client = null;
      this.transport = null;
      this.cachedTools = null;
    }
  }

  disposeSync(): void {
    const pid = this.transport?.pid;
    this.expectedClose = true;
    if (typeof pid === "number") terminateProcessSync(pid);
  }
}
