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
| `figma_extract_flows`       | `{url, nodeId?, save?}`                                                            | 原型交互 → 流程图（screens/edges/entryScreens/unresolved），落盘`.artemis/design/flows.json`；供后续"流程→测试生成"消费（M-B）                                                                                                                                                                                                                                     |
| `figma_gap_analysis`        | `{url, id?, assetGlobs?, tokenFiles?, save?}`                                      | 设计资源/色板 vs 项目资产/tokens 缺口（missingAssets/missingColors），**扫描规则按检测到的技术栈选择**（`src/projects/stack.ts`：Flutter/RN/原生 Android/iOS/Web 档案，含资产目录/定位/代码/命名约定），缺失资源按栈重命名（如 Android `ic_home.svg`、Flutter `home_icon.svg`）并给出目标目录；落盘 `.artemis/design/gaps.json`；供"资源导入"消费（M-C） |
| `figma_generate_tests`      | `{url?, flowsPath?, maxFlows?, save?, excelPath?, excelTemplate?}`                 | 连续交互线性化为端到端流程（entry→…→终态/BACK），生成 artemis 可直接执行的任务描述；落盘`tests.json` + `tests.md`（过程文档）+ `tests.xlsx`（每流程一行：用例名/页面链路/步骤/任务描述；默认表，`excelPath` 改路径；`excelTemplate` 传 `.xlsx` 模版时填充 `{{meta.*}}/{{counts.*}}/{{case.*}}/{{index}}` 占位符并复制行模版）（M-B）                                                                                              |
| `figma_import_assets`       | `{url?, gapPath?, destDir?, ids?, format?, densities?, overwrite?, dryRun?, save?}`            | 按 gaps.json 导出缺失资源（SVG 内联/PNG 下载）→ 按栈命名与首选目录写入；PNG 默认按栈倍率集（Android xhdpi/xxhdpi、Flutter 2.0x/3.0x、iOS imageset、RN @2x/@3x；`densities:false` 回退单文件 @2x）；**唯一性三层**：命名规范化 → 目标路径幂等（同内容 `unchanged`；异内容 `skipped_exists`/`overwrite`）→ **内容 sha256 去重**（批次内 + 项目资产索引，跨文件同名/异名重复记 `duplicate_of`）；`dryRun` 按同样规则预览；落盘 `import-report.json`（M-C/§13.35）                |
| `figma_export_brief`        | `{url, save?, includeFlows?, includeGaps?, scaffold?, maxComponents?, overwrite?}` | 构建简报：tokens（颜色/字阶/间距/圆角/阴影）+ 页面路由 + 组件与变体 + 流程概览 + 缺口摘要 + 栈编码约定 →`build-brief.{json,md}`；`scaffold` 按栈生成组件骨架（幂等）（M-D）                                                                                                                                                                                       |
| `pen_inspect`               | `{path?, save?}`                                                                   | pen.dev 离线检查：解析 `.pen`（开放 JSON，容忍 `//` 注释）→ 结构校验（id 唯一/无 `/`、ref 可解析、`$变量` 可解析）+ 摘要（屏幕/组件/实例/文案/变量与主题/图片资产与缺失）；path 缺省取 `.artemis/design` 下最新 `*.pen`；`save:true` 落盘 `.artemis/design/pen/summary.json`；无账号与网络需求（P1）                                                                              |
| `pen_import_tokens`         | `{path?, dryRun?, overwrite?, save?, enforcement?}`                                | pen 颜色变量 → canonical `tokens.json`（DTCG；**变量名即 token 名**，主题取值写入 `modes`（`axis=value`），`$别名` → `aliasOf`）+ 按栈 token 文件（复用 `writeStackTokenFile` 幂等写入）；输出 new/updated/unchanged/unused、裸色扫描与 enforcement（语义同 `figma_import_tokens`）；完全离线（P1）                                                                                                                                                                 |
| `pen_import_strings`        | `{path?, locale?, dryRun?, save?, enforcement?}`                                   | `.pen` 文本节点 → `strings.json` + 按栈资源写入（复用 `runStringsImport` 全流水线：冻结 key/冲突闭环/硬编码扫描/五栈写入）；`reusable` 组件自成屏幕上下文，`ref` 不展开；完全离线（P1）                                                                                                                                                                                                                                |
| `pen_export_brief`          | `{path?, save?, includeGaps?, scaffold?, maxComponents?, overwrite?}`              | `.pen` → `build-brief.{json,md}`（颜色/字阶/间距/圆角/阴影、屏幕与建议路由、可复用组件、按栈约定、可选 gaps 摘要）；复用 Figma 版 markdown 渲染与 `scaffoldComponentSkeleton`；完全离线（P1）                                                                                                                                                                                                                        |
| `pen_export`                | `{path?, out?, format?, scale?, dryRun?, timeoutMs?}`                              | headless CLI 渲染导出：`.pen` → PNG/JPEG/WEBP/PDF（默认 `.artemis/design/pen/<name>.<ext>`；`dryRun` 返回命令）；pen CLI 缺失时自动托管安装（`~/.aos/pen-cli`，`AOS_PEN_NO_INSTALL=1` 关闭；`AOS_PEN_CLI_PATH`/`AOS_PEN_CLI_DIR`/`AOS_PEN_VERSION` 可覆盖、`AOS_PEN_TIMEOUT_MS` 默认 120s），需已登录（`pen login` 或 `.env` `PEN_CLI_KEY` 自动透传）（P1 写回）  |
| `pen_apply_tokens`          | `{path?, tokensPath?, out?, dryRun?, timeoutMs?}`                                  | CLI 写回：`tokens.json`（含 modes 主题取值）→ `.pen` `SetVariables`；默认**原位更新**（临时文件 → 回读校验变量值 → 原子替换；校验失败不动原文件），`out` 可另存；别名 token 不单独写入（P1 写回）                                                                                                                                                                                                                       |
| `pen_apply_strings`         | `{path?, stringsPath?, out?, dryRun?, timeoutMs?}`                                 | CLI 写回：`strings.json` 的 nodeId→sourceText → `.pen` 文本节点 `Update(content)`；原位更新/校验/另存语义同上；nodeId 不存在记入 `notFound`（P1 写回）                                                                                                                                                                                                                                                                    |
| `pen_agent`                 | `{path?, out?, prompt, agent?, model?, effort?, anthropicBaseUrl?, custom?, exportPath?, exportType?, exportScale?, maxFailedCalls?, dryRun?, timeoutMs?}` | headless CLI agent 生成/修改设计：prompt → `.pen`（默认原位：临时文件→结构校验→原子替换，失败不动原文件；`out` 新建/另存）；pen CLI 缺失时自动托管安装（同 `pen_export`）；**凭证复用 active LLM**（不落日志/响应），项目 `.env` 的 `PEN_*`/`ANTHROPIC_*` 透传（active LLM 派生值优先），Anthropic 兼容端点按 provider 桥接：DeepSeek（apiKey，已实测）、Kimi/Z.AI/百炼（authToken + 模型映射，按官方文档，待真实 key 冒烟）；其他 provider 仅注入 `PEN_AGENT_API_KEY` 并告警（可 `anthropicBaseUrl`/`AOS_PEN_ANTHROPIC_BASE_URL` 覆盖）；有桥接时 claude agent 自动 `--custom`；可选 `exportPath` 顺带出图（P1 写回） |

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
- **里程碑后续**：M8b 证据回写（单条评论就地更新 + 确定性命名附件 + crash 摘要）、M8c CLI 与 issue tracker 迁移见 `.scratch/jira-integration/`（票据 03–06）与 §13.55。

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

