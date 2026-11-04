import { spawn } from "node:child_process";

import type { DeviceGatewayRecord } from "../db/types.js";

export interface GatewayChild {
  pid?: number;
  on(event: "exit" | "error", listener: (...args: unknown[]) => void): GatewayChild;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface StartDeviceGatewayInput {
  env: NodeJS.ProcessEnv;
  now?: () => number;
  spawnChild?: (command: string, args: string[]) => GatewayChild;
  onExit?: (code: number | null, signal: string | null) => void;
  /** 隧道建立前探测 runner 本机 Appium；默认 GET /status（1.5s）。 */
  probeAppium?: (url: string) => Promise<boolean>;
}

async function defaultProbeAppium(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/status`, {
      signal: AbortSignal.timeout(1_500)
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface DeviceGateway {
  snapshot(): DeviceGatewayRecord;
  stop(): Promise<void>;
}

function portFrom(raw: string | undefined, fallback: number): number {
  const parsed = Number((raw ?? "").trim());
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

/**
 * P0 设备网关：runner 主动 `ssh -R` 到中心，把本机 adb server（USB 设备）暴露为
 * 中心 loopback 端口。未配置 `AOS_GATEWAY_SSH_TARGET` 时返回 null（无 gateway）。
 */
export async function startDeviceGateway(
  input: StartDeviceGatewayInput
): Promise<DeviceGateway | null> {
  const target = (input.env.AOS_GATEWAY_SSH_TARGET ?? "").trim();
  if (target === "") return null;
  const ssh = (input.env.AOS_GATEWAY_SSH_PATH ?? "").trim() || "ssh";
  const adbPort = portFrom(input.env.AOS_GATEWAY_ADB_PORT, 15037);
  const localAdbPort = portFrom(input.env.AOS_GATEWAY_LOCAL_ADB_PORT, 5037);
  const appiumOverride = (input.env.AOS_GATEWAY_APPIUM_URL ?? "").trim();
  const appiumConfigured =
    appiumOverride !== "" || (input.env.AOS_GATEWAY_APPIUM_PORT ?? "").trim() !== "";
  const appiumPort = portFrom(input.env.AOS_GATEWAY_APPIUM_PORT, 15038);
  const localAppiumPort = portFrom(input.env.AOS_GATEWAY_LOCAL_APPIUM_PORT, 4723);
  const spawnChild =
    input.spawnChild ??
    ((command: string, args: string[]): GatewayChild =>
      spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] }) as unknown as GatewayChild);
  const reportedAt = new Date(input.now?.() ?? Date.now()).toISOString();
  const appiumCandidate =
    appiumOverride !== "" ? appiumOverride : `http://127.0.0.1:${localAppiumPort}`;
  const appiumReachable =
    appiumConfigured &&
    (await (input.probeAppium ?? defaultProbeAppium)(appiumCandidate).catch(() => false));
  let ready = true;
  let stopped = false;
  const children: GatewayChild[] = [];
  const forward = (centerPort: number, localPort: number): void => {
    const child = spawnChild(ssh, [
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-R",
      `${centerPort}:127.0.0.1:${localPort}`,
      target
    ]);
    children.push(child);
    child.on("error", () => {
      ready = false;
    });
    child.on("exit", (code, signal) => {
      ready = false;
      input.onExit?.(
        typeof code === "number" ? code : null,
        typeof signal === "string" ? signal : null
      );
    });
  };
  forward(adbPort, localAdbPort);
  if (appiumReachable && appiumOverride === "") {
    forward(appiumPort, localAppiumPort);
  }
  const appiumUrl = appiumReachable
    ? appiumOverride !== ""
      ? appiumOverride
      : `http://127.0.0.1:${appiumPort}`
    : null;
  const snapshot = (): DeviceGatewayRecord => ({
    adbServer: `127.0.0.1:${adbPort}`,
    appiumUrl,
    tunnelPort: adbPort,
    ready,
    reportedAt
  });
  return {
    snapshot,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      for (const child of children) child.kill("SIGTERM");
      ready = false;
    }
  };
}
