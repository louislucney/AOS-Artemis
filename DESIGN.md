# AOS × ARTEMIS 合并 MCP 服务 — 设计文档

- **版本**: v0.3（容器化多租户 + PostgreSQL 版）
- **日期**: 2026-09-28
- **状态**: 已按新需求（容器部署 / 多项目 / PG 存储 / 全 OpenAI 兼容端点）重构，待实现
- **部署形态**: 容器化部署，挂载共享工作区（如 `/workspace`），为公司内部多个项目提供服务
- **仓库布局**: 同一根目录 —— 本服务源码（根目录 `src/`）+ 两个 **git submodule**：`artemis/`（`google/artemis`）、`design-context-bridge/`（`CristinaFores/design-context-bridge`）

> **v0.3 变更摘要**（相对 v0.2）：
>
> 1. **项目为一等实体**：每个项目在 PostgreSQL 中有注册记录（路径/名称/时间戳）、多条 LLM 条目（name/base_url/model/key，含明文，按需求）+ active 指针、任务/调用统计。
> 2. **.env 首扫导入**：项目首次启用服务时扫描其 `.env`（新名 `AOS_LLM_*` 优先，兼容 `DEEPSEEK_API_KEY`/`OPENAI_API_KEY`/`OPENAI_BASE_URL` 等旧名）→ 导入 PG；缺失则返回 `setup_required` + `aos_configure` 工具引导补全。
> 3. **Figma 可选**：token 存在则读取（含 `FIGMA_ACCESS_TOKEN`），不存在忽略；仅在实际调用 Figma REST 能力时提醒提供。
> 4. **全 OpenAI 兼容**：所有 LLM 均按 OpenAI 请求方式（参考 DeepSeek）；artemis 侧统一 `custom` provider（`OPENAI_BASE_URL` + `OPENAI_API_KEY` + model）。
> 5. **H2 规则演化为自动重指**：非 Google 条目自动生成 `nodeOverrides`（object_detector/hopper → 当前 provider）并携带精度警告；不再硬性阻断（新部署模型下无 Google key 是常态）。
> 6. **传输层**：stdio 先行；`Transport` 抽象预留 HTTP（streamable-HTTP/SSE），项目身份由 `AOS_PROJECT_DIR`/会话标识携带。

---

## 1. 背景与目标

### 1.1 场景

公司内部多个项目的开发与测试一体化。服务以**容器**形式部署（挂载包含各项目的共享工作区），任意 CLI（opencode / Claude Code / Cursor / …）接入后：

1. **项目自带凭证**：每个项目在自己的 `.env` 中声明 LLM（OpenAI 兼容三元组：model / base_url / key）与可选的 Figma token。Key 的支付方即项目方；
2. **服务识别项目并导入**：项目首次启用时扫描其 `.env`，把 LLM 关联与 key 导入 PostgreSQL；缺失则引导补全；
3. **动态切换 LLM**：项目可挂多条 LLM 条目（不同网关/模型/计费 key），随时切换 active；
4. **Figma 设计上下文**（可选）：插件/REST 双模式；
5. **ARTEMIS 真机自动化**：用项目当前的 active LLM 驱动真机完成开发验证与测试；
6. **项目信息与任务统计**：全部记录到 PostgreSQL。

### 1.2 目标（Must）

| #  | 目标                                                    | 验收方式                                          |
| -- | ------------------------------------------------------- | ------------------------------------------------- |
| G1 | 单 MCP 入口，聚合 Figma 20 + mobile 5 + llm/配置类工具  | `ListTools` 返回 30+ 工具                       |
| G2 | 项目`.env` 首扫导入（新名优先兼容旧名）               | 集成测试：temp 项目 + 内存/PG 存储                |
| G3 | 缺失时`setup_required` + `aos_configure` 可写入补全 | 工具输出含`setup_required` / `configure` 成功 |
| G4 | 项目多条 LLM + active 切换（PG 持久化）                 | 切换后 PG`is_active` 唯一；下个任务用新模型     |
| G5 | Figma token 可选；调用 REST 时缺失则提醒                | 无 token 时 REST 工具返回引导                     |
| G6 | 项目信息/任务统计写入 PG；DB 不可用降级不阻断           | `aos_status.db` 状态 + 任务仍可运行             |
| G7 | 任意 CLI 接入（stdio）；传输层可扩展 HTTP               | 冒烟测试 + 设计评审                               |

### 1.3 非目标（v1）

- 不切换 CLI 自身的对话模型（客户端侧）；
- 不做 iOS；
- HTTP 模式为无状态 streamable-HTTP（每项目独立 runtime），会话级隔离（如按用户分区）不在 v1 范围。

### 1.4 成功标准

- 首次接入一个已有 `.env` 的项目 ≤ 1 次工具调用即完成导入并可用；
- 无 `.env` LLM 的项目收到清晰的 `setup_required`（含逐行修复指引）；
- 切换 active LLM 对下一任务 100% 生效；运行中任务不受影响；
- 密钥只出现在 `.env` 与 PostgreSQL（按需求明文），**永不**出现在工具响应的明文里（masked）。

---

## 2. 关键调研结论（可行性依据）

| 结论                                                                                                          | 证据                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| artemis 的独立任务运行器支持项目级 LLM 配置覆盖                                                               | `artemis/mcp_server/background/task_runner.py:72-110`（`ARTEMIS_CONFIG_DIR` → `llm-config.override.jsonc`，但该 loader 深合并"已展开"配置、忽略 `default/nodes` 键）、`:210-214`；`artemis/config/paths.py:149-159`（`ARTEMIS_ARTEMIS_JSONC` 环境变量优先，统一格式可正常展开） |
| 覆盖文件深合并                                                                                                | `artemis/artemis/config/llm.py:334-373`                                                                                                                                                                                                                                                      |
| **artemis `custom` provider = OpenAI 兼容**：key 读 `OPENAI_API_KEY`、端点读 `OPENAI_BASE_URL`    | `artemis/artemis/llm/router.py:369-383`（`ModelProvider.OLLAMA/VLLM/CUSTOM` 分支）                                                                                                                                                                                                         |
| 用户运行时即`provider: custom` + `deepseek-flash`（`.env`: `DEEPSEEK_API_KEY` + `OPENAI_BASE_URL`） | `/Users/louis/artemis/config/artemis.jsonc` 本地改动 + `.env` 变量名                                                                                                                                                                                                                       |
| 任务进程 detached，任务（含排队）不依赖网关进程                                                               | `artemis/mcp_server/utils/env_utils.py:52-65`、`tools/task_runner.py:445-509`                                                                                                                                                                                                              |
| 基础配置将`object_detector`/`hopper` 钉死为 Google 模型 → 非 Google 需覆盖                               | `artemis/config/artemis.jsonc:77-103`                                                                                                                                                                                                                                                        |
| Figma 插件硬编码`localhost:3055` 且 manifest 仅允许该域                                                     | `design-context-bridge/figma-plugin/code.ts:283,394,402`、`manifest.json`                                                                                                                                                                                                                  |
| PostgreSQL 访问：Node`pg`；测试可用 `pg-mem`（SQL 级模拟）                                                | —                                                                                                                                                                                                                                                                                             |

---

## 3. 总体架构

### 3.1 部署拓扑（容器 + 共享工作区 + PG）

```
┌─ 容器（公司内网）──────────────────────────────────────────────┐
│  CLI 客户端（opencode/Claude Code/Cursor…）                    │
│     │ stdio（M4: streamable-HTTP）                             │
│     ▼                                                          │
│  aos-mcp 服务（Node ≥20）                                      │
│   ├─ 项目层：定位项目（AOS_PROJECT_DIR/工作区扫描）→ 扫描 .env │
│   ├─ 存储层：PostgreSQL（projects / project_llms / task_stats）│
│   ├─ 工具：llm_list / llm_switch / aos_configure / aos_status  │
│   ├─ Figma 20 工具 + 本地桥 3055（M2；token 取 PG/.env）      │
│   └─ stdio MCP Client ──► artemis mcp_server（Python 子进程）  │
│         env：OPENAI_API_KEY/OPENAI_BASE_URL ← 项目 active LLM  │
│         └─ 任务进程（detached）→ 真机（ADB/Helper）            │
│                                                                │
│  挂载：/workspace   （含全部内部项目，供扫描 .env 与项目识别） │
│  网络：→ 内网 PostgreSQL；→ api.figma.com（REST 模式）         │
└────────────────────────────────────────────────────────────────┘
```

