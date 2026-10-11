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
| 用户运行时即`provider: custom` + `deepseek-flash`（`.env`: `DEEPSEEK_API_KEY` + `OPENAI_BASE_URL`） | `/Users/louis/artemis/config/artemis.jsonc` 本地改动 + `.env` 变量名（旧运行时安装已于 2026-10-08 移除，证据为历史记录）                                                                                                                                                                                                                       |
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
  case_id      TEXT,
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
| `aos_configure`             | `{apiKey, model?, baseUrl?, vendor?, name?, makeActive?, writeEnv?, force?, figmaToken?, jiraSite?, jiraEmail?, jiraApiToken?}` | 新增/更新条目（PG 或内存）+ 回写项目`.env`（`AOS_LLM_*`）+ 可选置 active；`vendor` 预设（deepseek/qwen/zhipu/moonshot/siliconflow/stepfun/ark/hunyuan）可自动填 baseUrl 并按稳定别名选型；显式三元组不触网；Jira 三件套（须同时提供，站点仅 `https://*.atlassian.net`）写入 `.env` 的 `JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN`；返回 masked 摘要 |
| `aos_status`                | `{}`                                                                               | 项目、DB 状态、条目数、active、子进程、Figma 桥/就绪性、Jira 配置（masked）、setup 状态                                                                                                                                                                                                                                                                                                     |
| `aos_tasks`                 | `{limit?, sync?}`                                                                  | 任务/调用统计（trace/状态/模型/时间）；默认先向 artemis 同步完成态                                                                                                                                                                                                                                                                                                     |
| `aos_crashes`               | `{action, signature?, traceId?, package?, kind?, since?, limit?}`                  | 崩溃取证：`list` 列出签名（kind/package/since/limit 过滤 + 采集开关）；`get` 返回完整栈/日志摘录；`scan` 手动扫描（指定 traceId 强制重扫）                                                                                                                                                                                                                       |
| `aos_usage`                 | `{action?, tool?, status?, days?, limit?}`                                         | 使用统计（调用事件）：`summary` 概览（含零调用工具）/ `signals` 信号分布（错误类、unknown 模板聚类、warnings 码、降级标记、参数键频次）/ `events` 流水（limit ≤200）；`AOS_USAGE=0` 时显式标注采集已关闭、历史数据仍可查；只统计客户端发起的调用（ADR-0006，见 §13.54）                                                                                          |
| `jira_issue_get`            | `{key}`                                                                            | 读取 Jira Cloud issue（key 或 browse URL）→ 规范化上下文：summary/status/statusCategory/type/labels/project/assignee/reporter/updated/created + `description.text`（ADF→纯文本）/`acceptanceCriteria`（启发式：标题段与 `AC:` 行，`heuristic:true`）/`raw`（原始 ADF）；缺凭证返回 `howToFix`（M8a，§6.8/§13.55）                                                    |
| `jira_issue_search`         | `{jql, limit?, fields?, nextPageToken?}`                                           | JQL 搜索（`POST /rest/api/3/search/jql` 游标分页、无 total）：key/url/summary/status/type/labels/updated/assignee；limit 默认 20、上限 100；`nextPageToken`/`isLast` 透传（M8a，§6.8/§13.55）                                                                                                                                                                        |
| `compare_design_and_device` | `{figmaUrl, nodeId?, deviceSerial?}`                                               | 组合工具：Figma 节点渲染图（PNG@2x）+ 真机截图，一并以 image content 返回供多模态比对                                                                                                                                                                                                                                                                                  |
| `design_device_diff`        | `{design:{source?,figmaUrl?,penPath?,nodeId?,renderOut?}, device?:{mode?,serial?,traceId?,stepNumber?,image?,lossless?}, alignment?:{insets?,ignoreRegions?}, diff?:{pixelThreshold?,minAreaRatio?,clusterGap?,maxRegions?,maxEdge?,nodeProximity?,colorTolerance?,systemBandRatio?}, save?, dryRun?}` | 设计 vs 真机差异（设计源 Figma 或 `.pen`（`design:{source:"pen",penPath?,renderOut?}`，pen CLI 渲染）；设备源 live 实时截图或 step（traceId 必填；stepNumber 可省略 → 失败证据自动检索，记录 anchor 来源/候选；默认 post）；live 可加 `lossless:true` 经 adb 抓无损 PNG（避免 JPEG 伪影，失败自动回退 live JPEG））：确定性对齐（设计宽度缩放 + 顶部对齐，insets 修正，默认按设计图最长边降采样到 1440px）+ 像素差异判定（pixelmatch，抗 JPEG 噪声：阈值/最小面积/聚类/上限可配）→ 结构化差异报告（区域/类别 `missing/extra/text/asset/position-size/color`（无节点几何时 `pixel`）/严重度/证据，设计节点几何与阈值入报告）+ 标注图；默认落盘 `<项目>/.artemis/design/diffs/<node>-<时间戳>/`（report.json / annotated.png / design.png / device.png），响应摘要 + 标注图 + 路径；`ignoreRegions` 屏蔽动态区域；`dryRun` 不取图不写盘；判定不依赖 LLM（ADR-0001/0002）；差异区域经 `screen-map.json` 输出 `localized`（mapped=`mapEntry`/unmapped=候选/no-candidates=原因） |
| `screen_map` | `{action:"list/propose/save", entries?, merge?}` | 持久屏幕映射 `<项目>/.artemis/design/screen-map.json`（设计屏幕/组件 ↔ 路由/组件/文件）：`propose` 基于 build-brief + 栈约定给粗粒度候选（confidence/unmatched，需 agent 复核）；`save` 显式写入（幂等，`merge` 增量）；`list` 读取；差异报告据此定位（ADR-0004） |
| `figma_extract_flows`       | `{url, nodeId?, save?}`                                                            | 原型交互 → 流程图（screens/edges/entryScreens/unresolved + `warnings`：`no-entry`/`unreachable-screens`/`unresolved-destinations`/`no-interactions`），落盘`.artemis/design/flows.json`；供后续"流程→测试生成"消费（M-B；契约见 §6.10）                                                                                                                                                                                                                                     |
| `figma_gap_analysis`        | `{url, id?, assetGlobs?, tokenFiles?, save?}`                                      | 设计资源/色板 vs 项目资产/tokens 缺口（missingAssets/missingColors），**扫描规则按检测到的技术栈选择**（`src/projects/stack.ts`：Flutter/RN/原生 Android/iOS/Web 档案，含资产目录/定位/代码/命名约定），缺失资源按栈重命名（如 Android `ic_home.svg`、Flutter `home_icon.svg`）并给出目标目录；落盘 `.artemis/design/gaps.json`；供"资源导入"消费（M-C） |
| `figma_generate_tests`      | `{url?, flowsPath?, maxFlows?, save?, excelPath?, excelTemplate?, requireFullCoverage?}`                 | 连续交互线性化为端到端流程（entry→…→终态/BACK），生成 artemis 可直接执行的任务描述；落盘`tests.json` + `tests.md`（过程文档）+ `tests.xlsx`（每流程一行：用例名/页面链路/步骤/任务描述；默认表，`excelPath` 改路径；`excelTemplate` 传 `.xlsx` 模版时填充 `{{meta.*}}/{{counts.*}}/{{case.*}}/{{index}}` 占位符并复制行模版）；响应与 `tests.json` 写 `coverage`（**硬覆盖**：未覆盖屏幕/跳转、`truncated`、`entryFallback`；`explore` 报告 inferred 缺口），`requireFullCoverage:true` 时硬覆盖不完整即报错且三份都不落盘（M-B；契约见 §6.10）                                                                                              |
| `figma_import_assets`       | `{url?, gapPath?, destDir?, ids?, format?, densities?, overwrite?, dryRun?, save?}`            | 按 gaps.json 导出缺失资源（SVG 内联/PNG 下载）→ 按栈命名与首选目录写入；PNG 默认按栈倍率集（Android xhdpi/xxhdpi、Flutter 2.0x/3.0x、iOS imageset、RN @2x/@3x；`densities:false` 回退单文件 @2x）；**唯一性三层**：命名规范化 → 目标路径幂等（同内容 `unchanged`；异内容 `skipped_exists`/`overwrite`）→ **内容 sha256 去重**（批次内 + 项目资产索引，跨文件同名/异名重复记 `duplicate_of`）；`dryRun` 按同样规则预览；落盘 `import-report.json`（M-C/§13.35）                |
| `figma_export_brief`        | `{url, save?, includeFlows?, includeGaps?, scaffold?, maxComponents?, overwrite?}` | 构建简报：tokens（颜色/字阶/间距/圆角/阴影）+ 页面路由 + 组件与变体 + 流程概览 + 缺口摘要 + 栈编码约定 →`build-brief.{json,md}`；`scaffold` 按栈生成组件骨架（幂等）（M-D）                                                                                                                                                                                       |
| `pen_inspect`               | `{path?, save?}`                                                                   | pen.dev 离线检查：解析 `.pen`（开放 JSON，容忍 `//` 注释）→ 结构校验（id 唯一/无 `/`、ref 可解析、`$变量` 可解析）+ 摘要（屏幕/组件/实例/文案/变量与主题/图片资产与缺失）；path 缺省取 `.artemis/design` 下最新 `*.pen`；`save:true` 落盘 `.artemis/design/pen/summary.json`；无账号与网络需求（P1）                                                                              |
| `pen_extract_flows`         | `{path?, save?, maxScreens?}`                                                      | pen 流程合成（离线）：`.pen` 无原型交互数据时，以「Flow 标注 > 屏内首个文本 > 图层名」命名屏幕、按标签前缀归并状态变体（主屏 + states）、按画板序号与画布排布推断跳转（全部 `trigger/actionType=INFERRED`）；落盘 `.artemis/design/flows.json`（供 `figma_generate_tests`/`suite check` 消费）+ `flow-map.md`（全局交互地图）；返回碎片度统计（默认名屏、状态归并、推断边）与 warnings（契约见 §6.10 生成策略相邻条目） |
| `pen_import_tokens`         | `{path?, dryRun?, overwrite?, save?, enforcement?}`                                | pen 颜色变量 → canonical `tokens.json`（DTCG；**变量名即 token 名**，主题取值写入 `modes`（`axis=value`），`$别名` → `aliasOf`）+ 按栈 token 文件（复用 `writeStackTokenFile` 幂等写入）；输出 new/updated/unchanged/unused、裸色扫描与 enforcement（语义同 `figma_import_tokens`）；完全离线（P1）                                                                                                                                                                 |
| `pen_import_strings`        | `{path?, locale?, dryRun?, save?, enforcement?}`                                   | `.pen` 文本节点 → `strings.json` + 按栈资源写入（复用 `runStringsImport` 全流水线：冻结 key/冲突闭环/硬编码扫描/五栈写入）；`reusable` 组件自成屏幕上下文，`ref` 不展开；完全离线（P1）                                                                                                                                                                                                                                |
| `pen_export_brief`          | `{path?, save?, includeGaps?, scaffold?, maxComponents?, overwrite?}`              | `.pen` → `build-brief.{json,md}`（颜色/字阶/间距/圆角/阴影、屏幕与建议路由、可复用组件、按栈约定、可选 gaps 摘要）；复用 Figma 版 markdown 渲染与 `scaffoldComponentSkeleton`；完全离线（P1）                                                                                                                                                                                                                        |
| `pen_export`                | `{path?, out?, format?, scale?, dryRun?, timeoutMs?}`                              | headless CLI 渲染导出：`.pen` → PNG/JPEG/WEBP/PDF（默认 `.artemis/design/pen/<name>.<ext>`；`dryRun` 返回命令）；pen CLI 缺失时自动托管安装（`~/.aos/pen-cli`，`AOS_PEN_NO_INSTALL=1` 关闭；`AOS_PEN_CLI_PATH`/`AOS_PEN_CLI_DIR`/`AOS_PEN_VERSION` 可覆盖、`AOS_PEN_TIMEOUT_MS` 默认 120s），需已登录（`pen login` 或 `.env` `PEN_CLI_KEY` 自动透传）（P1 写回）  |
| `pen_apply_tokens`          | `{path?, tokensPath?, out?, dryRun?, timeoutMs?}`                                  | CLI 写回：`tokens.json`（含 modes 主题取值）→ `.pen` `SetVariables`；默认**原位更新**（临时文件 → 回读校验变量值 → 原子替换；校验失败不动原文件），`out` 可另存；别名 token 不单独写入（P1 写回）                                                                                                                                                                                                                       |
| `pen_apply_strings`         | `{path?, stringsPath?, out?, dryRun?, timeoutMs?}`                                 | CLI 写回：`strings.json` 的 nodeId→sourceText → `.pen` 文本节点 `Update(content)`；原位更新/校验/另存语义同上；nodeId 不存在记入 `notFound`（P1 写回）                                                                                                                                                                                                                                                                    |
| `pen_agent`                 | `{path?, out?, prompt, agent?, model?, effort?, anthropicBaseUrl?, custom?, exportPath?, exportType?, exportScale?, maxFailedCalls?, dryRun?, timeoutMs?}` | headless CLI agent 生成/修改设计：prompt → `.pen`（默认原位：临时文件→结构校验→原子替换，失败不动原文件；`out` 新建/另存）；pen CLI 缺失时自动托管安装（同 `pen_export`）；**凭证复用 active LLM**（不落日志/响应），项目 `.env` 的 `PEN_*`/`ANTHROPIC_*` 透传（active LLM 派生值优先），Anthropic 兼容端点按 provider 桥接：DeepSeek（apiKey，已实测）、Kimi/Z.AI/百炼（authToken + 模型映射，按官方文档，待真实 key 冒烟）；其他 provider 仅注入 `PEN_AGENT_API_KEY` 并告警（可 `anthropicBaseUrl`/`AOS_PEN_ANTHROPIC_BASE_URL` 覆盖）；有桥接时 claude agent 自动 `--custom`；可选 `exportPath` 顺带出图（P1 写回） |
| `pen_import_assets`         | `{path?, ids, format?, densities?, destDir?, overwrite?, dryRun?, save?, timeoutMs?}` | CLI 资源导入（headless，需登录）：`.pen` 节点 → 位图（interactive `Export`：单会话、命令数=倍率数、单命令全 ids；png/jpeg/webp）→ 按栈命名/倍率集/目录幂等写入（复用 figma 写盘管线：路径幂等 + sha256 去重 + `duplicate_of`；`densities:false` 回退单 @2x）；产物以 CLI `Exported` 路径对账（缺产物记 `export-no-output` + 批次告警；未知 id 离线预校验失败）；报告 `.artemis/design/import-report.pen.json`（`schemaVersion`/`penCliVersion`/`vector:"unsupported"`；独立于 figma 报告）；超时会话级自适应（`AOS_PEN_IMPORT_TIMEOUT_MS`）；`dryRun` 仍渲染以获得去重结果（§13.58） |

`setup_required` 语义：无任何可用条目时，`llm_list` 正常返回并带 `setupRequired: true` + 指引；`mobile_run_task` 直接返回结构化 `setup_required` 错误（不调用子进程）；其余 mobile 工具放行。

**测试用例 Excel 导出（`figma_generate_tests`，2026-10-01）**：`save !== false` 时除 `tests.json`/`tests.md` 外默认落盘 `tests.xlsx`（`excelPath` 改路径）；无模版时生成开箱表（sheet `测试用例`，表头 `#/用例名称/涉及页面/步骤/artemis 任务描述`，表头加粗、首行冻结、步骤与任务描述自动换行）。传 `excelTemplate`（`.xlsx`）时读取用户模版填充占位符：

- 元数据（任意 sheet 单元格内子串替换；独占单元格的数字写为数字）：`{{meta.source}}`、`{{meta.generatedAt}}`、`{{counts.cases}}`、`{{counts.screens}}`、`{{counts.edges}}`。
- 行模版：含 `{{index}}`/`{{case.name}}`/`{{case.screens}}`/`{{case.steps}}`/`{{case.taskDesc}}` 的**首个**行按用例数复制（样式随行复制），逐行填充；多 sheet 各自可有行模版，纯元数据 sheet 允许；0 用例时行模版行被移除。
- 未识别的 `{{...}}` 原样保留；整个模版无行级占位符 → 报错且**不写任何文件**（模版读取与渲染在写盘前完成，Buffer 先行）。实现依赖 `exceljs`（仅运行时，测试不联网）。

### 6.2 Figma 20 工具（M2，vendor + zod）

沿用 dcb 工具名；token 解析顺序：PG 项目记录 → `.env`；REST 工具在 token 缺失时返回"请提供 `FIGMA_ACCESS_TOKEN`（或通过 `aos_configure` 写入）"的引导；插件模式不受影响。

**REST 限流加固**（2026-09-29 补丁，NOTICE 第 5 条）：`figma-rest/client.ts` 对 429 做有界处理——`Retry-After ≤ AOS_FIGMA_RETRY_MAX_WAIT_MS`（默认 60s）时等待一次并重试；超限则抛 `FigmaRateLimitError`（携带 `tier`/`retry-after`）并写入**按 token 指纹的冷却记忆**（冷却期内直接快速失败、不发请求）；响应缓存 TTL 提升为 10min 且可配（`AOS_FIGMA_CACHE_TTL_MS`，0 关闭），一次流水线运行对同一文件只拉取一次。背景：企业版文件 + 访客席位返回 `x-figma-rate-limit-type: low`，大文件少数请求即可触发多日冷却（实测 `retry-after≈4.4 天`），原实现会按 Retry-After 无限期 sleep 挂起调用。

### 6.3 mobile 5 工具（代理，schema 透传）

同 v0.2（原样透传，不做 zod 镜像，契约测试锁定）。

### 6.4 任务统计

本服务的 `CallTool` 拦截 `mobile_run_task`（不再限定成功）：记录（项目、trace、case、model、profile、desc、status）。成功且有 `trace_id` → `submitted`；即时错误或无有效 `trace_id` → 直接 `failed` 终态（`finished_at` 置位，`trace_id` 以 `local-<uuid>` 占位，不进入 pending）。**用例关联**：提交时用 `task_desc` 与 `.artemis/design/tests.json` 的 `taskDesc` 精确匹配，命中写入生成器冻结的 `case_id`（无法匹配留空，不做近似错配）；`aos_tasks` 输出 `case_id`；`model` 取 `mobile_run_task.model`，`profile` 不再混用同值。**完成态同步**：后台定时（30s）与 `aos_tasks` 调用时，通过 `mobile_manage_task(status)` 轮询 pending 行，终态（completed/failed/cancelled/orphaned）写回 `finished_at`；网关子进程不在线时跳过本轮，不打断任务。

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
- **设计 vs 真机 diff（v1）**：`design_device_diff` 的产物按对比单元落盘 `<项目>/.artemis/design/diffs/<node>-<时间戳>/`：`report.json`（schemaVersion=1；unit/alignment/ignoredRegions/regions/summary/elapsedMs）、`annotated.png`（差异框 + 编号）、`design.png`（设计源渲染原图，1×）、`device.png`（真机原图：live JPEG 或 `lossless` 无损 PNG，统一重编码为 PNG）；失败时不保留半成品目录。差异引擎为纯函数（`src/diff/engine.ts`），像素栈为纯 JS（pngjs/jpeg-js/pixelmatch，ADR-0002）。
- **测试文档**：`figma_generate_tests` 等设计流水线产物仍在 `<项目>/.artemis/design/`（见 §13），本次不变。
- **注意**：`ARTEMIS_*` 变量属于客户端/进程 env（项目 `.env` 不注入子进程），覆盖要写在 MCP 客户端配置的 env 或 shell 环境。

### 6.8 Jira Cloud 接入（M8a：读取）

**范围**：M8a 为客户端 + 凭证 + 读取（`jira_issue_get`/`jira_issue_search`）；证据回写（M8b）与 CLI/工作流迁移（M8c）见 §11 M8 与 §13.55。

- **凭证**：项目 `.env` 的 `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN`（`aos_configure` 可三件套写入，须同时提供）；凭证由 resolver 解析（进程 env 优先；启动与 `aos_configure` 后刷新，手动编辑 `.env` 需重启会话），不落 PG；站点仅接受 `https://<site>.atlassian.net`（去尾斜杠，排除 Server/DC 与自定义域）；`aos_status.jira` 显示 configured/site/email/token（masked）/missing。
- **客户端**：Basic auth（email:token）；`AbortSignal.timeout`（`AOS_JIRA_TIMEOUT_MS` 默认 30s）；429 按 Figma 模式：`Retry-After ≤ AOS_JIRA_RETRY_MAX_WAIT_MS`（默认 60s）等待一次并重试，否则按凭证指纹记录冷却（冷却期 fail-fast、不发请求）并抛 `JiraRateLimitError`（含 `RateLimit-Reason`）；不做响应缓存；非 2xx 抛 `JiraApiError`（status + body ≤500 截断 + 可行动 hint：400 有界 JQL / 401 token 一年过期轮换 / 403 权限 / 404 可见性 / 413 附件上限）。
- **读取契约**：issue 上下文规范化为纯文本 + 启发式验收标准（标题段延续到下一标题，外加 `AC:` 行回退；`heuristic:true` 明示不可全信），保留原始 ADF 供深入消费；搜索走 `/rest/api/3/search/jql`（显式字段、游标分页；JQL 需有界，API 侧 400 原样映射）。
- **里程碑后续**：M8b 已落地——票 03（评论/附件原语）：`jira_issue_comment`（纯文本→ADF；`AOS-TRACE:<traceId>` 页脚 marker 幂等更新/新建；评论属性 best-effort）、`jira_issue_attach`（multipart、确定性命名 `<basename>-<sha8><ext>`、同名同大小去重、上限取站点 meta 与 `AOS_JIRA_ATTACH_MAX_MB` 较小者、超限跳过）；票 04（证据 composite）：`jira_evidence_post`（复用 `traceEvidence` 聚合失败步骤截图/设计差异标注图/失败清单/崩溃签名；`classifyFailure` 确定性失败域；platform/deviceSerial 覆盖或按 serial 推断；`dryRun` 不触网；平台注释）；客户端扩展（comments/attachment meta/list/upload，JSON 请求抽象为 rawRequest 复用冷却与重试；写操作走 requestVoid 兼容 200/201/204/空体）。M8c 票 05（CLI）已落地：`aos-mcp jira issue create|comment|label|transition|link`（同客户端；`--project`/`--json`；exit 0/1/2；建单支持 Task/Bug、描述 ADF、标签、父级与 Blocks 链接；流转按可用 transitions 目标状态名匹配，不匹配列出可用项）；票 06 工作流文档已迁移（`docs/agents/issue-tracker.md` 重写为 Jira 工作流、`triage-labels.md` 加 tracker 映射、AGENTS 摘要同步）；**沙箱端到端验收待使用方提供沙箱凭证后执行**（记录于票据 06 Comments）。

### 6.9 iOS 真机后端（M9a：Appium + WDA）

真机 UDID（`classifyIosSerial=device`）由 AOS 接管并走 Appium + WebDriverAgent（模拟器保持 idb/simctl 双后端）：

- **服务**：`ios/appium`（service/server/client/session/facade/xml/capabilities/detect）——配置按项目 `.env` 打底、进程 env（客户端配置）覆盖（同模型目录规则，见 §13.57）；`AOS_APPIUM_URL` 直连或托管懒启动 `appium --port`（`AOS_IOS_APPIUM_PORT` 默认 4723，启动前先探测复用）；`/status` 就绪轮询；`disposeIosWda()` 随 stdio/HTTP 关停回收。
- **会话**：同 UDID FIFO 互斥 + 任务级 lease（finally 释放）+ 观测会话空闲回收（`AOS_IOS_SESSION_IDLE_MS` 默认 30min，0=保活）；观测拿锁有界等待（`AOS_IOS_OBSERVE_WAIT_MS` 默认 5s）→ `device_busy` + 最近缓存帧（结构化变体）；截图 busy 且有缓存帧 → 降级返回缓存帧路径并标注 `capturedAt`，层级 busy → 结构化报错（实现见 §13.79）；自愈阶梯（DELETE→POST→托管重启一次）。
- **能力**：截图、层级（page source XML 经 fast-xml-parser；解析失败 `parse_failed` 回退截图）、tap/swipe（W3C actions）、文本输入（先聚焦→有界等键盘→`POST /keys`；`mobile: typeText` 在 xcuitest 12.15 已移除）、terminate/activate/install/deepLink。
- **签名**：`AOS_IOS_XCODE_ORG_ID`（证书 OU 团队 ID，真机必填）、`AOS_IOS_XCODE_SIGNING_ID`（默认 Apple Development）、`AOS_IOS_WDA_BUNDLE_ID`（默认 com.aos.mcp.wda）；`useNewWDA=false` + `allowProvisioningDeviceRegistration=true`（真机实测）；多项目团队各异时各自在项目 `.env` 声明（分层规则见 §13.57）。
- **路由**：`mobile_get_device_state` device 分支（busy/parse_failed 降级）、`captureLiveScreenshot`（design diff / compare 真机截图，note "iOS 真机 WDA PNG" 即 backend 标识）、`mobile_run_task`（执行器设备 façade 对 device 走 WDA）。真机崩溃经 `devicectl systemCrashLogs`、真机日志经 `idevicesyslog` 实时尾采样（M9c，窗口近似 `clockWarning`；缺工具降级 `ios-log-tool-missing`）。
- **排障**：doctor/`aos_status.ios` 显示 Appium/xcuitest/签名/隧道指引；iOS 18+ 需一次性 `sudo appium driver run xcuitest tunnel-creation`。

### 6.10 接入契约：流程完整性保证（2026-10-08）

**契约**：项目接入 AOS 后，"设计流程 → 用例 → 执行"的**路线完整性由 MCP 保证**，项目侧只需提供最小输入；不要求项目自建测试套件或测试规范（自建 XCUITest 不在此保证范围内）。

