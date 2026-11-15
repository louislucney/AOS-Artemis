import { statfs } from "node:fs/promises";

import { defaultExec, resolveAdbPath, type ExecFn } from "../device/adb.js";

export interface HostPreflightResult {
  ok: boolean;
  freeBytes: number | null;
  totalBytes: number | null;
  freePercent: number | null;
  minFreePercent: number;
  reason: "insufficient-disk" | "unavailable" | null;
  message: string;
}

export interface HostPreflightOptions {
  rootPath: string;
  env?: NodeJS.ProcessEnv;
  statfsFn?: typeof statfs;
}

const DEFAULT_MIN_FREE_PERCENT = 10;
const DEFAULT_MIN_FREE_DEVICE_PERCENT = 10;

function minFreePercentFrom(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseFloat(env.AOS_RUNNER_MIN_FREE_DISK_PCT ?? "");
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MIN_FREE_PERCENT;
  return Math.min(raw, 100);
}

/** 执行机宿主磁盘门禁：只检查项目所在卷，不检查设备本身。
 * 读取失败标 unavailable 但不阻断（避免不同文件系统/容器误伤）。 */
export async function checkHostDisk(options: HostPreflightOptions): Promise<HostPreflightResult> {
  const env = options.env ?? process.env;
  const minFreePercent = minFreePercentFrom(env);
  const statfsFn = options.statfsFn ?? statfs;
  try {
    const stats = await statfsFn(options.rootPath);
    const blockSize = Number(stats.bsize);
    const blocks = Number(stats.blocks);
    const available = Number(stats.bavail);
    if (!Number.isFinite(blockSize) || !Number.isFinite(blocks) || !Number.isFinite(available) || blockSize <= 0 || blocks <= 0) {
      return {
        ok: true,
        freeBytes: null,
        totalBytes: null,
        freePercent: null,
        minFreePercent,
        reason: "unavailable",
        message: "执行机磁盘信息不可用（不阻断）"
      };
    }
    const freeBytes = available * blockSize;
    const totalBytes = blocks * blockSize;
    const freePercent = totalBytes === 0 ? null : (freeBytes / totalBytes) * 100;
    if (minFreePercent > 0 && freePercent !== null && freePercent < minFreePercent) {
      return {
        ok: false,
        freeBytes,
        totalBytes,
        freePercent,
        minFreePercent,
        reason: "insufficient-disk",
        message: `执行机磁盘不足：项目卷剩余 ${freePercent.toFixed(1)}%，低于 AOS_RUNNER_MIN_FREE_DISK_PCT=${minFreePercent}%`
      };
    }
    return {
      ok: true,
      freeBytes,
      totalBytes,
      freePercent,
      minFreePercent,
      reason: null,
      message: `执行机磁盘剩余 ${freePercent === null ? "未知" : `${freePercent.toFixed(1)}%`}`
    };
  } catch (error) {
    return {
      ok: true,
      freeBytes: null,
      totalBytes: null,
      freePercent: null,
      minFreePercent,
      reason: "unavailable",
      message: `执行机磁盘信息不可用（不阻断）：${error instanceof Error ? error.message : String(error)}`
    };
  }
}

export interface DeviceStorageResult {
  ok: boolean;
  serial: string;
  freeBytes: number | null;
  totalBytes: number | null;
  freePercent: number | null;
  minFreePercent: number;
  reason: "insufficient-device-disk" | "unavailable" | null;
  message: string;
}

function deviceThreshold(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseFloat(env.AOS_RUNNER_MIN_FREE_DEVICE_PCT ?? "");
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MIN_FREE_DEVICE_PERCENT;
  return Math.min(raw, 100);
}

