import { defaultExec, type ExecFn } from "../device/adb.js";
import { resolveXcrunPath } from "../device/ios.js";

export interface InstalledIosAppVersion {
  version: string | null;
  build: string | null;
  source: "devicectl" | "ideviceinstaller";
}

export type ReadIosInstalledAppVersionResult =
  | { ok: true; version: InstalledIosAppVersion }
  | { ok: false; code: "not-installed" | "unavailable"; error: string };

export function formatIosInstalledVersion(input: {
  version: string | null;
  build: string | null;
}): string | null {
  if (input.version === null && input.build === null) return null;
  return `${input.version ?? "?"}${input.build === null ? "" : ` (${input.build})`}`;
}

export function matchesIosInstalledVersion(
  expected: string,
  actual: { version: string | null; build: string | null }
): boolean {
  const wanted = expected.trim();
  if (wanted === "") return true;
  if (actual.version === wanted || actual.build === wanted) return true;
  if (actual.version !== null && actual.build !== null) {
    return `${actual.version} (${actual.build})` === wanted;
  }
  return false;
}

export type IosVersionCheckVerdict =
  | { ok: true; actual: string | null; check: "skipped" | "matched" }
  | {
      ok: false;
      code: "app-not-installed" | "app-version-mismatch" | "app-version-unavailable";
      message: string;
      actual: string | null;
    };

/** 纯函数：把逐台设备的读取结果合并成 runner 的版本校验结论。
 * 期望为空时只记录实际版本（读取失败也不阻断）；期望非空时任一设备不一致/读不到即失败。 */
export function evaluateIosVersionChecks(input: {
  bundleId: string;
  expected: string;
  checks: Array<{ serial: string; read: ReadIosInstalledAppVersionResult }>;
}): IosVersionCheckVerdict {
  const actual =
    input.checks
      .map((entry) => (entry.read.ok ? formatIosInstalledVersion(entry.read.version) : null))
      .filter((value): value is string => value !== null)
      .join("、") || null;
  const notInstalled = input.checks.find(
    (entry) => !entry.read.ok && entry.read.code === "not-installed"
  );
  if (notInstalled !== undefined) {
    const reason = notInstalled.read.ok ? "未知原因" : notInstalled.read.error;
    return {
      ok: false,
      code: "app-not-installed",
      message: `设备未安装 ${input.bundleId}：${reason}。请先通过 TestFlight 安装后重跑。`,
      actual
    };
  }
  const wanted = input.expected.trim();
  if (wanted === "") return { ok: true, actual, check: "skipped" };
  const unavailable = input.checks.find((entry) => !entry.read.ok);
  if (unavailable !== undefined) {
    const reason = unavailable.read.ok ? "未知原因" : unavailable.read.error;
    return {
      ok: false,
      code: "app-version-unavailable",
      message: `期望版本 ${wanted}，但无法读取设备已安装版本：${reason}`,
      actual
    };
  }
  const mismatched = input.checks.filter(
    (entry) => entry.read.ok && !matchesIosInstalledVersion(wanted, entry.read.version)
  );
  if (mismatched.length > 0) {
    const detail = input.checks
      .map(
        (entry) =>
          `${entry.serial}=${
            entry.read.ok ? (formatIosInstalledVersion(entry.read.version) ?? "未知") : "读取失败"
          }`
      )
      .join("；");
    return {
      ok: false,
      code: "app-version-mismatch",
      message: `iOS 应用版本不一致：期望 ${wanted}，设备实际 ${detail}`,
      actual
    };
  }
  return { ok: true, actual, check: "matched" };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

type DevicectlParse =
  | { status: "found"; version: InstalledIosAppVersion }
  | { status: "not-found" }
  | null;

function parseDevicectlApps(stdout: string, bundleId: string): DevicectlParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const apps = (parsed as { result?: { apps?: unknown } })?.result?.apps;
  if (!Array.isArray(apps)) return null;
  const app = apps.find(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      (entry as { bundleIdentifier?: unknown }).bundleIdentifier === bundleId
  ) as { version?: unknown; bundleVersion?: unknown } | undefined;
  if (app === undefined) return { status: "not-found" };
  return {
    status: "found",
    version: {
      version: stringOrNull(app.version),
      build: stringOrNull(app.bundleVersion),
      source: "devicectl"
    }
  };
}

