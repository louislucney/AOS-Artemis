import { defaultExec, type ExecFn } from "../../device/adb.js";

export interface AppiumDetectorOptions {
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
}

export interface AppiumDetection {
  appium: { found: boolean; path: string | null; version: string | null };
  xcuitest: { installed: boolean; version: string | null };
  guidance: string[];
}

export const APPIUM_TUNNEL_HINT = "sudo appium driver run xcuitest tunnel-creation";

/** Detect the Appium CLI and the xcuitest driver; guidance lists the concrete
 * fixes (install commands, signing team env, iOS 18+ tunnel). */
export async function detectAppium(options: AppiumDetectorOptions = {}): Promise<AppiumDetection> {
  const env = options.env ?? process.env;
  const exec = options.exec ?? defaultExec;
  const explicit = env.AOS_APPIUM_PATH?.trim();
  const binary = explicit && explicit !== "" ? explicit : "appium";
  const guidance: string[] = [];

  const versionResult = await exec(binary, ["--version"], { timeoutMs: 15_000 });
  const found = versionResult.code === 0 && !versionResult.error;
  const version = found ? (versionResult.stdout.trim().split("\n")[0]?.trim() || null) : null;

  let xcuitest: { installed: boolean; version: string | null } = { installed: false, version: null };
  if (found) {
    const list = await exec(binary, ["driver", "list", "--installed"], { timeoutMs: 30_000 });
    if (list.code === 0 && !list.error) {
      const escape = String.fromCharCode(27);
      const text = `${list.stdout}\n${list.stderr}`.split(escape).join("");
      const match = /xcuitest@(\S+?)(?:\s|\]|$)/.exec(text);
      if (match) xcuitest = { installed: true, version: match[1] ?? null };
      else if (/xcuitest/.test(text)) xcuitest = { installed: true, version: null };
    }
  }

  if (!found) {
    guidance.push("未检测到 appium：npm install -g appium（或设置 AOS_APPIUM_PATH 指向二进制）。");
  } else if (!xcuitest.installed) {
    guidance.push("xcuitest 驱动未安装：appium driver install xcuitest。");
  }
  const team = env.AOS_IOS_XCODE_ORG_ID?.trim();
  if (!team || team === "") {
    guidance.push(
      "真机签名需 AOS_IOS_XCODE_ORG_ID（证书 OU 团队 ID；可在 Xcode Settings → Accounts 查看）。"
    );
  }
  guidance.push(`iOS 18+ 真机首次使用需建立隧道：${APPIUM_TUNNEL_HINT}（已建立则复用）。`);

  return {
    appium: {
      found,
      path: explicit && explicit !== "" ? explicit : found ? "appium" : null,
      version
    },
    xcuitest,
    guidance
  };
}