- **项目最小输入**：① 可运行应用（模拟器/真机安装方式）；② 设计源（Figma URL 或 `.pen`）；③ 凭证（项目 `.env`：`FIGMA_ACCESS_TOKEN` + LLM key；iOS 真机另需 `AOS_IOS_XCODE_ORG_ID`）。
- **闸 1・提取**（`figma_extract_flows`）：`warnings` 数组显式报告 `no-entry`（无入口屏→entryFallback）、`unreachable-screens`（无法从入口到达）、`unresolved-destinations`（跳转目标缺失），与流程图一同落盘 `flows.json`。
- **闸 2・生成**（`figma_generate_tests`）：`coverage` 分**硬/探索**两类——`complete/uncoveredScreens/uncoveredEdges` 为硬覆盖（explicit/observed/confirmed 及 legacy 证据），`explore`（`uncoveredScreens/uncoveredEdges/complete`）报告 inferred 探索缺口（仅展示，不阻断）；`requireFullCoverage:true` 时硬覆盖不完整（未硬覆盖屏幕/跳转或路径截断）即报错，且 `tests.json/tests.md/tests.xlsx` 三份都不落盘。
- **闸 3・执行**（`suite run --fail-on-uncovered`）：按预检**硬覆盖**（未硬覆盖屏幕/跳转、生成截断）判定，命中即 exit 2；探索缺口仅报告；`--strict` 追加弱断言门禁；自定义 `--tests` 同样校验（cases 来自指定文件，flows 仍取 `.artemis/design/flows.json`）；缺/坏 `flows.json` 视为校验不可用并按不通过处理（fail-closed）；套件未执行时执行失败信息优先展示，覆盖结论并列输出。
- **执行闭环（既有）**：每用例为入口→终点的连续任务（`mobile_run_task`，iOS 走 idb/Appium 执行器），`case_id` 回填台账、失败步骤证据、`compare_design_and_device`/`design_device_diff` 视觉核对、崩溃取证。
- **默认姿势**：设计流水线脚本 `scripts/design-pipeline.mjs` 调 `figma_generate_tests` 时默认 `requireFullCoverage:true`；文档示例推荐同参数（MCP 参数本身保持可选，不改变既有调用方语义）。
- **口径**：边覆盖按屏幕对（`From → To`）计；BACK/自环不产生新屏幕步骤，不计边；覆盖计算为单一实现（`src/figma/coverage.ts` 的 `computeClassifiedCoverage`，生成闸与执行预检同口径分硬/探索两分区）：**硬类 = 非 `inferred`**（含 legacy-unknown——旧产物不因缺字段静默弱化门禁，失败响亮），**探索类 = `inferred`**（不参与门禁，仅报告）；`--strict` 时非探索弱断言计入门禁；`entryFallback` 为告警项不阻断（除非覆盖本身不完整）。
- **生成策略**：线性化选路为"覆盖贪心 + 长路径优先"——先选覆盖增量（屏幕+跳转）最大的路径，同增量取更长者，无新增覆盖的冗余短片段不产出；`maxDepth` 默认 30、可配（`figma_generate_tests` 参数，上限 50），是单条用例的边数上限；**到上限不丢尾**——以截断屏为起点生成首尾相接的续段用例（`visited` 继承防环，覆盖仍完整），`generation.depthSplits` 报告接续条数，响应 hint 提示调大 `maxDepth` 可获得更长单条连续用例（修复：此前深度截断直接丢弃剩余路径，长链只剩 12 步且尾部屏幕全未覆盖）。
- **续段自包含 + 步骤断言结构化（执行约束力）**：续段用例携带"入口 → 切点"的前导导航步骤（`prelude`；taskDesc 增「前导导航（仅到达起点，不计断言）」段，`continuation:true`/`startScreen` 字段标注），执行时不再依赖上段状态（修复：此前仅写"如不在该页，先导航过去"一句文案，接续段起点不可达）。所有用例每步输出结构化 `expectations`（目标屏名 + 设计文本 hints，与 `steps` 对齐），随 taskDesc 以 `【AOS-EXPECT】` JSON 块传递；iOS 执行器逐步确定性核对（空白归一化、hints 全部包含）：命中序号记入 step `scriptHits`，汇总为 `script_adherence`（run.json）与 `test_summary.adherence`（`checkable/satisfied/unchecked/unresolved`）；未出现项作为证据写入终态验证提示词与完成摘要（`⚠ 脚本断言未出现`）。口径为**建议级**（替代路径不硬失败，verify=final 下交模型裁量），tests.json 保持平台中立（Android 侧忽略该行）。
- **起始屏 preflight（确定性前置）**：`【AOS-EXPECT】` 块携带 `start`（journey 入口屏 + 设计 hints，`GeneratedTest.preflight` 字段；hints 为空则不下发）；iOS 执行器首步观测核对（`pending → matched/unmatched`，unchecked 表示不可核对）：未命中时每步向模型注入「起始屏核对未通过，请先导航到该页」提示（替代即兴导航），全程留痕——`test_summary.preflight.{screen,status,matched_at_step}`、run.json `preflight`、验证提示词「起始屏核对（确定性）」段与完成摘要 `⚠ 起始屏核对未通过`（同样建议级，不硬失败）。
- **pen 合成提取**（`pen_extract_flows`，离线）：`.pen` 无原型交互数据时，屏幕命名取「Flow 标注 > 屏内首个文本 > 图层名」（默认名 `Frame NNNN` 不再冒充屏名）；状态变体按标签前缀归并为主屏 + `states`；跳转按画板序号/画布排布推断并统一标注 `INFERRED`；产出可直接进入同一闭环的 `flows.json` 与全局 `flow-map.md`；碎片度（默认名屏、状态归并、推断边、缺标签）进入 `warnings`，供人工复核。
- **pre-merge 静态闸**（`suite check`）：tests.json × flows.json 静态覆盖（复用 preflight 单一实现），不连设备；未硬覆盖/截断/缺 flows exit 2（`--strict` 追加弱断言门禁）；"测试引用但设计缺失"的路线漂移仅警告（设计偏差 ≠ 路线缺口）。
- **对账闭环（导航级，§13.67/§13.68/§13.73/§13.74）**：`suite run` 把探索步骤的实际命中写入持久对账资产 `<项目>/.artemis/design/reconciliation.json`——iOS 经 trace `run.json` 的 `scriptHits`；Android 经 `data_engine.db` 的 OCR 标签匹配设计运行期文本/屏名（§13.73）。（幂等——同 trace 重放不重复计数；稳定排序；升级阈值 = 1 次观测；未命中的边登记 pending 差异）；**反向观测**（真机有设计无）以 `direction:"runtime-only"` 证据级条目记录（不生成、不升级）；审阅**决定历史**保留（改判追加，上限 10）。下一次 `figma_generate_tests` 自动把已升级边以 `runtime-observed` 生成硬断言（响应 `reconciliation.upgradedEdges`）。**人工审阅面**：`suite reconcile` 与 MCP `reconciliation` 工具（list/confirm/reject）——confirm → human-confirmed（硬断言）、reject → 边不进生成；未裁决不升权。
- **元素级映射（导航级，§13.69）**：iOS 运行把观察标签与设计运行期文本做唯一精确归一匹配，写入 `screen-map.json` 的 `elements`（含 accessibilityIdentifier 建议）；`screen_map` 工具可人工补（manual 优先）；下一次 `figma_generate_tests` 在步骤元素注记追加 `a11y: <identifier>`。
- **验收口径（oracle，§13.70）**：设计标注 `Flow/AC*` 分组或 `AC:`/`验收：` 前缀批注（或 `.artemis/design/acceptance.json` 人工确认覆盖）声明硬断言期望，assert 步骤携带 `hintsSource:"acceptance"`；无口径的屏沿用运行期文本（`hintsSource:"runtime-text"`，建议级）。Jira AC 留后续集成。
- **差分校准**（`suite calibrate`）：确定性套件结果（`--report` 导出 JSON 或 **JUnit XML**——Android instrumentation 直读，或 `--xcresult`，Xcode 16+ `xcresulttool get test-results tests`）按 case_id（测试名内嵌）对齐 MCP 台账；漏报率 = 漏报/(一致失败+漏报)，误报率 = 误报/(一致通过+误报)；`--fail-on-miss` 可作门禁；报告落 `.artemis/design/reports/calibration-*.json`。
- **追溯矩阵**（`suite report`）：xlsx 第二工作表输出 design 屏幕/跳转 ↔ case_id ↔ trace ↔ 证据存在性（未覆盖/无 trace/无证据标注）。
- **设计版本锚点**：`figma_extract_flows` 将 Figma `version`/`lastModified` 写入 flows.json（`fileVersion`/`lastModified`），为设计冻结（baseline-lock）预留。
- **flake 治理口径**（`suite run --retry N`，N≤3）：仅对未通过用例重跑做诊断，`retry {attempts, finalStatus, finalTraceId, flaky}` 如实写入报告/JSON；**首跑结果仍决定退出码**（重跑转绿不计首跑门禁），文本输出标注"重试转绿 N 例（flaky）"；quarantine 需 owner 签字（后续）。
- **闭环编排**（`suite loop`）：一步产出静态检查＋执行＋反馈＋校准的闭环报告（`loop-<stamp>.{json,md}`）与确定性"下一步动作"；exit 码沿用检查/执行门禁结论（`--allow-uncovered` 可放宽覆盖门禁）。**边界**：MCP 只负责测试闭环，不深入项目实现细节；"测试→完善"路径=按下一步动作改进 tests/flows/数据/错误码规则后重跑（`--calibration` 合并 `suite calibrate` 产物）。
- **flake 采样**（`suite flake --cases … --runs N`）：重复采样输出逐例通过率、翻转矩阵与 flaky 判定、轮次方差；落盘 `flake-<stamp>.{json,md}`；`--fail-on-flaky` 可作门禁。**测量口径**：翻转率决定 L2 投入强度（条数/是否入门禁），不决定"确定性校准器是否需要"（见 `.scratch/enterprise-ios-testing/analysis.md` §11.2 / 票据 10）。
- **quarantine 口径**（`.artemis/design/quarantine.json`）：条目须 `caseId + owner + signedAt`（可选 `expiresAt`）；生效项仍执行、结果标注 `quarantined`，**失败不计门禁**（`suite run/loop` 退出码排除）；过期/无效条目如实提示并恢复门禁；`--no-quarantine` 用于严格审计运行。
- **审计保留期（只读先行）**：`suite retention [--days 90] [--limit 20]` 扫描 reports/evidence/diffs/traces/crashes 五类产物，输出超期文件数/体积与最旧项；**不删除任何文件**（`src/figma/retention.ts` 纯函数扫描 + 报告）。自动清理动作待合规口径确认后另行实现（临时默认 90d）。

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
| 设备命令    | `scripts/adb-safe.mjs`（跨项目复制的 adb 包装器）：硬超时到点杀整个进程组（无孤儿 adb）、默认 push 安装（`--no-streaming`）、`shell` 拦截 `pm install`（FD 假死）、设备解析与结构化退出码；`test/adb-safe.test.js` 以假 adb 覆盖超时/退出码/多设备/用法 |
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
| M6             | 设计资源唯一性与 i18n 闭环（颜色 tokens / 图片补强 / 文本 i18n）                                   | 🚧 部分实施（M6a/M6b/M6c 完成，复数与 iOS stringsdict、位图倍率集均已落地；真机验收待后续，见 §13.9/§13.34/§13.35） |
| M7             | 厂商模型目录定时刷新 + 模型下线自动修复 +`mobile_run_task` 预检（8 家国产预设、`llm_models`）    | ✅ 已完成（新增 19 用例）                                               |
| D1             | 设计 vs 真机确定性差异（Figma/.pen × live/step/自动锚点；分类/严重度；screen_map 定位；真实基准） | ✅ 已完成（票据 01–07；307 用例；见 §13.13–13.19）                       |
| D2             | 测试闭环深化（用例身份台账、状态复位、套件运行器、失败证据/分类、设备基线、运行报告、生成反馈、CLI 接线）   | ✅ 已完成（票据 01–14；389 用例；见 §13.20–13.33）                       |
| U1             | 使用统计（客户端调用事件采集/存储/聚合 + `aos_usage` 工具 / `usage` CLI / Web 看板三消费面；ADR-0006）     | ✅ 已完成（票据 01–07；610 用例；见 §13.54）                             |
| M8             | Jira Cloud 接入（产品级读取/证据回写 + 仓库 issue tracker 迁移 CLI；spec 与票据见 `.scratch/jira-integration/`） | 🚧 部分实施（M8a 完成：client/凭证/`jira_issue_get`+`jira_issue_search`；M8b/M8c 为票据 03–06；见 §13.55） |
| M9             | iOS 真机后端（Appium+WDA：观测/动作/设计对比 + 执行器；日志/崩溃 M9c 与 .ipa 安装待续；spec/票据见 `.scratch/ios-real-device/`） | ✅ 代码完成（M9a/M9b 经真机端到端验证；M9c 崩溃走 devicectl、日志走 idevicesyslog 尾采样，真机冒烟待人工执行；见 §13.56） |
| M9.1           | iOS 执行器理解强化（感知档位/视觉融合/遮挡/no-op/终态验证/历史/失败日志/平台语义；spec 见 `.scratch/ios-understanding-parity/`） | ✅ 已完成（786 用例；见 §13.59） |

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
  - 脏图层名（`Frame 427`）回退**身份种子**命名 `asset <sha1(源 id) 前 8 位>`（`src/figma/gaps.ts` `applyAssetNaming`/`fallbackAssetName`，并标 `needsRename`）；命名在 plan 阶段完成、与导出内容无关，内容 sha256 只用于写盘判定/去重（多倍率下同一资源恒同名）；现有幂等写入保证不静默覆盖（真实代价是混淆性 `skipped_exists`）。
  - 导出规格（2026-10-02 已实施，§13.35）：**SVG 优先**；位图按栈倍率集（Android xhdpi(2x)/xxhdpi(3x)、Flutter 1x/2.0x/3.0x、iOS imageset 1x/2x/3x + Contents.json、RN base/@2x/@3x、Web 单 1x），不再统一 @2x；`densities:false` 回退旧行为。
  - 同内容不同语义名 → 提示合并（不自动改名）。

### 13.4 文本（i18n）

原则：**Figma 原文只进字符串资源，永不落代码字面量**。唯一性拆成两个独立问题：

1. **key 全局唯一 + 冻结映射（保稳定）**：key 由语义路径派生（`<screen|component>.<element>`，复用 `toCase`），**一经分配即冻结**——`nodeId → key` 映射持久化在 `strings.json`，图层改名/移动不改 key；另支持人工 key 锁定（override）。key 不由文案哈希派生（文案与翻译会变）。
2. **迁移（只兜 node 身份变化）**：仅当 nodeId 变化（删除重建、复制粘贴）时，以"源文案近似 + 结构位置"产出 `suggested_migration` 报告，人工确认后 oldKey→newKey 搬翻译；nodeId 不可靠场景降级为文本相似匹配。
3. **内容复用**：同默认文案（NFC 归一化后）+ 同上下文 → 复用同一 key；`common.*` 公共词（确定/取消）只给归并建议（人工确认，限制滥用以免丢上下文）；`(文案, 上下文) → key` 索引用于检测"应复用未复用"。
4. **占位符规范化**：`{name}` / `%s` / `%d` 归一为 ICU，写入时按栈转换（§13.8）；复数/性别/日期等 Figma 推不出的标 `needs_context`；**混合富文本与设计稿实例值（"Welcome, John" 里的 John）同样归 `needs_context` 人工流**。
5. **source_changed 检测**：`strings.json` 存源文案指纹（`sha256(NFC(sourceText)) + placeholders 集合`）；源文案变化 → `source_changed` 驱动重译；**语义变化 → 建议新 key**，禁止改义复用旧 key。
6. **各栈资源写入**（幂等语义与图片一致：同 key 同值 unchanged、同 key 异值 conflict、异 key 同值 reuse 建议；转义/复数/locale 码见 §13.8）：Flutter `.arb`；Android `strings.xml`（复数用 `<plurals>`）；RN JSON；iOS `.strings` + `.stringsdict`（复数，2026-10-02 决议；不用 `.xcstrings`）；Web JSON。
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
| M6b | 文本：**先做项目实际使用的 1–2 个栈**（按检测结果）→ 采集 + key 冻结映射 + `strings.json` + 资源写入 + 复用/冲突/占位符/转义；其余栈按需铺开 | ✅ 已实施（五栈写入；复数与 iOS `stringsdict` 已落地，见 §13.34） |
| M6c | 强制与联动：硬编码扫描、unusedStrings、test-gen 定位改 key 优先、迁移/冲突闭环报告 | ✅ 已实施（联动范围同 M6b） |

### 13.7 风险与未决

| 风险/未决 | 说明 |
|---|---|
| source locale 与 key 语言 | 需产品定：source 以设计稿语言为准；key 建议用英文语义名 |
| iOS 复数格式 | **已决**（2026-10-02）：`.stringsdict`（兼容全版本；不做 `.xcstrings`），见 §13.34 |
| 复数/上下文确认 | **已实施**（2026-10-02）：`.artemis/design/string-context.json` 人工确认（`{entries:{key:{plural:{variable?,forms}}}}`），见 §13.34 |
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
- 图片（§13.3 补强之一）：`applyAssetNaming` 对通用图层名（`Frame 427`）回退为确定性 `asset <figmaId hash8>`（按栈命名，如 `ic_asset_1a2b3c4d.svg`）并标 `needsRename`；位图倍率集（不再统一 @2x）已于 2026-10-02 落地（§13.35）。

**与 §13 设计的差异（记录）**
1. 文案写入已铺开至 Android/Flutter/RN/Web/iOS 五栈（原 M6b 计划先做 1–2 栈，随后补齐）；token 写入含 Android/Flutter/RN/Web/iOS（iOS 见 §13.53：`Colors.xcassets` colorsets + `AosTokens.swift`）。
2. 反向工程场景（无 Variables/Styles）下颜色命名由样例图层名推导并 `needsReview` 标注，人工经 `token-names.json` 修正，不静默猜测。
3. Android 文案写入专用生成文件（不改用户 `strings.xml`），冲突通过扫描既有资源检出。
4. `needs_rename` 文本仍写入资源（nodeId hash key）保证可用性，重命名后走正常派生。
5. 复数（`<plurals>` / ICU plural）与 iOS `.stringsdict` 已生成（2026-10-02，见 §13.34）：人工经 `.artemis/design/string-context.json` 确认 forms；iOS 决议用 `.stringsdict`（不做 `.xcstrings`），占位符按 §13.8 矩阵转换。
6. 图片兜底名以 figmaId 哈希代替内容 sha256（命名发生在导出下载前），确定性与可迁移性一致；位图倍率集（Android xhdpi/xxhdpi、Flutter 2.0x/3.0x、iOS imageset、RN @2x/@3x）已于 2026-10-02 落地（§13.35）。

### 13.10 实施记录（pen.dev 离线接入 P1 + Figma REST 限流加固）

> 实施于 2026-09-29；新增 `test/pen-read.test.js`（4 例）、`test/figma-limits.test.js`（3 例）、`test/pen-export.test.js`（5 例）与 `test/pen-cli.test.js`（7 例），全量 251 用例通过。

- **pen.dev 离线读取层**：`src/pen/read.ts`——JSONC 容忍解析（字符串感知的 `//` 与 `/* */` 剥离，不破坏 URL）、结构校验（id 唯一且不含 `/`、`ref` 可解析、`$变量` 可解析、变量名禁 `:`）、摘要（屏幕/组件/实例/文案样本/变量与主题/图片资产）。对应原生工具 `pen_inspect`（`src/pen/inspect.ts`）；path 缺省由 `src/pen/paths.ts` 统一解析（`.artemis/design` 下最新 `*.pen`），`save:true` 落盘 `.artemis/design/pen/summary.json`；**纯离线，无账号/网络需求**，测试可全离线（假 `.pen` fixture）。
- **pen 侧导出（tokens/strings/brief）**——产物路径与 Figma 版对齐：`src/pen/tokens.ts`（`pen_import_tokens`）颜色变量 → token：**变量名即 token 名**，主题取值写 `modes`（键 `axis=value`），支持 `$别名` 链（`aliasOf`）；usage/samples 来自节点 `fill`/`stroke` 的 `$引用` 计数与裸 hex 值匹配；与既有 `tokens.json` 按名合并——同值 `unchanged`、异值 `updated`（名称冻结）、消失 `unused`（值冻结语义与 Figma 反向工程版不同，因 pen 变量名本身语义化）；`src/pen/strings.ts`（`pen_import_strings`）由 `collectPenTexts` 采集文本记录（`reusable` 组件自成屏幕上下文、`ref` 不展开），复用 `runStringsImport` 全流水线（冻结 key/冲突闭环/五栈写入/硬编码扫描）；`src/pen/brief.ts`（`pen_export_brief`）复用 `renderBriefMarkdown`/`scaffoldComponentSkeleton`/`writeAssetFile`，颜色/字阶/间距/圆角/阴影聚合自 `.pen`。
- **共享抽取（Figma 侧行为不变）**：`writeStackTokenFile`（`figma/color.ts`，栈文件幂等写入）、`runStringsImport`/`renderStringsForStack`/`IMPLEMENTED_STRING_STACKS`（`figma/import-strings.ts`，采集后的公共流水线）。
- **旁路原型**：`scripts/figma-to-pen.mjs`（非服务工具）——Figma REST → `.pen`（version 2.19，官方公开 schema）：frame/group/rect/ellipse/polygon/path/text、填充（颜色/渐变/图片下载）、描边/效果/混合、组件 `reusable` + `ref` 实例、变量（从 Figma 样式生成颜色变量）、页面排布与坐标换算；带响应缓存与 429 退避（尊重 `retry-after`，>15min 不再等待）。
- **Figma 限流加固**：见 §6.2（bounded Retry-After、按 token 冷却记忆 fail-fast、缓存 TTL 10min 可配）。
- **pen CLI 写回（headless，P1）**：`src/pen/cli.ts`——`pen` 定位（`AOS_PEN_CLI_PATH` → 托管目录 → PATH，Windows 走 `pen.cmd`；托管与全自动安装见 §13.11）、`pen status` 登录态解析（email/workspace）、`interactive -i/-o` + stdin 命令管道（自动 `save()`/`exit()`）、ANSI 剥离、超时（`AOS_PEN_TIMEOUT_MS` 默认 120s）与失败分类（未安装/未登录/agent 凭证/模型不支持/execute 回滚/超时）；`pen_export`（`--export`，PNG/JPEG/WEBP/PDF；已验证 1.8s/张）；`pen_apply_tokens`（tokens.json → `SetVariables`，modes → `{value, theme}` 数组）与 `pen_apply_strings`（strings.json → `Update(content)`）默认**原位更新**：写临时文件 → 回读 .pen 校验（变量默认值/文本内容）→ 原子替换，校验失败保持原文件不变（测试覆盖回滚路径）。真实 CLI 端到端验证：inspect → import_tokens/strings → apply_tokens/strings → export 全通。
- **pen agent（headless，P1）**：`src/pen/agent.ts`（`pen_agent`）——prompt → `.pen`，凭证**复用 AOS active LLM 条目**（只进子进程 env，不落日志/响应）。CLI 的 Claude Agent SDK 走 Anthropic 协议，故按 provider 桥接（`anthropicBridgeFor`）：
  - **DeepSeek**：`api.deepseek.com` → `ANTHROPIC_BASE_URL=/anthropic`，auth=apiKey（`PEN_AGENT_API_KEY`）——**已实测**（含 `--custom` 自动开启，30.6s/14.1s 两次端到端）；
  - **Kimi/Moonshot、Z.AI/智谱、阿里云百炼 Qwen**：按官方 Claude Code 文档映射端点（`api.moonshot.cn/anthropic`、`api.z.ai/api/anthropic`｜`open.bigmodel.cn/api/anthropic`、`dashscope.aliyuncs.com/apps/anthropic`），auth=authToken（`ANTHROPIC_AUTH_TOKEN`，规避 pen 强制的 `ANTHROPIC_API_KEY`；Node 丢弃 undefined env 值），并注入 `ANTHROPIC_MODEL`/`DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`=该条目 model——**待真实 key 冒烟**（工具会在 warnings 标注"未验证"）；
  - 其他 provider：仅注入 `PEN_AGENT_API_KEY` 并告警，可用 `anthropicBaseUrl`/`AOS_PEN_ANTHROPIC_BASE_URL` 指定端点。
  默认原位更新（临时文件→`parsePenText` 结构校验→原子替换），`out` 新建/另存，`dryRun` 返回命令；失败分类覆盖 agent 凭证缺失/模型不支持。CLI agent 模型白名单仅 claude/codex/gemini，pen.dev 应用内连接的其他 provider（OpenRouter/xAI/OpenCode 等）暂不能被 CLI 选择。
- **未完成（规划）**：pen.dev MCP 代理接入（应用在环 stdio 桥，AOS 侧未代跑 pen MCP，客户端可自行挂载）；pen.dev 应用内连接的其他 agent provider（DeepSeek/Kimi/OpenRouter 等，见应用 Agents 面板）暂无法被 CLI 选择。

### 13.11 实施记录（pen CLI 依赖全自动托管）

> 实施于 2026-09-30；新增 `test/pen-install.test.js`（4 例）并扩充 `test/pen-cli.test.js`（路径解析/透传/Windows `pen.cmd` 断言修复），全量 255 用例通过。

