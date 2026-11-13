import type { AppInstallMode, AppVersionCheck } from "../db/types.js";

export interface AppInstallPlanInput {
  platforms: string[];
  appAssetFilename: string | null;
  appPackage: string | null;
  skipIosInstall: boolean;
  iosInstallConfirmed: boolean;
  appVersionExpected: string | null;
}

export interface AppInstallPlan {
  appInstallMode: AppInstallMode | null;
  appVersionExpected: string | null;
  appVersionCheck: AppVersionCheck | null;
  warnings: string[];
}

export type AppInstallPlanResult =
  | { ok: true; plan: AppInstallPlan }
  | { ok: false; error: string };

function expectedVersion(raw: string | null): { value: string | null; error?: string } {
  const value = (raw ?? "").trim();
  if (value === "") return { value: null };
  if (value.length > 64) return { value: null, error: "期望版本过长（最多 64 字符）" };
  if (/[\r\n\t]/.test(value)) return { value: null, error: "期望版本不能包含换行或制表符" };
  return { value };
}

/** 面板/CLI 共用：把「是否下发 iOS 安装包 + 期望版本」解析成任务字段。
 * 不依赖设备；只做确定性的输入校验，避免把矛盾组合写进任务。 */
export function resolveAppInstallPlan(input: AppInstallPlanInput): AppInstallPlanResult {
  const hasIos = input.platforms.includes("ios");
  const asset = (input.appAssetFilename ?? "").trim().toLowerCase();
  const isIpa = asset.endsWith(".ipa");
  const isApk = asset.endsWith(".apk");
  const expected = expectedVersion(input.appVersionExpected);
  if (expected.error !== undefined) return { ok: false, error: expected.error };
  const hasPackage = (input.appPackage ?? "").trim() !== "";

  if (!hasIos) {
    return {
      ok: true,
      plan: {
        appInstallMode: null,
        appVersionExpected: null,
        appVersionCheck: null,
        warnings: []
      }
    };
  }

  const expectedUnusedWarning =
    expected.value === null ? [] : ["已选择下发 IPA：期望版本不生效（版本由安装包决定）"];

  if (input.skipIosInstall) {
    if (!input.iosInstallConfirmed) {
      return { ok: false, error: "请先确认设备已通过 TestFlight 安装该 App" };
    }
    if (isIpa) {
      return { ok: false, error: "已选择不下发 iOS 安装包：不能同时选择 IPA" };
    }
    if (!hasPackage) {
      return { ok: false, error: "不下发 iOS 安装包时必须填写应用包名（bundle ID）" };
    }
    return {
      ok: true,
      plan: {
        appInstallMode: "installed",
        appVersionExpected: expected.value,
        appVersionCheck: expected.value === null ? "skipped" : null,
        warnings: []
      }
    };
  }

  // 非混合端：没有 IPA 时按“设备已安装”处理（CLI 兼容旧行为；
  // 面板会在调用前强制要求勾选 TestFlight 确认）。
  if (input.platforms.length === 1) {
    if (!isIpa) {
      return {
        ok: true,
        plan: {
          appInstallMode: "installed",
          appVersionExpected: expected.value,
          appVersionCheck: expected.value === null ? "skipped" : null,
          warnings: ["未选择 iOS IPA：使用设备已安装应用（如通过 TestFlight 安装）"]
        }
      };
    }
    return {
      ok: true,
      plan: {
        appInstallMode: "asset",
        appVersionExpected: null,
        appVersionCheck: null,
        warnings: expectedUnusedWarning
      }
    };
  }

  // 混合端沿用单安装包模型：IPA 走 iOS；APK 走 Android，iOS 使用已安装应用。
  if (isIpa) {
    return {
      ok: true,
      plan: {
        appInstallMode: "asset",
        appVersionExpected: null,
        appVersionCheck: null,
        warnings: [
          "混合端任务只安装 IPA：Android 将使用设备已安装应用",
          ...expectedUnusedWarning
        ]
      }
    };
  }
  if (isApk) {
    if (!hasPackage) {
      return {
        ok: false,
        error: "混合端任务未选择 IPA：iOS 使用已安装应用时必须填写应用包名（bundle ID）"
      };
    }
    return {
      ok: true,
      plan: {
        appInstallMode: "installed",
        appVersionExpected: expected.value,
        appVersionCheck: expected.value === null ? "skipped" : null,
        warnings: ["混合端任务选择 APK：iOS 将使用设备已安装应用"]
      }
    };
  }
  return {
    ok: true,
    plan: {
      appInstallMode: "installed",
      appVersionExpected: expected.value,
      appVersionCheck: expected.value === null ? "skipped" : null,
      warnings: [
        "混合端任务未选择 IPA：iOS 将使用设备已安装应用",
        ...(!hasPackage ? ["iOS 使用已安装应用需要填写应用包名（bundle ID）"] : [])
      ]
    }
  };
}