- **生成统计不再沉默**：`linearizeFlowsWithStats` 输出 `{maxFlows,maxDepth,entryFallback,exploredPaths,keptPaths,droppedPaths,truncated}`；`figma_generate_tests` 经 `onStats` 回调把 `generation` 写入响应与 tests.json（入口回退、截断、丢弃路径数可见）。
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
- **失败域确定性分类**（`classifyFailure`，纯函数）：优先级 应用缺陷（与 trace 关联的崩溃签名，high）→ 环境（复位 `adb-not-found/device-offline/timeout` 或失败文案含 adb/device/no devices/设备离线 等，high）→ 数据环境（失败文案含登录/账号/数据/列表/网络 等信号；命中前置假设 high，否则 medium）→ 行为或设计差异（有 `failed_items` 且无其它证据，high）→ 用例缺陷（轮询超时 / 提交被拒且文案含参数/格式/task_desc，medium）→ unclassified low 并给出原因；规则固定顺序、固定样本可回归（同输入输出 deepEqual）。
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
- **判定**：`matchApiErrors` 逐行匹配并计数、取首个样例与时间；`handledPattern` 命中 → `handled`，声明但未命中 → `unhandled`，未声明 → `observed`。失败域新增 **`api-error`**（仅 `unhandled` 触发）：优先级 崩溃 > 环境 > api-error > 数据环境 > 行为或设计 > 用例缺陷 > 未分类；`handled/observed` 只作证据不改域。
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
- **边界**：不做 OCR、不做像素级脱敏；图片不做降采样（v0 直传模拟器原始 PNG，注意 token 成本）；多模态启发可能误判（显式 env 可覆盖）。
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
