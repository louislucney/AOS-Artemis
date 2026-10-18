import { writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveProject } from "./config/loader.js";
import { createProjectStore } from "./db/index.js";
import { exportProjectData, type ExportWhat } from "./export/index.js";
import { errorMessage } from "./util.js";

const USAGE = [
  "用法: aos-mcp export --what results|process|data [--format json|csv] [--project <dir>]",
  "         [--out <file>] [--since <ISO>] [--limit <n>]",
  "  三口径导出：results（测试结果）/ process（测试过程）/ data（测试用的数据）；缺省 JSON 输出到 stdout"
].join("\n");

function flagValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

export async function runExportCommand(args: string[]): Promise<number> {
  const whatRaw = flagValue(args, "--what");
  if (whatRaw !== "results" && whatRaw !== "process" && whatRaw !== "data") {
    console.error(USAGE);
    return 2;
  }
  const formatRaw = flagValue(args, "--format") ?? "json";
  if (formatRaw !== "json" && formatRaw !== "csv") {
    console.error(`非法 --format "${formatRaw}"（须为 json|csv）`);
    return 2;
  }
  const limitRaw = flagValue(args, "--limit");
  let limit: number | undefined;
  if (limitRaw !== null) {
    const parsed = Number(limitRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`非法 --limit "${limitRaw}"（须为正整数）`);
      return 2;
    }
    limit = Math.floor(parsed);
  }
  const since = flagValue(args, "--since");
  if (since !== null && Number.isNaN(Date.parse(since))) {
    console.error(`非法 --since "${since}"（须为可解析的 ISO 时间）`);
    return 2;
  }

  const projectFlag = flagValue(args, "--project");
  let rootPath: string;
  try {
    rootPath =
      projectFlag !== null
        ? path.resolve(projectFlag)
        : resolveProject({ env: { ...process.env, AOS_CONFIG: "" } }).rootDir;
  } catch (error) {
    console.error(`项目解析失败：${errorMessage(error)}`);
    return 2;
  }

  try {
    const { store, close } = await openStore();
    try {
      const result = await exportProjectData(rootPath, store, {
        what: whatRaw as ExportWhat,
        format: formatRaw,
        ...(since === null ? {} : { since }),
        ...(limit === undefined ? {} : { limit })
      });
      const out = flagValue(args, "--out");
      if (out !== null) {
        await writeFile(path.resolve(out), result.content, "utf8");
        console.error(`已导出: ${path.resolve(out)}（${JSON.stringify(result.counts)}）`);
      } else {
        console.log(result.content);
      }
      return 0;
    } finally {
      await close();
    }
  } catch (error) {
    console.error(`导出失败：${errorMessage(error)}`);
    return 2;
  }
}

async function openStore() {
  const created = await createProjectStore();
  return {
    store: created.store,
    close: async () => {
      await created.store.close();
    }
  };
}
