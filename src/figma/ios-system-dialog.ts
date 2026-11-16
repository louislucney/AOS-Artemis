import type { IosDevice } from "../device/ios-actions.js";

export interface IosSystemDialog {
  title: string | null;
  message: string | null;
  buttons: string[];
}

export type IosSystemDialogResult =
  | { status: "none"; dialog: null; reason: null }
  | { status: "dialog"; dialog: IosSystemDialog; reason: null }
  | { status: "unavailable"; dialog: null; reason: string };

function textOf(node: { label: string; value: string }): string {
  return (node.label || node.value || "").trim();
}

/** iOS 只把明确的 Alert 类型当作系统弹窗；普通页面/表单按钮不误报。
 * 不点击、不关闭，调用方决定 block/warn。 */
export async function readIosSystemDialog(input: {
  device: IosDevice;
  env?: NodeJS.ProcessEnv;
}): Promise<IosSystemDialogResult> {
  const env = input.env ?? process.env;
  if ((env.AOS_RUNNER_SYSTEM_DIALOG_CHECK ?? "1").trim() === "0") {
    return { status: "unavailable", dialog: null, reason: "disabled" };
  }
  let nodes;
  try {
    nodes = await input.device.nodes();
  } catch (error) {
    return {
      status: "unavailable",
      dialog: null,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
  const alertNodes = nodes.filter((node) => /alert/i.test(node.type));
  if (alertNodes.length === 0) return { status: "none", dialog: null, reason: null };
  const texts = nodes.map(textOf).filter((text) => text !== "");
  const buttons = nodes
    .filter((node) => /button/i.test(node.type) && textOf(node) !== "")
    .map(textOf)
    .slice(0, 6);
  return {
    status: "dialog",
    dialog: {
      title: texts[0] ?? null,
      message: texts.length > 1 ? texts.slice(1).join(" / ") : null,
      buttons
    },
    reason: null
  };
}