function parseIdeviceinstallerApps(
  stdout: string,
  bundleId: string
): InstalledIosAppVersion | null {
  const text = stdout.trim();
  if (text === "") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    const apps = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { apps?: unknown })?.apps)
        ? (parsed as { apps: unknown[] }).apps
        : null;
    if (apps !== null) {
      const app = apps.find(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          ((entry as { CFBundleIdentifier?: unknown }).CFBundleIdentifier === bundleId ||
            (entry as { bundleIdentifier?: unknown }).bundleIdentifier === bundleId)
      ) as Record<string, unknown> | undefined;
      if (app !== undefined) {
        return {
          version: stringOrNull(app.CFBundleShortVersionString ?? app.version),
          build: stringOrNull(app.CFBundleVersion ?? app.build),
          source: "ideviceinstaller"
        };
      }
    }
  } catch {
    /* XML / plain output below */
  }
  const index = text.indexOf(bundleId);
  if (index < 0) return null;
  const window = text.slice(Math.max(0, index - 2_000), index + 4_000);
  const version =
    /CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(window)?.[1] ?? null;
  const build = /CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(window)?.[1] ?? null;
  if (version !== null || build !== null) {
    return { version, build, source: "ideviceinstaller" };
  }
  const line = text.split(/\r?\n/).find((entry) => entry.includes(bundleId));
  if (line === undefined) return null;
  const parts = line.split(/[,\t;]/).map((entry) => entry.trim());
  const plainVersion = parts.find((entry) => /^\d+(\.\d+){1,3}$/.test(entry)) ?? null;
  const plainBuild = parts.find((entry) => /^\d+$/.test(entry) && entry !== plainVersion) ?? null;
  return { version: plainVersion, build: plainBuild, source: "ideviceinstaller" };
}

/** 读取真机已安装 App 的版本。优先 CoreDevice（iOS 17+），旧系统回退
 * `ideviceinstaller --format json`（runner 未安装该工具时返回 unavailable，不误判）。 */
export async function readIosInstalledAppVersion(input: {
  udid: string;
  bundleId: string;
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  timeoutMs?: number;
}): Promise<ReadIosInstalledAppVersionResult> {
  const env = input.env ?? process.env;
  const exec = input.exec ?? defaultExec;
  const bundleId = input.bundleId.trim();
  if (bundleId === "") {
    return { ok: false, code: "not-installed", error: "应用包名（bundle ID）为空" };
  }
  const timeoutMs = input.timeoutMs ?? 15_000;
  const xcrun = resolveXcrunPath(env).path;
  const devicectl = await exec(
    xcrun,
    [
      "devicectl",
      "device",
      "info",
      "apps",
      "--device",
      input.udid,
      "--json-output",
      "-"
    ],
    { timeoutMs, env }
  );
  if (devicectl.error === undefined && devicectl.code === 0) {
    const parsed = parseDevicectlApps(devicectl.stdout, bundleId);
    if (parsed?.status === "found") return { ok: true, version: parsed.version };
    if (parsed?.status === "not-found") {
      return {
        ok: false,
        code: "not-installed",
        error: `设备未安装 ${bundleId}（devicectl 未列出该应用）`
      };
    }
    // JSON 解析失败（例如工具输出混入非 JSON）：继续尝试 ideviceinstaller，不误判为未安装。
  }

  const ideviceinstaller = env.AOS_IDEVICEINSTALLER_PATH?.trim() || "ideviceinstaller";
  const fallback = await exec(
    ideviceinstaller,
    ["-u", input.udid, "-l", "--format", "json"],
    { timeoutMs, env }
  );
  if (fallback.error === undefined && fallback.code === 0) {
    const parsed = parseIdeviceinstallerApps(fallback.stdout, bundleId);
    if (parsed !== null) return { ok: true, version: parsed };
    return {
      ok: false,
      code: "not-installed",
      error: `设备未安装 ${bundleId}（ideviceinstaller 未列出该应用）`
    };
  }

  const devicectlReason =
    devicectl.error ?? (devicectl.stderr.trim() || `exit ${devicectl.code ?? "null"}`);
  const fallbackReason =
    fallback.error ?? (fallback.stderr.trim() || `exit ${fallback.code ?? "null"}`);
  return {
    ok: false,
    code: "unavailable",
    error: `无法读取设备已安装应用版本（devicectl: ${devicectlReason}；ideviceinstaller: ${fallbackReason}）`
  };
}