- **决策**：`@pen.dev/cli` 解包约 51MB（sharp / claude·codex agent SDK 等），不纳入服务 npm 依赖；改为**缺失即自动安装到用户级托管目录**，客户端零感知。
- **解析链**：`AOS_PEN_CLI_PATH` → 托管目录（`AOS_PEN_CLI_DIR`，默认 `~/.aos/pen-cli`）的 `node_modules/.bin/pen(.cmd)` → PATH（`resolvePenCliPath`，`src/pen/cli.ts`）。
- **自动安装（`ensurePenCli`，`src/pen/install.ts`）**：先解析与探测（`pen version`）；缺失且允许时 `npm install @pen.dev/cli[@AOS_PEN_VERSION] --prefix <托管目录> --no-save`。约束：Node ≥ 22.19（不满足直接拒绝安装并提示）；`AOS_PEN_NO_INSTALL=1` / `AOS_DEPS_NO_ONLINE=1` 关闭自动安装；安装超时 `AOS_PEN_INSTALL_TIMEOUT_MS`（默认 600s）；失败 5 分钟冷却 + 同目录并发去重；`dryRun` 不触发。`pen_export`/`pen_apply_tokens`/`pen_apply_strings`/`pen_agent` 与 doctor 均接入。
- **`.env` 透传（`penEnvFrom`）**：白名单 `PEN_CLI_KEY` / `PEN_AGENT_API_KEY` / `ANTHROPIC_*` / `AOS_PEN_*`，进程 env 优先、active LLM 派生凭证最后覆盖；此前 `PEN_CLI_KEY` 只读进程 env，现在项目 `.env` 写入即可直达 CLI 子进程（不落日志/响应）。
- **doctor**：新增 pen CLI 状态检查（未安装/未登录为 WARN 计入 degraded，可选不阻塞；含 Node 版本提示），`doctor --install-deps` 联动预装；`aos_status` 语义不变。
- **边界**：pen.dev 登录态（`pen login`）或 Developer Key 仍需人工一次性提供，MCP 无法自我注册账号；首次自动安装需网络；HTTP/Docker 部署同样走该机制（容器内 home 可写即可）。

### 13.12 实施记录（MCP 服务名更名 android-testing + 旧键迁移）

> 实施于 2026-09-30；新增 `test/install.test.js` 旧键迁移用例、冲突用例改用新键，全量 256 用例通过。

- **决策**：服务名 `aos` 无语义（客户端 MCP 列表与工具名前缀都只显示它），更名为 **`android-testing`**——当前仅支持 Android 真机测试，不溢出到 iOS/泛移动。ASCII 为硬约束：客户端把服务名净化后作为工具名前缀（opencode：非 `[a-zA-Z0-9_-]` → `_`），且模型 API 的工具名同样只接受该字符集，故中文名不可行。
- **范围**：`install` 生成的四个客户端配置键（`mcpServers.android-testing` / `servers.android-testing` / `mcp.android-testing`）与 Codex 手动片段同步；工具名本身不变（`mobile_run_task` 等照旧）。
- **旧键迁移（`removeJsoncPath`，`src/install.ts`）**：install 写入前先移除同一父路径下的历史键 `aos`，避免同一客户端同时加载新旧两个 server；仅移除该历史键，不动其他 server 与注释。
- **部署备注（客户端零配置发现）**：opencode 以工作区目录为 cwd 启动本地 MCP（`connectLocal` 取 `InstanceState.directory`），因此用户级全局配置挂载不带 `AOS_PROJECT_DIR` 的 `android-testing` 条目即可被所有项目发现（AOS 项目识别链回退 cwd）；`install` 仍为按项目精确挂载（写入 `AOS_PROJECT_DIR`）。

### 13.13 实施记录（design_device_diff v1：设计 vs 真机确定性差异）

> 实施于 2026-10-01，对应 spec `.scratch/design-device-diff/spec.md` 与票据 01；新增 `test/diff-engine.test.js`（10 例）与 `test/design-device-diff.test.js`（7 例），全量 272 用例通过。

- **范围（v1 最小闭环）**：Figma 节点 × 实时截图；差异分类与严重度、步骤截图、`.pen` 设计源、`screen_map` 定位按票据 02–07 后续实施。
- **差异引擎（纯函数，ADR-0002）**：`src/diff/engine.ts`——PNG/JPEG 解码（pngjs/jpeg-js）、设计宽度缩放 + 顶部对齐、insets 裁剪、`ignoreRegions` 判定前屏蔽、默认降采样最长边 1440px（区域坐标按比例还原）、pixelmatch `diffMask` 提取差异像素（默认阈值 0.1、抗锯齿剔除）、扫描线组件合并（聚类间距 8px）、最小面积 0.5% 与区域数上限 20、确定性排序（严重度→面积→坐标；同输入两次运行引擎输出逐字节一致）；`src/diff/annotate.ts` 生成标注图（严重度色框 + 点阵序号）。
- **工具**：`design_device_diff`（`src/diff/tool.ts`）——设计渲染经 `src/figma/render.ts`（Figma REST；diff 路径取 1× 以对齐 1× 节点几何，§13.17；`compare_design_and_device` 复用同一抽取但保持 2×，行为不变）；真机截图经既有代理通路 `mobile_get_device_state`；默认落盘 `<项目>/.artemis/design/diffs/<node>-<时间戳>/`（`report.json` schemaVersion=1 / `annotated.png` / `design.png` / `device.png`，device 重编码为真 PNG），响应=摘要 JSON + 标注图 image block + 路径；`dryRun` 不取图不写盘；写盘失败清理半成品；判定不依赖 LLM（ADR-0001）。
- **测试**：合成 golden（JPEG 有损无差异零误报、注入差异区域与容差、确定性、insets、ignoreRegions、降采样坐标还原、最小面积）+ 工具层（temp project + StubProxy + fetch stub、dryRun、错误与清理）；不依赖设备/网络/Python。
- **评审修订（Standards/Spec 双轴）**：dryRun 预览改用 URL 解析 nodeId（与落盘目录一致）；聚类改扫描线并去掉组件数上限；`device.png` 重编码为真 PNG；补「写盘失败清理」用例；标注拆模块；测试图像工具收进 `test/helpers.js`。
- **后续（frontier）**：票据 02（步骤截图）与 03（分类与严重度）解锁；04 依赖 02；05 依赖 01；06 依赖 01/03；07 依赖 03。

### 13.14 实施记录（design_device_diff 票据 02：显式步骤截图）

> 实施于 2026-10-01；新增 `test/diff-step-capture.test.js`（6 例），全量 278 用例通过。

- **设备源抽取**：`src/diff/device-source.ts`——`captureLiveScreenshot`（原 tool 内逻辑外移）与 `captureStepScreenshot`：经 `runtime.proxy.callTool("mobile_inspect_trace", {action:"view_step_screenshots", trace_id, step_number})` 取 `before_screenshot`/`after_screenshot`（`file://` 路径解码后读文件），不直读上游数据库（ADR-0003）。
- **工具语义**：`device.mode="step"` 需 `traceId` + `stepNumber`（缺失即结构化报错），`image` 选 `post`（默认，行动后）或 `pre`（行动前）；报告 `unit.device={mode,traceId,stepNumber,image,serial?}`；`live` 行为不变（unit 省略 image）。
- **错误分类**：上游 `{error,message}`（如 Step not found）、返回不可解析、对应截图为空、文件缺失，均返回带提示的结构化错误；校验发生在取图之前。
- **测试**：post/pre 选择（pre 与设计一致 → 0 区域，post 有改动 → 1 区域，证明选图正确）、缺参校验、上游错误、文件缺失；复用既有 StubProxy/fetch stub seam。

### 13.15 实施记录（design_device_diff 票据 03：差异分类与严重度）

> 实施于 2026-10-01；`test/diff-engine.test.js` 新增 9 例分类/严重度用例，全量 287 用例通过。

- **设计侧几何进引擎**：`diffScreens` 新增 `designNodes`（`{id,name,type,x,y,width,height,text?,parentFill?}`，设计坐标）与 `nodeProximity`/`colorTolerance`/`systemBandRatio` 阈值，输出 `thresholds`（实际生效的 8 项阈值，工具参数已全部暴露）——无节点几何时类别回退 `pixel`。
- **分类规则（确定性，不依赖真机结构）**：区域按与设计节点的最大交集判定——交集占区域 ≥60% 时：文本节点 → `text`；image/vector/path/ellipse/polygon/star → `asset`；节点被覆盖 ≥60% 时比较设备区域均色与节点 `parentFill`（容差 24）：相同 → `missing`（元素缺失露出父级背景），不同 → `color`；部分覆盖 → `position-size`。无交集：与最近节点距离 ≤ `nodeProximity`(24px) → `position-size`，否则 `extra`。区域携带 `designNode{id,name}`。
- **严重度**：比例阈值（0.1/0.03/0.005）与类别下限取更严者——`missing`/`extra`/`text` 至少 `major`；无设计节点且落在上下边缘条带（默认高度的 5%）的区域标 `suspected:"system-area"` 并压为 `info`。
- **Figma 几何**：`src/figma/render.ts` 新增 `fetchFigmaDesignNodes`（REST `/nodes`，绝对包围盒归一化到目标节点原点，SOLID 填充 hex、最近祖先填充作 `parentFill`，上限 500 节点）；获取失败仅告警并把分类降级为 `pixel`，不阻断对比。
- **报告/响应**：新增 `designNodes` 数、`thresholds`、`warnings`，区域含 `category`/`designNode`。
- **测试**：引擎合成用例覆盖 missing（父级填充匹配）、color、text、asset（含 `BOOLEAN_OPERATION`）、position-size（位移双条带）、extra、system-area、blocker/minor 严重度与阈值记录；工具层默认 Figma 节点树端到端断言 `missing` + `designNode.id`。
- **评审修订（Standards/Spec 双轴）**：`asset` 覆盖补 `line`/`boolean_operation`；近邻命中的 `position-size` 保留节点引用（避免贴边误降级 system-area）；半透明 `parentFill`（alpha<250）不做 missing 判定；`systemBandRatio` 进工具参数；阈值项数与文档对齐；`FigmaDesignNode` 复用引擎 `DesignNode` 类型、颜色转换复用 vendor `rgbaToHex`、响应共享字段去重。

### 13.16 实施记录（design_device_diff 票据 04：失败证据自动锚点）

> 实施于 2026-10-01；新增 `test/diff-auto-anchor.test.js`（4 例），全量 291 用例通过。

- **锚点解析（best-effort，ADR-0003）**：`device.mode=step` 仅给 `traceId` 时，`resolveTraceStepAnchor` 先经上游 `mobile_manage_task(action:"status")` 取 `test_summary.failed_items`（evidence 优先、item_text 兜底，截断 160 字符），再经 `mobile_inspect_trace(action:"search")` 检索并按 `[Step N ...]` 解析候选（去重、按检索排序取首个）；不直读 SQLite/ledger。
- **报告与响应**：`unit.device` 增 `anchor`（`explicit`/`search`）；响应 `anchor{source,query,candidates[≤5],ambiguous}`；多命中取首个并在 `warnings` 提示可用显式 `stepNumber`。
- **错误路径**：无失败证据（任务通过或 Flash 无 `run_outcome`）、检索零命中、上游错误均结构化报错并附「显式传 stepNumber」提示；设备采集先于 Figma 渲染，锚点失败不产生设计侧网络请求。
- **测试**：命中（含调用顺序 manage_task→search→view_step_screenshots、query/max_results、anchor 字段）、唯一命中不标歧义、无证据（仅一次上游调用）、零命中（不取图）。

### 13.17 实施记录（design_device_diff 票据 05：`.pen` 设计源）

> 实施于 2026-10-01；新增 `test/diff-pen-source.test.js`（5 例），全量 296 用例通过。

- **节点几何（离线）**：`penDesignNodes`（`src/diff/pen-source.ts`）将 `.pen` 解析为引擎 `DesignNode[]`：父级坐标累加得到绝对坐标；`fill` 支持 hex 与 `$变量`（经 `penVariableDefaultHex` 解析）、最近祖先填充作 `parentFill`；`layout` 非 none 的容器下、无 `layoutPosition:absolute` 的子节点无确定几何时跳过（避免误分类）；无宽高的中间容器只收敛自身、不剪掉子树（子节点用其 `x/y` 继续累加）。`depth` 记录层级，报告输出 `designScreens`（顶层节点名称/几何，≤10）。
- **渲染复用 CLI 通路**：`renderPenDesign` 与 `pen_export` 同构——`penEnvFrom`（项目 .env 白名单 + 进程 env）→ `ensurePenCli`（缺 CLI 自动托管安装；测试可注入 `deps.ensure`）→ `runPenExport`（PNG、**scale 1**：与 `.pen` 1× 节点几何对齐；失败分类与「未产出即清理」沿用 pen 工具语义），默认输出 `.artemis/design/pen/<name>.png`，`design.renderOut` 可覆盖；产物复用为 `design.png`。Figma 路径的 diff 渲染同步改为 1×（节点几何同为 1×）。
- **错误提示**：缺 `.pen` 文件返回 `PEN_HINT`（获取文件指引），CLI 未装/未登录/超时返回 `PEN_CLI_HINT`。
- **工具接口**：`design:{source?:"figma"|"pen", figmaUrl?, penPath?, nodeId?, renderOut?}`（省略 source 时按 figmaUrl/penPath 推断；`source:"pen"` 时 `penPath` 缺省取最新）；`timeoutMs` 透传渲染；报告 `unit.design={source:"pen",name}`；dryRun 仅解析路径不调用 CLI。
- **分类改进**：dominant 节点选择在交集面积相同时取更小节点（容器不再压过子元素；对 Figma 路径同样生效）。
- **测试**：离线 fixture `.pen`（嵌套坐标/`$变量`/flex 子节点）+ 假 pen exec/ensure（写 PNG、失败/未登录分支）+ StubProxy 设备截图，覆盖分类 `missing`、`--export-scale 1`、产物字节一致、`designScreens`、默认最新文件、参数校验与 dryRun。评审修订另含：设备/锚点采集先于设计渲染（失败不触发渲染与 CLI 安装），移除超出票据的 `timeoutMs` 入参。

### 13.18 实施记录（design_device_diff 票据 06：screen_map 定位）

> 实施于 2026-10-01；新增 `test/diff-screen-map.test.js`（5 例），全量 301 用例通过。

- **持久映射**：`src/diff/screen-map.ts`——`screen-map.json`（version=1；条目 `{design:{screen?,nodeId?,component?}, code:{route?,component?,file?}, source?, confidence?}`：屏幕或组件至少一项），确定性序列化（按 design key 排序、固定键序），`save` 幂等（同内容 `unchanged`）、`merge:true` 按 design key 增量合并；`list` 缺文件返回空表与提示；非法条目逐条报索引（ADR-0004）。
- **候选生成**：`propose` 读 `build-brief.json`（screens/components）+ 栈约定（`formatComponentFileName`/`toCase`/组件目录），屏幕→route/组件/文件候选（confidence 0.6）、组件→文件候选（0.5）；泛化名称进 `unmatched` 不猜测；缺 build-brief 时结构化报错并引导 `figma_export_brief`/`pen_export_brief`。
- **报告定位**：`design_device_diff` 为每个差异区域写 `localized`——按 `design.nodeId` → `design.component` → 所在屏幕（`design.screen`）顺序命中为 `mapped`（附 `mapEntry`）；否则用 build-brief 候选（按所在屏幕/组件过滤，≤3）标 `unmapped`；无候选标 `no-candidates` 并带 `reason`（区分「无 build-brief」与「条目未覆盖」）。候选在首个未映射区域出现时才惰性生成（已全映射不读 build-brief）；`screen-map.json` 损坏时 `list` 标记 `corrupt` 并提示，差异流程只读不改写。
- **几何来源补充**：Figma `fetchFigmaDesignNodes` 现输出目标节点自身为 depth=0 屏幕节点（子节点 depth+1），与 `.pen` 顶层屏幕语义一致；`designScreens` 取 depth=0。
- **测试**：propose（候选/confidence/unmatched/缺 brief 报错）、save/list（幂等/merge/非法/空）、diff 集成（mapped/unmapped/no-candidates 三态）。

### 13.19 实施记录（design_device_diff 票据 07：真实基准 fixture 与验收指标）

> 实施于 2026-10-01；新增 `test/diff-benchmark.test.js`（2 例）与 `test/fixtures/diff-bench/`（real Pixel 采集 2026-09-28 的 `device.jpg` 1080×2400、由其裁剪降采样再注入两处已知差异的 `design.png` 390×789、`ground-truth.json` 记录来源/insets/期望差异），全量 303 用例通过。

- **基准指标**：区域召回（差异中心落入期望 bbox±16px）与类别命中（`missing`/`color`）必须均为 1，且不得出现额外区域（噪声）；失败输出「实际区域 + 期望用例」明细。另含三个真实图场景：设备 JPEG 低质量重编码（q60）零误报（抗噪/阈值校准证据）、`ignoreRegions` 在真实图上屏蔽且 `ignoredRegions` 回显、不裁剪 insets 时系统条带被标 `suspected:system-area` 且降为 `info`。
- **schema 快照**：引擎结果顶层键、`thresholds`（8 项）、区域键（`bbox/category/designNode/pixelDiffRatio/severity`）与 `alignment/summary` 键集合被快照锁定；工具层 `report.json` 顶层键顺序在 `test/design-device-diff.test.js` 中按原顺序断言。fixture 可由 `scripts/make-diff-benchmark.mjs <device.jpg>` 复现（来源、insets、重绘颜色/尺寸记录在 `ground-truth.json`）。
- **顺带修复（引擎，行为变更）**：`maxEdge` 原先把设备图（1080×2400）计入最长边，导致设计先被降采样、设备再经「factor 缩放 + 对齐缩放」两次重采样，小块差异被最小面积误滤；现改为**只按设计图最长边**决定是否降采样（`downsampledTo` 仅在设计图超限时出现），设备图直接一次缩放到设计宽度。`alignment.scale` 语义为**设备像素 → 工作（设计）坐标系的比例**（设计降采样时含 factor；旧实现恒为 1× 比例）；区域 `bbox` 仍按 factor 还原到原设计坐标。回归测试锁定：大设备 + 小差异不被误滤、`downsampledTo` 不因设备超长出现、`scale` 含设计降采样因子。
- **离线约束**：测试只读仓库内 fixture 解码比对，不依赖设备/网络/Python。

### 13.20 实施记录（测试闭环票据 04：用例间状态复位）

> 实施于 2026-10-01；新增 `src/device/adb.ts`（从崩溃采集抽出 adb 解析/执行/失败分类，`src/crash/collect.ts` 导出面不变）与 `src/device/reset.ts`（`resetApp`）；`test/reset.test.js` 9 例；全量 330 例通过。

- **上游语义（代码 + 真机核实）**：`_handle_initial_app_launch` 在锁定应用已在前台时直接返回成功、不重新启动（`artemis/artemis/utils/app_launch_utils.py:369-378`）；`monkey -c LAUNCHER 1` 仅在非前台或重试时调用（`artemis/artemis/drivers/android/adb_driver.py:385-392`），`am force-stop` 仅在启动重试失败时出现（`app_launch_utils.py:299-305`）。emulator-5554 实测：深层页下单独 monkey 可回主 Activity，`force-stop + monkey` 产生全新 task——确认残留状态会被带入下一用例，复位必须显式做。
- **复位能力**：`resetApp({packageName, serial?})` 顺序执行 `adb [-s serial] shell am force-stop <pkg>` 与 `adb [-s serial] shell monkey -p <pkg> -c android.intent.category.LAUNCHER 1`，包名先按 Android applicationId 规则校验（防注入）；返回 `{ok, reason?, message?, serial, adb:{path,source}, commands}`；失败分类 `invalid-package / adb-not-found / device-offline / timeout / force-stop-failed / launch-failed`，环境类失败降级不抛错（由运行器决定继续或停止）；`AOS_RESET_TIMEOUT_MS` 默认 15s（1s–120s），adb 路径沿用 `AOS_ADB_PATH` / SDK / PATH 解析链。
- **待消费**：票据 08（最小套件运行器）在每例前调用；云真机/无 adb 部署按 `reason` 降级并在运行报告标注。

### 13.21 实施记录（测试闭环票据 05：用例身份与运行台账）

> 实施于 2026-10-01；`tests.json` 用例新增稳定 `id`（`generateTestCases` 按 name/screens/steps 的 sha256 前 12 位，同输入稳定）；`task_stats` 增 `case_id`（存量库 init 时 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 兼容）；新增 `src/figma/case-index.ts`（精确 `taskDesc` → caseId 查询）；`Runtime.recordTaskResult` 统一提交记录（成功/即时报错/无 trace）。测试 `test/case-ledger.test.js` 4 例 + `test/db.test.js` 台账往返；全量 335 例通过。

- **身份**：生成器冻结 `case-<sha256(name,screens,steps)[0:12]>`；id 不进入 taskDesc（避免污染 LLM 上下文）。
- **台账语义修复**：即时报错也记录且终态 `failed`；无有效 trace 用 `local-<uuid>` 占位并直接终态（不再有永不收敛的 `unknown` pending）；`profile` 与 `model` 分离（不再同值）；终态行写 `finished_at`。
- **工具面**：`aos_tasks` 返回 `case_id`，可按用例关联 trace 与后续证据（票据 09/11/12 消费）。

### 13.22 实施记录（测试闭环票据 06：任务结果 codec）

> 实施于 2026-10-01；新增 `src/artemis/task-result.ts`；测试 `test/task-result.test.js` 6 例；全量 341 例通过。

- **一个 module 拥有 MCP 字符串边界**：`resultText`（文本拼接）、`parseJsonObject`（对象 JSON，非法返回 null）、`resultPayload`（structuredContent 优先 → 文本 JSON）、`traceIdOf`（structured/文本字段 + 文本正则回退）、`taskStatusOf`（类型化 `TaskStatus`：trace/status/device/error/message/testSummary.failedItems/notes/stderr/stdout/时间窗秒→毫秒）、`taskStatusFromFile`（status.json 同 codec）。
- **删除的重复实现**：`Runtime.extractJson`、`server.extractTraceId`、`diff/device-source.parsePayload`+`textContent`、`composite` 内联 `JSON.parse`；`crash/scanner.readTraceStatusInfo` 改由 `taskStatusFromFile` 驱动（状态文件与上游状态响应语义一致）。
- **约束**：mobile 工具 schema 逐字节透传不变（`test/proxy.test.js` 锁定）；失败步骤自动锚点行为与报错语义保持（`test/diff-auto-anchor.test.js` 锁定）；`test_summary/error` 首次可结构化消费（票据 09/10 使用）。

### 13.23 实施记录（测试闭环票据 07：可执行性预检与覆盖视图）

> 实施于 2026-10-01；新增 `src/figma/preflight.ts`、`linearizeFlowsWithStats`；测试 `test/test-preflight.test.js` 3 例。

- **生成统计不再沉默**：`linearizeFlowsWithStats` 输出 `{maxFlows,maxDepth,entryFallback,exploredPaths,keptPaths,droppedPaths,depthSplits,truncated}`；`figma_generate_tests` 经 `onStats` 回调把 `generation` 写入响应与 tests.json（入口回退、截断、丢弃路径数可见）。
- **静态预检**（`preflightGeneratedTests(configDirAbs)`，纯读）：弱用例（步骤缺「应」类断言）逐条给出步骤索引与原因；覆盖视图列出未覆盖屏幕与未覆盖边（边以用例 `screens` 的连续对判定）；透传 `generation`；缺 flows.json 时覆盖退化为已生成屏幕；tests.json 缺失/损坏返回 null。

### 13.24 实施记录（测试闭环票据 08：最小套件运行器）

> 实施于 2026-10-01；新增 `src/figma/suite-runner.ts` 与 `Runtime.traceStatus`；测试 `test/suite-runner.test.js` 6 例。

- **运行循环**（`runGeneratedTests(runtime, options)`）：读 tests.json（可 `maxCases`）→ 逐例：可注入复位（默认 04 的 `resetApp`，降级不阻塞）→ 提交 `mobile_run_task`（透传 model/device_serial/locked_app_package，不改 schema）→ 轮询终态（`Runtime.traceStatus`：status.json 优先、代理回退；超时/间隔可配）→ `syncTaskStatuses()` 写回台账并触发崩溃采集。
- **报告**：逐例 `{caseId,name,status(passed/failed/timeout/submit-error),traceId,error,testSummary,evidence{notesDir,stderrLog,stdoutLog},reset}` + `passed/failed/skipped/total` + `preflight` 摘要；`stopOnFailure` 遇错即停；仅当 0 例提交成功时 `ok:false` 并给出明确 error（无设备/无 adb 场景）。
- **入口**：当前为模块级入口；MCP 工具 vs CLI 脚本（开放问题 3）待决策后接线（已由 §13.33 决议：CLI）。

### 13.25 实施记录（测试闭环票据 09：失败证据包）

> 实施于 2026-10-01；新增 `src/artemis/evidence.ts` 与 `Runtime.traceDir`；测试 `test/evidence.test.js` 5 例；全量 355 例通过。

- **一次调用聚合**（`traceEvidence(runtime, {traceId, fullTrace?, save?, outputDir?, design?, diffRunner?})`）：任务状态 + 全部 `failed_items` + 崩溃签名（`crashStore` 按 `traceIds` 过滤）+ 锚定失败步骤与截图 + 可选设计差异引用（`design_device_diff` step 模式，`diffRunner` 可注入）。产物默认落 `<项目>/.artemis/design/evidence/<traceId>/`：复制锚定步骤 pre/post（`fullTrace` 复制全部锚点候选步骤，上限 10），`manifest.json` 记录其余 stderr/stdout/notes/status/crash 记录/差异报告为路径引用（不复制）。
- **降级而非报错**：`trace-status-missing / no-run-outcome（Flash）/ anchor-skipped / anchor-unavailable / design-diff-failed / screenshot-unavailable / evidence-write-failed`；无任何证据时不建目录（`dir:null`、`ok:false`）。
- **顺带修复（行为变更）**：`resolveTraceStepAnchor` 原先把任务态的 `error` 字段误判为工具调用错误（失败任务带 error 时自动锚点必然失败），现仅在无 `status` 字段时按工具错误处理；由证据用例与既有 anchor 用例共同锁定。
- **入口**：模块级；MCP 工具 vs CLI 同票据 08 待开放问题 3（已由 §13.33 决议：CLI）。

### 13.26 实施记录（测试闭环票据 10：前置数据假设与失败域分类）

> 实施于 2026-10-02；新增 `src/figma/preconditions.ts`、`src/artemis/failure-taxonomy.ts`；测试 `test/failure-taxonomy.test.js` 7 例 + testgen/suite-runner 增补；全量 370 例通过。