### 3.2 项目身份与配置来源

| 来源                               | 角色                                                    | 优先级                            |
| ---------------------------------- | ------------------------------------------------------- | --------------------------------- |
| PostgreSQL`project_llms`         | **运行时事实源**（active 指针、多条目、动态修改） | ①                                |
| 项目`.env`                       | 首次导入来源 + 无 DB 时降级运行；Figma token            | ②                                |
| `aos.config.jsonc`（可选高级层） | 多 profile/nodeOverrides/设备固定等精细控制             | ③（条目合并时高于 env、低于 PG） |

---

## 4. 项目配置与 .env 契约

### 4.1 `.env` 契约（新名优先 + 兼容旧名）

| 新变量（优先）         | 兼容旧变量                                 | 说明                                                       |
| ---------------------- | ------------------------------------------ | ---------------------------------------------------------- |
| `AOS_LLM_NAME`       | —                                         | 条目名（可选；默认取 model 名）                            |
| `AOS_LLM_MODEL`      | —                                         | 模型名（必填；如`deepseek-flash`）                       |
| `AOS_LLM_BASE_URL`   | `OPENAI_BASE_URL`                        | OpenAI 兼容端点（必填；如`https://api.deepseek.com/v1`） |
| `AOS_LLM_API_KEY`    | `DEEPSEEK_API_KEY` → `OPENAI_API_KEY` | 密钥                                                       |
| `FIGMA_ACCESS_TOKEN` | —                                         | 可选；Figma REST 用                                        |

- 全 OpenAI 请求方式（参考 DeepSeek）；provider 固定为 `custom`（artemis 侧同款）。
- `.env` 永不提交（`.gitignore`）；服务输出只给 `****末4位`。
- 首扫逻辑：`AOS_LLM_*` 任一缺失 → 按旧名补位；model/base_url/key 三者不齐 → `setup_required`。

### 4.2 `aos.config.jsonc`（可选高级层）

保留 v0.2 的 `llm.profiles`（高级用户可定义多条带 provider 的档案）与 `artemis.deviceSerial` 等；**缺失时服务照常工作**（纯 .env/PG 模式）。profiles 与 PG/env 条目合并（同名冲突：PG > config > env）。

### 4.3 项目发现顺序

1. `AOS_PROJECT_DIR`（推荐；容器内由客户端 MCP 配置注入）→ 项目根；
2. `AOS_CONFIG`（显式配置文件路径，兼容旧用法）；
3. 从 `cwd` 向上查找 `aos.config.jsonc`；找不到则以 `cwd` 为项目根。

项目根确定后：`<root>/.env`（必需）、`<root>/aos.config.jsonc`（可选）。

### 4.4 首次启用流程（导入状态机）

```
启动 → 定位项目根 → 扫描 .env
  ├─ 有完整 LLM 三元组：
  │    ├─ PG 无任何条目 → 导入一条（name 默认取 model）并置 active；记 Figma token（若有）
  │    └─ PG 已有条目   → 不导入（PG 为准）；仅补记缺失的 Figma token
  ├─ 无/不完整 LLM：
  │    └─ setup_required（工具返回逐行指引；aos_configure 可一键补全）
  └─ DB 不可用：降级为「env 只读条目 + 会话内存」；切换仅影响当前会话（警告）
```

### 4.5 PostgreSQL 数据模型（v1）

连接：`AOS_DATABASE_URL`（MCP 客户端配置 env 注入，进程级，跨项目共享）。本地开发可用 compose 的 `local-db` profile（专用 PG 于 `127.0.0.1:5433`，见 README）；表结构首次连接自动创建。
时间戳用 ISO TEXT（pg-mem 兼容，v1 务实选择）；ID 用 `crypto.randomUUID()`。

```sql
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  root_path     TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  figma_token   TEXT,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_llms (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  provider    TEXT NOT NULL DEFAULT 'custom',
  base_url    TEXT,
  model       TEXT NOT NULL,
  api_key     TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (project_id, name)
);
-- active 唯一性在应用层保证（事务内先清后置），避免部分索引的兼容性问题

CREATE TABLE IF NOT EXISTS task_stats (
  id           TEXT PRIMARY KEY,
  project_id   TEXT REFERENCES projects(id) ON DELETE SET NULL,
  trace_id     TEXT NOT NULL,
  model        TEXT,
  profile      TEXT,
  status       TEXT NOT NULL,
  task_desc    TEXT,
  submitted_at TEXT NOT NULL,
  finished_at  TEXT
);

CREATE TABLE IF NOT EXISTS llm_model_cache (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cache_key  TEXT NOT NULL,          -- sha256(base_url + api_key) 前 24 位
  base_url   TEXT NOT NULL,
  models     TEXT NOT NULL DEFAULT '[]',   -- JSON 数组（OpenAI /models 的 data[].id）
  fetched_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, cache_key)
);
```

降级策略：`AOS_DATABASE_URL` 缺失或连接失败 → `MemoryStore`（会话内有效）+ `aos_status` 警告，**不阻断**任务执行。

---

## 5. 运行时装配（项目 active LLM → artemis）

### 5.1 子进程环境（统一 OpenAI 兼容）

```
<artemis.repo>/.venv/bin/python -m mcp_server     # cwd = <artemis.repo>
env:
  ARTEMIS_STANDALONE=1
  ARTEMIS_CONFIG_DIR=<project>/.artemis            # 生成物目录
  ARTEMIS_ARTEMIS_JSONC=<project>/.artemis/artemis.jsonc   # 项目级统一配置（见 §5.2）
  OPENAI_API_KEY=<active 条目的 key>
  OPENAI_BASE_URL=<active 条目的 base_url>
  PYTHONUNBUFFERED/PYTHONUTF8=1；PYTHONPATH=<artemis.repo>
  ADB_DEVICE_SERIAL（若配置）
  （主动删除 ARTEMIS_DAEMON_PORT）
```

`env 指纹` = hash(provider + key + base_url + configDir + deviceSerial)；**模型/label 变化不触发重启**。

### 5.2 生成的 `<project>/.artemis/artemis.jsonc`（项目级统一配置）

以 artemis 基础配置（`<repo>/config/artemis.jsonc`）为底，仅替换/合并 LLM 部分后写出；通过 `ARTEMIS_ARTEMIS_JSONC` 注入（`get_config_path` 环境变量优先）。保留底层文件里的 `agent`/`memory`/`video` 等全部非 LLM 段落。

```jsonc
{
  // …基础配置的 agent/memory/… 段落原样保留…
  "default": {
    "provider": "custom",
    "model": "deepseek-flash",
    "thinking_level": "medium",     // 基础 default 的其余字段保留
    "fallback": { "provider": "custom", "model": "deepseek-flash" }
  },
  "nodes": {
    // 基础 nodes 原样保留；非 Google 条目自动重指（v0.3 H2 演化；附精度警告）
    "object_detector": { "provider": "custom", "model": "deepseek-flash" },
    "hopper":          { "provider": "custom", "model": "deepseek-flash" }
  }
}
```

若条目显式提供 `nodeOverrides`（config 高级层 / aos_configure 扩展）→ 以显式值为准。**不使用** `llm-config.override.jsonc`：该 loader 把 override 深合并到"已展开"的 LLMConfig 上，`default/nodes` 键会被静默忽略（实测任务会回退到 Google 默认并因缺 key 失败）；激活时若发现历史遗留的该文件会被清理。

