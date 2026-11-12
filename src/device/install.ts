import { defaultExec, resolveAdbPath } from "./adb.js";

/** 用 streamed `adb install -r -t` 安装 Android APK。
 *
 * 只允许「覆盖安装」：`-r` 保留应用数据。绝不卸载/清数据——Artemis 侧的
 * adbutils 在版本或签名冲突时会先 `pm uninstall` 再装，等同于清空 app 数据，
 * 因此套件执行统一走这里，且失败时由调用方直接中止任务。 */
export async function adbInstallAndroidApk(
  env: NodeJS.ProcessEnv,
  serial: string,
  apkPath: string,
  exec: typeof defaultExec = defaultExec
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  const adb = resolveAdbPath(env, process.platform);
  if (adb.path === null) return { ok: false, error: "adb-not-found" };
  await exec(adb.path, ["-s", serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP"], {
    timeoutMs: 5_000,
    env
  }).catch(() => undefined);
  await exec(adb.path, ["-s", serial, "shell", "wm", "dismiss-keyguard"], {
    timeoutMs: 5_000,
    env
  }).catch(() => undefined);
  const result = await exec(adb.path, ["-s", serial, "install", "-r", "-t", apkPath], {
    timeoutMs: 600_000,
    env
  });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (result.code === 0 && /Success/i.test(result.stdout)) return { ok: true, output };
  return { ok: false, error: output === "" ? "adb install 失败（无输出）" : output };
}
