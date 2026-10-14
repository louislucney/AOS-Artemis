import type { RunnerDevice, RunnerTools } from "../db/types.js";
import { defaultExec, resolveAdbPath, type ExecFn } from "../device/adb.js";
import { classifyIosSerial, listIosSimulators, resolveIdbPath } from "../device/ios.js";
import { listAdbDevices } from "../device/logcat.js";

/** 设备盘点（心跳上报；`AOS_RUNNER_DEVICES` 非空 → 覆盖全部来源，真机 UDID 可显式列入）。 */
export interface RunnerInventory {
  platforms: Array<"ios" | "android">;
  devices: RunnerDevice[];
  tools: RunnerTools;
}

export interface CollectRunnerInventoryOptions {
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

const PROBE_TIMEOUT_MS = 5_000;

export async function collectRunnerInventory(
  options: CollectRunnerInventoryOptions = {}
): Promise<RunnerInventory> {
  const env = options.env ?? process.env;
  const exec = options.exec ?? defaultExec;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const appium = Boolean((env.AOS_APPIUM_URL ?? "").trim());

  const override = (env.AOS_RUNNER_DEVICES ?? "").trim();
  if (override !== "") {
    const devices = override
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value !== "")
      .map((serial) => deviceFromSerial(serial))
      .filter((device): device is RunnerDevice => device !== null);
    return finish(devices, {
      adb: false,
      idb: false,
      simctl: false,
      ideviceId: false,
      appium
    });
  }

  const adb = resolveAdbPath(env, platform);
  const adbResult =
    adb.path === null
      ? { ok: false, devices: [] as string[], error: "adb-not-found" }
      : await listAdbDevices(exec, adb.path);
  const devices: RunnerDevice[] = adbResult.devices.map((serial) => ({
    serial,
    name: "",
    platform: "android",
    kind: serial.startsWith("emulator-") ? "emulator" : "device",
    state: "device"
  }));
  const tools: RunnerTools = { adb: adbResult.ok, idb: false, simctl: false, ideviceId: false, appium };

  if (platform === "darwin") {
    const simulators = await listIosSimulators({ env, exec, platform, timeoutMs });
    if (simulators.ok) {
      tools.simctl = true;
      for (const simulator of simulators.simulators) {
        if (!simulator.isAvailable || simulator.state !== "Booted") continue;
        devices.push({
          serial: simulator.udid,
          name: simulator.name,
          platform: "ios",
          kind: "simulator",
          state: simulator.state
        });
      }
    }

    const idevice = await ideviceIdProbe(exec, timeoutMs);
    tools.ideviceId = idevice.ok;
    for (const serial of idevice.serials) {
      devices.push({ serial, name: "", platform: "ios", kind: "device", state: "device" });
    }

    tools.idb = await idbProbe(exec, env, timeoutMs);
  }

  return finish(devices, tools);
}

function deviceFromSerial(serial: string): RunnerDevice | null {
  if (serial === "") return null;
  const iosKind = classifyIosSerial(serial);
  if (iosKind !== null) {
    return { serial, name: "", platform: "ios", kind: iosKind, state: "configured" };
  }
  return {
    serial,
    name: "",
    platform: "android",
    kind: serial.startsWith("emulator-") ? "emulator" : "device",
    state: "configured"
  };
}

async function ideviceIdProbe(
  exec: ExecFn,
  timeoutMs: number
): Promise<{ ok: boolean; serials: string[] }> {
  try {
    const result = await exec("idevice_id", ["-l"], { timeoutMs });
    if (result.error || result.code !== 0) return { ok: false, serials: [] };
    const serials = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
    return { ok: true, serials };
  } catch {
    return { ok: false, serials: [] };
  }
}

async function idbProbe(exec: ExecFn, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<boolean> {
  try {
    const result = await exec(resolveIdbPath(env).path, ["--version"], { timeoutMs });
    return !result.error && result.code === 0;
  } catch {
    return false;
  }
}

function finish(devices: RunnerDevice[], tools: RunnerTools): RunnerInventory {
  const seen = new Set<string>();
  const unique = devices.filter((device) => {
    if (seen.has(device.serial)) return false;
    seen.add(device.serial);
    return true;
  });
  unique.sort((a, b) => {
    if (a.platform !== b.platform) return a.platform === "android" ? -1 : 1;
    return a.serial < b.serial ? -1 : a.serial > b.serial ? 1 : 0;
  });
  const platforms = [...new Set(unique.map((device) => device.platform))];
  return { platforms, devices: unique, tools };
}