**非 Google 条目的额外调整**：`agent.flash.step_summarizer.enabled=false`——该后台压缩器硬绑定 Google 轻量模型（`get_google_llm`）且在 `FlashRunner.__init__` 即初始化，不关会导致 Flash 任务启动即失败；记忆 chunk 胶囊（`memory.chunking.model`）与 Pro 轻量裁判（pixel safety net / planner validation）同样是硬 Google 依赖，前者懒触发、后者按需构造，自定义 provider 下会降级或失败（需 Google key 才能完全启用）。`llm_switch` 会就此返回警告。

---

## 6. MCP 工具面

### 6.1 新增/变更（zod）

| 工具                          | 输入                                                                                 | 输出要点                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm_list`                  | `{}`                                                                               | 条目列表（name/source/model/baseUrl/key masked/isActive）+`setupRequired` + 警告                                                                                                                                                                                                                                                                                     |
| `llm_switch`                | `{name, force?}`                                                                   | 激活条目（PG/内存）；模型下个任务生效；key/base_url 变化触发网关重启（H1 守卫：运行中任务存在时默认拒绝，`force:true` 跳过）                                                                                                                                                                                                                                         |
| `llm_models`                | `{action: list\|refresh, entry?}`                                                 | 厂商模型目录：`list` 读缓存（含 `deprecated/suggestedModel`），`refresh` 立即 `GET {baseUrl}/models` 并按需自动修复（见 §6.6）；返回 8 家国产厂商预设                                                                                                                                                                                                        |
| `aos_configure`             | `{apiKey, model?, baseUrl?, vendor?, name?, makeActive?, writeEnv?, figmaToken?}` | 新增/更新条目（PG 或内存）+ 回写项目`.env`（`AOS_LLM_*`）+ 可选置 active；`vendor` 预设（deepseek/qwen/zhipu/moonshot/siliconflow/stepfun/ark/hunyuan）可自动填 baseUrl 并按稳定别名选型；显式三元组不触网；返回 masked 摘要 |
| `aos_status`                | `{}`                                                                               | 项目、DB 状态、条目数、active、子进程、Figma 桥/就绪性、setup 状态                                                                                                                                                                                                                                                                                                     |
| `aos_tasks`                 | `{limit?, sync?}`                                                                  | 任务/调用统计（trace/状态/模型/时间）；默认先向 artemis 同步完成态                                                                                                                                                                                                                                                                                                     |
| `aos_crashes`               | `{action, signature?, traceId?, package?, kind?, since?, limit?}`                  | 崩溃取证：`list` 列出签名（kind/package/since/limit 过滤 + 采集开关）；`get` 返回完整栈/日志摘录；`scan` 手动扫描（指定 traceId 强制重扫）                                                                                                                                                                                                                       |
| `compare_design_and_device` | `{figmaUrl, nodeId?, deviceSerial?}`                                               | 组合工具：Figma 节点渲染图（PNG@2x）+ 真机截图，一并以 image content 返回供多模态比对                                                                                                                                                                                                                                                                                  |
| `figma_extract_flows`       | `{url, nodeId?, save?}`                                                            | 原型交互 → 流程图（screens/edges/entryScreens/unresolved），落盘`.artemis/design/flows.json`；供后续"流程→测试生成"消费（M-B）                                                                                                                                                                                                                                     |
| `figma_gap_analysis`        | `{url, id?, assetGlobs?, tokenFiles?, save?}`                                      | 设计资源/色板 vs 项目资产/tokens 缺口（missingAssets/missingColors），**扫描规则按检测到的技术栈选择**（`src/projects/stack.ts`：Flutter/RN/原生 Android/iOS/Web 档案，含资产目录/定位/代码/命名约定），缺失资源按栈重命名（如 Android `ic_home.svg`、Flutter `home_icon.svg`）并给出目标目录；落盘 `.artemis/design/gaps.json`；供"资源导入"消费（M-C） |
| `figma_generate_tests`      | `{url?, flowsPath?, maxFlows?, save?}`                                             | 连续交互线性化为端到端流程（entry→…→终态/BACK），生成 artemis 可直接执行的任务描述；落盘`tests.json` + `tests.md`（M-B，基本目标）                                                                                                                                                                                                                              |
| `figma_import_assets`       | `{url?, gapPath?, destDir?, ids?, format?, overwrite?, dryRun?, save?}`            | 按 gaps.json 导出缺失资源（SVG 内联/PNG 下载）→ 按栈命名与首选目录写入；**唯一性三层**：命名规范化 → 目标路径幂等（同内容 `unchanged`；异内容 `skipped_exists`/`overwrite`）→ **内容 sha256 去重**（批次内 + 项目资产索引，跨文件同名/异名重复记 `duplicate_of`）；`dryRun` 按同样规则预览；落盘 `import-report.json`（M-C）                |
| `figma_export_brief`        | `{url, save?, includeFlows?, includeGaps?, scaffold?, maxComponents?, overwrite?}` | 构建简报：tokens（颜色/字阶/间距/圆角/阴影）+ 页面路由 + 组件与变体 + 流程概览 + 缺口摘要 + 栈编码约定 →`build-brief.{json,md}`；`scaffold` 按栈生成组件骨架（幂等）（M-D）                                                                                                                                                                                       |
| `pen_inspect`               | `{path?, save?}`                                                                   | pen.dev 离线检查：解析 `.pen`（开放 JSON，容忍 `//` 注释）→ 结构校验（id 唯一/无 `/`、ref 可解析、`$变量` 可解析）+ 摘要（屏幕/组件/实例/文案/变量与主题/图片资产与缺失）；path 缺省取 `.artemis/design` 下最新 `*.pen`；`save:true` 落盘 `.artemis/design/pen/summary.json`；无账号与网络需求（P1）                                                                              |
| `pen_import_tokens`         | `{path?, dryRun?, overwrite?, save?, enforcement?}`                                | pen 颜色变量 → canonical `tokens.json`（DTCG；**变量名即 token 名**，主题取值写入 `modes`（`axis=value`），`$别名` → `aliasOf`）+ 按栈 token 文件（复用 `writeStackTokenFile` 幂等写入）；输出 new/updated/unchanged/unused、裸色扫描与 enforcement（语义同 `figma_import_tokens`）；完全离线（P1）                                                                                                                                                                 |
| `pen_import_strings`        | `{path?, locale?, dryRun?, save?, enforcement?}`                                   | `.pen` 文本节点 → `strings.json` + 按栈资源写入（复用 `runStringsImport` 全流水线：冻结 key/冲突闭环/硬编码扫描/五栈写入）；`reusable` 组件自成屏幕上下文，`ref` 不展开；完全离线（P1）                                                                                                                                                                                                                                |
| `pen_export_brief`          | `{path?, save?, includeGaps?, scaffold?, maxComponents?, overwrite?}`              | `.pen` → `build-brief.{json,md}`（颜色/字阶/间距/圆角/阴影、屏幕与建议路由、可复用组件、按栈约定、可选 gaps 摘要）；复用 Figma 版 markdown 渲染与 `scaffoldComponentSkeleton`；完全离线（P1）                                                                                                                                                                                                                        |

`setup_required` 语义：无任何可用条目时，`llm_list` 正常返回并带 `setupRequired: true` + 指引；`mobile_run_task` 直接返回结构化 `setup_required` 错误（不调用子进程）；其余 mobile 工具放行。

### 6.2 Figma 20 工具（M2，vendor + zod）

沿用 dcb 工具名；token 解析顺序：PG 项目记录 → `.env`；REST 工具在 token 缺失时返回"请提供 `FIGMA_ACCESS_TOKEN`（或通过 `aos_configure` 写入）"的引导；插件模式不受影响。

