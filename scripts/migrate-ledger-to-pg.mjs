#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXIT = { ok: 0, usage: 2, failed: 4 };

const HELP = `ledger-to-pg — 把项目文件台账中的 usage_events / regression_tasks 一次性补进中心 PG

用法:
  node scripts/migrate-ledger-to-pg.mjs [--project <dir>] [--dry-run] [--json]

选项:
  --project <dir>   项目根目录（默认 AOS_PROJECT_DIR 或 cwd）
  --dry-run         只报告将插入多少条，不写库（默认即 dry-run）
  --write           实际写入（幂等；按 id 去重）
  --json            输出结构化 JSON
  --database-url <url>  覆盖 MOBILE_TESTING_DATABASE_URL

说明:
  - 只读项目 .artemis/ledger/usage.jsonl 与 state.json，不改动任何文件。
  - 旧项目 id 会重映射为目标 PG 项目 id（按 root_path 匹配）。
  - usage_events 与 regression_tasks 按 id 幂等插入；已存在则跳过。
  - suite_runs/case_sets 请用 suite backfill；本脚本不处理。
`;

function parseArgs(argv) {
  const flags = { dryRun: true, json: false };
  let project = process.env.AOS_PROJECT_DIR ?? process.cwd();
  let databaseUrl = process.env.MOBILE_TESTING_DATABASE_URL ?? "";
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      flags.help = true;
      continue;
    }
    if (token === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
    if (token === "--write") {
      flags.dryRun = false;
      continue;
    }
    if (token === "--json") {
      flags.json = true;
      continue;
    }
    if (token === "--project" || token === "--database-url") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${token} 缺少取值`);
      }
      if (token === "--project") project = value;
      else databaseUrl = value;
      index += 1;
      continue;
    }
    throw new Error(`未知选项 ${token}`);
  }
  return { project: path.resolve(project), databaseUrl: databaseUrl.trim(), ...flags };
}

function readJsonLines(file, warnings) {
  const entries = [];
  if (!fs.existsSync(file)) return entries;
  const text = fs.readFileSync(file, "utf-8");
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && typeof parsed.id === "string") {
        entries.push(parsed);
      } else {
        warnings.push(`usage.jsonl 第 ${index + 1} 行缺少 id，已跳过`);
      }
    } catch {
      warnings.push(`usage.jsonl 第 ${index + 1} 行不是合法 JSON，已跳过`);
    }
  }
  return entries;
}

export function readLedger(projectDir) {
  const ledgerDir = path.join(projectDir, ".artemis", "ledger");
  const warnings = [];
  const usage = readJsonLines(path.join(ledgerDir, "usage.jsonl"), warnings);
  let regressionTasks = [];
  const stateFile = path.join(ledgerDir, "state.json");
  if (fs.existsSync(stateFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8")).state ?? {};
      regressionTasks = Array.isArray(state.regressionTasks) ? state.regressionTasks : [];
    } catch {
      warnings.push("state.json 无法解析，跳过 regression_tasks");
    }
  } else {
    warnings.push("state.json 不存在，跳过 regression_tasks");
  }
  const legacyProjectIds = [
    ...new Set(
      [...usage, ...regressionTasks]
        .map((entry) => entry.projectId)
        .filter((value) => typeof value === "string" && value !== "")
    )
  ];
  return { usage, regressionTasks, legacyProjectIds, warnings, ledgerDir };
}

function dedupeById(entries, label, warnings) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      warnings.push(`${label} 存在重复 id ${entry.id}，仅保留一条`);
      continue;
    }
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

function chunk(values, size = 500) {
  const out = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

async function existingIds(query, table, ids) {
  const found = new Set();
  for (const part of chunk(ids)) {
    if (part.length === 0) continue;
    const result = await query(`SELECT id FROM ${table} WHERE id = ANY($1::text[])`, [part]);
    for (const row of result.rows ?? []) found.add(String(row.id));
  }
  return found;
}

export async function migrateLedgerToPg({ projectDir, query, dryRun = true }) {
  const ledger = readLedger(projectDir);
  const warnings = [...ledger.warnings];
  const usage = dedupeById(ledger.usage, "usage_events", warnings);
  const regressionTasks = dedupeById(ledger.regressionTasks, "regression_tasks", warnings);

  const projects = await query("SELECT id, name, root_path FROM projects ORDER BY last_seen_at DESC NULLS LAST", []);
  const normalized = path.resolve(projectDir).replace(/\/+$/, "");
  const project = (projects.rows ?? []).find(
    (row) => path.resolve(String(row.root_path ?? "")).replace(/\/+$/, "") === normalized
  );
  if (!project) {
    throw new Error(
      `PG 中没有 root_path=${normalized} 的项目：先让服务以 MOBILE_TESTING_DATABASE_URL 启动一次，或运行 suite backfill`
    );
  }

  const usageExisting = await existingIds(
    query,
    "usage_events",
    usage.map((entry) => entry.id)
  );
  const tasksExisting = await existingIds(
    query,
    "regression_tasks",
    regressionTasks.map((entry) => entry.id)
  );

  const usageToInsert = usage.filter((entry) => !usageExisting.has(entry.id));
  const tasksToInsert = regressionTasks.filter((entry) => !tasksExisting.has(entry.id));

  let usageInserted = 0;
  let tasksInserted = 0;
  if (!dryRun) {
    for (const entry of usageToInsert) {
      const result = await query(
        `INSERT INTO usage_events
           (id, project_id, at, tool, family, ok, duration_ms, error_class, error_summary, signals, arg_keys, trace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [
          entry.id,
          project.id,
          entry.at,
          entry.tool,
          entry.family,
          entry.ok === true,
          Number(entry.durationMs ?? 0),
          entry.errorClass ?? null,
          entry.errorSummary ?? null,
          JSON.stringify(entry.signals ?? []),
          JSON.stringify(entry.argKeys ?? []),
          entry.traceId ?? null
        ]
      );
      if ((result.rows ?? []).length > 0) usageInserted += 1;
    }
    for (const entry of tasksToInsert) {
      const result = await query(
        `INSERT INTO regression_tasks
           (id, project_id, created_at, created_by, refs, platforms, baseline, status, claimed_by, claimed_at, run_ids, attempts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [
          entry.id,
          project.id,
          entry.createdAt,
          entry.createdBy ?? null,
          JSON.stringify(entry.refs ?? []),
          JSON.stringify(entry.platforms ?? []),
          entry.baseline ?? "latest",
          entry.status ?? "pending",
          entry.claimedBy ?? null,
          entry.claimedAt ?? null,
          JSON.stringify(entry.runIds ?? []),
          Number(entry.attempts ?? 0)
        ]
      );
      if ((result.rows ?? []).length > 0) tasksInserted += 1;
    }
  }

  return {
    project: { id: project.id, name: project.name, rootPath: project.root_path },
    legacyProjectIds: ledger.legacyProjectIds,
    usage: {
      total: usage.length,
      existing: usage.length - usageToInsert.length,
      wouldInsert: usageToInsert.length,
      inserted: usageInserted
    },
    regressionTasks: {
      total: regressionTasks.length,
      existing: regressionTasks.length - tasksToInsert.length,
      wouldInsert: tasksToInsert.length,
      inserted: tasksInserted
    },
    dryRun,
    warnings
  };
}

function printReport(report) {
  const mode = report.dryRun ? "dry-run（未写库）" : "已写库";
  console.log(`项目: ${report.project.name} (${report.project.id})`);
  console.log(`路径: ${report.project.rootPath}`);
  console.log(`旧 projectId: ${report.legacyProjectIds.join(", ") || "—"}`);
  console.log(`usage_events: 共 ${report.usage.total} · 已存在 ${report.usage.existing} · 将插入 ${report.usage.wouldInsert} · 已插入 ${report.usage.inserted}`);
  console.log(`regression_tasks: 共 ${report.regressionTasks.total} · 已存在 ${report.regressionTasks.existing} · 将插入 ${report.regressionTasks.wouldInsert} · 已插入 ${report.regressionTasks.inserted}`);
  for (const warning of report.warnings) console.log(`警告: ${warning}`);
  console.log(`模式: ${mode}`);
}

async function main() {
  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[ledger-to-pg] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(EXIT.usage);
  }
  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }
  if (flags.databaseUrl === "") {
    console.error("[ledger-to-pg] 未配置 MOBILE_TESTING_DATABASE_URL（或用 --database-url 指定）");
    process.exit(EXIT.usage);
  }
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: flags.databaseUrl });
  try {
    const report = await migrateLedgerToPg({
      projectDir: flags.project,
      dryRun: flags.dryRun,
      query: (sql, params) => pool.query(sql, params)
    });
    if (flags.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else printReport(report);
  } catch (error) {
    console.error(`[ledger-to-pg] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = EXIT.failed;
  } finally {
    await pool.end();
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry !== "" && import.meta.url === entry) {
  await main();
}
