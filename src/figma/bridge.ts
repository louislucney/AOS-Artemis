import {
  startFigmaBridge,
  FIGMA_BRIDGE_PORT,
  type BridgeHandle
} from "../vendor/design-context-bridge/figma-bridge/ws-server.js";

export interface FigmaBridgeState {
  status: "not_started" | "listening" | "skipped_occupied" | "error";
  port: number | null;
  message: string;
}

let handle: BridgeHandle | null = null;
let state: FigmaBridgeState = { status: "not_started", port: null, message: "" };

/** Start the loopback bridge (locked to port 3055 in production). */
export async function startBridge(options: { port?: number } = {}): Promise<FigmaBridgeState> {
  if (state.status === "listening") return { ...state };
  const result = await startFigmaBridge({ port: options.port ?? FIGMA_BRIDGE_PORT });
  if (result.ok) {
    handle = result;
    state = { status: "listening", port: result.port, message: result.message };
  } else {
    handle = null;
    state = { status: result.status, port: result.port, message: result.message };
  }
  return { ...state };
}

export function bridgeState(): FigmaBridgeState {
  return { ...state };
}

export async function stopBridge(): Promise<void> {
  if (handle) {
    await handle.close();
    handle = null;
  }
  state = { status: "not_started", port: null, message: "" };
}