**REST 限流加固**（2026-09-29 补丁，NOTICE 第 5 条）：`figma-rest/client.ts` 对 429 做有界处理——`Retry-After ≤ AOS_FIGMA_RETRY_MAX_WAIT_MS`（默认 60s）时等待一次并重试；超限则抛 `FigmaRateLimitError`（携带 `tier`/`retry-after`）并写入**按 token 指纹的冷却记忆**（冷却期内直接快速失败、不发请求）；响应缓存 TTL 提升为 10min 且可配（`AOS_FIGMA_CACHE_TTL_MS`，0 关闭），一次流水线运行对同一文件只拉取一次。背景：企业版文件 + 访客席位返回 `x-figma-rate-limit-type: low`，大文件少数请求即可触发多日冷却（实测 `retry-after≈4.4 天`），原实现会按 Retry-After 无限期 sleep 挂起调用。

### 6.3 mobile 5 工具（代理，schema 透传）

同 v0.2（原样透传，不做 zod 镜像，契约测试锁定）。

### 6.4 任务统计

本服务的 `CallTool` 拦截 `mobile_run_task`：成功后从结果中提取 `trace_id`，向 `task_stats` 记录（项目、trace、model、profile、desc、submitted）。**完成态同步**：后台定时（30s）与 `aos_tasks` 调用时，通过 `mobile_manage_task(status)` 轮询 pending 行，终态（completed/failed/cancelled/orphaned）写回 `finished_at`；网关子进程不在线时跳过本轮，不打断任务。

### 6.5 崩溃取证（Crash Triage）

任务终态后自动对任务时间窗做一次设备崩溃扫描，把"能引发 crash 的问题"登记为可去重、可定位的签名。实现位于 `src/crash/`（AOS 层），不改动 artemis 子模块。

**触发**：`syncTaskStatuses` 写回终态时入队（stdio/HTTP 的 30s 定时器与 `aos_tasks` 调用均会触发）；`aos_crashes(action="scan")` 手动兜底（指定 `traceId` 时强制重扫）。扫描经 Runtime 内串行队列执行（同一 Runtime 内不会并发 adb），失败只记日志不打断同步；`AOS_CRASH_CAPTURE=0` 关闭。

**采集**（`src/crash/collect.ts`）：`adb -s <serial> logcat -b crash -v threadtime -d`（crash buffer 独立于 main buffer，抗滚动）→ 空/失败时回退 `logcat -v threadtime -d -T "<窗口起点>"`（main buffer 时间窗）；采集前后用 `adb shell date +%s` 探测设备时钟偏差并补偿（探测失败按零偏差 + 告警）。serial 取 status.json，缺失时单设备兜底；跳过原因分类：`disabled / already-scanned / no-window / no-serial / device-offline / adb-not-found / command-failed`。

**解析与签名**（`src/crash/parse.ts`）：识别 `FATAL EXCEPTION`（Java/Kotlin）、`Fatal signal` + DEBUG 块 `>>> pkg <<<`（native）、`ANR in <pkg>`；**归属强约束**——只收录能解析出包名的崩溃，并按任务 `locked_app_package`（本次会话内从 `mobile_run_task` 参数记录，过滤其他 app/系统噪声）过滤；窗口 = status.json `start_time/end_time`（epoch 秒）±5s，日志时间按参考时刻推断年份（跨年回滚）。签名 = `sha256(包名|kind|根因异常类|首个应用帧)` 前 16 位；根因取 Caused by 链尾异常类，帧取根因段首个属于该包的帧（回退字面栈顶）；`signatureBasis` 记录构成。签名永远基于原始栈，mapping/retrace 只做展示增强。

**存储**：`<项目>/.artemis/crashes/index.json`（签名索引）+ `<id>.json`（完整栈/日志摘录；frames≤60、摘录≤200 行且≤16KB）+ `scanned.json`（已扫描 trace，保留 200）。同签名累加 `occurrences`/`outcomeCounts`（区分任务 failed 与 completed 时出现的崩溃），`traceIds` 保留最近 20；超过 `AOS_CRASH_MAX_RECORDS`（默认 200）按最近出现淘汰（被淘汰签名再现会重置计数，属已知语义）。写入原子（tmp+rename），`index.json`/`scanned.json` 损坏自动隔离为 `.corrupt` 并重建。

**环境变量**：`AOS_CRASH_CAPTURE=0` 关闭；`AOS_ADB_PATH` 显式 adb；`AOS_CRASH_TIMEOUT_MS`（默认 15000，1s–120s）；`AOS_CRASH_MAX_RECORDS`（默认 200）。

**已知边界（v1）**：仅本地/同机 adb（不读 artemis 的 `ADB_HOST/ADB_PORT` 远程配置）；设备在任务结束后即销毁的场景无法事后采集（云真机，根治=任务中采集，待 M4/上游）；release 混淆构建的签名基于混淆栈（mapping.txt/retrace 为后续增强）；跨进程同时写同一项目 `.artemis/crashes` 未加锁（同一 Runtime 内已串行化）。

### 6.6 厂商模型目录与自动修复（M7）

**动机**：厂商会下线旧模型（DeepSeek 文档：`deepseek-flash` 是稳定别名；旧名 `deepseek-v4-flash` 已下线，请求仍会被路由到新模型）。写死的 model 名一旦失效，任务会在 artemis 内部失败——整个项目"卡住"。

**机制**（`src/llm/providers.ts` 预设 + `src/llm/catalog.ts` 目录）：

- **预设目录**：8 家国产厂商（DeepSeek / 阿里百炼 / 智谱 / Kimi / 硅基流动 / 阶跃 / 火山方舟 / 腾讯混元）的 OpenAI 兼容端点、文档链接与稳定别名，供 `aos_configure(vendor=…)` 一键配置。
- **定时刷新**：对已配置条目 `GET {base_url}/models`（Bearer key，10s 超时，解析 `data[].id`）；缓存到 PG `llm_model_cache`（行键 = `sha256(base_url + api_key)` 前 24 位）。stdio/HTTP 的 30s 后台循环按 TTL 检查（`AOS_MODEL_REFRESH_HOURS`，默认 12h，0 关闭定时；读项目 `.env`，进程 env 优先），`llm_models(action="refresh")` 强制刷新。请求失败保留旧列表并记 `last_error`，不影响任务。
- **报告**：`llm_list` / `aos_status` 每条目附 `models.{known,fetchedAt,stale,count,activeModelAvailable,deprecated,suggestedModel}`。`stale` 缓存不做"下线"判断（避免误报）。
- **自动修复**（`AOS_LLM_AUTO_REPAIR=0` 关闭，默认开）：新鲜缓存中 active 模型缺失时，① 优先厂商稳定别名（旧名含 capability 标记 reasoner/pro/max/ultra/vision/vl/coder/code 时跳过，避免降级语义）；② 否则同 token 核等价（忽略版本/日期段，最短名优先）；无法确信 → 只报告不修改。修复写回顺序：store（PG/内存）→（模型源自项目 `.env` 时）项目 `.env` →（active 条目）`.artemis/artemis.jsonc` + activeCache。模型变化不在 env 指纹内，不触发子进程重启。
- **任务拦截**：`mobile_run_task` 前置 `ensureActiveModelUsable()`——新鲜缓存判定模型已下线且无法自动修复时，返回结构化 `model_deprecated` 错误（含 `availableModels` 与 `suggestedModel`），不再等 artemis 跑到一半才报 `model_not_found`。
- **已知边界**：仅支持 OpenAI 风格 `GET /models` 的厂商（google/anthropic 条目跳过）；预设别名是静态提示，刷新列表才是事实源（别名不在列表中时不采用）；缓存按"项目 + key 指纹"存储，换 key 产生新行（旧行不清理）；Node `fetch` 默认不读代理变量，公司内网需 `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`（Node ≥24；`install` 会把代理变量带入客户端 env）。

### 6.7 产物落盘路径（项目内）

**决策**：接入项目的一切运行产物默认落在项目自己的 `.artemis/` 下，artemis 仓库不再承载新产物；显式环境变量可覆盖。

