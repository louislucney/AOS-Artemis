import { defaultExec, resolveAdbPath, type ExecFn } from "../device/adb.js";

export interface AndroidSystemDialog {
  package: string;
  className: string;
  title: string | null;
  message: string | null;
  buttons: string[];
}

export type AndroidSystemDialogResult =
  | { status: "none"; dialog: null; reason: null }
  | { status: "dialog"; dialog: AndroidSystemDialog; reason: null }
  | { status: "unavailable"; dialog: null; reason: string };

interface UiNode {
  package: string;
  className: string;
  text: string;
  desc: string;
  clickable: boolean;
  bounds: string;
}

const SYSTEM_PACKAGES = new Set([
  "com.android.systemui",
  "com.google.android.permissioncontroller",
  "com.android.permissioncontroller",
  "android"
]);

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(/([A-Za-z0-9:_-]+)="([^"]*)"/g)) {
    attrs[match[1]!] = match[2]!;
  }
  return attrs;
}

function parseNodes(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  for (const match of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
    const attrs = parseAttrs(match[1]!);
    const className = attrs.class ?? "";
    const pkg = attrs.package ?? "";
    const text = (attrs.text ?? "").trim();
    const desc = (attrs["content-desc"] ?? "").trim();
    if (pkg === "" && className === "" && text === "" && desc === "") continue;
    nodes.push({
      package: pkg,
      className,
      text,
      desc,
      clickable: attrs.clickable === "true",
      bounds: attrs.bounds ?? ""
    });
  }
  return nodes;
}

function textOf(node: UiNode): string {
  return node.text || node.desc;
}

/** 只读识别当前 Android 系统弹窗：系统 package 下的 Dialog/Alert 或 text-bearing 系统节点。
 * 不做点击、不阻塞；调用方决定 block/warn。 */
export async function readAndroidSystemDialog(input: {
  serial: string;
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
}): Promise<AndroidSystemDialogResult> {
  const env = input.env ?? process.env;
  const exec = input.exec ?? defaultExec;
  if ((env.AOS_RUNNER_SYSTEM_DIALOG_CHECK ?? "1").trim() === "0") {
    return { status: "unavailable", dialog: null, reason: "disabled" };
  }
  const adb = resolveAdbPath(env, process.platform);
  if (adb.path === null) {
    return { status: "unavailable", dialog: null, reason: "adb-not-found" };
  }
  const dump = "/sdcard/mobile-testing-window.xml";
  try {
    const dumped = await exec(
      adb.path,
      ["-s", input.serial, "shell", "uiautomator", "dump", dump],
      { timeoutMs: 15_000, env }
    );
    if (dumped.error || dumped.code !== 0) {
      return { status: "unavailable", dialog: null, reason: dumped.error ?? `uiautomator exit ${String(dumped.code)}` };
    }
    const read = await exec(adb.path, ["-s", input.serial, "shell", "cat", dump], {
      timeoutMs: 10_000,
      env
    });
    if (read.error || read.code !== 0 || read.stdout.trim() === "") {
      return { status: "unavailable", dialog: null, reason: read.error ?? `cat exit ${String(read.code)}` };
    }
    const nodes = parseNodes(read.stdout);
    const system = nodes.filter((node) => SYSTEM_PACKAGES.has(node.package));
    if (system.length === 0) return { status: "none", dialog: null, reason: null };
    const dialogish = system.find((node) => /dialog|alert|modal|popup/i.test(node.className)) ?? null;
    const buttons = system
      .filter((node) => node.clickable && /button/i.test(node.className) && textOf(node) !== "")
      .map(textOf)
      .slice(0, 6);
    const texts = system.map(textOf).filter((text) => text !== "");
    if (dialogish === null && buttons.length === 0) {
      return { status: "none", dialog: null, reason: null };
    }
    return {
      status: "dialog",
      dialog: {
        package: (dialogish ?? system[0]!).package,
        className: (dialogish ?? system[0]!).className,
        title: texts[0] ?? null,
        message: texts.length > 1 ? texts.slice(1).join(" / ") : null,
        buttons
      },
      reason: null
    };
  } catch (error) {
    return {
      status: "unavailable",
      dialog: null,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}
