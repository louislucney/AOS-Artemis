import type { ChatMessage } from "../../llm/chat.js";
import type { ReadingChunkPlan } from "./types.js";

export const READING_PROMPT_VERSION = 3;

const SCHEMA = `{
  "screens": [
    {
      "screenId": "s1",
      "name": "屏幕名",
      "boardLabel": "手机外框上方的画板/状态文字，如 行動預點-下滑；没有则 null",
      "stateLabel": "从画板标签提取的状态，如 下滑；没有则 null",
      "observed": {
        "title": "可见标题或 null",
        "headerControls": [
          { "kind": "back|title|search|cart|menu-entry|tab|other", "label": "文字或 null", "bbox": { "x": 0, "y": 0, "width": 0, "height": 0 }, "confidence": 0.9 }
        ],
        "persistentNav": { "sideNav": [], "bottomTabs": [], "activeTab": null },
        "contentGroups": [{ "label": "分组标题", "items": ["项目"] }],
        "floatingActions": [],
        "annotations": [
          { "text": "旁注文字", "source": "annotation-line|text|unknown", "target": "unknown|null", "bbox": { "x": 0, "y": 0, "width": 0, "height": 0 } }
        ]
      },
      "states": [],
      "inferredInteractions": [
        { "element": "控件", "action": "tap|scroll|swipe", "to": "目标屏 id 或 null", "basis": "可见依据", "status": "observed|inferred|unconfirmed", "confidence": 0.8, "why": "为什么" }
      ]
    }
  ],
  "crossScreenLinks": [
    { "fromScreenId": "s1", "fromElement": "控件", "toScreenId": "目标屏 id 或 null", "toLabel": "目标名或 null", "status": "observed|inferred|unconfirmed", "basis": "可见依据", "why": "为什么" }
  ],
  "questions": [
    { "id": "q-001", "screenId": "s1", "question": "需要确认的问题", "why": "为什么影响判断", "options": ["选项"] }
  ]
}`;

export function buildReadingMessages(input: {
  plan: ReadingChunkPlan;
  images: Array<{ screenId: string; dataUrl: string }>;
}): ChatMessage[] {
  const screenLines = input.plan.screens
    .map(
      (screen, index) =>
        `${index + 1}. id=${screen.id} name=${screen.name}${
          screen.kind === "state"
            ? ` parent=${screen.parentScreenId ?? "unknown"} kind=state`
            : ""
        }${
          input.plan.boundaryBefore !== null && index === 0
            ? `（前一屏：${input.plan.boundaryBefore}）`
            : ""
        }${
          input.plan.boundaryAfter !== null && index === input.plan.screens.length - 1
            ? `（后一屏：${input.plan.boundaryAfter}）`
            : ""
        }`
    )
    .join("\n");
  const knownEdges =
    input.plan.knownEdges.length === 0
      ? "无"
      : JSON.stringify(
          input.plan.knownEdges.map((edge) => ({
            from: edge.from.id,
            to: edge.to?.id ?? null,
            element: edge.element.name,
            trigger: edge.trigger,
            actionType: edge.actionType
          })),
          null,
          2
        );
  const knownElements =
    input.plan.knownElements.length === 0
      ? "无"
      : JSON.stringify(
          input.plan.knownElements.map((element) => ({
            class: element.class,
            intent: element.intent,
            label: element.label ?? null,
            screenId: element.screenId ?? null,
            nodeId: element.nodeId ?? null
          })),
          null,
          2
        );

  const instruction = `你在阅读一份移动端设计稿的相邻屏幕。只报告图中可见的事实；不要编造未出现的控件、页面或跳转。

屏幕顺序：
${screenLines}

已有原型边（只作上下文，不可被覆盖）：
${knownEdges}

已有视觉元素（只作上下文，不可替代你的控件清单）：
${knownElements}

必须遵守：
1. 每屏先做 header 控件清单：back / title / search / cart / menu-entry / tab / other。右上角圆形放大镜必须归为 search；无文字但可见的图标必须输出为 other（带 bbox），不得省略。
2. 每屏记录手机外框上方的画板标签/状态到 boardLabel/stateLabel（如「行動預點-下滑」/「下滑」）；这是设计元数据，不是 App UI，不得放进 title/headerControls；没有则 null。
3. observed 只放可见事实（文字、控件、分组、标注线）；连接线单独放 annotations；不要把旁注文字当成目标页。
4. 交互放 inferredInteractions：status=observed 仅当图上有明确线/明确原型边；inferred 需给 basis；unconfirmed 必须生成 question。目标不在本块屏幕集时 to=null + question，不要猜屏 id。
5. Flow/Header、状态栏、备注等设计 chrome 不要放进 headerControls；如看到可疑 chrome，在问题/说明里指出。
6. 空数组合法：某屏确实没有 header 控件/浮动动作时输出 []，但不能缺字段。
7. 只输出 JSON，不要 Markdown、不要解释。

JSON 形状：
${SCHEMA}`;

  return [
    {
      role: "system",
      content:
        "你是移动 UI 设计稿阅读器。只输出 JSON；严格区分观察、推断、待确认；宁可提问，不要编造。"
    },
    {
      role: "user",
      content: [
        { type: "text", text: instruction },
        ...input.images.flatMap((image) => [
          { type: "text" as const, text: `[屏幕 ${image.screenId}]` },
          { type: "image_url" as const, image_url: { url: image.dataUrl } }
        ])
      ]
    }
  ];
}