- **任务轨迹**：给 artemis 子进程设 `ARTEMIS_TRACES_DIR=<项目>/.artemis/traces`（`src/artemis/assembly.ts` 的 `projectTracesDir()`）。步骤截图（`traces/images/`、`<trace_id>/step_N_overlay.jpg`）、Pro `notes/`（`task_plan.md` / `output.md`）、`stdout.log` / `stderr.log`、`status.json`、`run_outcome.json` 与历史库 `data_engine.db` 全部随之下沉；`mobile_inspect_trace` / `mobile_manage_task` 免改动即读到项目内文件。
- **覆盖语义**：显式 `ARTEMIS_TRACES_DIR`（客户端/进程 env，`install` 会透传）优先；相对路径按项目根解析，子进程与 AOS 侧（崩溃取证扫描、任务完成态文件同步）共用同一绝对路径。`tracesDir` 纳入子进程 env 指纹——改动会在下次调用时重启网关子进程。
- **live_screenshot**：上游 `mobile_get_device_state` 把文件写在 artemis 仓库根（返回 `file://<repo>/live_screenshot_<device>.jpg`），AOS 在代理转发后自动复制一份到 `<项目>/.artemis/traces/live_screenshots/`（`src/artemis/artifacts.ts`；工具响应与 schema 原样透传，复制失败只记日志）。`compare_design_and_device` 复用同一文件，同样被镜像。
- **测试文档**：`figma_generate_tests` 等设计流水线产物仍在 `<项目>/.artemis/design/`（见 §13），本次不变。
- **注意**：`ARTEMIS_*` 变量属于客户端/进程 env（项目 `.env` 不注入子进程），覆盖要写在 MCP 客户端配置的 env 或 shell 环境。

---

## 7. 切换机制（PG 中心）

```
llm_switch(name, force):
  0) 串行化互斥
  1) 定位条目（PG > config > env）；未知 → 返回可用列表
  2) 校验可用性（key/base_url 完整）
  3) 若条目来自 config/env 且 DB 可用 → 先 upsert 到 PG（动态化）
  4) 计算 env 指纹差异；needsRestart = 子进程运行中 && 指纹变化
  5) needsRestart 且非 force → mobile_diagnose 查 tasks；非空 → 拒绝（提示等待或 force）
  6) PG 事务：清 active → 置 active；写 .artemis/artemis.jsonc（并清理遗留 override 文件）
  7) needsRestart → 优雅停子进程（下次调用惰性重启）
  8) 返回 { active, previous, effects, warnings }
```

- 生效时机：模型变更对**下一个**任务生效；运行中任务（detached）不受影响。
- 无 DB 降级：active 指针写 `.artemis/state.json`（会话/本地兜底）。

---

## 8. 部署与 CLI 接入

### 8.1 容器

- 镜像（`Dockerfile`，多阶段）：Node 22 + Python 3.12（artemis venv）+ Android 工具链（adb/ffmpeg；scrcpy 在 Debian 13 已移除 → 尽力而为安装，缺失时仅录像降级）；
- 挂载：共享工作区（`/workspace`）、Figma 桥端口（`127.0.0.1:3055:3055`）、Android 设备（USB 透传或网络 ADB，`ADB_HOST/ADB_PORT`）；
- 环境：`AOS_DATABASE_URL`（PG）、`AOS_WORKSPACE_ROOT`（可选）；
- 客户端以 `docker exec -i -w /workspace/<project> <container> node /app/dist/index.js` 接入（`aos-mcp install --mode docker` 自动生成）。

### 8.2 客户端配置（stdio）

```jsonc
{
  "command": "docker",                      // 或容器内直接 node
  "args": ["exec", "aos-mcp", "node", "/app/dist/index.js"],
  "env": {
    "AOS_PROJECT_DIR": "/workspace/<project>",
    "AOS_DATABASE_URL": "postgres://..."
  }
}
```

### 8.3 传输层

- **stdio**（`aos-mcp serve`）：每项目一个进程，`AOS_PROJECT_DIR`/cwd 定位项目；
- **streamable-HTTP**（`aos-mcp serve --http --port 8765 --workspace /workspace`，无状态模式）：端点 `POST /mcp/<project>`，每项目独立 Runtime（store 关联、artemis 子进程、LLM 条目）；`GET /healthz` 返回 workspace 与已注册项目；非 POST 返回 405（无状态模式不使用 SSE 会话）。项目名做白名单校验（`[A-Za-z0-9._-]`，拒绝 `..`）。
- 工具与运行时层不感知传输，两个入口共用 `createServerForRuntime()`。

### 8.4 `doctor` 更新

检查：Node、项目定位、.env LLM 三元组（含旧名回退）、PG 连接（`SELECT 1`）、artemis venv 与**依赖版本标记**（`artemis/.venv/.aos-deps.json` 对比 `uv.lock` 哈希：ready/stale/unmanaged/missing）、ADB 设备、Figma token。输出 `ready|degraded|blocked` + `Run:`/`Guidance:` 指引。

### 8.5 artemis 依赖包（首次安装与依赖更新）

- **构建**：`node dist/cli.js deps build`（跨平台：Windows/macOS/Linux；macOS/Linux 亦可用 `scripts/artemis-deps.sh`）→ `dist-deps/artemis-deps-<os>-<arch>.tar.gz`（uv 专用缓存 + manifest：平台/Python/uv/lock 哈希/commit）。
- **首次运行**：serve 或 `doctor --install-deps` 检测 venv 缺失 → 从 `AOS_ARTEMIS_DEPS_URL`（或 config `artemis.depsUrl`）下载 → sha256 校验 → 解压 → `uv sync --frozen --no-install-project --offline`（实测 190 包 <1s，总耗时以解压为主）。
- **依赖更新**：stamp 的 lock 哈希 ≠ 当前 `uv.lock` → 自动更新：新依赖包命中则离线更新；旧包/缺失则回退在线 `uv sync` 并提示重建（`AOS_DEPS_NO_ONLINE=1` 禁止回退）。仅代码更新无需任何操作（venv 只装依赖）。
- **无托管 venv**（无 stamp）：离线探测通过则"收养"并写入 stamp；失败进入更新流程。

---

## 9. 安全设计

| 项              | 措施                                                                                                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 密钥存储        | 项目`.env`（gitignore）+ PostgreSQL（**按需求明文**）；工具响应仅 masked；日志不落 key                                                                                                                         |
| PG 明文风险缓解 | 连接走内网 + TLS；独立 DB/role 最小权限；审计（last_seen/updated_at）；文档明示风险与轮换流程                                                                                                                          |
| 多租户隔离      | 一切记录以项目`root_path` 为键；工具只读写当前项目条目；跨项目访问无路径可寻                                                                                                                                         |
| dcb 桥（M2）    | 端口锁 3055；CORS 收紧；store 前缀命名空间化                                                                                                                                                                           |
| 子进程          | 只杀 mcp_server 直接子进程；detached 任务进程不动；启动孤儿清理                                                                                                                                                        |
| 降级            | DB 不可用不阻断；但`aos_status` 明确警告"条目仅会话内有效"                                                                                                                                                           |
| 日志与审计      | `<project>/.artemis/logs/aos-mcp.log`（时间戳/级别/每次工具调用 name+ok+ms+错误摘要；`uncaughtException` 堆栈落盘）+ `artemis-child.log`（子进程 stderr 持久化）；`AOS_LOG_LEVEL/DIR/DISABLE_FILE/MAX_MB` 可配 |
| 崩溃取证产物    | 仅落盘本地`<项目>/.artemis/crashes`（gitignore）；工具返回栈/摘录有上限；崩溃日志可能含敏感文本（URL token 等），属已知限制                                                                                          |

---

## 10. 测试策略