- **生成物显式前置假设**：`deriveCasePreconditions(screens,{entryFallback?})` 确定性产出：应用已安装 → 开始停留入口页（入口推断时附「入口屏未声明」）→ 屏幕名启发式（登录/账号 → 可登录；profile/我的 → 已登录；列表/list/消息/订单/商品/购物车 → 数据非空）；去重保序。每条用例 `preconditions` 进入 `tests.json`、`tests.md`（`- 前置假设：…`）、`tests.xlsx`（默认表新增「前置假设」列；模版占位符新增 `{{case.preconditions}}`）与 taskDesc 行（`前置假设：…；若数据不满足，请停止并报告数据不满足`）；case id 不变（仍哈希 name/screens/steps）。
- **失败域确定性分类**（`classifyFailure`，纯函数）：优先级 应用缺陷（与 trace 关联的崩溃签名，high）→ 环境（复位 `adb-not-found/device-offline/timeout` 或失败文案含 adb/device/no devices/设备离线 等，high）→ 数据环境（失败文案含登录/账号/数据/列表/网络 等信号；命中前置假设 high，否则 medium）→ 设计推断（纯探索脚本失败 high；断言有凭据全命中且探索未全达成 medium，见 §13.66）→ 行为或设计差异（有 `failed_items` 且无其它证据，high）→ 用例缺陷（轮询超时 / 提交被拒且文案含参数/格式/task_desc，medium）→ unclassified low 并给出原因；规则固定顺序、固定样本可回归（同输入输出 deepEqual）。
- **ADR-0001 边界**：分类是解释层，输入不含设计差异结果、输出不参与也不改写 diff 判定；`design_device_diff` 契约未动。
- **运行器接入**：`SuiteCaseResult.failure`（passed 为 null）；失败终态先 `flushCrashScans()` 再按 trace 过滤 `crashStore` 取崩溃签名，复位降级/提交失败/超时分别入参分类；运行报告即含逐例分类与判定依据（票据 12 导出消费）。

### 13.27 实施记录（测试闭环票据 11：真机基线视觉回归）

> 实施于 2026-10-02；新增 `src/diff/baseline.ts`；测试 `test/baseline.test.js` 6 例；全量 370 例通过。

- **基线与分桶**：`saveBaseline` 从任务步骤截图（`captureStepScreenshot`，pro 步骤证据）复制 `image.png` 并写 `meta.json`（schemaVersion/serial/caseId/stepNumber/image/width/height/dpi/ignoreRegions/traceId/capturedAt）；目录 `<项目>/.artemis/design/baselines/<serial>/<caseId>/step-<N>-<pre|post>/`（段名净化），显式 serial 优先、回退截图设备、再回退 `default`。
- **设备对设备比较**：`compareBaseline` 用同一 `diffScreens` 引擎（`maxEdge` 4096，基线/当前同分辨率不缩放；`ignoreRegions` 取基线元数据与本次入参并集）；分辨率不同 → `unmapped:resolution-mismatch`，DPI 双方均已知且不同 → `unmapped:dpi-mismatch`（不比对）；无基线 → `no-baseline` 而非报错。
- **三类判定**：`last-diff.json` 保存上次区域；本次区域按类别 + 中心距 ≤24px 配对 → `new`/`persisting`，未被配对的旧区域 → `fixed`；`summary {regions,new,persisting,fixed}`；同输入判定确定性由 新→持续→修复 生命周期用例锁定。
- **边界**：与设计 vs 真机 `design_device_diff` 并存、互不替代（复用 `diffScreens` 但不改其契约，diff 用例全量回归）；模块级入口，票据 13 消费（已由 §13.33 接线为 CLI）。

### 13.28 实施记录（测试闭环票据 12：运行报告导出）

> 实施于 2026-10-02；新增 `src/figma/run-report.ts`；测试 `test/run-report.test.js` 3 例；全量 373 例通过。

- **从台账生成**（`buildRunReport(runtime, {limit?,caseIds?,outputDir?,save?,stamp?})`）：读 `store.listTasks`（按 submittedAt 升序、traceId 次序稳定；`caseIds` 过滤），逐行映射 `outcome`（completed→passed / submitted→pending / 其余→failed）；`durationMs` 优先状态文件 `start_time/end_time`，回退台账 submittedAt/finishedAt；证据取 `traceStatus` 的 notes/stderr/stdout + 恒有 `traceDir`；用例名与前置假设按 caseId（回退 taskDesc 精确匹配）关联 `tests.json`；失败行复用票据 10 的 `classifyFailure`（台账无复位/提交错误，依据状态 + trace 崩溃 + 前置假设）。
- **产物**：xlsx 结果页 `<项目>/.artemis/design/reports/run-<stamp>.xlsx`（#/用例/用例ID/结果/台账状态/耗时(秒)/traceId/失败域/置信度/判定依据/证据路径，冻结表头）与 JUnit XML `run-<stamp>.xml`（`testsuites/testsuite aos-run` 计数与总耗时、`testcase` name/classname/time、failed → `failure type=失败域 message=判定依据`、pending → `skipped`；XML 转义）；不触碰既有 `tests.xlsx` 生成契约与模版语义（testgen 用例全量回归）；`save:false` 不写盘。

### 13.29 实施记录（测试闭环票据 13：执行反馈回生成器）

> 实施于 2026-10-02；新增 `src/figma/generation-feedback.ts`（`RunReportCase` 增 `failedItems` 透出 failed_items）；测试 `test/generation-feedback.test.js` 3 例；全量 376 例通过。

- **只读聚合**（`buildGenerationFeedback(runtime, {limit?,minFailures?})`，minFailures 默认 2）：复用 `buildRunReport(save:false)` 的台账映射 + 票据 10 分类，叠加 `preflightGeneratedTests` 的弱断言与设备基线扫描（`baselines/<serial>/<caseId>/step-*/last-diff.json` 有区域即未消除热点）。输出 `issues`：`screens`（失败用例涉及屏幕计数）、`assertions`（failed_items 的 itemText/evidence 归并）、`data`（分类证据里的 `precondition:*`）、`weakAssertions`（无「应」步骤）、`visualHotspots`（区域数/类别/目录）。
- **建议与可追踪**：`suggestions[]` 四种 kind——`prompt`（屏幕反复失败加定位/等待/断言）、`data`（前置数据假设总不满足）、`hint`（断言反复失败或基线差异未消除）、`assertion`（弱步骤补断言）；每条带 `targets`（caseId/screen/stepIndex/precondition）与 `caseIds`/`traceIds` 历史回溯；排序计数降序 + 码点次序，同输入确定性。
- **默认不改写**：不写任何文件、不修改生成物；是否应用由调用方决定（数据/断言标注、提示词调整）。

### 13.30 实施记录（测试闭环票据 01：生成器拆分）

> 实施于 2026-10-02；新增 `src/figma/test-xlsx.ts` 与 `src/figma/gaps.ts`；全量 376 例通过，产物与工具行为不变。

- **xlsx 引擎独立**：`WorkbookMeta`、默认表、模版占位符/样式/行复制、错误语义全部移至 `test-xlsx.ts`（`renderTestsWorkbook` 原样搬移）；`test-gen.ts` 仅保留生成/线性化/markdown 并引用引擎；测试改从 `dist/figma/test-xlsx.js` 导入引擎，断言不变。
- **缺口分析独立**：`flows.ts` 的项目扫描/命名/缺口工具段（`globToRegExp`、`walkProjectFiles`、`readTokenContents`、`normalizeAssetName`、`isGenericLayerName`、`GapInput/GapResult`、`analyzeGapData`、`applyAssetNaming`、`figmaGapAnalysis`）整体移至 `gaps.ts`；`color.ts`/`strings.ts`/`import.ts`/`server.ts` 改从新 module 导入；`flows.ts` 只留流程图抽取（`buildFlowGraph`/`figmaExtractFlows`）。

### 13.31 实施记录（测试闭环票据 02：契约补全与 Runtime 专项测试）

> 实施于 2026-10-02；新增 `test/runtime.test.js`（6 例）、假子进程工具定义抽到 `test/fixtures/fake-artemis-tools.mjs`；全量 382 例通过。

- **5/5 透传契约**：`test/proxy.test.js` 从假子进程共享的 `UPSTREAM_TOOLS` 逐工具 deepEqual `{name,description,inputSchema}`（含 required/additionalProperties），不再只验 `mobile_diagnose` 一个。
- **Runtime 专项**：`test/runtime.test.js` 直接断言四条清扫分支——无记录 no-op、死 pid 清 state、owner 存活不动、cmdline 不匹配不杀、`bash exec -a "python -m mcp_server"` 真进程孤儿被终止并回报（跳过 win32）；另断言默认装配（store/state/crashStore/traceDir/惰性代理）与 `dispose`。删除 `sweepStaleChild` 实现或任一分支都会使其变红；不依赖真实 PG/设备/外网。

### 13.32 实施记录（测试闭环票据 03：测试反馈提速）

> 实施于 2026-10-02；全量 382 例通过，语义/断言不变。

- **夹具去重**：`helpers.makeTempDir(prefix)` 收敛全仓 25+ 处 `fs.mkdtempSync(path.join(os.tmpdir(), …))`；`test/fixtures/logcat.mjs`（`logcatTime`/`logcatLine`）收敛 crash-parse/crash-collect/crash-tools 三份时间戳格式化；`test/fixtures/figma-flow-doc.mjs`（`syntheticFlowDocument({extraEntry})`）收敛 figma-flows/figma-testgen 两份合成文档（保留 transition 与入口变体，断言全绿）。
- **聚焦运行**：`npm run test:file -- <files>`（先构建再跑，不会跑旧 dist）、`npm run test:name -- "<pattern>"`（`sh -c` 包装保证 pattern 位于文件参数之前；恒带 `test/*.test.js`，避免 Node 无参发现扫入 submodule）。
- **覆盖率**：`npm run test:coverage` = 先构建 + `node --test --experimental-test-coverage test/*.test.js`（Node 内置，无第三方依赖）；当前 lines 91.65%。

### 13.33 实施记录（开放问题 3 决议：测试闭环 CLI 接线）

> 实施于 2026-10-02；新增 `src/suite-command.ts` 与 `aos-mcp suite` 子命令；测试 `test/suite-command.test.js` 7 例；全量 389 例通过。

- **决议**：测试闭环（票据 08/09/11/12/13 的模块）接线为 **CLI 子命令**，不新增 MCP 工具、不动 mobile 透传契约。理由：suite 轮询单次可达数分钟，MCP 同步调用易触发客户端超时；CLI 天然支持长任务、退出码与 CI 门禁，且 `suite run` 失败仍可回到 agent 用 `mobile_run_task`/`suite evidence` 细查。
- **命令面**（`node dist/cli.js suite …`，公共 `--project <dir>`/`--json`）：`run`（tests.json，`--tests/--max/--stop-on-failure/--device/--app/--model/--poll-timeout`，输出预检摘要 + 逐例 PASS/FAIL + 失败域 + 证据命令）、`evidence <traceId>`（`--full-trace/--out/--no-save/--design-figma|--design-pen/--node`）、`baseline save|compare`（`--case/--step/--trace/--image/--serial/--dpi/--ignore`；compare 支持 `--fail-on new|persisting|any`）、`report`（`--limit/--case/--out/--stamp/--no-save/--no-sync`，默认先同步台账再导出）、`feedback`（`--limit/--min-failures`）。
- **退出码**：0 成功/全通过；1 用例失败或证据缺失；2 参数/执行错误、tests.json 不可读或 `--fail-on` 命中回归。`help` 子命令输出完整用法。
- **装配**：默认 `loadProject({env: AOS_PROJECT_DIR 覆盖}) → createProjectStore（PG 失败降级内存）→ Runtime.initialize()`，结束 `disposeSync` 子进程并关闭 store；`buildRuntime` 可注入，测试用假 proxy/内存 store 跑 7 条路径（run 全通过/失败分类/缺文件、evidence 聚合与离线降级、baseline 生命周期与门禁、report/feedback 产物与建议、help/未知子命令）。
- **历史入口指针**：§13.24/§13.25/§13.27 的"模块级入口"已由本节接线。

### 13.34 实施记录（M6 收尾：复数与 iOS stringsdict）

> 实施于 2026-10-02；`src/figma/strings.ts` + `src/figma/import-strings.ts`；测试 `test/strings-plural.test.js` 5 例；全量 394 例通过。决议：iOS 用 `.stringsdict`（兼容全版本，不做 `.xcstrings`）。

- **人工确认流**：`.artemis/design/string-context.json`（`{version,entries:{"<canonical key>":{plural:{variable?="count",forms:{zero|one|two|few|many|other}}}}}`，`other` 必填、forms 仅允许 `{variable}` 占位符）。`loadStringContext` 逐条校验：缺 `other`/非法 quantity/多余占位符/格式错误 → 记入 `stringContext.errors` 并忽略该条；未命中任何 key → `stringContext.unmatched`；报告 `stringContext.pluralKeys`、`counts.pluralized`，`counts.needsContext` 只统计未确认项；hint 给出文件契约。`needs_context` 条目被确认后即写入（`isWritable`），无需改 lifecycle。
- **各栈写入**：Android 同文件 `<plurals name><item quantity>`（quantity 按 zero/one/two/few/many/other 固定序，`{count}`→`%1$d`，字面 `%`→`%%`、`'`/XML 转义）；Flutter arb/RN/Web JSON 写 ICU `{count, plural, …}`，Flutter `@key.placeholders.count.type="int"`；iOS `.strings` 跳过复数 key，另生成同目录 `Localizable.stringsdict`（`NSStringLocalizedFormatKey=%#@count@`、`NSStringFormatSpecTypeKey=NSStringPluralRuleType`、`NSStringFormatValueTypeKey=d`、`{count}`→`%d`，同 marker；无复数时不建文件）。
- **幂等与冲突**：复用各栈既有语义（生成文件二次导入 `unchanged`；用户已有同名普通 string/JSON key → 维持 conflict 流程，复数转换不静默覆盖）。
- **pen 侧自动复用**：`pen_import_strings` 走同一 `runStringsImport`，无需改动。

### 13.35 实施记录（M6 收尾：位图倍率集）

> 实施于 2026-10-02；`src/figma/import.ts` + `figma_import_assets` schema；测试 `test/import-assets.test.js` +3 例（含 Android/iOS 集成）；全量 397 例通过。决议：全栈倍率默认开启。

- **plan 展开**：`planImports(..., {format:"png", densities:true})` 按栈把 1 个资源展开为倍率变体（`scale`/`variant`/`role`）：Android 仅当目录匹配 `…/drawable|mipmap`（含既有 dpi 后缀归一）→ `drawable-xhdpi`(2x)/`drawable-xxhdpi`(3x)；Flutter 基目录 1x + `2.0x`/`3.0x`；iOS `<name>.imageset/` 1x/2x/3x + 生成 `Contents.json`（`role:"contents"`）；RN 同名 `@2x`/`@3x`；Web 单 1x。文件名先剥离既有 `@2x/@3x` 再派生，SVG 始终单文件；`densities:false` 或未知栈回退单文件 @2x（旧行为，兼容）。
- **导出与写入**：按 plan 中的 scale 集合去重调用 Figma `/images`（每 scale 一次），PNG 每倍率独立渲染（内容不同 → sha256 各自校验）；Contents.json 由 `renderIosContents` 生成并 `writeAssetFile(overwrite)`（幂等）；`dryRun` 只计划；报告新增 `densities`、`counts.assets`/`files` 与逐条 `scale/role/variant`，hint 说明回退开关。
- **工具面**：`figma_import_assets` 新增 `densities?: boolean`（默认 true）；内容去重、`duplicate_of`、冲突与 `import-report.json` 语义不变。










### 13.36 实施记录（API 错误 → 错误码匹配 → 通用处理判定 → 反馈）

> 实施于 2026-10-02；spec `.scratch/api-error-feedback/spec.md`（票据 01–05）；新增 `src/artemis/api-errors.ts`、`src/device/logcat.ts`，改造 `suite-runner`/`failure-taxonomy`/`run-report`/`generation-feedback`/`suite-command`；全量 412 例通过。

- **错误码注册表（人工先行）**：`.artemis/design/error-codes.json`（`{version,codes:{"<code>":{match,handler?,expect?,handledPattern?}}}`）；`loadApiErrorCatalog` 逐条校验（match 必填且正则合法、handledPattern 可编译），非法条目计入 `errors[]` 并忽略；未配置 → 空表（不阻塞）。
- **确定性采集**：`AdbLogcatCollector`（`src/device/logcat.ts`）按 trace 时间窗 `logcat -v threadtime -d -T <start-5s>` 拉取主缓冲；设备时钟探测失败按 0 偏差并回传 `clockWarning`；无 adb/无设备/日志为空 → 结构化 `skipped`（`adb-not-found|no-serial|device-offline|log-empty`），不抛错；`formatLogcatTime`/设备列表/时钟探测与崩溃采集共用（`src/crash/collect.ts` 去除重复实现）。
- **判定**：`matchApiErrors` 逐行匹配并计数、取首个样例与时间；`handledPattern` 命中 → `handled`，声明但未命中 → `unhandled`，未声明 → `observed`。失败域新增 **`api-error`**（仅 `unhandled` 触发）：优先级 崩溃 > 环境 > api-error > 数据环境 > 设计推断 > 行为或设计 > 用例缺陷 > 未分类；`handled/observed` 只作证据不改域。
- **runner 集成**：每例终态（默认开启）采集并匹配，产物 `.artemis/traces/<traceId>/api-errors.json`（含 window/serial/source/degraded/errors）；`SuiteCaseResult.apiErrors + apiErrorsDegraded`；`suite run --no-api-errors` 关闭、`--fail-on api-error` 可让未处理错误使用例 FAIL（默认仅证据，不阻断）；报告 `apiErrorCatalog` 显示规则数与无效条目。
- **报告/反馈**：`suite report` xlsx 追加「API 错误 / 处理判定」两列（`CODE(verdict ×n)`、`CODE=handler|expect`），JUnit failure 内容追加 `api_error: CODE verdict=... handler=...`；`suite feedback` 对重复未处理错误输出 `kind:"api"` 建议（可追踪 case/trace）。
- **手动复算**：`node dist/cli.js suite api-errors <traceId> [--serial <s>] [--no-save] [--json]`（注册表缺失 → 退出 2；无状态/采集失败 → 1；成功 → 0）。
- **非目标**：抓包/代理/HAR、响应体断言、非 Android 栈、按代码自动扫描错误码（后续）。

### 13.37 实施记录（install CLI 参数校验）

> 实施于 2026-10-02；`src/install.ts`；测试 `test/install.test.js` +2（全量 414 例通过）。

- `install --help/-h` → 打印 `installUsage()` 并退出 0，**不写任何文件**；未知 `--flag`、非法 `--targets`（未知 target 名）、非法 `--mode`、缺值参数（`--project/--targets/--container/--url/--service`）→ `参数错误: …` 并退出 1。
- 修复背景：此前未知参数被 `default: break` 静默忽略，`install --help` 会按默认 `targets=全部` 执行一次完整安装（写四份客户端配置）。

### 13.38 实施记录（构建新鲜度提示与生成物三件套强制）

> 实施于 2026-10-04；`src/util.ts`（`isBuildStale`）、`src/runtime.ts`（`Runtime.build` + 启动 WARN）、`src/tools/llm.ts`（`aos_status.build`）、工具描述与 AGENTS 硬性约定；测试 `test/build-stale.test.js` 2 例。

- **强制三件套（复核结论，无需改代码）**：`figma_generate_tests` 在 `save !== false` 时先渲染 xlsx Buffer、再一次性写 `tests.json`+`tests.md`+`tests.xlsx`（任一渲染失败则三份都不写，`savedTo` 恒含三个路径），由 `test/figma-testgen.test.js` 的默认工作表/默认落盘用例锁定；工具描述已明确"仅 `save:false` 才不写任何文件"。
- **构建新鲜度**：ESM 在进程启动时加载代码，`dist/` 重建后旧进程不会热更新。`Runtime` 记录 `startedAt` 并用 `isBuildStale`（模块 mtime > 进程启动 + 2s 容差）判定；陈旧时启动日志 WARN、`aos_status.build = { module, startedAt, stale, note? }` 提示重启客户端；改造后可用该字段自证（旧进程没有 `build` 字段即说明仍是旧构建）。

### 13.39 实施记录（无损设备截图：`device.lossless`）

> 实施于 2026-10-06；`src/device/adb.ts`（二进制安全 `ExecBufferFn`/`defaultExecBuffer`）、`src/device/screenshot.ts`（`captureAdbPng`）、`src/diff/device-source.ts`（`LiveCaptureOptions` + 回退）、`src/diff/tool.ts`（`device.lossless`，与 `mode=step` 冲突报错）、`src/tools/composite.ts`（`compare_design_and_device` 同参；截图抽取移至 `src/tools/device-image.ts` 消除循环依赖）、`src/server.ts` schema；测试 `test/device-screenshot.test.js` 8 例。

- **动机**：`mobile_get_device_state` 的 `live_screenshot_*.jpg` 是给 LLM 感知用的有损 JPEG；像素级 diff 直接使用会产生压缩伪影（文字振铃、色度抽样），在阈值边缘出现假差异/漏检。
- **行为**：`device.lossless: true`（仅 `mode=live`；默认 false）时 AOS 直接经 adb `exec-out screencap -p` 抓 PNG（自动解析 serial；adb 缺失/离线/超时/非 PNG 均回退 live JPEG，note 附回退原因）；`compare_design_and_device` 透传同参。`mobile_get_device_state` 保持 JPEG 不变（token 经济）。
- **边界**：屏幕截图无有效 alpha（已合成不透明帧），本项解决的是 JPEG 有损压缩而非 alpha；设计侧（Figma/pen 渲染）与 diff 产物本就走 PNG。

### 13.40 实施记录（修复 build 新鲜度缓存缺陷）

> 实施于 2026-10-06；`src/runtime.ts`（`build` 改为每次读取动态计算的 getter；新增 `RuntimeOptions.buildModuleUrl` 供测试注入）、`test/build-stale.test.js`（新增"同进程内重建后 stale=true"用例，共 3 例）。

- **缺陷**：`stale` 原在构造函数中计算一次并缓存；进程启动时 dist 必然"不更新"，此后重建 dist 也不会刷新 → `aos_status.build.stale` 永远为 false，§13.38 的重启提示实际不可达。
- **修复**：`runtime.build` 改为 getter，每次读取用 `isBuildStale(moduleUrl, startedAtMs)` 重算；启动 WARN 保留（覆盖"启动后立刻重建"的竞态）。`aos_status` 字段与语义不变，现在能真实反映"进程早于构建"。

### 13.41 实施记录（iOS 设备后端 slice 1：模拟器截图接入 design diff / compare）

> 实施于 2026-10-06；来源 `docs/iOS-适配方案.md`（P0 实测与 P1 项目侧 DeviceBackend 已完成，本项是其 P2 的首个 AOS 侧切片）。新增 `src/device/ios.ts`、`test/ios-screenshot.test.js`（14 例）；改造 `src/diff/device-source.ts`、`src/diff/tool.ts`、`src/tools/composite.ts`、`src/server.ts`。

- **范围（slice 1）**：iOS 模拟器截图源接入两个设计对比工具——`design_device_diff`（`device.platform:"ios"`，与 `device.mode` 冲突校验、`dryRun`/报告透出 platform）与 `compare_design_and_device`（`platform:"ios"`）；后端 idb → `xcrun simctl io` 兜底（与项目侧 `tools/device-backend.mjs` 同一优先级）。ARTEMIS 为 Android-only，因此 iOS 路径无 live JPEG 回退，失败返回带指引的结构化错误。
- **目标选择**：显式 `device.serial`（UDID）优先；否则解析 `xcrun simctl list devices booted --json` 取唯一已启动模拟器，0 台 → `no-device`、多台 → `no-serial`（提示指定 UDID）；仅 macOS（`darwin`）可用，其他平台 `ios-unsupported`。
- **产物语义**：idb/simctl 截图恒为无损 PNG（模拟器 scale 常为 3，像素尺寸），diff 引擎按设计宽度缩放，与 Android `lossless` 路径同语义；平台差异的 logical/scale 显式约定（方案 §2.6）留待任务执行层接入时补齐。
- **测试**：假 exec 注入（无真机/无网络）：路径解析、booted 列表解析、显式/自动目标、no-device/no-serial、idb 回退 simctl、双侧缺失、not-png、timeout、非 macOS、工具层 platform 透传与 mode=step 冲突。
- **未含（后续 P2 余项）**：iOS 层级与动作（idb ui describe-all/tap/text）、`mobile_run_task` 平台路由（artemis drivers/ios 或 AOS 侧连接器）、崩溃/日志取证——见 `docs/iOS-适配方案.md` §3。

### 13.42 实施记录（iOS 设备后端 slice 2：`mobile_get_device_state` 观察路由）

> 实施于 2026-10-06；`src/device/ios.ts`（`listIosSimulators`/`describeIosUi`/`isSimulatorUdid`）、新增 `src/tools/ios-state.ts`、`src/server.ts` 拦截；`test/ios-device-state.test.js`（10 例）。

- **路由判据（唯一且显式）**：仅当 `device_serial` 为规范 UUID（模拟器 UDID）时由 AOS 接管；省略 serial 或非 UUID（如 `emulator-5554`）仍走 ARTEMIS/adb。首次访问会做一次 `simctl list devices --json` 校验：未知 UDID、未启动（提示 `simctl boot`）、非 macOS 均返回 `Error:` 文本（形态与 artemis 的失败文本一致）。
- **响应契约与 Android 对齐**：`screenshot` → 写 `<项目>/.artemis/traces/live_screenshots/live_screenshot_<udid>.png` 并返回 `file://<abs>`（上游 Android 为 artemis 仓库根 `.jpg` + AOS 镜像；iOS 直写项目目录，镜像步骤自动跳过同路径）；`hierarchy` → `idb ui describe-all --json` → 简化列表 `[i] Text: '…' | Bounds: [n…]`（0-1000 归一化，`Value:` 行、300 行截断标记），与 artemis 的 minimal list 同构；`view_type` 非法时返回同文案 `Error: Invalid view_type …`。
- **边界**：本切片只读（观察），不含动作/恢复/任务执行；模拟器层级来自 idb，真机 UDID（非规范 UUID 格式）不接管；iOS 失败不回落 Android（UDID 不会命中 adb 设备）。
- **测试**：UUID 判据、模拟器列表解析、idb JSON 解析、层级格式化（坐标/Value/截断）、路由 null（Android 透传）、未知/未启动/非 macOS、截图落盘与错误分支、层级成功/失败。