/** Android 设备 /data 剩余空间检查；探测失败不阻断，避免把远程 adb 差异误判为设备故障。 */
export async function checkAndroidDeviceStorage(input: {
  serial: string;
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
}): Promise<DeviceStorageResult> {
  const env = input.env ?? process.env;
  const exec = input.exec ?? defaultExec;
  const minFreePercent = deviceThreshold(env);
  const unavailable = (message: string): DeviceStorageResult => ({
    ok: true,
    serial: input.serial,
    freeBytes: null,
    totalBytes: null,
    freePercent: null,
    minFreePercent,
    reason: "unavailable",
    message
  });
  const adb = resolveAdbPath(env, process.platform);
  if (adb.path === null) return unavailable("adb 不可用，跳过设备存储检查");
  let result;
  try {
    result = await exec(
      adb.path,
      ["-s", input.serial, "shell", "df", "-k", "/data"],
      { timeoutMs: 10_000, env }
    );
  } catch (error) {
    return unavailable(`设备存储检查失败（不阻断）：${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.error || result.code !== 0) {
    return unavailable(`设备存储检查失败（不阻断）：${result.error ?? `exit ${String(result.code)}`}`);
  }
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const dataLine =
    [...lines].reverse().find((line) => /\s\/data$/.test(line)) ??
    (lines.length > 0 ? lines[lines.length - 1]! : "");
  const parts = dataLine.split(/\s+/);
  if (parts.length < 5) return unavailable("设备 df 输出无法解析（不阻断）");
  const blocks = Number(parts[1]);
  const available = Number(parts[3]);
  if (!Number.isFinite(blocks) || !Number.isFinite(available) || blocks <= 0 || available < 0) {
    return unavailable("设备 df 数值无法解析（不阻断）");
  }
  const totalBytes = blocks * 1024;
  const freeBytes = available * 1024;
  const freePercent = totalBytes === 0 ? null : (freeBytes / totalBytes) * 100;
  if (minFreePercent > 0 && freePercent !== null && freePercent < minFreePercent) {
    return {
      ok: false,
      serial: input.serial,
      freeBytes,
      totalBytes,
      freePercent,
      minFreePercent,
      reason: "insufficient-device-disk",
      message: `设备 ${input.serial} 存储不足：/data 剩余 ${freePercent.toFixed(1)}%，低于 AOS_RUNNER_MIN_FREE_DEVICE_PCT=${minFreePercent}%`
    };
  }
  return {
    ok: true,
    serial: input.serial,
    freeBytes,
    totalBytes,
    freePercent,
    minFreePercent,
    reason: null,
    message: `设备 ${input.serial} /data 剩余 ${freePercent === null ? "未知" : `${freePercent.toFixed(1)}%`}`
  };
}

function numericField(text: string, key: string): number | null {
  const match = new RegExp(`(?:^|\\n)\\s*${key}\\s*:\\s*([0-9]+)`, "i").exec(text);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** iOS 真机 /data 容器剩余空间：best-effort 走 ideviceinfo 的 disk_usage 域；
 * 工具缺失/输出不识别时不阻断（模拟器由宿主磁盘检查覆盖）。 */
export async function checkIosDeviceStorage(input: {
  serial: string;
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
}): Promise<DeviceStorageResult> {
  const env = input.env ?? process.env;
  const exec = input.exec ?? defaultExec;
  const minFreePercent = deviceThreshold(env);
  const unavailable = (message: string): DeviceStorageResult => ({
    ok: true,
    serial: input.serial,
    freeBytes: null,
    totalBytes: null,
    freePercent: null,
    minFreePercent,
    reason: "unavailable",
    message
  });
  const tool = (env.AOS_IDEVICEINFO_PATH ?? "ideviceinfo").trim() || "ideviceinfo";
  let result;
  try {
    result = await exec(tool, ["-u", input.serial, "-q", "com.apple.disk_usage"], {
      timeoutMs: 10_000,
      env
    });
  } catch (error) {
    return unavailable(`iOS 设备存储检查失败（不阻断）：${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.error || result.code !== 0) {
    return unavailable(`iOS 设备存储检查失败（不阻断）：${result.error ?? `exit ${String(result.code)}`}`);
  }
  const freeBytes = numericField(result.stdout, "TotalDataAvailable");
  const totalBytes = numericField(result.stdout, "TotalDataCapacity");
  if (freeBytes === null || totalBytes === null || totalBytes <= 0) {
    return unavailable("iOS disk_usage 输出无法解析（不阻断）");
  }
  const freePercent = (freeBytes / totalBytes) * 100;
  if (minFreePercent > 0 && freePercent < minFreePercent) {
    return {
      ok: false,
      serial: input.serial,
      freeBytes,
      totalBytes,
      freePercent,
      minFreePercent,
      reason: "insufficient-device-disk",
      message: `iOS 设备 ${input.serial} 存储不足：数据卷剩余 ${freePercent.toFixed(1)}%，低于 AOS_RUNNER_MIN_FREE_DEVICE_PCT=${minFreePercent}%`
    };
  }
  return {
    ok: true,
    serial: input.serial,
    freeBytes,
    totalBytes,
    freePercent,
    minFreePercent,
    reason: null,
    message: `iOS 设备 ${input.serial} 数据卷剩余 ${freePercent.toFixed(1)}%`
  };
}

export interface DeviceBootResult {
  ok: boolean;
  serial: string;
  reason: "device-not-booted" | "unavailable" | null;
  message: string;
}

/** Android 设备启动完成检查：未 boot_completed 时不进入安装/用例执行。 */
export async function checkAndroidBootState(input: {
  serial: string;
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
}): Promise<DeviceBootResult> {
  const env = input.env ?? process.env;
  const exec = input.exec ?? defaultExec;
  const adb = resolveAdbPath(env, process.platform);
  if (adb.path === null) {
    return { ok: true, serial: input.serial, reason: "unavailable", message: "adb 不可用，跳过启动状态检查" };
  }
  try {
    const result = await exec(
      adb.path,
      ["-s", input.serial, "shell", "getprop", "sys.boot_completed"],
      { timeoutMs: 5_000, env }
    );
    if (result.error || result.code !== 0) {
      return { ok: true, serial: input.serial, reason: "unavailable", message: "设备启动状态读取失败（不阻断）" };
    }
    if (result.stdout.trim() === "1") {
      return { ok: true, serial: input.serial, reason: null, message: "设备已启动完成" };
    }
    return {
      ok: false,
      serial: input.serial,
      reason: "device-not-booted",
      message: `设备 ${input.serial} 尚未完成启动（sys.boot_completed!=1）`
    };
  } catch (error) {
    return {
      ok: true,
      serial: input.serial,
      reason: "unavailable",
      message: `设备启动状态读取失败（不阻断）：${error instanceof Error ? error.message : String(error)}`
    };
  }
}