| 层          | 内容                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单元        | .env 扫描（新名/旧名/缺项）、entry 合并与 active 决议、configure 写入 .env 的幂等、masked 输出                                                                                                                |
| 存储        | `MemoryStore` 语义测试 + `pg-mem` 跑真实 SQL（schema/upsert/active 唯一/任务记录）                                                                                                                        |
| 集成        | 假 artemis 子进程：透传/重启/stderr；`setup_required` → `aos_configure` → 切换 → 重启全链路                                                                                                            |
| 契约        | mobile schema 透传逐字节一致                                                                                                                                                                                  |
| 崩溃取证    | 解析 fixtures（Java/native/ANR、根因签名、年份边界、时窗与时钟偏差）、采集 fake exec（crash buffer/`-T` 回退/离线/超时分类）、文件索引（去重/淘汰/损坏隔离）、Runtime 集成（终态触发/串行/包过滤/关闭开关） |
| E2E（手动） | 容器内真实项目：首扫导入 → 切 DeepSeek → 真机任务使用新模型                                                                                                                                                 |
| E2E（手动） | `scripts/e2e-crash.mjs`：`am crash` 制造真实崩溃 → 采集→签名→写入 `.artemis/crashes` → `aos_crashes list`                                                                                         |
| CI          | lint + build + node:test（不依赖真实 PG/设备）                                                                                                                                                                |

---

## 11. 里程碑

| 阶段           | 内容                                                                                               | 状态                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| M0             | 脚手架/配置加载/init/doctor                                                                        | ✅ 已完成（v0.2 基线）                                                  |
| M1             | artemis 代理 + 透传/env 装配/重启 + llm 工具 + 退出钩子                                            | ✅ 已完成（v0.2 基线）                                                  |
| **M1.5** | **v0.3 重构：PG 存储层 + .env 首扫导入 + aos_configure + 多条目 active 切换 + 任务统计记录** | ✅ 已完成（56 测试全绿）                                                |
| M2             | Figma 20 工具内嵌（zod）+ 桥补丁 + REST token 引导                                                 | ✅ 已完成（63 测试全绿）                                                |
| M3             | 容器化打包（Dockerfile）+ 客户端安装器 + 真机 E2E                                                  | ✅ 已完成（镜像构建 + docker exec 端到端验证：29 工具含容器内 artemis） |
| M4             | HTTP 传输 + 任务状态同步 + 组合工具                                                                | ✅ 已完成（79 测试全绿；HTTP/stdio 双入口实测）                         |
| M5             | 崩溃取证（M1 范围：终态采集 → 签名 → 文件索引 →`aos_crashes`）                                | ✅ 已完成（新增 35 用例全绿）                                           |
| M6             | 设计资源唯一性与 i18n 闭环（颜色 tokens / 图片补强 / 文本 i18n）                                   | 🚧 部分实施（M6a/M6b/M6c 完成；复数/位图倍率/真机验收待后续，见 §13.9） |
| M7             | 厂商模型目录定时刷新 + 模型下线自动修复 +`mobile_run_task` 预检（8 家国产预设、`llm_models`）    | ✅ 已完成（新增 19 用例）                                               |

---

## 12. 风险与未决问题

| 风险                                    | 影响                         | 缓解                                                                                                       |
| --------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| PG 不可用                               | 动态切换/持久化失效          | 降级内存 + 告警；恢复后下次启动重新导入                                                                    |
| 明文密钥入库                            | DB 泄露面                    | 内网/TLS/最小权限/审计；文档提示轮换；后续可加列级加密                                                     |
| 旧名解析歧义（OPENAI_API_KEY 指向别处） | 导入错误 key                 | 优先级：`AOS_LLM_API_KEY` > `DEEPSEEK_API_KEY` > `OPENAI_API_KEY`；`aos_status` 显示实际采用变量名 |
| 多项目并发写 PG                         | active 竞态                  | 事务内先清后置 + 应用层互斥；后续可加行级锁                                                                |
| 容器内 ADB 设备访问                     | 任务不可用                   | 镜像含工具链；USB 透传/网络 ADB；doctor 检查                                                               |
| 设备生命周期（云真机任务结束即销毁）    | 终态后采集抓不到 crash       | v1 记入`device-offline` 跳过原因并在文档声明；根治=任务中采集（M4/上游）                                 |
| 崩溃日志含敏感文本                      | 本地泄露面                   | 仅存`.artemis/crashes`（gitignore）+ 工具返回截断；后续可加脱敏                                          |
| release 混淆栈                          | 签名可去重但难读、可能撞签名 | 签名固定基于原始栈；mapping.txt/retrace 后续增强                                                           |

**未决**：① 是否引入列级加密（当前按需求明文）；② HTTP 模式下的多用户鉴权（v1 为内网无鉴权 + 项目名约束）。

---

## 13. 设计资源唯一性与 i18n（M6 评估，未实施）

> 状态：**M6a 已实施；M6b/M6c 已实施于 Android/Flutter 范围**（其余栈按需铺开），实施记录见 §13.9。目的：为"Figma 资源提交"（颜色/图片/文本）给出可审计的唯一性保证方案；文本必须遵守 i18n 规范（不得以字面量落代码）。

### 13.1 现状评估

统一保证唯一性的四层模型：**归一化 → 语义命名 → 内容/键索引（幂等 + 冲突可见）→ 代码侧强制（禁裸值）**。归一化层必须包含 **Unicode NFC + trim**（文本）与 hex/alpha 规范（颜色），否则不可见差异会破坏去重与幂等。

| 资源 | 已有机制 | 评估结论 |
|---|---|---|
| 图片 | sha256 内容去重（批次 + 项目索引）、路径幂等、`duplicate_of`、按栈命名（`src/figma/import.ts:143`） | 机制完整（同图全域唯一）；补强命名兜底与导出规格即可 |
| 颜色 | 归一化 `#RGB→#RRGGBB` 比较 + token 文件扫描 + `missingColors`（`src/figma/flows.ts:381`） | **半闭环**：alpha 被丢弃（`src/vendor/design-context-bridge/figma-rest/analysis.ts:11` 只取 RGB），不同透明度撞同一值；无 token 命名/生成/写入；无裸色检测；渐变被静默忽略 |
| 文本 | 仅 `textHints` 定位提示（`src/figma/flows.ts:195`）与测试用例文案（`src/figma/test-gen.ts:89`） | **零机制**：无 key 体系、无字符串资源写入/复用/冲突检测、无硬编码扫描；测试定位用原文，locale 变化即失效 |

### 13.2 颜色（Design Tokens）

- **归一化**：`#RRGGBB` + alpha 独立维度（canonical 采用 CSS 顺序 `#RRGGBBAA`），去重按归一化值；`rgbaToHex` 补 alpha（vendor 补丁需带 `PATCH (aos-mcp)` 标记）。各栈 alpha 顺序转换见 §13.8。
- **语义命名**：`color.<surface|text|border|brand>.<role>[.state]`，从 Figma Variables/Styles 名 slug 化；同值多语义 → 一个基础值 + 多个语义别名；usageCount 仅作参考，不作命名依据。
- **主题 / modes 预留**：tokens.json 颜色条目带 `modes`（如 `{ default, dark }`）；M6a 只支持单 mode，但 schema 与命名从第一天预留；映射 Android `values-night`、Flutter `ThemeMode`、RN `useColorScheme`、CSS `[data-theme]`（typography/spacing 不带 modes）。
- **单一事实源**：生成 `<项目>/.artemis/design/tokens.json`，**canonical 采用 W3C DTCG 草案格式**（`$value`/`$type` + alias 引用，兼容 Style Dictionary v4；锁定版本并记录兼容边界），按栈写入 `colors.xml` / `ColorScheme` / `theme.ts` / CSS variables；写入幂等（同值 unchanged、异值 conflict、仅设计侧存在 missing、仅项目侧存在 unused warn）。
- **闭环与强制**：gap analysis 增加反向检查；源码裸 hex 扫描（排除 token 文件）→ `hardcodedColors`；近似色（ΔE 阈值）只告警、不自动合并。
- **范围显式**：纯色 only；**渐变 / 阴影 / P3 广色域 out-of-scope**，报告记 `skipped_nonSolid`（不是无声丢弃）。
- **确定性输出**：token 排序、JSON 键序、换行固定（见 §13.8），否则幂等判定失效、diff 全是噪音。

### 13.3 图片（已具备，补强）