### 13.43 实施记录（iOS 动作层：idb 动作 + simctl 生命周期回退）

> 实施于 2026-10-06；`src/device/ios-actions.ts`（`makeIosDevice` 门面：tap/swipe/inputText/launch/terminate/openUrl/nodes/size/screenshot/handleAlerts）、`test/ios-actions.test.js`（11 例）。

- **动作语义**：坐标统一 logical point 且取整（idb 只接受整数）；swipe 时长为秒（下限 0.1）；`inputText` ASCII 走 `idb ui text`（键码），非 ASCII 必须带目标坐标走 `idb ui set-value --api ax`（替换语义，返回 `mode=type|set`）——P0 实测结论（CJK 无键码、set-value 可用）。
- **生命周期/深链**：launch/terminate/openUrl 首选 idb，失败回退 `xcrun simctl`；`terminate` 为 best-effort（布尔返回不抛）；`handleAlerts({accept,dismiss,mode})` 按方案 §2.4 策略化清理：默认 accept 中文文案表，最多 3 轮，`mode:"keep"` 直接跳过。
- **边界**：`capabilities.back="none"`（iOS 无系统返回键，返回由用例/代理编排）；`size()` 取自 Application 节点逻辑尺寸（iPhone 17 Pro 实测 402×874 pt）；本层暂无 MCP 暴露，供后续 `mobile_run_task` iOS 执行器（P2 余项）消费。
- **验证**：单测（参数取整/时长换算、回退链路、错误传播、弹窗计数、非法平台）；模拟器冒烟——tap「轻App」发生页面切换、terminate+launch 复位成功、handleAlerts 空跑安全。

### 13.44 实施记录（iOS 设备后端 slice 4：`mobile_run_task` 路由 + AOS 最小执行器）

> 实施于 2026-10-06；`src/llm/chat.ts`（OpenAI 兼容对话客户端）、`src/ios/task-runner.ts`（观察-决策-动作循环 + 内存任务表）、`src/server.ts` 拦截（`mobile_run_task`/`mobile_manage_task`）、`src/runtime.ts`（`ios-` trace 跳过 Android 崩溃扫描）；`test/ios-task-runner.test.js`（7 例）、`test/llm-chat.test.js`（3 例）。

- **路由判据**：`mobile_run_task` 的 `device_serial` 为模拟器 UDID（规范 UUID）时由 AOS 执行器接管；`mobile_manage_task` 按内存任务表命中 `trace_id` 接管（status/stop/inject_instruction）；其余（Android serial/省略 serial/未知 trace）原样透传 ARTEMIS。setup/模型预检门禁沿用（active LLM 缺失或模型下线时同样拦截）。
- **执行器（v0，Flash 式反应循环）**：每步观察 idb 层级（元素 Center 为逻辑点坐标，供模型直接点击）→ 截屏存证 → active LLM 输出单个 JSON 动作（tap/swipe/text/launch/terminate/openUrl/alerts/wait/done/fail）→ 校验并执行；`AOS_IOS_MAX_STEPS` 默认 30（1–200）；连续无进展由模型自行 fail；`text` 含非 ASCII 必须带输入框坐标（沿用 P0 结论）。
- **异步契约**：立即返回 `{trace_id: ios-<uuid>, status: "running", device_serial, model, run_dir, status_file}`；**无主动唤醒**（响应消息提示轮询）；`mobile_manage_task(action=status)` 返回 `status/progress/recent_steps/result/run_dir`（字段对齐 artemis 同名工具）；stop 置位后下一轮退出为 `cancelled`。
- **产物与台账**：`<项目>/.artemis/traces/ios-<uuid>/`（run.json / status.json（runtime 直接可读，`aos_tasks` sync 自动完结）/ shots/step-N.png）；`recordTaskResult` 写 task_stats（model=active entry.model）；`ios-` 前缀跳过 Android 崩溃扫描。
- **边界（v0 未含）**：无 wakeup/conversation 通知；层级为唯一感知（图片仅落盘证据，不送模型；纯文本 LLM 可直接用）；`mobile_inspect_trace` 未拦截（iOS trace 上该工具仍走 artemis 会报错）；无 plan/checker/notes 等 Pro 能力；失败分类沿用简单文本（无 §13.26 分域）。
- **验收（真实链路）**：`mobile_run_task(task='观察并报告设置页标题', device_serial=<iPhone 17 Pro UDID>)` → 真 DeepSeek Flash 一步 done（summary=页面标题=设置）；`mobile_manage_task(status)` 轮询到 completed；run.json/shots 落盘。

### 13.45 实施记录（iOS 执行器视觉 fallback：视觉模型解析 + 降级记录）

> 实施于 2026-10-06；`src/ios/vision.ts`（视觉目标解析/多模态命名启发/PNG IHDR 尺寸）、`src/llm/chat.ts`（多模态 content 分片）、`src/ios/task-runner.ts`（按需附图 + 失败降级）；`test/ios-vision.test.js`（6 例）、`test/ios-task-runner.test.js` 增 2 例。

- **视觉目标解析（优先级）**：`AOS_IOS_VISION_LLM=<条目名>`（registry 条目，要求完整）→ `AOS_IOS_VISION_MODEL`（可配 `AOS_IOS_VISION_BASE_URL/API_KEY`，缺省继承 active）→ active 模型名多模态启发（vision/vl/gpt-4o/gemini/claude-3|4 等）→ 无（纯文本模式）。启动响应与 run.json 记录 `vision: {model, source}`。
- **按需附图**：可见文本元素 <3 个（层级质量差）或 `AOS_IOS_VISION_ALWAYS=1` 时，该步 user 消息带 `image_url`（`data:image/png;base64,`）分片；文本分片同时给出截图 px 与逻辑 pt/scale（§2.6 约定：坐标输出逻辑点，从截图估计需 ÷scale）；其余步骤纯文本（`perception:"text"`）。
- **降级**：视觉调用失败（模型不支持图片/鉴权/网络）→ 记录 `vision_degraded`（run.json + status 响应）并当场回退纯文本调用该步（`perception:"text-degraded"`），后续步骤保持可用；不因视觉失败中断任务。
- **边界**：不做 OCR、不做像素级脱敏；图片不做降采样（v0 直传模拟器原始 PNG，注意 token 成本）；多模态启发可能误判（显式 env 可覆盖）。（§13.59 已换代：默认档位 `AOS_IOS_VISION_MODE=auto` 每步视觉输入，附图为感知/决策分流，`AOS_IOS_VISION_ALWAYS=1` 并入 auto 语义。）
- **验收**：单测覆盖解析优先级/命名启发/IHDR 尺寸/附图与降级链路；真实验收用 `AOS_IOS_VISION_ALWAYS=1` + 不存在的视觉模型驱动降级（DeepSeek 不支持图片 → 400 → 回退文本完成）。

### 13.46 实施记录（iOS trace 检查器 + 路由下沉：`mobile_inspect_trace` / 设计步骤对比闭环）

> 实施于 2026-10-06；新增 `src/ios/inspect.ts`；`src/ios/task-runner.ts`（failed 状态补 `test_summary.failed_items`）；`src/runtime.ts`（只读 mobile 工具路由下沉到代理包装层，内部调用同样生效）；`src/server.ts` 移除重复分支；`test/ios-inspect.test.js`（6 例）。

- **检查器动作**：`view_summary`（步骤/结果/vision 摘要）、`view_step_details`（单步 thought/action/params/outcome/perception + 截图路径）、`view_step_screenshots`（`before_screenshot`=本步观察图，`after_screenshot`=下一步观察图（后置状态），overlay 恒 null）、`search`（全文子串优先、按标点/空白分词兜底、支持 step_range/max_results，结果行 `[Step N] …` 供设计工具锚点解析）。
- **路由下沉（关键）**：`mobile_manage_task`/`mobile_get_device_state`/`mobile_inspect_trace` 的 iOS 路由从 server 处理器下沉到 `Runtime` 的代理包装层（`maybeIosCall`），因此**服务内部调用**（`design_device_diff` 的 status/search/截图链路）同样命中 iOS 后端；`mobile_run_task` 仍留在 server（需要 setup/模型预检门禁与任务记录语义）。
- **设计步骤对比闭环**：失败任务的状态响应携带 `test_summary.failed_items`（evidence=失败原因）→ `design_device_diff(device:{mode:"step",traceId,image:"pre"})` 可自动锚定失败步骤并读取该步观察截图，完成"设计 vs iOS 失败步骤"确定性对比。
- **边界**：`after` 语义为"下一步的观察图"（末步为 null，需 `image:"pre"`）；无 overlay 图；search 不做模糊/拼音。
- **测试**：检查器四动作 + 非 iOS 透传；集成用真实运行时（StubProxy）跑失败任务 → 自动锚定（anchor.source=search）→ 像素差异 1 区域，且证明内部调用未落到 ARTEMIS 桩。

### 13.47 实施记录（iOS 设备后端 slice 7：suite 用例闭环接入 iOS）

> 实施于 2026-10-06；新增 `src/device/ios-reset.ts`；`src/runtime.ts`（`mobile_run_task` 路由下沉到代理包装层）、`src/server.ts`（去除重复分支 + iOS trace 防重复记账）、`src/device/reset.ts`（`APP_PACKAGE_PATTERN` 导出 + `ios-unsupported` 原因）、`src/figma/suite-runner.ts`（`suiteResetFor` + iOS 日志降级）、`src/artemis/failure-taxonomy.ts`（`ios-unsupported` 归环境域）；`test/ios-reset.test.js`（3 例）、`test/suite-ios.test.js`（3 例）、`test/ios-task-runner.test.js` 增 2 例。

- **路由统一下沉**：`mobile_run_task` 的 iOS 路由与其余只读工具一致，移入 Runtime 代理包装层——`suite run` 等**服务内部调用**由此命中 iOS 执行器；server 仅保留 setup/模型预检门禁，并对 `traceId` 以 `ios-` 开头的结果跳过二次记账（iOS 执行器已按 active entry.model 记录）。
- **iOS 复位**：`resetIosApp`——校验包名/macOS/UDID → idb terminate（best-effort）→ idb launch（失败即 `launch-failed`）；`AppResetOutcome` 兼容（`adb: {path:null,source:"missing"}`，命令留痕）；`suiteResetFor(serial)` 按 UDID 自动选择；复位失败仍按既有分类（`ios-unsupported` 计入环境域）。
- **日志/取证降级**：iOS trace 不跑 adb logcat，`apiErrorsDegraded="ios-log-unsupported"`（API 错误注册表匹配暂缺，行为显式标注而非静默）；崩溃扫描此前已跳过 `ios-` trace。
- **任务启停**：`--app <package>` 同时作为 `locked_app_package` 传入执行器 → 循环前 idb launch 该应用（失败即任务 failed）。
- **验收（真实链路）**：`node dist/cli.js suite run --device <UDID> [--app com.apple.Preferences]` 两次真实运行 PASS（无复位 / idb 复位 ok），`apiErrorsDegraded=ios-log-unsupported`，trace 落 `.artemis/traces/ios-*`。

### 13.48 实施记录（iOS 崩溃取证 + suite evidence iOS 链路）

> 实施于 2026-10-06；新增 `src/crash/ios.ts`（.ips 解析/窗口采集）；`src/crash/types.ts`（`kind:"ios"`、`attribution:"ips-header"`、`source:"diagnostic-reports"`）、`src/runtime.ts`（`captureIosCrashes` 入同一崩溃索引）、`src/ios/task-runner.ts`（终态触发 + `test_summary` 落盘）、`src/server.ts`（`aos_crashes` kind 过滤加 `ios`）；`test/ios-crash.test.js`（4 例）、`test/ios-inspect.test.js` 增 evidence 用例。

- **采集**：iOS trace 终态后（`AOS_CRASH_CAPTURE` 开启时）扫描宿主机 `~/Library/Logs/DiagnosticReports/*.ips`，按 mtime 落在任务窗口（前后 2s/5s 容差）筛选，解析 header/body（app_name、exception.type、termination.reason、thread0 帧），签名=`包名|异常类|首帧`，与 Android 崩溃共用 `CrashIndexStore`（去重计数、trace 关联、`aos_crashes list/get` 可见，kind=`ios`）。
- **联动**：`suite evidence` 的失败项/锚点/崩溃引用对 iOS 全部可用；`test_summary` 现同时写入 `status.json`（此前仅存在于内存状态响应，导致落盘读取路径拿不到失败项）。
- **边界**：仅宿主机 DiagnosticReports（模拟器与 macOS 上运行的模拟器进程崩溃）；真机崩溃（idevicecrashreport/MetricKit）未接；`.ips` 文本格式（旧 `.crash`）不支持；窗口内其他进程崩溃若未传 `--app` 也会被收录（processName 过滤按需生效）。

### 13.49 实施记录（真机 UDID 识别：classifyIosSerial，best-effort）

> 实施于 2026-10-06；`src/device/ios.ts`（`classifyIosSerial`：模拟器规范 UUID / 真机现代 `8-16` / 旧 `40-hex`）、`src/tools/ios-state.ts`、`src/ios/task-runner.ts`、`src/device/ios-reset.ts`、`src/figma/suite-runner.ts` 改用统一判据；测试覆盖分类与"真机跳过 simctl 校验"路径。

- **语义**：模拟器走 simctl 列表/Booted 校验不变；真机 UDID 跳过 simctl 校验（无 boot 概念），直接交给 idb 后端，连接失败由 idb 报错并带指引；`reset`/`suiteResetFor`/logcat 降级同样识别真机。
- **未验证**：本机无 iPhone，真机链路（idb 连接、配对隧道、真机截图/动作）为 best-effort，未实测；方案 §3 P3 的签名/配对自动化仍是前置。
- **风险**：40-hex 与个别 Android 序列号形态可能碰撞（概率低）；如遇误判可用非 UDID 形态 serial 或先 `lldb`/`idb list-targets` 核对。

### 13.50 实施记录（MCP 服务名更名 mobile-testing + 旧键迁移扩展）

> 实施于 2026-10-06；`src/install.ts`（`MCP_SERVER_NAME` + `LEGACY_SERVER_NAMES`）、`test/install.test.js`（旧键迁移用例覆盖 `android-testing`），文档同步 README / 接入指南。

- **决策**：iOS 设备后端（§13.41–§13.49）落地后，服务名 `android-testing`（§13.12 因当时仅支持 Android 而定）不再成立，更名为 **`mobile-testing`**——覆盖 Android + iOS 双端真机/模拟器测试。ASCII 硬约束不变（客户端 MCP 列表与工具名前缀只显示该名，工具名本身不变）。
- **范围**：`install` 生成的四个客户端配置键（`mcpServers.mobile-testing` / `servers.mobile-testing` / `mcp.mobile-testing`）与 Codex 手动片段同步；协议层 Server name（`aos-mcp`）与 CLI/包名不变（沿用 §13.12 先例）。
- **旧键迁移**：`LEGACY_SERVER_NAMES = ["aos", "android-testing"]`，install 写入前移除同一父路径下的两个历史键，避免同一客户端同时加载新旧 server；仅移除历史键，不动其他 server 与注释。已挂载客户端执行一次 `install --force`（或手动改键）后重启即生效。

### 13.51 实施记录（iOS trace 跨进程持久化与中断归因）

> 实施于 2026-10-06；新增 `src/ios/trace-store.ts`（磁盘视图 + 归因 + orphan 落盘）；`src/ios/task-runner.ts`（原子写、`status.json` 补 `platform`/`pid`/`process_started_at`、`maybeIosManageTask` 两级查找）；`src/ios/inspect.ts`（签名对齐 `maybeIosDeviceState(runtime,args,deps)`，磁盘 fallback 渲染复用同一视图）；`src/runtime.ts`（`traceStatus` 读路径归因收尾）；`test/ios-trace-store.test.js`（6 例）、`test/ios-task-runner.test.js`/`test/ios-inspect.test.js` 签名适配与落盘字段用例。

- **持久化**：`run.json`/`status.json` 改 `writeFileAtomic`（原子替换，此前为普通写）；两者记录 `platform:"ios"`、`pid`（owner 进程）、`process_started_at`（`now - process.uptime()`，备查 pid 复用）。
- **两级查找**：`mobile_manage_task`/`mobile_inspect_trace` 先查进程内任务表，未命中再读 trace 目录；平台判据以持久化 `platform` 字段优先，`ios-` 前缀仅作旧 trace fallback（平台字段为其他值或无字段且非 `ios-` 前缀 → ARTEMIS 透传，行为不变）。
- **归因（orphaned）**：磁盘视图对 `running` 做存活校验——pid 存活保持 `running` 并给 note（超过阈值加 `stale`）；pid 已退出、或无 pid 且 `status.json` 最后写入超过阈值（心跳语义，`AOS_IOS_STALE_MS` 默认 30 分钟）→ 归 `orphaned`（复用既有终态词，`TERMINAL_TASK_STATUSES` 内含）并回写 `status.json`/`run.json`，30s `syncTaskStatuses` 随即把 `aos_tasks` 收尾；磁盘态跨进程 stop/inject 明确返回「无法跨进程操作」，不伪造成功。
- **边界**：升级前产生的纯内存 iOS trace（无磁盘产物）查不到，属预期行为；pid 复用未做进一步指纹校验（仅记录 `process_started_at` 备查）；`traceStatus` 在读路径上做幂等归因回写。
- **测试**：磁盘存活/死亡两分支（注入 liveness）、无 pid 超时与未超时（注入 clock）、platform 字段优先/前缀 fallback/android 不接管、inspect 磁盘步骤检索、`runtime.traceStatus` 收尾、运行中任务落盘 `platform`/`pid` 字段。

### 13.52 实施记录（iOS 平台对等 M1：执行与证据链，票据 02–07）

> 实施于 2026-10-06；`src/ios/task-runner.ts`（参数 warnings / app_path 拒绝 / app 锁定 / post 截图 / 屏幕文本 / settle / scale）、`src/ios/overlay.ts`（动作标注）、`src/ios/inspect.ts`、`src/ios/trace-store.ts`、`src/device/ios-log.ts`、`src/figma/suite-runner.ts`、`src/suite-command.ts`、`src/runtime.ts`、`src/diff/tool.ts`；测试新增 `test/ios-overlay.test.js`、`test/ios-log.test.js` 并扩充 ios/suite 系列。

- **参数语义与锁定（票据 03）**：iOS 启动/失败响应恒含机器可读 `warnings[]`（`{code:"param_ignored", field, actual}`；`model` 落实际模型、`conversation_id`=poll-only，其余=unsupported-on-ios）；AOS 代理层对 Android `mobile_run_task` 响应补空 `warnings`（双端同构，纯增量）；`app_path` 结构化拒绝（`code:app_path_unsupported`，启动失败同样写入任务行）；`locked_app_package` 限制 `launch`/`terminate` 仅目标 bundle、禁用 `openUrl`；前台逃逸为已知限制（文档+backlog）。
- **套件契约（票据 04）**：iOS trace 由执行器单点记账（套件按持久化 `platform` 字段跳过，`ios-` 前缀 fallback）；iOS 复位异常 reason=`launch-failed`（failure-taxonomy 归 environment）；合成 `test_summary` 带 `synthesized:true`（`TaskTestSummary` 同步解析）。
- **iOS 日志（票据 05）**：`src/device/ios-log.ts`——`xcrun simctl spawn <udid> log show --predicate 'process == "名"'`，超时 15s、行数上限 2000（超限即放弃并降级 `log-over-limit`；`AOS_IOS_LOG_TIMEOUT_MS`/`AOS_IOS_LOG_MAX_LINES`）；非 darwin/no-process/log-empty/log-show-failed 显式降级；套件注入式采集（`iosLogCollector`）与 `suite api-errors --app <bundle>` 接入，成功时 `source:"simctl-log"`。
- **崩溃路由（票据 06）**：`aos_crashes scan`（显式与批量）按 `platform`/前缀路由 iOS 采集（`processName` 取 lockedPackages、窗口取 status.json/任务台账），`empty` 时有界重试（默认 3 次 × 2s，可注入），结果记入 scan 索引；进程死亡由 `syncTaskStatuses` 对 iOS 终态同样触发该路径（不再按前缀跳过），`captureIosCrashes` 不写 scan 索引、统一由扫描路径收口。
- **inspect 增强（票据 02）**：每步持久化屏幕文本摘要并纳入 search；动作后（含 done/fail 终态步）经可配置 settle（默认 200ms，0–2000，`AOS_IOS_SETTLE_MS`）补真实 post 截图；动作标注 overlay 按需生成（tap/swipe/text，坐标 point×scale，pngjs 画环，失败显式 `action_overlay_error`）；`view_step_details` 补 `device_serial`；`view_step_screenshots` 的 after 改为同一步 post（与 Android 语义对齐，不再用下一步观察图）。
- **diff step（票据 07）**：移除 `platform="ios"` 仅 live 的限制；iOS trace 步骤截图可作设备源（跨进程依赖 §13.51 磁盘 fallback）。

### 13.53 实施记录（iOS 平台对等 M2：设计代码化，票据 08–12）

> 实施于 2026-10-06；`src/figma/color.ts`、`src/projects/stack.ts`、`src/figma/import-tokens.ts` / `src/pen/tokens.ts`、`src/figma/gaps.ts`、`src/figma/import.ts`、`src/figma/strings.ts`、`src/figma/import-strings.ts`、`src/figma/brief.ts` / `src/pen/brief.ts`、`src/diff/screen-map.ts`；测试扩充 tokens/import-assets/figma-flows/strings/strings-plural/stack。

- **iOS token 产物（票据 08）**：`ios-native` 的 `i18n.tokenFile`=`ios/AosTokens.swift`；生成 Swift 枚举（`static let colorBrandPrimary = Color("color.brand.primary")`，marker 注释）+ `Resources/Colors.xcassets/<token>.colorset/Contents.json`（sRGB 浮点组件、marker 写入 info.author）；`StackTokenWrite.extraFiles` 与主文件同一幂等/覆盖语义；figma/pen 两路径同行为。
- **缺口分析（票据 09）**：颜色提取支持 colorset JSON（浮点→hex）与 Swift `Color(red:green:blue:)`（`Color("assetName")` 由同名 colorset 覆盖）；其余形式声明不识别；资产 basename 规范化剥离 `@2x/@3x`，仅 @2x/@3x 的 imageset 不再误报。
- **资产导入（票据 10）**：iOS 默认 SVG 落 `<dir>/<name>.imageset/` + vector `Contents.json`（`preserves-vector-representation`）；`Contents.json` 仅在图片成功写入后写（error/duplicate 跳过并标注），统一走 hash/`duplicate_of` 幂等；单倍率位图同样收敛进 imageset。
- **strings（票据 11）**：locale 映射 `iosLocaleDirectory`（zh→zh-Hans、zh-TW→zh-Hant-TW、zh-Hant-HK/pt-BR 保真）与 `androidLocaleDir`（`values-zh-rHK` 旧式，不切 `b+`）；iOS 跨 `.lproj` 冲突检测（用户文件优先，冲突经 resolutions 闭环）；`.stringsdict` 解析/合并/冲突（保留人工条目，冲突时不覆盖、不产生空文件）；Swift 硬编码文案白名单扫描（Text/Label/navigationTitle；排除 URL/数字/符号/NSLocalizedString）。
- **栈检测与多栈警告（票据 12）**：iOS 检测放宽为限深 ≤2 层搜索 `xcodeproj/xcworkspace`（忽略 node_modules/dist/build/Pods 等）；tokens/assets/brief/gap/screen-map 在跳过非主栈时响应带 `warnings`（列出被跳过栈；全栈分别产出为 backlog）。

### 13.54 实施记录（使用统计：客户端调用事件采集与三消费面，票据 01–07）

> 实施于 2026-10-06；新增 `src/db/usage-event.ts`、`src/usage/capture.ts`、`src/usage/aggregate.ts`、`src/usage/web.ts`、`src/tools/usage.ts`、`src/usage-command.ts`；改 `src/db/types.ts` / `src/db/memory.ts` / `src/db/postgres.ts` / `src/runtime.ts` / `src/server.ts` / `src/http-server.ts` / `src/cli.ts`；测试新增 `test/usage-store.test.js`（6）/ `test/usage-capture.test.js`（10）/ `test/usage-server.test.js`（10）/ `test/usage-aggregate.test.js`（11）/ `test/usage-tool.test.js`（9）/ `test/usage-web.test.js`（9）/ `test/usage-command.test.js`（10）/ `test/usage-e2e.test.js`（1），`test/http-server.test.js` 增 2 例。

