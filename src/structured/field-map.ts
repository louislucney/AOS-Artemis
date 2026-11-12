import type { IosUiNode } from "../device/ios.js";
import type { StructuredTarget } from "../figma/structured-actions.js";

export interface FieldProposal {
  /** 可用于 native `type` 的确定性目标；没有 id/label 时为 null（只能点坐标）。 */
  target: StructuredTarget | null;
  label: string | null;
  type: string;
  bounds: { x: number; y: number; width: number; height: number };
}

const EDITABLE_TYPE =
  /edittext|textfield|securetextfield|searchfield|textview.*editable|textinput/i;

/** 从当前 UI 层级挑出可编辑控件，生成字段映射候选（不读取/输出输入值）。 */
export function proposeFieldTargets(nodes: IosUiNode[]): FieldProposal[] {
  const seen = new Set<string>();
  const out: FieldProposal[] = [];
  for (const node of nodes) {
    if (!EDITABLE_TYPE.test(node.type)) continue;
    const id = node.id.trim();
    const label = node.label.trim();
    const target: StructuredTarget | null =
      id !== ""
        ? { kind: "resource-id", value: id }
        : label !== ""
          ? { kind: "content-desc", value: label }
          : null;
    const key =
      target === null
        ? `${node.rect.x},${node.rect.y},${node.rect.width},${node.rect.height}`
        : `${target.kind}:${target.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      target,
      label: label === "" ? null : label,
      type: node.type,
      bounds: { ...node.rect }
    });
  }
  return out;
}