- 已有：sha256 内容寻址（同图全域唯一）、路径幂等、`duplicate_of`、栈命名规则。
- 补强：
  - 脏图层名（`Frame 427`）回退 `asset-<sha256前12位>`，碰撞再追加序号；现有幂等写入已保证不会静默覆盖（真实代价是混淆性 `skipped_exists`），加长前缀降低概率。
  - 导出规格：**SVG 优先**；位图按栈倍率集（iOS @3x、Android xhdpi/xxhdpi），不再统一 @2x（现实现硬编码 @2x，改动点为 `figma_import_assets`）。
  - 同内容不同语义名 → 提示合并（不自动改名）。

### 13.4 文本（i18n）

原则：**Figma 原文只进字符串资源，永不落代码字面量**。唯一性拆成两个独立问题：

1. **key 全局唯一 + 冻结映射（保稳定）**：key 由语义路径派生（`<screen|component>.<element>`，复用 `toCase`），**一经分配即冻结**——`nodeId → key` 映射持久化在 `strings.json`，图层改名/移动不改 key；另支持人工 key 锁定（override）。key 不由文案哈希派生（文案与翻译会变）。
2. **迁移（只兜 node 身份变化）**：仅当 nodeId 变化（删除重建、复制粘贴）时，以"源文案近似 + 结构位置"产出 `suggested_migration` 报告，人工确认后 oldKey→newKey 搬翻译；nodeId 不可靠场景降级为文本相似匹配。
3. **内容复用**：同默认文案（NFC 归一化后）+ 同上下文 → 复用同一 key；`common.*` 公共词（确定/取消）只给归并建议（人工确认，限制滥用以免丢上下文）；`(文案, 上下文) → key` 索引用于检测"应复用未复用"。
4. **占位符规范化**：`{name}` / `%s` / `%d` 归一为 ICU，写入时按栈转换（§13.8）；复数/性别/日期等 Figma 推不出的标 `needs_context`；**混合富文本与设计稿实例值（"Welcome, John" 里的 John）同样归 `needs_context` 人工流**。
5. **source_changed 检测**：`strings.json` 存源文案指纹（`sha256(NFC(sourceText)) + placeholders 集合`）；源文案变化 → `source_changed` 驱动重译；**语义变化 → 建议新 key**，禁止改义复用旧 key。
6. **各栈资源写入**（幂等语义与图片一致：同 key 同值 unchanged、同 key 异值 conflict、异 key 同值 reuse 建议；转义/复数/locale 码见 §13.8）：Flutter `.arb`；Android `strings.xml`（复数用 `<plurals>`）；RN JSON；iOS `.strings`（复数需 `.stringsdict` 或 Xcode 15+ `.xcstrings`，待定）；Web JSON。
7. **防回归（双向）**：gap 扫描硬编码文案 → `hardcodedStrings`；Figma 删除文案 → `unusedStrings`（仅报告，可能有动态/服务端引用）；`figma_generate_tests` 定位改为"testID/资源 key 优先，原文仅默认 locale 兜底"。
8. **脏名兜底**：通用图层名（`Text` / `Frame 427`）→ 派生 `nodeId` 短哈希 key（稳定可迁移）+ `needs_rename`，人工重命名后走正常派生；不用递增序号（不稳定）。
9. **key 平台约束**：Android 资源名限 `[a-z0-9_]` 且有长度上限——超长截断 + 短哈希后缀，写入前校验。
10. **产物**：`<项目>/.artemis/design/strings.json`（key / sourceText / sourceFingerprint / lang / screen / nodeId / placeholders / lifecycle / action）。

### 13.5 接口与配置草案（待评审）

- **工具拆分（独立变更工具）**：新增 `figma_import_strings`、`figma_import_tokens`；`figma_export_brief` 保持只读概览职责（概览 vs 变更的 dryRun/审计语义不同）。
- `StackProfile` 增 `i18n` 段：资源文件路径模板、key 命名风格（canonical + 按栈转换）、source locale、复数策略（`src/projects/stack.ts`）。
- **两级状态命名（避免混用）**：`action`（written / unchanged / skipped_exists / planned / error）是导入动作结果；`lifecycle`（new / reused / conflict / source_changed / needs_context / needs_rename / resolved）是 key 生命周期。
- **conflict 闭环**：人工决策写入 `resolutions.json` 持久化，已解决项不再重复报；**overwrite 永不解决 conflict**，只作用于非冲突更新。
- **enforcement 一等化**：`enforcement: report | warn | block`（项目配置 / 工具参数），存量项目以 report 渐进接入。
- 落盘：`.artemis/design/strings.json`、`tokens.json`、`resolutions.json`；工具响应给 counts + 逐 key/逐 token 两级状态，便于 IDE agent 审计。

### 13.6 里程碑拆分（M6，待评审）

| 阶段 | 内容 | 验收 |
|---|---|---|
| M6a | 颜色：alpha 归一化（含 modes schema 预留）+ 语义命名 + `tokens.json`（DTCG）+ 按栈写入 + 裸色扫描 + 确定性输出 | ✅ 已实施（单测：alpha 顺序/别名/modes/幂等/冲突/排序稳定） |
| M6b | 文本：**先做项目实际使用的 1–2 个栈**（按检测结果）→ 采集 + key 冻结映射 + `strings.json` + 资源写入 + 复用/冲突/占位符/转义；其余栈按需铺开 | ✅ 已实施（五栈写入；复数与 iOS `stringsdict` 后续） |
| M6c | 强制与联动：硬编码扫描、unusedStrings、test-gen 定位改 key 优先、迁移/冲突闭环报告 | ✅ 已实施（联动范围同 M6b） |

### 13.7 风险与未决

| 风险/未决 | 说明 |
|---|---|
| source locale 与 key 语言 | 需产品定：source 以设计稿语言为准；key 建议用英文语义名 |
| iOS 复数格式 | `.stringsdict` 还是 Xcode 15+ `.xcstrings`，M6b 前必须定（`.strings` 表达不了复数） |
| 复数/上下文确认 | Figma 推不出，需人工确认流（由 `strings.json` 的 `needs_context` 驱动） |
| 颜色别名语义化 | Variables/Styles 缺失（反向工程场景）时命名质量受限，需人工确认 |
| 强推 i18n | 存量项目可能不用资源文件：`enforcement: report` 渐进接入，不阻断 |
| 跨栈 key 风格 | 各栈大小写不同（snake/camel）；`strings.json` 存 canonical，写入时按栈转换 |
| DTCG 草案演进 | 格式仍会变（色彩结构化提案）；锁定版本 + 兼容 Style Dictionary v4，记录迁移路径 |
| 范围蔓延 | 渐变/阴影/P3/富文本显式 out-of-scope；报告可见（`skipped_nonSolid` / `needs_context`） |

### 13.8 附录：跨栈转换矩阵与确定性要求（M6 落地细节）

**颜色 alpha 顺序**（canonical = CSS 顺序 `#RRGGBBAA`）：

| 栈 | 写入格式 | alpha 位置 |
|---|---|---|
| Android XML | `#AARRGGBB` | 前置 |
| Flutter | `Color(0xAARRGGBB)` | 前置 |
| iOS asset catalog | components（R/G/B/A 浮点字符串） | 分量 |
| RN theme | `#RRGGBBAA` | 后置 |
| Web CSS vars | `#RRGGBBAA` 或 `rgba()` | 后置 |

**文本占位符**：

| 栈 | 语法 | 备注 |
|---|---|---|
| canonical | ICU `{name}` | 中间层唯一格式 |
| Android | `%1$s` / `%1$d` | 多参数必须位置式；`%` 字面量需 `%%` 或 `formatted="false"` |
| Flutter arb | `{name}` + `@name` metadata | 复数走 ICU plural |
| iOS | `%@` / `%1$@` / `%1$d` | 复数需 `.stringsdict` / `.xcstrings` |
| RN / Web | `{name}`（i18next 等） | 按项目实际库探测 |

**转义**：Android `'`、`&`、`%`；iOS 引号与 `\n`；ARB/JSON 走标准 JSON 转义 + ICU。