- **采集面（ADR-0006）**：只在 `createServerForRuntime()` 的 `CallTool` 包装层记录客户端经 stdio/HTTP 发起的调用；服务内部编排（suite/design_device_diff 等直接走 `runtime.proxy.callTool`）不经过该层，不产生事件。成功、工具报错、参数校验失败与未知工具名都记录；`aos_usage` 自身按名排除；记录/落库异常只写 warn，绝不影响调用结果。
- **事件模型与隐私**：`id / projectId / at(ISO) / tool / family(native|figma|pen|mobile|unknown) / ok / durationMs / errorClass(validation|figma|artemis|timeout|internal|unknown) / errorSummary(≤300，PG 读回白名单) / signals / argKeys / traceId`；参数只记键名集合、不记录参数值本身（errorSummary 为服务端回显片段，≤300，不含凭据）；连续调用时间戳严格递增（同毫秒内 +1ms，保证排序稳定）；查询/聚合的取数上限跟随 `AOS_USAGE_MAX_EVENTS`（0=不清理时按默认 50000 有界采样）。
- **存储**：PG 新表 `usage_events`（append-only，signals/arg_keys 以 TEXT JSON 存以兼容 pg-mem）与内存实现语义一致；写入时顺带清理（`AOS_USAGE_RETENTION_DAYS` 默认 90，0 不清理；`AOS_USAGE_MAX_EVENTS` 每项目上限默认 50000，超出丢最旧；未注册项目的孤儿桶同样纳入清理）。
- **聚合（纯模块，零 IO）**：`summary`（total / 成功率 / p50 / p95（精确最近秩）/ 按工具/族/天分布 / 零调用目录）、`signals`（错误类分布、unknown 与无类失败的归一化模板聚类（引号内容/路径/UUID/hex/长 token/数字→占位符）、warnings 码+field、降级标记（8 码）、每工具参数键频次）、`events`（最新在前，limit ≤ `USAGE_EVENT_LIST_MAX=200`）；排序全部确定。
- **工具 `aos_usage`**：原生 zod（`action=summary|signals|events`，`tool/status/days/limit`），返回 JSON 文本（中文标注），含 `usage{enabled,storage,note?}`、`store{kind,degraded}`、`filters` 与对应聚合；零调用目录 = 进程内工具目录（动态 import `inProcessToolCatalog()`，剔除自身）∪ 代理在线时的 `mobile_*`（Web/CLI 仅覆盖进程内目录，mobile 工具在首次调用后出现）；`AOS_USAGE=0` 只停采集，查询照常并附 `USAGE_DISABLED_NOTE`。
- **CLI `usage`**：`node dist/cli.js usage [--json|--all|--project <名|根路径>|--days <n>]`（默认当前项目、7 天；文本摘要 + JSON 稳定字段）；`usage --web [--port 8766] [--host 127.0.0.1]` 内嵌只读看板，复用同一 `handleUsageRequest`，端口占用 exit 2，SIGINT/SIGTERM 清理监听；内存降级时提示「独立 CLI 进程无法读取其他进程的内存事件」。
- **Web 看板**：`GET /usage`（服务端渲染 HTML：概览/存储徽标/工具表含零调用行/信号面板/事件流水分页与筛选；内联 CSS，无 JS 框架）与 `GET /usage.json`（同源 JSON）；HTTP 模式跟随服务器绑定，`AOS_USAGE_WEB=0` 时两路由 404（CLI `--web` 同样受该开关约束）；只读、无鉴权（与内网无鉴权口径一致）、无处置标记。
- **日志追踪**：审计行扩展为 `tool=<name> ok=<bool> ms=<n> usage=<id>`（失败时保留 `error=` 摘要），`usage=<id>` 与事件 id 双向可查；`aos_status.usage` 显示 `{enabled, storage}`。
- **验收（离线）**：`test/usage-e2e.test.js` 用同一 `MemoryStore` 走真实 MCP 服务器（InMemoryTransport）记录一条客户端事件，再断言 `aos_usage` 工具、`usage` CLI（文本+JSON）、`/usage`+`/usage.json` 与审计日志 `usage=<id>` 对同一条事件互相印证；全链路不依赖真实 PG/设备/外网。全量 610 用例、lint 干净；Out of Scope 核对：无内部编排记录、无会话序列挖掘、无看板鉴权/处置、无外部遥测/HAR、`task_stats` 未改、无前端框架与构建。

### 13.55 实施记录（Jira 接入 M8a：凭证配置与读取，票据 01–02）

> 实施于 2026-10-07；新增 `src/jira/config.ts`、`src/jira/client.ts`、`src/jira/adf.ts`、`src/jira/context.ts`、`src/tools/jira.ts`；改 `src/runtime.ts`（`jiraConfig()`）、`src/server.ts`（`jira_issue_get`/`jira_issue_search`）、`src/tools/configure.ts`（jira 三件套）、`src/tools/llm.ts`（`aos_status.jira`）、`src/usage/capture.ts` + `src/db/types.ts`（family `jira`）、`src/commands.ts`（.env 模板）；测试新增 `test/jira-context.test.js`（6）/ `test/jira-client.test.js`（5）/ `test/jira-tools.test.js`（9），全量 631 用例、lint 干净。spec/票据见 `.scratch/jira-integration/`。

- **凭证与配置**：`aos_configure` 新增 `jiraSite/jiraEmail/jiraApiToken`（三者同时提供；站点仅 `https://*.atlassian.net` 并去尾斜杠），写入项目 `.env` 的 `JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN`；响应与 `aos_status.jira` 只回 masked 预览，token 不落 PG/日志；凭证由 resolver 解析（进程 env 优先；启动与 `aos_configure` 后刷新，手动编辑 `.env` 需重启会话）。
- **客户端**：`JiraClient`（Basic auth、`AbortSignal.timeout`、429 有界等待 + 按凭证指纹冷却 fail-fast、`JiraApiError` 带 status/hint、无缓存）；测试注入 `fetchImpl`/`sleep`/`env` 覆盖冷却、重试与错误映射，不联网。
- **读取**：`jira_issue_get`（key/browse URL → 规范化上下文；ADF→文本覆盖 doc/段落/标题/列表/代码块/引用/表格/提及等；AC 启发式标题段 + `AC:` 行，raw ADF 保留）与 `jira_issue_search`（`/rest/api/3/search/jql` POST、显式字段、limit 1–100、游标 `nextPageToken` 透传）。
- **usage**：family 增加 `jira`（`jira_` 前缀），工具目录自动纳入 `aos_usage` 零调用统计；`aos_status` 增 `jira` 小节。
- **边界**：M8a 只读；Server/DC、OAuth、建单、状态同步与证据回写（M8b/M8c）为票据 03–06；真实沙箱冒烟为人工验收（自动测试全 mock、不联网）。

### 13.56 实施记录（iOS 真机 M9a：WDA 后端与真机验证，票据 00–03）

> 实施于 2026-10-08；新增 `src/ios/appium/{client,session,facade,xml,capabilities,server,detect,service}.ts`；改 `runtime.ts`（`iosWda()`/`disposeIosWda()`/`appiumDetector`）、`tools/ios-state.ts`、`diff/device-source.ts`、`ios/task-runner.ts`、`server.ts`/`http-server.ts`（关停回收）、`tools/llm.ts`（`aos_status.ios`）、`commands.ts`（doctor）；依赖新增 `fast-xml-parser`；测试 `test/ios-appium-*.test.js`、`test/ios-wda-service.test.js` 共 25 例；全量 665 绿、lint 干净。spec/票据见 `.scratch/ios-real-device/`。

- **spike 事实（票 00，真机 iPhone 12/iOS 26.6.2）**：隧道 registry `127.0.0.1:42314` 常驻；签名团队取证书 OU（本机 `Z35S33J39R`）+ `allowProvisioningDeviceRegistration`；`useNewWDA=false` 复用会话 ~1s；`mobile: typeText` 已移除 → `POST /keys`；键盘输入须先聚焦。
- **真机端到端（票 03）**：`mobile_get_device_state` 经全新 MCP 进程（自动托管 Appium）——截图 10.2s（5.6MB PNG → `.artemis/traces/live_screenshots/`）/层级 7.2s（4549 字符真实主屏）✅；design diff / compare 真机受益于同一截图源。
- **边界与待续**：M9b 套件真机复位已接线（注入 WDA façade）、`.ipa` 安装（票 05）完成；真机崩溃取证（票 06）已接入 `devicectl systemCrashLogs`（来源标识 `devicectl-systemCrashLogs`）；真机日志已接入 `idevicesyslog` 实时尾采样（窗口近似 + `clockWarning`；缺工具/窗口已过降级 `ios-log-tool-missing`/`window-elapsed-live-tail`；`AOS_IDEVICESYSLOG_PATH`/`AOS_IOS_LOG_TIMEOUT_MS` 可配；人工冒烟待执行）；Appium 异常退出仍可能遗留孤儿进程（关停路径已回收，崩溃路径后续加固）。

### 13.57 实施记录（iOS 签名/Appium 配置分层：项目 .env 打底）

> 实施于 2026-10-08；改 `runtime.ts`（新增 `iosEnv = { ...project.dotenvValues, ...baseEnv }`，默认 `detectAppium` 与 `IosWdaService` 改用之）与 `commands.ts`（doctor 检测同规则）；测试 `test/runtime.test.js` 增 1 例（打桩 fetch 断言会话 capabilities：dotenv 值生效、进程 env 覆盖）；全量 670 绿、lint 干净。README §iOS 真机与 `.scratch/ios-real-device/spec.md` 同步。

- **动机**：`AOS_IOS_XCODE_ORG_ID` 等此前只读宿主级进程 env，多项目团队 ID 各异时同一实例无法各用各的（HTTP 单实例尤甚）；现与 LLM/Figma/Jira 的 per-project 配置一致，团队 ID 写入项目 `.env` 即可。
- **优先级**：进程 env（客户端配置）仍覆盖项目 `.env`，全局限定语义不变；`aos_status.ios` / doctor 与真实会话读取同一分层 env。
- **边界**：`ios/task-runner` 执行器调参（`AOS_IOS_MAX_STEPS` / `AOS_IOS_SETTLE_MS` / 视觉开关）仍读进程 env，未纳入本次分层。（§13.59 已收口：新增 `runtime.iosEnvironment()`，执行器开关统一走项目 `.env` 打底、进程 env 覆盖。）

### 13.58 实施记录（pen 资源导入：`pen_import_assets`，v1 ids-only 位图）

> 实施于 2026-10-09；新增 `src/pen/assets.ts`；改 `src/figma/import.ts`（`ImportPlanEntry`/`ImportResultEntry.figmaId` → `sourceId`、导出 `renderIosContents`、`RASTER_FORMATS` 加 `webp`、figma 报告加 `schemaVersion:2`）、`src/figma/gaps.ts`（`fallbackAssetName` 导出、参数泛化为源 id）、`src/server.ts`（工具注册）；测试新增 `test/pen-assets.test.js`（11 例）；人工冒烟 `scripts/e2e-pen-assets.mjs`（真实 CLI 0.3.10 实测：2x PNG 750×1710、报告 schema 正确、临时目录清理）。spec/两轮评审记录见 `.scratch/pen-assets/spec.md`。

- **能力核实（修正旧结论）**：`pen interactive` 的 `execute` 提供 `Export(nodeIds, format, outputPath, options?)`（png/jpeg/webp/pdf/html；每节点独立文件 `<nodeId>.<ext>`、默认 2x、响应逐行 `Exported <绝对路径>`；无 `svg`）；此前"pen CLI 只能整档渲染"不成立——`pen_export` 只包了非交互 `--export`，本工具接 interactive 管道（复用 `runPenInteractive`）补齐按节点导出。
- **批量与会话**：单次 interactive 会话、**命令数 = 倍率数、单命令携带全部 ids**（进程数与资源数解耦）；超时为**会话级**（`penExec` 每 spawn 一个硬超时），默认 `max(AOS_PEN_TIMEOUT_MS, 60s + ids×倍率×5s)`、`AOS_PEN_IMPORT_TIMEOUT_MS` 可覆盖、上下限 5s–30min（`resolveImportTimeoutMs`）。
- **对账与缺产物判定**：ids 离线预校验（不存在即参数错误、不启 CLI）；产物 = 响应 `Exported` 路径 ∪ 临时目录扫描；缺产物逐项 `status:"error", error:"export-no-output"` + 批次告警（全缺=CLI/登录/格式问题，部分缺=节点可能零尺寸/不可见）；全缺时硬错误附日志尾。
- **命名与幂等（身份/内容解耦）**：命名在 plan 阶段由身份决定（`formatAssetFilename`；脏名如 `Frame 427` 回退 `asset <sha1(源 id) 前 8 位>`），与导出内容无关（多倍率恒同名）；内容 sha256 只用于 `unchanged/skipped_exists/duplicate`；写盘/去重/栈规则全部复用 `src/figma/import.ts` 纯函数；iOS `Contents.json` 与 figma 产物一致（非矢量不写 `properties`）。
- **报告与 schema**：`.artemis/design/import-report.pen.json`（独立于 figma 报告），payload 含 `source:"pen"`/`schemaVersion:2`/`penCliVersion`/`penPath`/`vector:"unsupported"`/`session{timeoutMs,scales,commands,exportedFiles}`/`counts`/`uniqueness`/`results`；字段更名（`figmaId`→`sourceId`）为内部类型级 breaking（测试只消费 `relativePath/status/role`，仓库内无报告字段消费方），figma 报告同批加 `schemaVersion:2`。
- **边界与后续**：`dryRun` 仍执行渲染（去重结果依赖内容，语义同 `figma_import_assets`）；无 SVG 输出（P1 离线合成或等 CLI 支持）；候选启发式（v1.5）未实施；写盘纯函数下沉 shared 层为后续项（pen→figma 依赖为既有惯性）。

### 13.59 实施记录（iOS 执行器理解强化：感知 / 循环 / 平台语义）

> 实施于 2026-10-10；spec 与两轮评审见 `.scratch/ios-understanding-parity/spec.md`。新增 `src/ios/{occlusion,perception,noop}.ts`、`IosDeviceLogTail`（`src/device/ios-log.ts`）；改 `src/ios/task-runner.ts`（模型分流/终态验证/历史压缩/失败日志/开关）、`src/ios/vision.ts`（`resolveVisionMode`）、`src/tools/ios-state.ts`（遮挡告警）、`src/ios/appium/service.ts` 与 `src/device/ios-actions.ts`（观测重试）、`src/ios/{trace-store,inspect}.ts`（verification/failure_logs 透出与 search）、`src/runtime.ts`（`iosEnvironment()`）；README 同步。测试新增 `test/ios-{occlusion,perception,noop}.test.js` 与 iOS 执行器/日志/服务增量用例；全量 784 绿、lint 干净。

- **感知档位（票 01/02）**：`AOS_IOS_VISION_MODE=auto|sparse|off`（默认 auto；`AOS_IOS_VISION_ALWAYS=1` 映射为 auto）。auto = 每步视觉输入：多模态主模型（`looksVisionCapable`）直附截图并由主模型决策；文本主模型（有 visionTarget）每步调视觉感知——模型只输出 `[{text,bounds_px}]`（截图像素坐标、不做算术），执行器按 `scale=像素宽/逻辑宽` 换算逻辑 pt、计算 Center，以 `[V#] (模型视觉，可能有误) OCR Text: … | Center: (x,y) | Bounds: …` 融合进元素列表（独立配额 30 行、不挤占 200 行元素预算；与可访问性文本规范化相等/包含去重；非法/越界丢弃）。`perception` 扩为 `text|image|vision-text|text-degraded`；丢弃计数写 run.json `vision_dropped`。多模态路径历史不保留旧截图（对齐 Android 中间截图裁剪）。`sparse` 保留旧阈值（可见文本 <3），`off` 纯文本。
- **遮挡告警（票 03）**：移植 Android 互相遮挡算法（≥50% 重叠、排除同心父子包含），新增 iOS 合并规则：主导遮挡层（覆盖 ≥3 个文本元素且面积占屏 40–90%）输出单条全局告警并抑制相关逐元素告警，其余按重叠比取前 5 对。应用于执行器 prompt 与 `mobile_get_device_state` 的 `formatIosHierarchy`（输出契约变更，既有断言同步更新）。
- **no-op 检测（票 04）**：元素签名（排除系统状态栏与顶带节点）与截图哈希（裁上下 5% 系统带）双不变判定；`wait` 不参与；连续 1/3 步注入策略提示、连续相同 action+params 注入换策略提示；step 记 `noop`、record 记 `noopStreak`。
- **终态验证（票 05）**：`AOS_IOS_VERIFY=final|off`（默认 final）；`done(success=true)` 后补采一次 observation（失败标 `hierarchy:"stale"`），调用验证模型（默认主模型；`AOS_IOS_VERIFY_LLM` 可指定独立条目；非多模态模型不加截图）。fail 必须带非空 `failed_items`，否则 unavailable；`stale` 且验证模型非多模态直接 unavailable（不基于陈旧层级硬判）。pass → completed + 真实 `test_summary`（`synthesized:false`、`verification:"model-final"`、`verification_model`）；fail → failed，summary「验证未通过：…」，`failed_items` 入台账；unavailable 保持 completed 并显式标记。
- **历史压缩（票 06）**：`AOS_IOS_HISTORY_STEPS`（默认 8，范围 4–20）；更早步骤输出动作链摘要（thought 首句 ≤40 字 + action + outcome，跳屏步带屏幕摘要），≤800 字符、超限首尾保留 + 省略标记；digest 写 run.json。
- **失败日志（票 08）**：`AOS_IOS_LOG_FEEDBACK=0` 可关；失败终态前采集——模拟器用 `IosLogCollector` 时间窗过滤；真机用任务启动即挂的 `idevicesyslog` 环形缓冲（上限 200 行内存，失败终态落盘）；写 `logs/device.log`（来源/时间近似标注），摘要追加「设备日志已采集（N 行，来源 X）」；`mobile_inspect_trace` 的 view_summary 透出 `failure_logs`、search 可检索日志内容。不自动重试、不喂回循环（backlog）。
- **观测重试（票 09）**：`AOS_IOS_OBSERVE_RETRY`（默认 1，范围 0–5）；真机 WDA `nodes()` 解析失败与模拟器 idb `describe-all` 失败各重试一次（300ms 间隔），仍失败保持既有 `parse_failed`/错误语义。
- **平台语义（票 07）**：`tests.json`/`tests.md`/`tests.xlsx` 保持平台中立、零改动；`IOS_SYSTEM_PROMPT` 增规则：系统弹窗优先用 `alerts` 处理、视觉补充行与可访问性元素冲突时以可访问性元素为准。
- **env 分层收口**：`runtime.iosEnvironment()` 暴露 `{ ...项目 .env, ...进程 env }`；执行器开关（步数/视觉/验证/历史/日志/重试）统一经此读取（§13.57 边界收口；项目 `.env` 现在也生效、进程 env 仍优先，向后兼容）。
- **边界**：视觉感知走模型而非 macOS Vision framework OCR（backlog）；验证失败即终态、不自动修复重试；真机日志缓冲为长驻进程、可用开关关闭；`.scratch` 票 00（失败归因 + 零代码 A/B）为人工 spike，需设备执行、未随本批自动完成。
- **脚本断言核对（增补 2026-10-10：长用例执行约束力闭环）**：生成侧 `linearizeFlowsWithStats` 返回与 `paths` 对齐的 `prefixes`（入口→切点导航前缀，非续段为空），`generateTestCases` 据此产出 `continuation/startScreen/prelude/expectations` 字段与 `【AOS-EXPECT】` 块（`src/figma/test-gen.ts`）；tests.md 增加接续段标注与前导清单，tests.xlsx 新增 `{{case.prelude}}`/`{{case.startScreen}}`/`{{case.continuation}}` 占位符（默认表"步骤"列续段前置 `P#)` 行）。执行侧 `src/ios/task-runner.ts` 导出 `parseScriptPlan`（解析 `start` + `steps`）；每轮观测与 done 后补采各做一次命中匹配（`matchScriptExpectations`），`buildScriptAdherence` 汇总；验证提示词新增"脚本断言核对"段（未出现项→ failed_items 候选）；无验证时摘要追加 `⚠` 行。**起始屏 preflight（同批）**：生成侧 `GeneratedTest.preflight`（入口屏 + hints）随 `start` 下发；执行侧 `IosScriptPreflight`（`pending/matched/unmatched/unchecked`）首步核对、未命中每步注入导航提示、`test_summary.preflight` 与 run.json `preflight` 留痕、验证提示词"起始屏核对（确定性）"段 + 摘要 `⚠` 行；建议级不硬失败。新增测试：`test/figma-testgen.test.js`（续段 prelude/字段/AOS-EXPECT 解析/preflight/覆盖率不回退）、`test/ios-task-runner.test.js`（`parseScriptPlan` 解析边界、命中/未命中核对、`test_summary.adherence`、preflight matched/unmatched、run.json）。全量 786 绿。

### 13.60 实施记录（票 01：无交互数据检测与结构化告警）

> 实施于 2026-10-10；CR 交互理解主线首票（spec `.scratch/cr-interaction-understanding/`，根决策 ADR-0007/0008）。改 `src/figma/flows.ts`、`src/pen/flows.ts`、`src/server.ts`（工具描述）；测试 +6；全量 792 绿。

- **Figma**：`buildFlowGraph` 记录范围内携带原型交互的节点数（`interactionNodes`，随 flows.json 与工具 `counts.interactionNodes` 透出）；`flowGraphWarnings` 在「屏幕数 > 1 且 0 条边」时输出新码 `no-interactions`（文案区分「0 交互」与「有交互但未提取到可执行跳转」两态；details 列屏名；单屏文件不告警，避免噪声），与 no-entry/unreachable/unresolved 并列。
- **pen**：`.pen` v2.20 经 schema 核实无原型交互字段（唯一链接性字段为 text `href`）；新增确定性检测 `detectPenInteractionSignals`（`href` + 交互类节点键 interactions/prototype/reactions/onTap/onClick/onPress/hotspot + `metadata.type` 交互线索；空值 false/0/空串/空数组/空对象不计数）。告警由恒定 `pen-no-interactions` 改为条件二选一：无线索保持（文案注明格式依据）；有线索改为新码 `pen-interactions-present`（显式标注「未解析、仍按画板推断」，不静默合成）；`synthesis.interactionSignals`、工具 `counts.interactionSignals`、flow-map 说明行随状态切换。
- **边界**：本票仅检测与告警；线索解析与来源置标（provenance）属票 02+。
- **测试**：`test/figma-flows.test.js`（无交互告警/单屏不告警/有交互不告警/有交互无跳转告警）、`test/pen-flows.test.js`（线索翻转/空值不计数/确定性/工具级响应与落盘产物）。

### 13.61 实施记录（票 02：来源模型置标 provenance / confidence / 文本类别）

> 实施于 2026-10-10；CR 交互理解主线第二票（ADR-0008）。新增 `src/provenance.ts`；改 `src/figma/flows.ts`（置标 + 类别 + `normalizeFlowGraph`）、`src/pen/flows.ts`、`src/figma/test-gen.ts`；测试 +7；全量 799 绿。

