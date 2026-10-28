import type { RunnerDevice, RunnerTools } from "../db/types.js";
import { defaultExec, resolveAdbPath, type ExecFn } from "../device/adb.js";
import { classifyIosSerial, listIosSimulators, resolveIdbPath, resolveXcrunPath } from "../device/ios.js";
import { listAdbDevices } from "../device/logcat.js";
import { resolveMaestroPath } from "../device/maestro.js";

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
      appium,
      maestro: false,
      devicectl: false
    });
  }

  const adb = resolveAdbPath(env, platform);
  const adbPath = adb.path;
  const adbResult =
    adbPath === null
      ? { ok: false, devices: [] as string[], error: "adb-not-found" }
      : await listAdbDevices(exec, adbPath, env);
  const devices: RunnerDevice[] = await Promise.all(
    adbResult.devices.map(async (serial) => {
      const meta =
        adbPath === null
          ? { model: null, osVersion: null }
          : await probeAndroidDeviceMeta(exec, adbPath, serial, timeoutMs, env);
      return {
        serial,
        name: "",
        model: meta.model,
        osVersion: meta.osVersion,
        platform: "android" as const,
        kind: serial.startsWith("emulator-") ? ("emulator" as const) : ("device" as const),
        state: "device"
      };
    })
  );
  const maestro = resolveMaestroPath(env);
  const tools: RunnerTools = {
    adb: adbResult.ok,
    idb: false,
    simctl: false,
    ideviceId: false,
    appium,
    maestro:
      maestro.path === null
        ? false
        : await versionProbe(exec, maestro.path, ["--version"], timeoutMs, env),
    devicectl: false
  };

  if (platform === "darwin") {
    const simulators = await listIosSimulators({ env, exec, platform, timeoutMs });
    if (simulators.ok) {
      tools.simctl = true;
      for (const simulator of simulators.simulators) {
        if (!simulator.isAvailable || simulator.state !== "Booted") continue;
        devices.push({
          serial: simulator.udid,
          name: simulator.name,
          model: simulator.name === "" ? null : simulator.name,
          osVersion: simulator.osVersion ?? null,
          platform: "ios",
          kind: "simulator",
          state: simulator.state
        });
      }
    }

    const idevice = await ideviceIdProbe(exec, timeoutMs);
    tools.ideviceId = idevice.ok;
    const iosDevices = await Promise.all(
      idevice.serials.map(async (serial) => {
        const meta = await probeIosDeviceMeta(exec, serial, timeoutMs);
        return {
          serial,
          name: "",
          model: meta.model,
          osVersion: meta.osVersion,
          platform: "ios" as const,
          kind: "device" as const,
          state: "device"
        };
      })
    );
    devices.push(...iosDevices);

    tools.idb = await idbProbe(exec, env, timeoutMs);
    tools.devicectl = await versionProbe(
      exec,
      resolveXcrunPath(env).path,
      ["devicectl", "--version"],
      timeoutMs
    );
  }

  return finish(devices, tools);
}

function deviceFromSerial(serial: string): RunnerDevice | null {
  if (serial === "") return null;
  const iosKind = classifyIosSerial(serial);
  if (iosKind !== null) {
    return {
      serial,
      name: "",
      model: null,
      osVersion: null,
      platform: "ios",
      kind: iosKind,
      state: "configured"
    };
  }
  return {
    serial,
    name: "",
    model: null,
    osVersion: null,
    platform: "android",
    kind: serial.startsWith("emulator-") ? "emulator" : "device",
    state: "configured"
  };
}

/** 单行文本（去空行）；空输出 → null。 */
function firstLine(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return null;
}

async function versionProbe(
  exec: ExecFn,
  command: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv
): Promise<boolean> {
  try {
    const result = await exec(command, args, {
      timeoutMs,
      ...(env === undefined ? {} : { env })
    });
    return !result.error && result.code === 0;
  } catch {
    return false;
  }
}

async function probeAndroidDeviceMeta(
  exec: ExecFn,
  adbPath: string,
  serial: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv
): Promise<{ model: string | null; osVersion: string | null }> {
  const read = async (prop: string): Promise<string | null> => {
    try {
      const result = await exec(adbPath, ["-s", serial, "shell", "getprop", prop], {
        timeoutMs,
        env
      });
      if (result.error || result.code !== 0) return null;
      return firstLine(result.stdout);
    } catch {
      return null;
    }
  };
  const [model, osVersion] = await Promise.all([
    read("ro.product.model"),
    read("ro.build.version.release")
  ]);
  return { model, osVersion };
}

async function probeIosDeviceMeta(
  exec: ExecFn,
  serial: string,
  timeoutMs: number
): Promise<{ model: string | null; osVersion: string | null }> {
  const read = async (key: string): Promise<string | null> => {
    try {
      const result = await exec("ideviceinfo", ["-u", serial, "-k", key], { timeoutMs });
      if (result.error || result.code !== 0) return null;
      return firstLine(result.stdout);
    } catch {
      return null;
    }
  };
  const [model, osVersion] = await Promise.all([
    read("ProductType"),
    read("ProductVersion")
  ]);
  return { model, osVersion };
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