**locale 码**：canonical 用 BCP-47；写入时转换 Android `values-zh-rCN` / iOS `zh-Hans` / Flutter-Web `zh`。

**确定性输出（幂等前置条件）**：token/key 按名称排序；JSON 固定键序与缩进；行尾 `\n` 且文件尾单换行；生成内容 sha256 记入 manifest；验收要求"同一输入二次导入全部 unchanged"。

### 13.9 实施记录（M6a/M6b/M6c，Android/Flutter 范围）

> 实施于 2026-09-29；新增 `test/tokens.test.js`、`test/strings.test.js`、`test/import-tokens.test.js`、`test/import-strings.test.js` 及 test-gen 增补，共 31 用例全绿。

**工具与产物**
- 新增原生工具 `figma_import_tokens`（M6a）与 `figma_import_strings`（M6b）；`figma_export_brief` 保持只读（§13.5 决议）。
- canonical：`.artemis/design/tokens.json`（DTCG：`$type`/`$value` + `$extensions.aos.{modes,usageCount,samples,needsReview,aliasOf}`，无时间戳、字节级确定）与 `.artemis/design/strings.json`（key/nodeId/sourceText/canonicalText/sourceFingerprint/placeholders/lifecycle）；人工输入：`token-names.json`（值→token 名覆盖）、`resolutions.json`（conflict 闭包，只读）。
- 颜色：vendor `rgbaToHex` alpha 补丁（NOTICE 第 4 条，paint opacity 乘入颜色 alpha）；**值冻结**命名（同值复用旧名；同值多语义样本 → 基础 token + 别名）；`modes` 预留（当前仅 `default`）；栈写入 Android XML（`#AARRGGBB`）/ Flutter Dart（`0xAARRGGBB`）/ RN TS / Web CSS；目标文件带生成标记，无标记且未 `overwrite` → `skipped_unmanaged`；裸色扫描（`#hex` 与 `0xAARRGGBB`）；`enforcement: report|warn|block`。
- 文本：Figma TEXT 采集（screen/component 上下文；混合样式与动态值 → `needs_context`；通用图层名 → `nodeId` 短哈希 key + `needs_rename`）；**key 冻结**（nodeId 映射，改名/移动不改 key）；node 身份变化时同 key 直接沿用并在 `migrations` 记录建议，key 冲突加后缀并给 `suggested_migration`；`source_changed`（指纹 `sha256(NFC(sourceText)+placeholders)`）；同文重复用建议；`unusedStrings`；写入 Android `values/aos_strings.xml`（专用生成文件；扫描全部 `values*/xml` 检测用户已有 key，异值报 conflict、同值让位用户）、Flutter `app_<locale>.arb`、RN `src/i18n/<locale>.json`、Web `src/locales/<locale>.json`（三者加性合并，不覆盖已有翻译）与 iOS `<locale>.lproj/Localizable.strings`（引号/换行/反斜杠转义；`%@`/位置式占位符）；`needs_context` 不写入、`needs_rename` 写入（hash key）；**overwrite 不解决 conflict**（需 `resolutions.json`）。
- M6c 联动：`figma_generate_tests` 读取 strings.json，为命中文本的步骤附加 `i18n: <key>`（原文仅 source locale 兜底）；硬编码文案扫描（Android layout `android:text|hint|contentDescription`、Flutter `Text('…')`）；`unusedStrings` 报告。
- 图片（§13.3 补强之一）：`applyAssetNaming` 对通用图层名（`Frame 427`）回退为确定性 `asset <figmaId hash8>`（按栈命名，如 `ic_asset_1a2b3c4d.svg`）并标 `needsRename`；位图倍率集（不再统一 @2x）待后续。

**与 §13 设计的差异（记录）**
1. 文案写入已铺开至 Android/Flutter/RN/Web/iOS 五栈（原 M6b 计划先做 1–2 栈，随后补齐）；token 写入含 Android/Flutter/RN/Web，iOS token 文件不支持（返回 null）。
2. 反向工程场景（无 Variables/Styles）下颜色命名由样例图层名推导并 `needsReview` 标注，人工经 `token-names.json` 修正，不静默猜测。
3. Android 文案写入专用生成文件（不改用户 `strings.xml`），冲突通过扫描既有资源检出。
4. `needs_rename` 文本仍写入资源（nodeId hash key）保证可用性，重命名后走正常派生。
5. 复数（`<plurals>` / ICU plural）与 iOS `.stringsdict`/`.xcstrings` 尚未生成：当前只写普通 string，占位符已完成 ICU→平台转换（§13.8 矩阵已备，属后续）。
6. 图片兜底名以 figmaId 哈希代替内容 sha256（命名发生在导出下载前），确定性与可迁移性一致；位图倍率（@2x/@3x 集）未改。

### 13.10 实施记录（pen.dev 离线接入 P1 + Figma REST 限流加固）

> 实施于 2026-09-29；新增 `test/pen-read.test.js`（4 例）、`test/figma-limits.test.js`（3 例）与 `test/pen-export.test.js`（5 例），全量 244 用例通过。

- **pen.dev 离线读取层**：`src/pen/read.ts`——JSONC 容忍解析（字符串感知的 `//` 与 `/* */` 剥离，不破坏 URL）、结构校验（id 唯一且不含 `/`、`ref` 可解析、`$变量` 可解析、变量名禁 `:`）、摘要（屏幕/组件/实例/文案样本/变量与主题/图片资产）。对应原生工具 `pen_inspect`（`src/pen/inspect.ts`）；path 缺省由 `src/pen/paths.ts` 统一解析（`.artemis/design` 下最新 `*.pen`），`save:true` 落盘 `.artemis/design/pen/summary.json`；**纯离线，无账号/网络需求**，测试可全离线（假 `.pen` fixture）。
- **pen 侧导出（tokens/strings/brief）**——产物路径与 Figma 版对齐：`src/pen/tokens.ts`（`pen_import_tokens`）颜色变量 → token：**变量名即 token 名**，主题取值写 `modes`（键 `axis=value`），支持 `$别名` 链（`aliasOf`）；usage/samples 来自节点 `fill`/`stroke` 的 `$引用` 计数与裸 hex 值匹配；与既有 `tokens.json` 按名合并——同值 `unchanged`、异值 `updated`（名称冻结）、消失 `unused`（值冻结语义与 Figma 反向工程版不同，因 pen 变量名本身语义化）；`src/pen/strings.ts`（`pen_import_strings`）由 `collectPenTexts` 采集文本记录（`reusable` 组件自成屏幕上下文、`ref` 不展开），复用 `runStringsImport` 全流水线（冻结 key/冲突闭环/五栈写入/硬编码扫描）；`src/pen/brief.ts`（`pen_export_brief`）复用 `renderBriefMarkdown`/`scaffoldComponentSkeleton`/`writeAssetFile`，颜色/字阶/间距/圆角/阴影聚合自 `.pen`。
- **共享抽取（Figma 侧行为不变）**：`writeStackTokenFile`（`figma/color.ts`，栈文件幂等写入）、`runStringsImport`/`renderStringsForStack`/`IMPLEMENTED_STRING_STACKS`（`figma/import-strings.ts`，采集后的公共流水线）。
- **旁路原型**：`scripts/figma-to-pen.mjs`（非服务工具）——Figma REST → `.pen`（version 2.19，官方公开 schema）：frame/group/rect/ellipse/polygon/path/text、填充（颜色/渐变/图片下载）、描边/效果/混合、组件 `reusable` + `ref` 实例、变量（从 Figma 样式生成颜色变量）、页面排布与坐标换算；带响应缓存与 429 退避（尊重 `retry-after`，>15min 不再等待）。
- **Figma 限流加固**：见 §6.2（bounded Retry-After、按 token 冷却记忆 fail-fast、缓存 TTL 10min 可配）。
- **未完成（规划）**：pen.dev CLI/MCP 写回（需账号：MCP 为本地 stdio 桥 + 应用在环，CLI 支持 headless 但导出/agent 需登录或 `PEN_CLI_KEY`）。
