import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { importScreenFile, penScreensDir } from "../design/screens.js";
import { errorMessage } from "../util.js";
import { penEnvFrom, type PenExecFn } from "./cli.js";
import type { PenEnsureFn } from "./install.js";
import { renderPenScreens, type PenScreenRenderInput, type PenScreenRenderResult } from "./render.js";

/** pen 截图捕获共享原语（design-screenshots T2/T4）：单次交互会话批量渲染到
 * 私有临时目录 → 逐张校验后原子入库 `design/screens/pen-<slug>/` → 清理；
 * 逐屏/通道级失败如实上报（调用方决定 warning 文案与摘要形态）。 */

export interface PenScreensCapture {
  /** 最终入库目录（`design/screens/pen-<slug>/` 绝对路径）。 */
  dir: string;
  /** screenId → 已入库的最终 PNG 绝对路径（仅成功入库的屏）。 */
  imagePaths: Map<string, string>;
  skipped: string[];
  /** 通道级失败（渲染整体不可用）时的错误文案；部分成功或全成功为 null。 */
  channelError: string | null;
}

export interface CapturePenScreensInput {
  configDirAbs: string;
  target: string;
  screenIds: string[];
  dotenv: Record<string, string>;
  deps?: {
    render?: (input: PenScreenRenderInput) => Promise<PenScreenRenderResult>;
    exec?: PenExecFn;
    ensure?: PenEnsureFn;
  };
}

export async function capturePenScreens(input: CapturePenScreensInput): Promise<PenScreensCapture> {
  const ids = [...new Set(input.screenIds.filter((id) => id.trim() !== ""))];
  const finalDir = penScreensDir(input.configDirAbs, input.target);
  if (ids.length === 0) return { dir: finalDir, imagePaths: new Map(), skipped: [], channelError: null };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-pen-screens-"));
  let rendered: PenScreenRenderResult;
  try {
    rendered = await (input.deps?.render ?? renderPenScreens)({
      target: input.target,
      screenIds: ids,
      env: penEnvFrom(input.dotenv, process.env),
      outDir: tempDir,
      exec: input.deps?.exec,
      ensure: input.deps?.ensure
    });
  } catch (error) {
    rendered = {
      ok: false,
      dir: tempDir,
      files: new Map(),
      missing: ids,
      error: errorMessage(error)
    };
  }

  const imagePaths = new Map<string, string>();
  for (const id of ids) {
    const source = rendered.files.get(id);
    if (!source) continue;
    const stored = importScreenFile(source, finalDir, id);
    if (stored.status !== "invalid") imagePaths.set(id, stored.path);
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }

  const channelError =
    !rendered.ok && imagePaths.size === 0 ? (rendered.error ?? "pen CLI 未产出渲染图") : null;
  return {
    dir: finalDir,
    imagePaths,
    skipped: ids.filter((id) => !imagePaths.has(id)),
    channelError
  };
}