- **词表**（CONTEXT.md）：`provenance ∈ {explicit, inferred, runtime-observed, human-confirmed, legacy-unknown}`（首个值从 ADR-0008 的「显式交互」放宽为「显式」，以覆盖显式设计对象/文本）；`confidence ∈ {high, low}`（explicit/observed/confirmed=high，inferred/legacy=low）；`textClass ∈ {runtime-text, annotation, layer-name}`（`Flow/*` 祖先层下的文本 = annotation）。
- **产物**：flows.json 升 `schemaVersion: 2`——screens/edges 携带 provenance/confidence，`textHints` 从 `string[]` 变为 `{text, textClass}[]`（Figma=explicit/high；pen 合成=inferred/low）；tests.json 的 expectations 每步携带 provenance/confidence，`【AOS-EXPECT】` steps 同步带 provenance。
- **兼容（保守消费）**：`normalizeFlowGraph`/`normalizeFlowHints` 读取旧 flows.json（缺字段/字符串 hints）→ legacy-unknown/low + runtime-text，不静默升权；未知 `textClass` 降级 `annotation`（只展示、不进断言）；畸形边引用校验（`to` 无名 → null）；**读取时 confidence 由 provenance 派生**（持久值仅供展示，自相矛盾字段不生效）。`figma_generate_tests` 读盘路径统一走 normalize；iOS 执行器解析 AOS-EXPECT 忽略未知字段（无回归）；原有内嵌 legacy 图（如手工夹具）经 `generateTestCases` 的容错读取同样可用。回填 = 重跑解析（解析器升级后产物自带）。
- **边界**：本票只置标与透传；类别消费（批注不进断言）、推断边降级探索、门禁分级属票 03+。结构分类规则（`Flow/*` → annotation）已随字段落地，票 03 收敛为「消费过滤 + note 类细化 + starbucks 回归」。
- **测试**：`test/provenance.test.js`（枚举归一含原型链键、confidence 映射、`Flow/*` 判定）、`test/figma-flows.test.js`（explicit/high 置标、Flow/* 批注分类、normalize 兼容两态 + 未知类别降级）、`test/pen-flows.test.js`（inferred/low、类别、schemaVersion=2）、`test/figma-testgen.test.js`（expectations/AOS-EXPECT provenance+confidence、legacy flows 端到端保守归一）。

### 13.62 实施记录（票 03：批注/图层名消费过滤 + starbucks 回归）

> 实施于 2026-10-10；CR 交互理解主线第三票。改 `src/figma/flows.ts`、`src/pen/flows.ts`（采集端分类限流）、`src/figma/test-gen.ts`（断言消费白名单）；测试 +4；全量 803 绿。

- **消费过滤**：`runtimeHintTexts`（`textClass=runtime-text`）成为 expectations / 起始屏 preflight / 元素定位 label 的**唯一**断言候选来源（§13.70 起验收口径 `acceptance` 为其外另一硬断言来源）；批注文本与 childNames 图层名不再进入断言、`【AOS-EXPECT】` 与 taskDesc 断言文案（类别证据仍留在 flows.json 供展示/对账）；无运行期文本时元素定位回退到元素图层名（定位用途，非断言）。
- **采集端分类限流（评审修复）**：hints 采集从"混合类别先截断"改为**按类别分别限流**且深搜索不因配额停止——批注洪水不再挤掉运行期文本（此前 3 条 `Flow/*` 批注在前即会让「早安, Amy」进不了 flows.json，消费过滤后断言为空）。
- **note 类守门**：pen 侧 note/context/prompt 节点内容按类型门天然不进 hints（负向回归固化）；`Flow/*` 命名规则沿用 `isAnnotationLayerName` 单实现（票 02 已落；Figma 无独立 note 类型，判定即命名约定）。
- **starbucks 回归**：合成含「刊頭廣告 - 活動跑馬燈」（批注）与图层名 childNames 的夹具 → expectations/起始屏/步骤 label/AOS-EXPECT 四层均只含运行期文本（「內用點餐」「早安, Amy☀️」「選擇門市」），批注文本全程不出现在 taskDesc。
- **边界**：批注的「提示级展示」未新增渲染面（flows.json 已带类别）；弱断言告警在新口径下部分步骤增多（back/AFTER_TIMEOUT 文案自带「应」除外），留给票 05 的门禁分级。
- **测试**：`test/figma-testgen.test.js`（starbucks 回归：四层过滤）、`test/figma-flows.test.js` / `test/pen-flows.test.js`（批注洪水回归：运行期文本存活 + 类别配额独立）、`test/pen-flows.test.js`（note/context/prompt 不进 hints）。

### 13.63 实施记录（票 04：推断边 → 探索步骤，生成语义）

> 实施于 2026-10-10；CR 交互理解主线第四票。改 `src/figma/test-gen.ts`（来源分流）、`src/figma/preflight.ts`（探索步骤不计弱断言、索引对齐）、`src/provenance.ts`（`isUnconfirmedProvenance` / `StepKind` / `isExploreKind`）；测试 +4；全量 807 绿。

- **生成分流**：`isUnconfirmedProvenance`（inferred / legacy-unknown）的边生成**探索步骤**——通用文案「探索到达「X」（来源未确认）：自行尝试触发通往该页的交互，记录实际路径与页面变化；不参与断言判定」；`AFTER_TIMEOUT`（等待 N 秒后确认到达）、`back`（探索返回上一屏）、无目标（探索未知跳转）各有专用措辞，不覆盖 trigger 语义；explicit / observed / confirmed 走现行硬断言路径。
- **结构化标记**：`StepExpectation.kind ∈ {assert, explore}`（tests.json 与 `【AOS-EXPECT】` steps 同步；`StepKind`/`isExploreKind` 归 `src/provenance.ts` 单点，preflight 不再字面量解码）；探索步骤 `hints=[]`（不断言，`screen` 保留为探索目标）；taskDesc 在含探索步骤时加「本用例含 N 步探索（来源未确认）…不参与 PASS/FAIL」行（**N 含续段前导探索步骤**）；tests.md/xlsx 经同一步骤文本自然呈现（三件套落盘有端到端断言）。
- **kind = deferred 语义**：`kind=explore` 即「不参与 PASS/FAIL 的 deferred 步骤」；执行器的 deferred 运行语义（不硬失败、adherence 只核 hard）属票 06。
- **门禁口径（承接）**：`suite check` 弱断言统计按**原始索引**对齐 `expectations[index].kind` 豁免 explore（字符串步骤过滤不再错位；legacy tests.json 无 expectations 时回退原「应」字口径）；覆盖口径的硬/探索分离属票 05。
- **兼容**：旧 flows（legacy-unknown）在**断言/步骤**语义按保守 = 探索；**覆盖门禁**分类见 §6.10/§13.64（legacy 仍属硬目标——失败响亮，不静默弱化旧项目门禁）；旧 tests.json 无 kind 在 preflight 回退旧口径；iOS 执行器解析 AOS-EXPECT 忽略未知 `kind`（回归测试锁定）。
- **测试**：`test/figma-testgen.test.js`（显式+推断混合分流、legacy 保守、trigger 语义专用措辞、AOS-EXPECT kind、md 渲染、三件套落盘含探索）、`test/pen-flows.test.js`（pen 合成全探索端到端）、`test/test-preflight.test.js`（explore 不计弱断言）、`test/ios-task-runner.test.js`（parser 对 kind/provenance 未知字段容错）。

### 13.64 实施记录（票 05：覆盖口径硬/探索分离 + `--strict`）

> 实施于 2026-10-10；CR 交互理解主线第五票。改 `src/figma/coverage.ts`（分类覆盖单一实现）、`src/figma/test-gen.ts`、`src/figma/preflight.ts`、`src/suite-command.ts`、`src/provenance.ts`（`isHardCoverageTarget`）；测试 +3；全量 810 绿。

- **分类口径**：`computeClassifiedCoverage` 复用 `computeScreenCoverage` 实现硬/探索两分区——**硬类 = 非 `inferred`**（explicit/observed/confirmed 及 legacy-unknown：旧产物保持门禁强度，失败响亮）；**探索类 = `inferred`**（pen 合成等；不参与门禁，仅报告）。
- **生成闸**：`FlowCoverage.complete/uncoveredScreens/uncoveredEdges` 转为硬覆盖语义，新增 `explore: {uncoveredScreens/uncoveredEdges/complete}`；`requireFullCoverage` 按硬覆盖判定（inferred 不虚高门禁），报错文案并列探索缺口；响应 hint 与工具描述同步口径。
- **执行预检**：`PreflightCoverage` 读 flows.json provenance 拆分（`screens` 仍为全量覆盖并集，供路线漂移检测）；`suite check`/`suite run --fail-on-uncovered` 门禁只看硬覆盖；输出行标注「未硬覆盖 … · 探索缺口 …（不阻断）」，JSON 输出含 `coverage.explore`。
- **`--strict`**：`check` 与 `run --fail-on-uncovered` 支持；开启时非探索弱断言（preflight weakCases，explore 已豁免）计入门禁 exit 2；默认行为与退出码语义不变（0/1/2）；`run --strict` 未带 `--fail-on-uncovered` 时输出提示（不静默失效）。
- **留白与同步**：纯推断图（无硬目标）生成闸为空真通过——探索缺口在 `coverage.explore` 可见，不视为已验证；`suite loop` 报告并列探索缺口计数（json/md）；`computeClassifiedCoverage` 复用单一实现，legacy=硬 的决策有单测锁定。
- **测试**：`test/figma-testgen.test.js`（硬闸不被 inferred 虚高、探索缺口仅报告、legacy 仍门禁）、`test/test-preflight.test.js`（provenance 拆分）、`test/suite-command.test.js`（check 默认 0 / `--strict` exit 2 / 探索步豁免）、`test/suite-loop.test.js`（探索缺口计数）。

### 13.65 实施记录（票 06：iOS 探索步骤执行语义）

> 实施于 2026-10-10；CR 交互理解主线第六票。改 `src/ios/task-runner.ts`；测试 +2；全量 812 绿。

- **解析**：`parseScriptPlan` 读取 `【AOS-EXPECT】` steps 的 `kind`（`isExploreKind`；缺省 = assert，兼容旧产物），`IosScriptExpectation.kind` 复用 `StepKind`（provenance.ts 单点定义）。
- **adherence 分区**：`buildScriptAdherence` 只统计 assert 类（checkable/satisfied/unchecked/unresolved）；新增 `deferred: {total, reached}`——探索步骤不进 unresolved 口径；`reached` 口径为**目标屏名作为完整可见标签出现**（按 ` | ` 拆分的标签集合精确匹配，杜绝短屏名子串误命中）；步骤级 `scriptHits` 继续记录命中。
- **执行语义与保障等级**：系统提示词新增规则 9（探索步骤不参与 PASS/FAIL，**显式覆盖规则 5**：找不到入口记录实际路径后继续或 done，不要用 fail 中止）；验证提示词新增「另有 N 步探索（deferred）不参与本次判定，请勿因此写入 failed_items」；完成摘要的 `⚠ 脚本断言未出现` 只为 assert 未命中出现。**保障等级为提示级 + 验证豁免**：模型若仍对探索未达成输出 `fail` 会中止任务（无法把 fail 机械归因到具体步骤），真实失败（崩溃等）也应如实失败——不做机械拦截，已在本文档明示。
- **透出**：run.json `script_adherence` 全量（含 deferred）；`test_summary.adherence` 在 `deferred.total>0` 时携带 deferred（adherence 分区后，纯探索用例不会被整体省略）。
- **不回归**：hard 断言命中/未命中、preflight、终态验证通路不变。
- **测试**：`test/ios-task-runner.test.js`（parser kind、deferred 分区与 reached、验证提示词豁免、test_summary deferred、探索未达成仍 completed、旧用例 deferred=0）。

### 13.66 实施记录（票 07：`design-inference` 失败域 + 报告来源显示）

> 实施于 2026-10-10；CR 交互理解主线第七票。改 `src/artemis/failure-taxonomy.ts`、`src/artemis/task-result.ts`、`src/figma/suite-runner.ts`、`src/figma/run-report.ts`、`src/suite-command.ts`、`src/figma/suite-loop.ts`、`src/provenance.ts`（`summarizeScriptProvenance`）；测试 +2；全量 814 绿。

- **失败域**：新增 `design-inference`，归类规则插在 data-environment 之后、behavior-or-design 之前（崩溃/环境/API/数据等强信号优先，不冲突）：用例失败且 failedItems 非空时——脚本**纯探索**（asserts=0、explores>0）→ confidence high；**混合脚本**需**双证据**才判 medium：`unresolvedAsserts===0`（iOS adherence 显式回传断言全命中）且 `exploresReached < explores`（探索未全达成）；无 adherence（Android/计划解析失败）或探索全达成或断言未出现 → 回落 `behavior-or-design`。**优先级取舍**：数据/登录类文案启发式先于 design-inference（纯探索用例的真实数据问题仍归 data-environment），已在测试锁定。
- **输入信号**：`FailureInput.scriptProvenance {asserts, explores, unresolvedAsserts?, exploresReached?}`；tests.json `expectations.kind` 经 `summarizeScriptProvenance`（provenance.ts 单点）汇总；iOS `test_summary.adherence`（unresolved/deferred reached）解析进 `TaskTestSummary.adherence`（`task-result.ts`）；组装由 `scriptProvenanceSignal` 单点（suite-runner / run-report 共用）。
- **报告来源显示**：`SuiteCaseResult.scriptProvenance` 入套件 JSON 与控制台（`[FAIL] … · 脚本 断言N/探索M`）；run-report xlsx 增「脚本来源」列（`断言 N / 探索 M`）；JUnit failure message 含归类理由（含探索计数）；`suite loop` 失败域动作文案列全域名；移动任务摘要在 `test_summary.adherence` 透出 assert/explore（来源）计数与归类置信度（套件侧）。
- **边界与延后**：①「设计↔观测冲突 → design-inference」的冲突信号依赖对账资产（票 08/09），本票只覆盖推断来源失败；②`jira_evidence_post` 归域未接 `scriptProvenance`（无 tests.json 上下文），与套件报告在纯探索场景可能不一致——按需后续接线；③轮询超时且中途有 failedItems 的路径沿用既有优先级（failedItems 分支先于 timedOut），不在本票调整。
- **测试**：`test/failure-taxonomy.test.js`（纯探索 high / 双证据 medium / 断言未出现回落 / adherence 缺失回落 behavior-or-design / 探索全达成回落 / 数据信号优先 / 崩溃优先）、`test/suite-runner.test.js`（端到端归类 + scriptProvenance 透出）、`test/run-report.test.js`（xlsx 列头与值）。

### 13.67 实施记录（票 08：对账资产核心——证据记录 + 导航级自动升级）

> 实施于 2026-10-10；CR 交互理解主线第八票（ADR-0004 资产模式，ADR-0007 升级规则）。新增 `src/figma/reconciliation.ts`；改 `src/figma/suite-runner.ts`（摄取接线）、`src/figma/test-gen.ts`（生成消费）；测试 +9；全量 823 绿。

- **资产 schema（v1，`.artemis/design/reconciliation.json`）**：逐边条目 `{from, to, designProvenance, provenance, status: pending|upgraded, traces[]（完整审计轨迹，不截断——保证任意 trace 重放幂等）, hits, lastSeenAt}`；纯函数 `parse/serialize/applyObservations/applyReconciliationToGraph/hitsFromRunSteps`，读写薄 IO（load/save，原子写、缺省空资产、损坏容错、保留已有 version），稳定排序（edge key `"From → To"`）。
- **摄取（执行 → 资产）**：`suite run` 每例终态且为 iOS trace 时，读 trace `run.json` 的 `steps[].scriptHits`，把探索步骤（tests.json expectations kind=explore，含屏幕名与来源）映射为边（screens 序列中目标屏的**最后一次**出现的前一屏 → 目标屏，回访屏不错配）：命中的边计数并升级；**未命中的边登记为 pending 差异条目**（套件钩子不再以"有命中"为前提；设计与真机观测未对上，待审阅/复跑）。同 trace 重放幂等。best-effort：失败 `logWarn` 不阻断套件。
- **升级规则（导航级）**：阈值 = 1 次观测命中即升级（`designProvenance` 为 inferred/legacy 时才升级；explicit 记录但不改写）；pending → upgraded 生命周期有测试锁定；硬断言级升级不在自动范围（留票 09 人工/验收口径）。
- **生成消费（资产 → 生成）**：`figma_generate_tests` 读盘/现场提取后都叠加资产——已升级边把 inferred/legacy 置为 `runtime-observed`/high，下一次生成直接产出硬断言（不再探索），响应带 `reconciliation.upgradedEdges`；无资产文件时输出与旧行为一致（显式测试）。
- **边界**：Android/无 run.json 的 trace 不摄取（记录计数不可得）；冲突仲裁与人工确认属票 09；资产不参与 diff 判定（ADR-0001）；屏幕名即边身份的局限（跨屏同名/改名）留待审核面按 nodeId 强化。
- **测试**：`test/reconciliation.test.js`（观测计数/幂等/pending 生命周期/explicit 不改写/稳定排序/损坏容错/图叠加/hits 解析/ingest 落盘含差异登记）、`test/figma-testgen.test.js`（升级边生成硬断言 + 响应计数 + 无资产零变化）、`test/suite-ios.test.js`（iOS 运行→升级+差异双条目端到端）。

### 13.68 实施记录（票 09：对账审阅面——CLI/MCP 人工确认）

> 实施于 2026-10-10；CR 交互理解主线第九票。改 `src/figma/reconciliation.ts`（审阅纯函数 + 工具 handler + 共享 listing）、`src/suite-command.ts`（`suite reconcile`）、`src/server.ts`（`reconciliation` 工具注册）；测试 +6；全量 829 绿。

- **资产 schema 扩展**：entry 增 `review {decision: confirmed|rejected, reviewer, at, note?}`；`status ∈ {pending, upgraded, confirmed, rejected}`；确认 → provenance `human-confirmed`（硬断言级），驳回 → 回落 `designProvenance`；观察升级逻辑不变（已确认/驳回条目不再被观测改写，命中仍记录为审计轨迹）。解析时 **review 决定优先于陈旧 status**；重复决定未传 reviewer 时保留上次记录。
- **纯函数**：`reviewEdge(asset, {from,to,decision,reviewer?,note?,at})` 幂等（重复同一决定仅刷新 reviewer/时间、不追加历史；改判覆盖为最新决定并把被取代项追加进 `history`，上限 10——见 §13.74）；未知边返回可行动错误（提示先跑套件或核对屏幕名）。
- **共享输出面**：`reconciliationListing(configDirAbs)` 单点构造（counts/edges/`toTextHints` 目标屏运行期文本上下文/一次读取 flows.json 建屏名 Map），MCP 工具与 CLI（文本与 `--json`）同形输出。
- **MCP 工具 `reconciliation`**（screen-map 先例：模块内导出 handler、错误边界 try/catch）：list / confirm / reject（可选 reviewer/note）。
- **CLI `suite reconcile list|confirm|reject [--from --to --reviewer --note --json]`**：confirm/reject 缺参 exit 2、未知边 exit 1、成功 exit 0，并提示后续生成行为（human-confirmed 硬断言 / rejected 不生成）。
- **生成消费**：`applyReconciliationToGraph` 扩展——confirmed → `human-confirmed`/high（硬断言路径）；rejected → 从流程图**移除**（不再生成，覆盖口径随图）；响应带 `reconciliation.{upgradedEdges,confirmedEdges,rejectedEdges}`（零值省略）；**未裁决（pending）不升权**有生成侧测试。
- **corrupt 判定修正**：仅 JSON 不可解析记 corrupt（合法的空 `{"version":1,"edges":[]}` 不再误报）；部分坏条目静默丢弃（记录为已知边界）。
- **边界**：观测摄取只产生探索边条目，explicit 边通常不入资产（人工确认/驳回按边名仍可作用于 explicit——人工权威）；审阅只针对资产已有条目；屏幕名即身份（改名/同名需 list 核对）；rejected 移除边不单独报告可达性影响（覆盖分母随图缩小，记录为已知边界）。
- **测试**：`test/reconciliation.test.js`（决定幂等/改判/未知边/reviewer 保留/图叠加 confirmed+rejected/工具 handler 列表含文本上下文与可行动错误）、`test/figma-testgen.test.js`（观测→审阅→生成单链：确认边硬断言 + 驳回边移除 + 响应计数 + 未裁决不升权 + 无资产零变化）、`test/suite-command.test.js`（reconcile list/confirm/reject 退出码 0/1/2 与资产落盘）。

### 13.69 实施记录（票 10：元素级映射自动发现 + accessibilityIdentifier 建议）

> 实施于 2026-10-10；CR 交互理解主线第十票。改 `src/diff/screen-map.ts`（elements 资产 + 匹配/建议/合并纯函数）、`src/figma/suite-runner.ts`（iOS 摄取接线）、`src/figma/test-gen.ts`（生成消费 a11y 建议）、`src/server.ts`（screen_map 工具 elements 参数/输出）；测试 +6；全量 835 绿。

- **资产扩展（screen-map.json，与屏幕级共存）**：新增 `elements: ElementMapEntry[]`（`{screen, text, observedLabel, identifier, confidence, source, hits, traces, lastSeenAt}`）；空数组不落盘（向后兼容——既有文件序列化字节不变）；稳定排序（screen+text）；`loadScreenMap` 的 corrupt 判定修正为「entries 与 elements 皆空」（elements-only 文件不再误报损坏）。
- **匹配规则（确定性）**：设计运行期文本（tests.json expectations hints，trim 后为身份）↔ 观察标签（iOS `run.json` 各步 `screen` 文本摘要按 ` | ` 拆分）**唯一精确归一匹配**（去空白 + 小写，`normalizeElementLabel` 单点共享）；设计文本归一后冲突或未出现 → 跳过（不猜）；重复观察标签折叠；命中 confidence=1。**同 trace 幂等**（entry `traces` 去重，重放不膨胀）。
- **identifier 建议**：latin 词 → camelCase（小写字母开头，单字母合法）；纯非 ASCII → `element_<sha1 前 8>`（稳定幂等）。
- **人工补（关键路径）**：`screen_map(action:"save", elements:[…])`（source 强制 manual；与自动条目按 screen+text 合并，**manual 的 identifier 不被观察覆盖**）；**工具 schema 已暴露 `elements`（server-smoke 锁定，防止 zod strip 断链）**；list 输出 `elements`。
- **生成消费**：`figma_generate_tests` 载入 elements（按 hits 优选，键为归一文本——同文案跨屏建议同一 identifier，属约定行为）→ 步骤元素注记追加 `；a11y: <identifier>`（tests.md/xlsx/taskDesc 同步）；无建议时行为不变。
- **口径与边界（明示）**：本票实现为「运行期文本 ↔ 观察标签」映射，**不含 design nodeId 与几何维度**（backlog §13.72 已补：hints/screen 携带 nodeId+bounds、条目归一 bounds、tap 几何消歧）；自动发现双端可用（iOS trace `run.json`；Android `data_engine.db`，§13.73）；简报已接线（§13.71）；`screenTextSummary` 截断（60 元素/4000 字符）可能漏配尾部标签；纯探索边 hints=[] 不参与元素发现（其目标屏文本可经 assert 边进入）。
- **测试**：`test/diff-screen-map.test.js`（建议确定性含单字母/唯一匹配/歧义跳过/合并与 manual 优先/trace 幂等/序列化兼容/落盘幂等）、`test/suite-ios.test.js`（运行 → elements 落盘）、`test/figma-testgen.test.js`（步骤 a11y 注记）、`test/server-smoke.test.js`（screen_map schema 暴露 elements + reconciliation required 锁定）。

### 13.70 实施记录（票 11：验收口径入生成——设计标注先行）

> 实施于 2026-10-10；CR 交互理解主线第十一票（spec Q8；收尾票）。改 `src/figma/flows.ts`（验收采集 + 共享判定）、`src/pen/flows.ts`、`src/figma/test-gen.ts`（硬断言来源 + `acceptance.json` 覆盖）；测试 +5；全量 840 绿。

- **识别规则（设计标注先行，确定性）**：`Flow/AC*` 命名分组内的文本（整条为口径）或 `Flow/*` 批注中 `AC:` / `验收(标准|条件|要求)：` / `驗收(標準|條件|要求)：` 前缀文本（**大小写不敏感**、**支持多行**；词表与 Jira 验收启发式对齐）；**空体/仅有前缀 → 忽略**（模糊口径保守留在展示级批注，不进断言）；每屏上限 5 条；随 flows.json screens 的 `acceptance` 字段落盘（无口径不写字段；normalize 去重、过滤空项与非法类型、空数组不落字段）。
- **硬断言来源绑定**：assert 步骤的期望 hints 优先取目标屏 `acceptance`（`hintsSource:"acceptance"`，上限 5 与存储一致），否则取运行期文本（`hintsSource:"runtime-text"`）；探索步骤仍 `hints=[]`（导航未确认前不硬断言，**口径在观测/人工升级后生效**——有端到端回归）；`【AOS-EXPECT】` steps 携带 `hintsSource`（执行器忽略未知字段，无回归）。
- **人工确认覆盖**：`.artemis/design/acceptance.json`（`{screens:{"<屏名>":["条目"]}}`）在生成时覆盖同名屏的注释口径（**人工确认优先**；来源可视为文件作者，无 reviewer 字段；口径侧冲突由覆盖语义解决，**不经 09 审阅面**——导航级冲突仍走 08/09；文件非法 → 忽略并回退注释）；Jira AC 摄取留后续集成。
- **冲突与提示级口径**：验收条目优于运行期文本（确定性优先）；「无口径的屏保持提示级」——运行期文本断言为建议级（执行器不断言硬失败），起始屏 preflight 仍只取运行期文本（边界）。
- **测试**：`test/figma-flows.test.js`（Flow/AC 组 + `AC:` 行 + 大小写/多行 + 空体忽略 + 无口径缺省 + normalize 容错）、`test/pen-flows.test.js`（同规则）、`test/figma-testgen.test.js`（hintsSource 双源 + AOS-EXPECT 字段 + acceptance.json 覆盖 + 升级后口径生效端到端）。

### 13.71 实施记录（backlog：build-brief 接线 a11y 标识建议）

> 实施于 2026-10-10；CR 交互理解主线 backlog 首项（闭合 §13.69「简报未接线」边界）。改 `src/figma/brief.ts`（`BriefData.accessibility` + `briefAccessibility` + md 第 7 节）、`src/pen/brief.ts`；测试 +2；全量 842 绿。

- **接线**：`figma_export_brief` / `pen_export_brief` 读取 `.artemis/design/screen-map.json` 的 elements（稳定排序 screen+text），写入 build-brief.json 的 `accessibility: [{screen,text,identifier,source,hits}]`；build-brief.md 在元素非空时新增「## 7. 无障碍标识建议（a11y）」表（下一节顺延为 8；元素为空时编号回退、既有输出不变）。
- **用途**：代码侧实现组件时直接采用建议 identifier（与测试侧步骤 `a11y:` 注记同源），闭合「设计 → 代码」锚点一致。
- **边界**：建议来源于观测/人工映射（无 elements 即不出章）；Jira AC 仍 backlog。
- **测试**：`test/figma-brief.test.js`（md 第 7/8 节与回退编号、`briefAccessibility` 排序与缺省空）。

### 13.72 实施记录（backlog：几何 / design nodeId 元素映射）

> 实施于 2026-10-10；backlog 第二项（承接 §13.69 边界）。改 `src/figma/flows.ts`、`src/pen/flows.ts`（hints/screen 携带 nodeId + design-px bounds）、`src/diff/screen-map.ts`（条目 nodeId/归一 bounds、按屏作用域匹配、tap 几何消歧、`observedTapsFromRunSteps`）、`src/figma/suite-runner.ts`（flows 元数据富化 + taps 摄取）；测试 +3；全量 845 绿。

- **设计侧富化**：`FlowHint` 增 `nodeId`/`bounds`（design px 绝对坐标；Figma `absoluteBoundingBox`、pen x/y/w/h），`FlowScreen` 增 `bounds`；随 flows.json 落盘（additive，schemaVersion 仍 2；normalize 校验、legacy 缺省）。
- **元素条目**：`ElementMapEntry` 增 `designNodeId`/`bounds`（**归一 0..1 per screen**：`(rect − screen) / screen`）；条目身份键 = `(screen, nodeId, text)`（同屏同名不同节点各自独立；无 nodeId 时行为不变）。
- **匹配升级（按屏作用域）**：跨屏同名文本不再互斥（各屏独立条目，修正 §13.69 的全局去重）；同屏同名按 nodeId 去重；同屏多候选时用 **trace 级 tap 几何消歧**——tap 归一坐标（截图像素 ÷ step.scale ÷ 启动截图逻辑尺寸，PNG 头解析）落在恰一个候选矩形内 → 命中（confidence 0.8），命中 0 或多个 → 跳过（不猜）。
- **摄取接线**：`suite run`（iOS）元素发现时读 flows.json 富化 hint 元数据（屏 bounds + 节点 nodeId/bounds），并从 run.json tap 步骤（shot+scale+PNG 尺寸）计算归一 taps；flows 缺失/截图不可读 → 退回纯文本匹配（行为同 §13.69）。
- **边界**：tap 为 trace 级证据（不按步归屏）；几何消歧仅用包含判定（无距离阈值参数）；Android 自动发现由 §13.73 接线；identifier 建议规则不变。
- **测试**：`test/figma-flows.test.js` / `test/pen-flows.test.js`（nodeId+bounds 采集）、`test/diff-screen-map.test.js`（按屏作用域、几何消歧含双命中与无几何跳过、taps 归一化与缺截图退化、归一 round-trip）、`test/suite-ios.test.js`（flows 元数据富化端到端）。

### 13.73 实施记录（backlog：Android 侧自动发现）

> 实施于 2026-10-10；backlog 第三项（接 §13.69/§13.72 的 Android 边界）。新增 `src/artemis/android-trace.ts`（`node:sqlite` 只读）；改 `src/figma/suite-runner.ts`（非 iOS trace 摄取分支；`buildElementDesigns` 抽公共）；测试 +2（`node:sqlite` 缺失自动 skip）；全量 847 绿。

- **数据源（离线可核，artemis 子模块为事实源）**：`<tracesDir>/data_engine.db`（SQLite；子进程以 `session_id == trace_id` 记账）；`steps.action_taken` JSON（`{action, coordinates, coordinate_space:"normalized"}`，Flash 记录模型 0–1000 归一坐标）+ `images.ocr_result` JSON（`[{text, position}]`）。tap 归一：`relX/relY = x/1000`。
- **对账摄取**：探索步骤「到达」判定为确定性 OCR 匹配——目标屏设计运行期文本（flows.json 归一化）或屏名出现在 OCR 标签集即命中（→ `hitIndexes` → 既有 `ingestExplorationObservations`）；未命中不记 hit（pending 差异照常登记）。
- **元素映射**：OCR 文本作 `observedLabels`、归一 tap 作 `observedTaps`；设计侧富化与 iOS 共用（`buildElementDesigns`）；同屏重名同样走几何消歧。
- **降级**：DB 缺失/`node:sqlite` 不可用（Node < 22.5，动态 import 失败）→ 静默跳过（无发现、不报错）；**schema 漂移经显式 PRAGMA 列守卫探测 → 记 warn + 跳过**（ADR-0009）；AOS 本体 Node ≥ 20 兼容不受影响（仅该功能需 ≥ 22.5，README 注明）。
- **边界**：Android 无 AOS-EXPECT adherence（断言核对仍 artemis 自管）；到达门槛为 1 个设计文本/屏名命中（OCR 缺失即无证据，保守）；未标 `coordinate_space` 的动作不计 tap。
- **测试**：`test/android-trace.test.js`（DB 读取/标签与归一 taps/未知 trace 与缺库退化 + 套件端到端：OCR 命中升级对账边、元素条目带 designNodeId；`node:sqlite` 缺失自动 skip）。

### 13.74 实施记录（backlog：对账决定历史 + 反向观测）

> 实施于 2026-10-10；backlog 第四项（收尾）。改 `src/figma/reconciliation.ts`（direction/history + `applyRuntimeOnlyObservations`）、`src/artemis/android-trace.ts`（pre/post 标签 + transitions）、`src/figma/suite-runner.ts`（设计上下文 `loadDesignContext`、屏匹配 `bestScreenForSummary`、双端反向摄取）、`src/suite-command.ts`（list 呈现）；测试 +4；全量 849 绿。

- **决定历史**：`reviewEdge` 仅在**决定变更**时把被取代的 review 追加进 `entry.history`（上限 10，含 reviewer/note/时间），同决定重复只刷新时间/reviewer；normalize 持久化 history；CLI list 追加 `决定历史 confirmed→rejected` 呈现；工具 JSON 全量透出。
- **方向模型**：entry 增 `direction: "design" | "runtime-only"`（缺省 design，legacy 兼容）。runtime-only 条目：`designProvenance: legacy-unknown`、`provenance: runtime-observed`、初始 status pending；**永不影响生成**（`applyReconciliationToGraph` 过滤 runtime-only；审阅 confirm/reject 仅裁决留痕，provenance 保持观测级）。
- **反向观测摄取（真机有设计无）**：iOS——`run.json` 步屏文本摘要压缩后取相邻转移；Android——`data_engine.db` 步骤 pre/post OCR 标签集合不同者；两侧统一经 `bestScreenForSummary`（按屏匹配数取唯一最大；并列/无匹配 → 弃，不猜）映射到设计屏；设计图已有该边（`edgeKeys`）则跳过；同 trace 幂等（traces 去重）、按边去重。
- **边界**：反向观测为**证据级**（不生成、不升级、不硬断言）；映射并列即弃（保守）；Android 转移依赖 pre/post 图落盘（缺 post 即无证据）。
- **测试**：`test/reconciliation.test.js`（历史追加/同决定不追加/round-trip；runtime-only 创建/幂等/design 优先/不升权/审阅留痕）、`test/android-trace.test.js`（transitions 采集 + 端到端逆向条目）、`test/suite-ios.test.js`（iOS 逆向条目端到端）。

### 13.75 实施记录（iOS 设备解析收口：`resolveIosDevice` + `Runtime.iosDevice`）

> 实施于 2026-10-11；架构评审候选 A（`improve-codebase-architecture`，见临时报告）。新增 `src/device/ios-facade.ts`（纯模块 `resolveIosDevice`）；改 `src/runtime.ts`（`iosDevice(serial)` 绑定）、`src/ios/task-runner.ts` / `src/figma/suite-runner.ts` / `src/device/ios-reset.ts`（3 个设备构造点迁移）；测试 +6（`test/ios-facade.test.js` 5 例 + `test/ios-reset.test.js` 1 例）；全量 855 绿、lint 干净。

- **动机**：真机后端（M9a/M9c）叠加后，"选后端"的内联三元表达式散在多个调用点（`task-runner` 任务设备、`suite-runner` 复位注入、`ios-reset` 默认构造），真机 serial 在无注入时会错造模拟器设备；按 artemis `create_driver` 的先例收成单一设备解析入口。
- **机制**：`resolveIosDevice(serial, deps)`——非 iOS serial → `null`；模拟器（UUID 形态）→ `makeIosDevice`（`simulatorOptions` 透传，测试注入 exec/env/platform）；真机（8-16 / 40 hex）→ `deps.wdaDevice(udid)`，缺 provider → 明确抛错。`Runtime.iosDevice(serial)` 绑定 `this.iosWda().device`，为生产唯一入口；设备构造点不再各自分支。
- **边界**：观察读取（`tools/ios-state.ts`、`diff/device-source.ts` 的 `IosWdaService.screenshot/nodes`，含 observe 重试/`parse_failed` 归并）不在本次范围，保持现状（留给后续"平行实现收敛"候选）；`classifyIosSerial` 仍保留用于行为判定（复位策略、日志分支、`.ipa` 门禁）。`ios-reset` 的行为变化：真机 serial 无注入时由"错造模拟器设备"改为显式报错（`suite` 生产路径本就注入 WDA 设备，不受影响）。
- **测试**：`test/ios-facade.test.js`（非 iOS → null 且零 provider 调用；模拟器本机构造且不触 WDA；`simulatorOptions` 透传生效；真机走 provider；真机缺 provider 抛错）、`test/ios-reset.test.js`（真机无注入 → `/WDA provider/` 拒绝）。

### 13.76 实施记录（iOS 平行实现收敛：日志窗口策略 / 崩溃分发 / trace raw 读取 / 观察截图取源）

> 实施于 2026-10-11；架构评审候选 B（承接 §13.75）。改 `src/device/ios-log.ts`（新增 `collectWindowLogs` 窗口策略与类型）、`src/ios/task-runner.ts`（`collectFailureLogs` 只留落盘与 `IosFailureLogs` 组装）、`src/crash/ios-dispatch.ts`（新，`collectIosCrashesFor` 分发）、`src/runtime.ts`（崩溃采集改经分发，删除 `useDevice` 分支）、`src/ios/trace-store.ts`（新增 `readIosRunPayload`）、`src/figma/suite-runner.ts`（对账读取改经 trace-store）、`src/tools/ios-state.ts`（截图取源改经 `runtime.iosDevice` 门面）；测试 +6（`test/ios-log.test.js` 3 例、`test/ios-crash-dispatch.test.js` 3 例）；全量 861 绿、lint 干净。

- **动机**：A 落地后仍存在的"同概念多实现"——日志窗口策略在 task-runner 重写、崩溃分发在 runtime 手写、suite 对账直读 run.json、`mobile_get_device_state` 观察截图自行按 kind 选源。
- **日志（B2）**：`collectWindowLogs({serial, windowStartMs, windowEndMs, processName?, tail?, collector?, env?, nowMs?})` 收口策略——tail 快照（真机实时尾）→ 模拟器 `log show` → 真机无 tail `no-collector`；`ok` 时 lines 必非空（空窗口以 `skipped` 表达）；窗口过滤由实现侧适配（`clockWarning` 标注近似）。task-runner 保留 `persistFailureLogs`（`logs/device.log` + `IosFailureLogs` 契约）。
- **崩溃（B3）**：`collectIosCrashesFor(serial, window, dispatch)`——`{via:"injected"}`（注入覆盖，来源标 `diagnostic-reports`；互斥 union）或 `{via:"auto"}`（按 serial 种类：模拟器 DiagnosticReports / 真机 devicectl，source 随实现）；runtime 的 `useDevice` 判断删除，注入缝保留（`deps.collect` / `iosCrashCollector` 改为 `IosCrashCollectFn`）。
- **trace（B4）**：`trace-store.readIosRunPayload(traceDir)` 暴露原始 run.json（缺失/不可解析 → null，调用方判空）；suite 对账不再直读文件。
- **截图（B1）**：`mobile_get_device_state` 截图（含 `parse_failed` 回退）改经 `deps.device ?? runtime.iosDevice(serial)` 门面取图；错误文案真机保留"真机截图失败"前缀、模拟器透出底层错误（错误码映射退场）；层级读取（`IosWdaService.nodes` 的 observe 重试）与 `device-source` 的 note 标签保持原路径（本切片显式不动）。
- **边界**：层级两个 formatter 不合并（0-1000 人读 vs 逻辑点 prompt，契约不同；共享 occlusion 已抽出）；`device-source` 截图保持现状（note 的 idb/simctl 标签保真）。
- **测试**：`test/ios-log.test.js`（tail 优先窗口过滤、真机无 tail 降级、模拟器采集器与异常/空窗）、`test/ios-crash-dispatch.test.js`（按 kind 分发 + injected 覆盖 + source 标注）、`test/ios-device-state.test.js`（注入缝由 `captureIosPng`/`wda` 换为 fake `device`）。

### 13.77 实施记录（iOS 执行器拆分：task-runner 门面 + 9 个实现模块）

> 实施于 2026-10-11；架构评审候选 C（承接 §13.75/§13.76）。`src/ios/task-runner.ts`（1,908 行）拆分：`types.ts`（记录/状态类型 + `VerifierTarget`）、`task-registry.ts`（任务内存注册表）、`script-plan.ts`（【AOS-EXPECT】解析与贴合）、`prompt-history.ts`（system prompt/屏幕格式化/历史摘要/提示）、`verifier.ts`（终态验证）、`failure-logs.ts`（日志窗口落盘 + `resolveLogFeedback`）、`trace-persist.ts`（run.json/status.json 持久化 + 截图落盘）、`run-loop.ts`（执行循环 + 动作执行）、`tool-entry.ts`（两个工具入口 + 状态视图）；`task-runner.ts` 收敛为 7 行门面（仅再导出 `maybeIosRunTask`/`maybeIosManageTask`/`getIosTask`/`__resetIosTasks`）。测试 +0（纯搬移）；861 全绿、lint 干净。

- **动机**：单文件混合编排/感知/LLM 往返/动作/持久化/验证/日志/工具 schema；拆分后每块有明确 seam，导航与改动半径下降（候选 C 的"验证与感知降为内部缝、外围工具成薄适配层"）。
- **接口**：`mobile_*` 工具面与 `Runtime` 集成零变化（`runtime.ts` 仍只 import 门面）；类型消费者（`trace-store.ts`/`inspect.ts`）改直连 `types.js`，消除唯一的 type-level 环；`StartIosTaskDeps` 留在 `tool-entry.ts`（`run-loop.ts` 仅 type-import，无运行时环）。
- **边界**：`executeAction` 留 `run-loop.ts`（循环内环动作执行）；`captureStepShot` 随 `trace-persist.ts`（产物写入）；`visibleElementCount`/`MIN_TEXT_ELEMENTS` 留 `run-loop.ts`（视觉触发属循环决策）；不新造 runTask 接口（`maybeIosRunTask` 已是唯一深接口）。
- **测试**：既有 35/36 入口级用例零改动通过；`parseScriptPlan`（`test/ios-task-runner.test.js`）与 `buildHistorySections`（`test/ios-noop.test.js`）改从新模块导入（2 行）。

### 13.78 实施记录（路由收口：trace 前缀单源 / api-errors 来源标签 / 路由测试补齐）

> 实施于 2026-10-11；架构评审候选 D（承接 §13.75–§13.77；事实修正后范围收敛）。改 `src/ios/trace-store.ts`（新增 `IOS_TRACE_PREFIX`/`isIosTraceId`）、`src/ios/tool-entry.ts`（traceId 用常量）、`src/server.ts`（任务统计跳过改用谓词）、`src/suite-command.ts` + `src/figma/suite-runner.ts`（api-errors 来源按 serial 种类标注：真机 `idevicesyslog` / 模拟器 `simctl-log`，修真机错标）、`src/artemis/api-errors.ts`（`source` 联合类型放宽）；测试 +6（新 `test/ios-routing.test.js` 6 例，其中 1 例自 `test/ios-task-runner.test.js` 迁出；`test/suite-command.test.js` +1）；全量 867 绿、lint 干净。

- **边界（事实修正）**：原报告"18 处字符串嗅探"在 A–C 后大部分已归位（设备构造走 `Runtime.iosDevice`、崩溃走 `collectIosCrashesFor`、日志分支为模块内部合法语义）；剩余真实项 = 前缀硬编码 3 处 + 来源标签 1 处 + 路由测试缺口。不做 dispatch 表驱动（现状单点分发、4 条 if 清晰）；`device-source.ts` 错误文案正则留给候选 E。
- **前缀单源**：`IOS_TRACE_PREFIX` + `isIosTraceId`（trace-store 唯一事实源；`isIosTraceDir` 磁盘归属判定不动，platform 字段优先）；`tool-entry` 写入与 `server.ts` 任务统计跳过共用，`server` 不再内联 `startsWith`。
- **来源标签**：`api-errors` 产物 `source` 按 serial 种类标注真实采集器（真机 `idevicesyslog`、模拟器 `simctl-log`），修 suite-command 与 suite-runner 两处真机错标；`ApiErrorArtifact.source` 联合类型同步放宽。
- **路由测试**：`test/ios-routing.test.js`——wrapper 级（经 `runtime.proxy.callTool`）：iOS UDID `mobile_run_task` 截获 / `mobile_diagnose` 穿透 / Android serial 穿透 / 磁盘 iOS trace 的 `manage`、`inspect` 截获；server 级：`ios-` 结果跳过任务行补记、普通 trace 补记（对照）。

### 13.79 实施记录（结构化降级：`device_busy` 与缓存帧脱离字符串）

> 实施于 2026-10-11；架构评审候选 E（承接 §13.75–§13.78）。改 `src/ios/appium/service.ts`（`WdaCaptureResult` 增加 busy 判别变体：`IosDeviceBusyError` → 结构化 `{busy:true, cachedFrame}`，不再拍平为字符串）、`src/diff/device-source.ts`（删除 `/busy|占用/i` 正则，改读结构化字段；异常路径 `instanceof` 转换）、`src/tools/ios-state.ts`（截图 busy + 缓存帧 → 落盘缓存帧并返回路径 + 标注 `capturedAt`；无帧/层级 busy → 结构化报错）；测试 +4；全量 871 绿、lint 干净。

- **动机**：README/DESIGN/CONTEXT 三处承诺"busy 返回 `device_busy` + 最近缓存帧"，但实现里结构化错误在 `service.screenshot/nodes` 拍平为字符串，消费者只能拿正则反推，`service.cachedFrame` 无生产消费者——承诺全部落空（ADR-0005 的显式降级原则）。
- **机制**：`WdaCaptureResult<T> = ok | {ok:false, busy?:false, error} | {ok:false, busy:true, error, cachedFrame}`（busy 作判别键，既有注入 `{ok:false,error}` 不受影响）；`service.screenshot/nodes` catch `instanceof IosDeviceBusyError` → busy 变体（携带 `.cachedFrame`；`CachedFrame` 类型经 session 导出）。
- **降级口径**：观测截图（`mobile_get_device_state` device 分支）busy 且有缓存帧 → 写 `live_screenshot_<udid>.png`（缓存帧）并返回 `file://…` + 标注「device_busy：返回最近缓存帧，capturedAt=…」；无缓存帧 → `device_busy` 结构化文案；层级 busy → 结构化文案（无帧可降级）。diff/compare（`device-source`）busy 仍报错（陈旧帧可能误报差异，显式不做帧降级），错误提示由结构字段生成并注明缓存帧可用性。
- **边界**：缓存帧无 TTL/stale 标记（会话空闲回收不清帧，仅 dispose 清理）；执行器步骤截图 `captureStepShot` 的 busy 仍静默跳过（不引入陈旧步骤图）。
- **测试**：`test/ios-wda-service.test.js`（service busy → 结构化变体；device-source busy/普通错误两条提示；普通失败走 Appium 指引）、`test/ios-device-state.test.js`（busy 缓存帧降级返回并标注/无帧报错/层级 busy 提示）。

### 13.80 实施记录（`data_engine.db` 对账读取收边：显式 schema 守卫 + ADR-0009）

> 实施于 2026-10-11；架构评审候选 F（收尾）。改 `src/artemis/android-trace.ts`（`REQUIRED_COLUMNS` + `schemaGaps`（`pragma_table_info` 探测）；schema 漂移 → `logWarn` + 跳过，宽 catch 仍兜损坏）、`test/android-trace.test.js`（+1 用例：缺列/缺表 → null）；新增 `docs/adr/0009-android-trace-readonly-schema-binding.md`；全量 872 绿、lint 干净。

- **动机**：本条读取是 AOS 源码中唯一的 SQLite schema 绑定（151 行、只读、降级为 null），原实现以宽 catch 兜底——schema 漂移与未知 trace/缺库**不可区分**且无测试；与 ADR-0003（其理由"不绑定上游 schema"）的口径张力从未成文。
- **机制**：打开只读库后先按列探测契约（`steps`: session_id/step_number/action_taken/pre_image_name/post_image_name；`images`: image_name/ocr_result；`data_engine` 无 `user_version`，只能 PRAGMA）；缺表/缺列/不可读 → `logWarn`（可诊断的契约漂移）+ 返回 null；缺库/`node:sqlite` 不可用/未知 trace 保持静默（预期内缺数据）；数据解析路径不变。
- **边界**：不迁移上游工具面（`mobile_inspect_trace` 返回渲染文本，pre/post 标签与归一 taps 无法无损还原——ADR-0009 Considered Options）；读取结果仍为 `null` 语义（消费方只需要有/无）；ADR-0003 继续约束"失败步骤截图"来源，不受影响。
- **测试**：`test/android-trace.test.js` 新增 schema 漂移用例（缺 `post_image_name` 列、缺 `images` 表 → null；真实 `node:sqlite` 构造，node < 22.5 自动 skip）。

### 13.81 实施记录（观察读取统一：`ios/observation.ts`）

> 实施于 2026-10-11；第二轮架构评审候选 1。新增 `src/ios/observation.ts`（`observeScreenshot`/`observeHierarchy` 判别结果：ok 携带 bytes/nodes+backend，失败携带 serial 种类与 busy（含缓存帧））；改 `src/tools/ios-state.ts`（截图/层级统一经观察模块，注入缝收缩为 `observe` 一处）、`src/diff/device-source.ts`（iOS 分支委派观察模块，保留既有 `captureIosPng`/`captureWdaPng` 注入兼容）；测试 +0（注入缝更新）；全量 873 绿。

- **动机**：同一"读屏"概念三套协议（facade `Buffer|throw`、service `WdaCaptureResult`、raw `IosPngCapture`）与三处注入端口（`device`/`wda`/`describeIosUi`），busy/parse_failed 策略在消费者重复实现。
- **机制**：观察模块按 serial 种类分派——模拟器走 idb/simctl 原始捕获（保留 tool 标签），真机走 WDA 服务（结构化变体；`IosDeviceBusyError` → busy 判别）；`device-source` 的 note/提示由判别结果生成，不再各自分支。
- **边界**：执行器内环（run-loop）继续直接使用 `IosDevice` 动作接口（观察 ≠ 动作）；`device-source` 的差异对比不在 busy 时降级用缓存帧（陈旧帧可能误报，沿用 §13.79 决策）。
- **测试**：`test/ios-device-state.test.js` 注入缝换为 `observe.{wdaScreenshot,wdaNodes,captureIosPng,describeIosUi}`（含 busy 缓存帧/无帧/层级 busy 三态）。

### 13.82 实施记录（执行器内环拆分：`step-observe`/`step-record` + 设备解析隐患修复）

> 实施于 2026-10-11；第二轮架构评审候选 2。新增 `src/ios/step-observe.ts`（`observeStep`：读屏/尺寸/前置截图 → preflight/scriptHits → noop 游标 → 视觉融合降级）、`src/ios/step-record.ts`（`toStepRecord` 三段重复合一）；改 `src/ios/run-loop.ts`（`runLoop` 401 → ~320 行，只留顺序与终态）；测试 +1（设备解析失败 → 终态 failed）；全量 873 绿。

- **机制**：循环携带状态收缩为 `ObservationCursor`（lastSignature/lastShotHash/previousAction）；`observeStep` 失败抛 `观察屏幕失败: …`，由 `runLoop` 终态收尾。
- **隐患修复**：设备解析（`runtime.iosDevice`）与 `runtime.entries()` 移入守护——WDA/Appium 启动失败不再产生未处理拒绝、记录不再滞留 `running`（回归用例断言 `无法解析 iOS 设备` 终态）。
- **边界**：`executeAction` 与 `visibleElementCount` 判定随 `runLoop` 留驻（内环动作/视觉触发策略）。

### 13.83 实施记录（缓存帧生命周期：age/stale 与消费面）

> 实施于 2026-10-11；第二轮架构评审候选 3（兑现 `.scratch/ios-real-device` spec 的 stale 承诺）。改 `src/ios/appium/session.ts`（`CachedFrame` 增 `capturedAtMs`；`frameAgeMs`/`isFrameStale`/`resolveCachedFrameMaxAgeMs`；`AOS_IOS_CACHED_FRAME_MAX_AGE_MS` 默认 10min，0=关闭陈旧判定）、`src/tools/ios-state.ts`（busy 降级标注 `age≈…`，陈旧追加「已陈旧」）、`src/diff/device-source.ts`（busy 提示含帧龄）、`src/ios/appium/service.ts`（删除无生产消费者的 `cachedFrame(udid)` 访问器）；测试 +3；全量 876 绿。

- **策略**：陈旧帧仍返回（保留降级可用性）但显式标注；差异对比路径不消费帧（§13.79 决策不变）。
- **边界**：帧无 TTL 自动清理（随会话 manager dispose 释放）；`AOS_IOS_CACHED_FRAME_MAX_AGE_MS` 由 `runtime.iosEnvironment()` 分层读取。

### 13.84 实施记录（design 资源单一读取：`figma/design-store.ts`）

> 实施于 2026-10-11；第二轮架构评审候选 5。新增 `src/figma/design-store.ts`（`readTestsDocument`/`loadDesignFlowGraph`（必归一）/`loadGeneratedCases`/`toGeneratedCase`/`designDir`）；迁移 6 个 tests.json 解析器（suite-runner / preflight / run-report / generation-feedback / case-index / suite-command ×2）与 4 个 flows.json 读取（suite-runner / preflight / run-report / reconciliation）经 store；测试 +3（`test/design-store.test.js`）；全量 879 绿。

- **动机**：同一文件六种解析、`GeneratedCaseLike` 三处重声明；`preflight`/`run-report` 的 raw 读取绕过 `normalizeFlowGraph`，provenance 默认值可能分叉。
- **边界**：`test-gen` 的自定义 flowsPath 读取（错误语义特异）保持原样；`pen` 侧无独立 suite 读取路径不受影响。

### 13.85 实施记录（套件执行核心：`figma/case-runner.ts`）

> 实施于 2026-10-11；第二轮架构评审候选 4。新增 `src/figma/case-runner.ts`（`executeCase(testCase, context)`：reset → 提交（含失败记账）→ 轮询 → api-errors 采集与产物 → 结果组装；返回 `{result, submitted, submitError, terminal}`）；`suite-runner.ts` 866 → 528 行（`runGeneratedTests` 只留加载/筛选/编排/聚合，对账摄取抽为 `ingestTraceObservations`）；新增 `src/crash/query.ts`（`crashesForTrace`，与 run-report 去重）；测试 +0；全量 879 绿。

- **接口**：`CaseRunContext`（runtime/model/deviceSerial/lockedAppPackage/quarantined/failOnApiErrors/apiCatalog/resetFn/iosDeviceWda/timers/采集器）——轮询与提交语义可脱离设备文件夹具直测；flake/retry 复用同一执行器。
- **边界**：停止/首错传播由调用方（runner 循环）处理；对账摄取留在 runner（依赖设计上下文与 reconciliation 模块）。

### 13.86 实施记录（任务台账抽取：`tasks/ledger.ts`）

> 实施于 2026-10-11；第二轮架构评审候选 6（第一切片）。新增 `src/tasks/ledger.ts`（`TaskLedger`：提交/结果记账（`local-` 占位、caseId 回填、lockedPackages 上限 200）、`traceStatus`（status.json 优先 + iOS orphan 对账 + 代理回退）、`syncTaskStatuses`（终态回调注入崩溃取证））；`runtime.ts` 对应方法改为委托（公开面零变化，`traceDir` 保留）；测试 +0；全量 879 绿。

- **边界（本切片未做）**：`ChildSupervisor`（child spec/指纹/sweep 的自由函数内联）暂缓——该拆牵扯 proxy 生命周期与 `sweepStaleChild` 测试不变量，留作独立轮次；`lockedPackageFor` 暴露给崩溃扫描进程名推断。

### 13.87 实施记录（server ListTools schema 缓存）

> 实施于 2026-10-11；第二轮架构评审候选 7（功能切片）。改 `src/server.ts`（`nativeSchemaCache`/`figmaSchemaCache`——zod→JSON schema 转换按工具名缓存一次，HTTP 每 POST 新建 server 的 ListTools 不再重复转换）；测试 +0；全量 879 绿。

- **边界（本切片未做）**：`NATIVE_TOOLS`（534 行）域文件拆分与 stdio/HTTP 引导去重（`runtime-host`）暂缓——两者为纯搬移/生命周期整理，价值在导航性而非行为，留作独立轮次。
