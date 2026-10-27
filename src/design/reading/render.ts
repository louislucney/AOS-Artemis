import type { ReadingFile } from "./types.js";
import type { ReadingChunk } from "./types.js";

function md(value: string | null): string {
  if (value === null) return "—";
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function code(value: string | null): string {
  return value === null ? "—" : `\`${value.replace(/`/g, "'")}\``;
}

export function renderReadingMarkdown(reading: ReadingFile): string {
  const lines: string[] = [
    "# 设计稿阅读",
    "",
    `> 来源: ${md(reading.source)}`,
    `> 生成: ${md(reading.generatedAt)} · 模型: ${md(reading.model)} · 分块 ${reading.chunkSize}/${reading.overlap}`,
    ""
  ];

  const spine = reading.spine;
  lines.push("## CR 主线（假设）", "");
  if (spine === null) {
    lines.push("（证据不足，未形成主线假设）", "");
  } else {
    lines.push(`**${md(spine.title)}**`, "", md(spine.summary), "");
    lines.push(
      `- 状态: ${spine.status} · 屏 ${spine.screenIds.length} · 边 ${spine.edgeIds.length}`
    );
    lines.push(
      `- 证据: observed ${spine.statusSummary.observed} / inferred ${spine.statusSummary.inferred} / unconfirmed ${spine.statusSummary.unconfirmed}`
    );
    if (spine.statusSummary.inferred > 0) {
      lines.push(`- **主线含 ${spine.statusSummary.inferred} 条推断边，不是硬结论。**`);
    }
    const canvasOrderEdges = spine.edgeIds.filter(
      (id) => reading.interactions.find((edge) => edge.id === id)?.basis === "canvas-order"
    ).length;
    if (canvasOrderEdges > 0) {
      lines.push(
        `- 其中 ${canvasOrderEdges} 条为画板顺序假设（canvas-order），不代表真实控件跳转。`
      );
    }
    if (reading.completeness.unconfirmedEdges > 0) {
      lines.push(`- 另有 ${reading.completeness.unconfirmedEdges} 条待确认边未进入主线。`);
    }
    lines.push("");
  }

  const c = reading.completeness;
  lines.push("## 完整性", "");
  lines.push(
    `- 屏幕: 读到 ${c.screensRead}/${c.screensTotal} · observed ${c.observedScreens} · 失败/漏读 ${c.failedScreens}`
  );
  lines.push(`- 丢屏/截断: dropped ${c.droppedScreens.length} · truncated ${c.truncatedScreens.length}`);
  if (c.droppedScreens.length > 0) lines.push(`- dropped: ${c.droppedScreens.map((id) => code(id)).join("、")}`);
  if (c.unreadScreens.length > 0) lines.push(`- unread: ${c.unreadScreens.map((id) => code(id)).join("、")}`);
  if (c.truncatedScreens.length > 0) lines.push(`- truncated: ${c.truncatedScreens.map((id) => code(id)).join("、")}`);
  lines.push(`- 边: unresolved ${c.unresolvedEdges} · unconfirmed ${c.unconfirmedEdges} · overlap 冲突 ${c.overlapConflicts}`);
  lines.push(`- 覆盖: header ${c.headerCoverage}/${c.screensTotal} · bottomNav ${c.bottomNavCoverage}/${c.screensTotal} · 标注 ${c.annotationScreens}`);
  if (c.orphanScreens.length > 0) {
    lines.push(`- 孤岛屏: ${c.orphanScreens.map((id) => code(id)).join("、")}`);
  }
  lines.push("");

  lines.push("## 屏幕", "");
  for (const screen of reading.screens) {
    lines.push(
      `### ${md(screen.name)} ${code(screen.screenId)}${
        screen.kind === "state" ? "（状态变体）" : ""
      }`,
      ""
    );
    if (screen.parentScreenId !== undefined) {
      lines.push(`- 父屏: ${code(screen.parentScreenId)}`);
    }
    if (screen.boardLabel !== null && screen.boardLabel !== undefined) {
      lines.push(
        `- 画板: ${md(screen.boardLabel)}${
          screen.stateLabel === null || screen.stateLabel === undefined
            ? ""
            : `（状态: ${md(screen.stateLabel)}）`
        }`
      );
    }
    if ((screen.knownStates?.length ?? 0) > 0) {
      lines.push(`- 已知状态: ${(screen.knownStates ?? []).map((label) => md(label)).join(" / ")}`);
    }
    if (screen.title !== null) lines.push(`- 标题: ${md(screen.title)}`);
    if (screen.headerControls.length > 0) {
      lines.push(
        `- header: ${screen.headerControls
          .map((control) => `[${md(control.kind)}] ${md(control.label)}`)
          .join(" · ")}`
      );
    }
    if (screen.persistentNav.bottomTabs.length > 0) {
      lines.push(
        `- 底部 tab: ${screen.persistentNav.bottomTabs.map((tab) => md(tab)).join(" / ")}${
          screen.persistentNav.activeTab === null ? "" : `（当前 ${md(screen.persistentNav.activeTab)}）`
        }`
      );
    }
    if (screen.persistentNav.sideNav.length > 0) {
      lines.push(`- 侧栏: ${screen.persistentNav.sideNav.map((item) => md(item)).join(" / ")}`);
    }
    for (const group of screen.contentGroups) {
      lines.push(`- 分组 ${md(group.label)}: ${group.items.map((item) => md(item)).join("、")}`);
    }
    for (const action of screen.floatingActions) {
      lines.push(`- 浮动动作: [${md(action.kind)}] ${md(action.label)}`);
    }
    for (const annotation of screen.annotations) {
      lines.push(`- 标注: ${md(annotation.text)} → ${md(annotation.target)}（${md(annotation.source)}）`);
    }
    lines.push("");
  }

  lines.push("## 交互", "");
  if (reading.interactions.length === 0) {
    lines.push("（无）", "");
  } else {
    lines.push("| 从 | 元素 | 动作 | 到 | 状态 | 依据 |", "|---|---|---|---|---|---|");
    for (const edge of reading.interactions) {
      lines.push(
        `| ${code(edge.fromScreenId)} | ${md(edge.fromElement)} | ${md(edge.action)} | ${code(
          edge.toScreenId
        )}${edge.toLabel === null ? "" : ` / ${md(edge.toLabel)}`} | ${edge.status} | ${md(edge.basis)} |`
      );
    }
    lines.push("");
  }

  if ((reading.answers?.length ?? 0) > 0) {
    lines.push("## 人工答案", "");
    for (const answer of reading.answers ?? []) {
      lines.push(`- ${code(answer.id)} ${md(answer.answer)}`);
    }
    lines.push("");
  }

  lines.push("## 问题", "");
  if (reading.completeness.questionsAnswered > 0) {
    lines.push(`已按 answers.json 回答 ${reading.completeness.questionsAnswered} 条问题。`, "");
  }
  if (reading.questions.length === 0) {
    lines.push("（无）", "");
  } else {
    lines.push(
      `显示 ${reading.questions.length} / 共 ${reading.completeness.questionsTotal} 条（其余见 chunks/*.json）`,
      ""
    );
    for (const question of reading.questions) {
      lines.push(`- ${code(question.screenId)} ${md(question.question)} — ${md(question.why)}`);
    }
    lines.push("");
  }

  if (reading.warnings.length > 0) {
    lines.push("## 警告", "");
    for (const warning of reading.warnings) {
      lines.push(`- [${warning.code}] ${md(warning.message)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function renderChunkMarkdown(chunk: ReadingChunk): string {
  const lines = [
    `# 阅读块 ${chunk.chunkId}`,
    "",
    `- 计划屏幕: ${chunk.plannedScreenIds.map((id) => code(id)).join("、")}`,
    `- 实际读到: ${chunk.screenIds.map((id) => code(id)).join("、") || "—"}`,
    `- 丢尾/未读: ${[...chunk.droppedScreens, ...chunk.unreadScreens].map((id) => code(id)).join("、") || "—"}`,
    "",
    "## 屏幕",
    ""
  ];
  for (const screen of chunk.screens) {
    lines.push(`### ${md(screen.name)} ${code(screen.screenId)}`);
    lines.push("");
    if (screen.headerControls.length > 0) {
      lines.push(
        `- header: ${screen.headerControls.map((control) => `[${md(control.kind)}] ${md(control.label)}`).join(" · ")}`
      );
    }
    for (const annotation of screen.annotations) {
      lines.push(`- 标注: ${md(annotation.text)} → ${md(annotation.target)}`);
    }
    lines.push("");
  }
  lines.push("## 交互", "");
  for (const edge of chunk.interactions) {
    lines.push(
      `- ${code(edge.fromScreenId)} ${md(edge.fromElement)} → ${code(edge.toScreenId)} (${edge.status})`
    );
  }
  lines.push("", "## 问题", "");
  for (const question of chunk.questions) {
    lines.push(`- ${md(question.question)} — ${md(question.why)}`);
  }
  return lines.join("\n") + "\n";
}
