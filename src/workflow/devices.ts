import { resolveAndroidAdbSocket } from "../device/device-hosts.js";
import { collectRunnerInventory } from "../runner/inventory.js";
import type { Runtime } from "../runtime.js";
import { errorMessage } from "../util.js";
import type { SetupNeed } from "./setup.js";

export interface DeviceCandidate {
  serial: string;
  platform?: string;
}

export type DevicePick =
  | { ok: true; device: string }
  | { ok: false; needs: "setup"; check: SetupNeed }
  | { ok: false; needs: "info"; questions: string[]; context: string[] };

export function deviceNeed(note: string | null): SetupNeed {
  return {
    target: "device",
    missing: ["在线设备"],
    howTo: [
      "连接设备并确认在线：node scripts/adb-safe.mjs devices（Android 需已授权 USB 调试）",
      "node dist/cli.js doctor 查看设备与工具链状态（iOS 模拟器启动后亦可见）",
      "或用 device 参数直接指定设备序列号 / UDID"
    ],
    ...(note !== null ? { note: `设备盘点失败：${note}` } : {})
  };
}

/** 设备盘点的运行时环境：iOS 分层配置（config/.env/进程 env）＋ ADB_SERVER_SOCKET
 * 按既有优先级解析（含 `deviceHosts.android.adbHost`，ADR-0011 集中部署）。 */
export function runnerInventoryEnv(runtime: Runtime): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...runtime.iosEnvironment() };
  const android = resolveAndroidAdbSocket(runtime.project.config, runtime.project.resolver);
  if (android !== null) env.ADB_SERVER_SOCKET = android.socket;
  return env;
}

export async function defaultListDevices(runtime: Runtime): Promise<DeviceCandidate[]> {
  const inventory = await collectRunnerInventory({ env: runnerInventoryEnv(runtime) });
  return inventory.devices.map((device) => ({ serial: device.serial, platform: device.platform }));
}

export async function pickDevice(
  requested: string | null,
  listDevices: () => Promise<DeviceCandidate[]>
): Promise<DevicePick> {
  if (requested !== null) return { ok: true, device: requested };
  let devices: DeviceCandidate[] = [];
  let listError: string | null = null;
  try {
    devices = await listDevices();
  } catch (error) {
    listError = errorMessage(error);
  }
  if (devices.length === 0) return { ok: false, needs: "setup", check: deviceNeed(listError) };
  if (devices.length > 1) {
    return {
      ok: false,
      needs: "info",
      questions: [`发现 ${devices.length} 台在线设备，本次执行用哪台？重跑并在 device 参数给出序列号 / UDID`],
      context: devices.map((entry) =>
        entry.platform ? `${entry.serial}（${entry.platform}）` : entry.serial
      )
    };
  }
  return { ok: true, device: devices[0]!.serial };
}
