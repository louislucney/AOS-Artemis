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

连接：`MOBILE_TESTING_DATABASE_URL`（MCP 客户端配置 env 注入，进程级，跨项目共享）。本地开发可用 compose 的 `local-db` profile（专用 PG 于 `127.0.0.1:5433`，见 README）；表结构首次连接自动创建。
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

降级策略：`MOBILE_TESTING_DATABASE_URL` 缺失或连接失败 → `MemoryStore`（会话内有效）+ `aos_status` 警告，**不阻断**任务执行。

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
| `figma_generate_tests`      | `{url?, flowsPath?, maxFlows?, save?, excelPath?, excelTemplate?, requireFullCoverage?}`                 | 连续交互线性化为端到端流程（entry→…→终态/BACK），生成 artemis 可直接执行的任务描述；落盘`tests.json` + `tests.md`（过程文档）+ `tests.xlsx`（每流程一行：用例名/页面链路/步骤/任务描述；默认表，`excelPath` 改路径；`excelTemplate` 传 `.xlsx` 模版时填充 `{{meta.*}}/{{counts.*}}/{{case.*}}/{{index}}` 占位符并复制行模版）；响应与 `tests.json` 写 `coverage`（**硬覆盖**：未覆盖屏幕/跳转、`truncated`、`entryFallback`；`explore` 报告 inferred 缺口），`requireFullCoverage:true` 时硬覆盖不完整即报错且三份都不落盘（M-B；契约见 §6.10；每个 taskDesc 注入 `【真实数据】` 硬约束条款，§13.93）                                                                                              |
| `figma_import_assets`       | `{url?, gapPath?, destDir?, ids?, format?, densities?, overwrite?, dryRun?, save?}`            | 按 gaps.json 导出缺失资源（SVG 内联/PNG 下载）→ 按栈命名与首选目录写入；PNG 默认按栈倍率集（Android xhdpi/xxhdpi、Flutter 2.0x/3.0x、iOS imageset、RN @2x/@3x；`densities:false` 回退单文件 @2x）；**唯一性三层**：命名规范化 → 目标路径幂等（同内容 `unchanged`；异内容 `skipped_exists`/`overwrite`）→ **内容 sha256 去重**（批次内 + 项目资产索引，跨文件同名/异名重复记 `duplicate_of`）；`dryRun` 按同样规则预览；落盘 `import-report.json`（M-C/§13.35）                |
| `figma_export_brief`        | `{url, save?, includeFlows?, includeGaps?, scaffold?, maxComponents?, overwrite?}` | 构建简报：tokens（颜色/字阶/间距/圆角/阴影）+ 页面路由 + 组件与变体 + 流程概览 + 缺口摘要 + 栈编码约定 →`build-brief.{json,md}`；`scaffold` 按栈生成组件骨架（幂等）（M-D）                                                                                                                                                                                       |
| `pen_inspect`               | `{path?, save?}`                                                                   | pen.dev 离线检查：解析 `.pen`（开放 JSON，容忍 `//` 注释）→ 结构校验（id 唯一/无 `/`、ref 可解析、`$变量` 可解析）+ 摘要（屏幕/组件/实例/文案/变量与主题/图片资产与缺失）；path 缺省取 `.artemis/design` 下最新 `*.pen`；`save:true` 落盘 `.artemis/design/pen/summary.json`；无账号与网络需求（P1）                                                                              |
| `pen_extract_flows`         | `{path?, save?, maxScreens?, vision?}`                                                      | pen 流程合成：`.pen` 无原型交互数据时，以「Flow 标注 > 屏内首个文本 > 图层名」命名屏幕、按标签前缀归并状态变体（主屏 + states）、按画板序号与画布排布推断跳转（`trigger/actionType=INFERRED`）；可选视觉识别（`vision: auto`（默认）/`true`/`false`）——active LLM 具备视觉时渲染每屏识别交互元素（受控类别/意图 + bbox → nodeId grounding），产出元素清单（`vision-inferred`/low）与未决目的地（`to:null`）探索边，不可用显式降级不阻断；落盘 `.artemis/design/flows.json`（schemaVersion 3，供 `figma_generate_tests`/`suite check` 消费）+ `flow-map.md`；返回碎片度统计、视觉统计与 warnings（契约见 §6.10 生成策略相邻条目、§13.91） |
| `pen_import_tokens`         | `{path?, dryRun?, overwrite?, save?, enforcement?}`                                | pen 颜色变量 → canonical `tokens.json`（DTCG；**变量名即 token 名**，主题取值写入 `modes`（`axis=value`），`$别名` → `aliasOf`）+ 按栈 token 文件（复用 `writeStackTokenFile` 幂等写入）；输出 new/updated/unchanged/unused、裸色扫描与 enforcement（语义同 `figma_import_tokens`）；完全离线（P1）                                                                                                                                                                 |
| `pen_import_strings`        | `{path?, locale?, dryRun?, save?, enforcement?}`                                   | `.pen` 文本节点 → `strings.json` + 按栈资源写入（复用 `runStringsImport` 全流水线：冻结 key/冲突闭环/硬编码扫描/五栈写入）；`reusable` 组件自成屏幕上下文，`ref` 不展开；完全离线（P1）                                                                                                                                                                                                                                |
| `pen_export_brief`          | `{path?, save?, includeGaps?, scaffold?, maxComponents?, overwrite?}`              | `.pen` → `build-brief.{json,md}`（颜色/字阶/间距/圆角/阴影、屏幕与建议路由、可复用组件、按栈约定、可选 gaps 摘要）；复用 Figma 版 markdown 渲染与 `scaffoldComponentSkeleton`；完全离线（P1）                                                                                                                                                                                                                        |
| `pen_export`                | `{path?, out?, format?, scale?, dryRun?, timeoutMs?}`                              | headless CLI 渲染导出：`.pen` → PNG/JPEG/WEBP/PDF（默认 `.artemis/design/pen/<name>.<ext>`；`dryRun` 返回命令）；pen CLI 缺失时自动托管安装（`~/.aos/pen-cli`，`AOS_PEN_NO_INSTALL=1` 关闭；`AOS_PEN_CLI_PATH`/`AOS_PEN_CLI_DIR`/`AOS_PEN_VERSION` 可覆盖、`AOS_PEN_TIMEOUT_MS` 默认 120s），需已登录（`pen login` 或 `.env` `PEN_CLI_KEY` 自动透传）（P1 写回）  |
| `pen_apply_tokens`          | `{path?, tokensPath?, out?, dryRun?, timeoutMs?}`                                  | CLI 写回：`tokens.json`（含 modes 主题取值）→ `.pen` `SetVariables`；默认**原位更新**（临时文件 → 回读校验变量值 → 原子替换；校验失败不动原文件），`out` 可另存；别名 token 不单独写入（P1 写回）                                                                                                                                                                                                                       |
| `pen_apply_strings`         | `{path?, stringsPath?, out?, dryRun?, timeoutMs?}`                                 | CLI 写回：`strings.json` 的 nodeId→sourceText → `.pen` 文本节点 `Update(content)`；原位更新/校验/另存语义同上；nodeId 不存在记入 `notFound`（P1 写回）                                                                                                                                                                                                                                                                    |
| `pen_agent`                 | `{path?, out?, prompt, agent?, model?, effort?, anthropicBaseUrl?, custom?, exportPath?, exportType?, exportScale?, maxFailedCalls?, dryRun?, timeoutMs?}` | headless CLI agent 生成/修改设计：prompt → `.pen`（默认原位：临时文件→结构校验→原子替换，失败不动原文件；`out` 新建/另存）；pen CLI 缺失时自动托管安装（同 `pen_export`）；**凭证复用 active LLM**（不落日志/响应），项目 `.env` 的 `PEN_*`/`ANTHROPIC_*` 透传（active LLM 派生值优先），Anthropic 兼容端点按 provider 桥接：DeepSeek（apiKey，已实测）、Kimi/Z.AI/百炼（authToken + 模型映射，按官方文档，待真实 key 冒烟）；其他 provider 仅注入 `PEN_AGENT_API_KEY` 并告警（可 `anthropicBaseUrl`/`AOS_PEN_ANTHROPIC_BASE_URL` 覆盖）；有桥接时 claude agent 自动 `--custom`；可选 `exportPath` 顺带出图（P1 写回） |
| `pen_import_assets`         | `{path?, ids, format?, densities?, destDir?, overwrite?, dryRun?, save?, timeoutMs?}` | CLI 资源导入（headless，需登录）：`.pen` 节点 → 位图（interactive `Export`：单会话、命令数=倍率数、单命令全 ids；png/jpeg/webp）→ 按栈命名/倍率集/目录幂等写入（复用 figma 写盘管线：路径幂等 + sha256 去重 + `duplicate_of`；`densities:false` 回退单 @2x）；产物以 CLI `Exported` 路径对账（缺产物记 `export-no-output` + 批次告警；未知 id 离线预校验失败）；报告 `.artemis/design/import-report.pen.json`（`schemaVersion`/`penCliVersion`/`vector:"unsupported"`；独立于 figma 报告）；超时会话级自适应（`AOS_PEN_IMPORT_TIMEOUT_MS`）；`dryRun` 仍渲染以获得去重结果（§13.58） |

`setup_required` 语义：无任何可用条目时，`llm_list` 正常返回并带 `setupRequired: true` + 指引；`mobile_run_task` 直接返回结构化 `setup_required` 错误（不调用子进程）；其余 mobile 工具放行。

**测试用例 Excel 导出（`figma_generate_tests`，2026-10-01）**：`save !== false` 时除 `tests.json`/`tests.md` 外默认落盘 `tests.xlsx`（`excelPath` 改路径）；无模版时生成开箱表（sheet `测试用例`，表头 `#/用例名称/涉及页面/前置假设/步骤/artemis 任务描述`，表头加粗、首行冻结、步骤与任务描述自动换行）；任务描述含 `【真实数据】` 硬约束条款与 `【AOS-EXPECT】` 断言块（§13.93）。传 `excelTemplate`（`.xlsx`）时读取用户模版填充占位符：

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
- **会话**：同 UDID FIFO 互斥 + 任务级 lease（finally 释放）+ 观测会话空闲回收（`AOS_IOS_SESSION_IDLE_MS` 默认 30min，0=保活）；观测拿锁有界等待（`AOS_IOS_OBSERVE_WAIT_MS` 默认 5s）→ `device_busy` + 最近缓存帧（结构化变体）；截图 busy 且有缓存帧 → 降级返回缓存帧路径并标注 `capturedAt`/`age`，超过 `AOS_IOS_CACHED_FRAME_MAX_AGE_MS`（默认 10min，0=关闭）追加「已陈旧」，层级 busy → 结构化报错（实现见 §13.79/§13.83）；自愈阶梯（DELETE→POST→托管重启一次）。
- **能力**：截图、层级（page source XML 经 fast-xml-parser；解析失败 `parse_failed` 回退截图）、tap/swipe（W3C actions）、文本输入（先聚焦→有界等键盘→`POST /keys`；`mobile: typeText` 在 xcuitest 12.15 已移除）、terminate/activate/install/deepLink。
- **签名**：`AOS_IOS_XCODE_ORG_ID`（证书 OU 团队 ID，真机必填）、`AOS_IOS_XCODE_SIGNING_ID`（默认 Apple Development）、`AOS_IOS_WDA_BUNDLE_ID`（默认 com.aos.mcp.wda）；`useNewWDA=false` + `allowProvisioningDeviceRegistration=true`（真机实测）；多项目团队各异时各自在项目 `.env` 声明（分层规则见 §13.57）。
- **路由**：`mobile_get_device_state` device 分支（busy/parse_failed 降级）、`captureLiveScreenshot`（design diff / compare 真机截图，note "iOS 真机 WDA PNG" 即 backend 标识）、`mobile_run_task`（执行器设备 façade 对 device 走 WDA）。观察读取统一经 `src/ios/observation.ts`、执行器为门面 + 分模块（§13.81/§13.77）。真机崩溃经 `devicectl systemCrashLogs`、真机日志经 `idevicesyslog` 实时尾采样（M9c，窗口近似 `clockWarning`；缺工具降级 `ios-log-tool-missing`）。
- **排障**：doctor/`aos_status.ios` 显示 Appium/xcuitest/签名/隧道指引；iOS 18+ 需一次性 `sudo appium driver run xcuitest tunnel-creation`。

### 6.10 接入契约：流程完整性保证（2026-10-08）

**契约**：项目接入 AOS 后，"设计流程 → 用例 → 执行"的**路线完整性由 MCP 保证**，项目侧只需提供最小输入；不要求项目自建测试套件或测试规范（自建 XCUITest 不在此保证范围内）。

- **项目最小输入**：① 可运行应用（模拟器/真机安装方式）；② 设计源（Figma URL 或 `.pen`）；③ 凭证（项目 `.env`：`FIGMA_ACCESS_TOKEN` + LLM key；iOS 真机另需 `AOS_IOS_XCODE_ORG_ID`）。
- **闸 1・提取**（`figma_extract_flows`）：`warnings` 数组显式报告 `no-entry`（无入口屏→entryFallback）、`unreachable-screens`（无法从入口到达）、`unresolved-destinations`（跳转目标缺失），与流程图一同落盘 `flows.json`。
- **闸 2・生成**（`figma_generate_tests`）：`coverage` 分**硬/探索**两类——`complete/uncoveredScreens/uncoveredEdges` 为硬覆盖（explicit/observed/confirmed 及 legacy 证据），`explore`（`uncoveredScreens/uncoveredEdges/complete`）报告 inferred 探索缺口（仅展示，不阻断）；`requireFullCoverage:true` 时硬覆盖不完整（未硬覆盖屏幕/跳转或路径截断）即报错，且 `tests.json/tests.md/tests.xlsx` 三份都不落盘。
- **闸 3・执行**（`suite run --fail-on-uncovered`）：按预检**硬覆盖**（未硬覆盖屏幕/跳转、生成截断）判定，命中即 exit 2；探索缺口仅报告；`--strict` 追加弱断言门禁；自定义 `--tests` 同样校验（cases 来自指定文件，flows 仍取 `.artemis/design/flows.json`）；缺/坏 `flows.json` 视为校验不可用并按不通过处理（fail-closed）；套件未执行时执行失败信息优先展示，覆盖结论并列输出。
- **执行闭环（既有）**：每用例为入口→终点的连续任务（`mobile_run_task`，iOS 走 idb/Appium 执行器），`case_id` 回填台账、失败步骤证据、`compare_design_and_device`/`design_device_diff` 视觉核对、崩溃取证。
- **默认姿势**：设计流水线脚本 `scripts/design-pipeline.mjs` 调 `figma_generate_tests` 时默认 `requireFullCoverage:true`；文档示例推荐同参数（MCP 参数本身保持可选，不改变既有调用方语义）。
- **口径**：边覆盖按屏幕对（`From → To`）计；BACK/自环不产生新屏幕步骤，不计边；覆盖计算为单一实现（`src/figma/coverage.ts` 的 `computeClassifiedCoverage`，生成闸与执行预检同口径分硬/探索两分区）：**硬类 = 非 `inferred`/`vision-inferred`**（含 legacy-unknown——旧产物不因缺字段静默弱化门禁，失败响亮），**探索类 = `inferred`/`vision-inferred`（ADR-0010）**（不参与门禁，仅报告）；`--strict` 时非探索弱断言计入门禁；`entryFallback` 为告警项不阻断（除非覆盖本身不完整）。
- **生成策略**：线性化选路为"覆盖贪心 + 长路径优先"——先选覆盖增量（屏幕+跳转+未决探索边）最大的路径，同增量取更长者，无新增覆盖的冗余短片段不产出；**未决目的地边（`to:null`）不计入覆盖目标但按"每条只探索一次"保留用例**（否则视觉识别/未决交互永远不会被执行，对账拿不到真机观测）；`maxDepth` 默认 30、可配（`figma_generate_tests` 参数，上限 50），是单条用例的边数上限；**到上限不丢尾**——以截断屏为起点生成首尾相接的续段用例（`visited` 继承防环，覆盖仍完整），`generation.depthSplits` 报告接续条数，响应 hint 提示调大 `maxDepth` 可获得更长单条连续用例（修复：此前深度截断直接丢弃剩余路径，长链只剩 12 步且尾部屏幕全未覆盖）。
- **续段自包含 + 步骤断言结构化（执行约束力）**：续段用例携带"入口 → 切点"的前导导航步骤（`prelude`；taskDesc 增「前导导航（仅到达起点，不计断言）」段，`continuation:true`/`startScreen` 字段标注），执行时不再依赖上段状态（修复：此前仅写"如不在该页，先导航过去"一句文案，接续段起点不可达）。所有用例每步输出结构化 `expectations`（目标屏名 + 设计文本 hints，与 `steps` 对齐），随 taskDesc 以 `【AOS-EXPECT】` JSON 块传递；taskDesc 同时注入 `【真实数据】` 硬约束条款（数据须经真实请求链路，禁止伪造页面/假数据，见 §13.93）；iOS 执行器逐步确定性核对（空白归一化、hints 全部包含）：命中序号记入 step `scriptHits`，汇总为 `script_adherence`（run.json）与 `test_summary.adherence`（`checkable/satisfied/unchecked/unresolved`）；未出现项作为证据写入终态验证提示词与完成摘要（`⚠ 脚本断言未出现`）。口径为**建议级**（替代路径不硬失败，verify=final 下交模型裁量），tests.json 保持平台中立（Android 侧忽略该行）。
- **起始屏 preflight（确定性前置）**：`【AOS-EXPECT】` 块携带 `start`（journey 入口屏 + 设计 hints，`GeneratedTest.preflight` 字段；hints 为空则不下发）；iOS 执行器首步观测核对（`pending → matched/unmatched`，unchecked 表示不可核对）：未命中时每步向模型注入「起始屏核对未通过，请先导航到该页」提示（替代即兴导航），全程留痕——`test_summary.preflight.{screen,status,matched_at_step}`、run.json `preflight`、验证提示词「起始屏核对（确定性）」段与完成摘要 `⚠ 起始屏核对未通过`（同样建议级，不硬失败）。
- **pen 合成提取**（`pen_extract_flows`，离线）：`.pen` 无原型交互数据时，屏幕命名取「Flow 标注 > 屏内首个文本 > 图层名」（默认名 `Frame NNNN` 不再冒充屏名）；状态变体按标签前缀归并为主屏 + `states`；跳转按画板序号/画布排布推断并统一标注 `INFERRED`；产出可直接进入同一闭环的 `flows.json` 与全局 `flow-map.md`；碎片度（默认名屏、状态归并、推断边、缺标签）进入 `warnings`，供人工复核。**可选视觉识别**（`vision`，默认 auto；ADR-0010/§13.91）：active LLM 具备视觉能力时渲染每屏 → 识别交互元素（受控类别/意图 + 归一化 bbox → nodeId grounding）→ 元素清单（`vision-inferred`/low）+ 未决目的地（`to:null`）探索边；不可用显式降级（`vision-unavailable`/`vision-render-unavailable`/`vision-call-failed`/`vision-screen-cap`/`vision-screen-no-geometry`/`vision-disabled-by-env`），不静默、不阻断门禁。
- **pre-merge 静态闸**（`suite check`）：tests.json × flows.json 静态覆盖 + 生成物完整性 + 真实数据约束（复用 preflight 单一实现），不连设备；未硬覆盖/截断/缺 flows、**缺 tests.xlsx 或 xlsx 早于 tests.json**（三件套强制）、**用例 taskDesc 缺 `【真实数据】` 约束标记**（禁止伪造页面/假数据，须经真实请求链路）均 exit 2（`--strict` 追加弱断言门禁）；"测试引用但设计缺失"的路线漂移仅警告（设计偏差 ≠ 路线缺口）。
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
- 环境：`MOBILE_TESTING_DATABASE_URL`（PG）、`AOS_WORKSPACE_ROOT`（可选）；
- 客户端以 `docker exec -i -w /workspace/<project> <container> node /app/dist/index.js` 接入（`aos-mcp install --mode docker` 自动生成）。

### 8.2 客户端配置（stdio）

```jsonc
{
  "command": "docker",                      // 或容器内直接 node
  "args": ["exec", "aos-mcp", "node", "/app/dist/index.js"],
  "env": {
    "AOS_PROJECT_DIR": "/workspace/<project>",
    "MOBILE_TESTING_DATABASE_URL": "postgres://..."
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

- **视觉目标解析（优先级）**：`AOS_IOS_VISION_LLM=<条目名>`（registry 条目，要求完整）→ `AOS_IOS_VISION_MODEL`（可配 `AOS_IOS_VISION_BASE_URL/API_KEY`，缺省继承 active）→ active 模型名多模态启发（vision/vl/gpt-4o/gemini/claude-3|4 等）→ 无（纯文本模式）。启动响应与 run.json 记录 `vision: {model, source}`。（2026-10-19 修订：启发式名单已收口——iOS 与设计侧共用 `isVisionCapableModel` 单源，并增补 `deepseek-flash`；见 §13.127）
- **按需附图**：可见文本元素 <3 个（层级质量差）或 `AOS_IOS_VISION_ALWAYS=1` 时，该步 user 消息带 `image_url`（`data:image/png;base64,`）分片；文本分片同时给出截图 px 与逻辑 pt/scale（§2.6 约定：坐标输出逻辑点，从截图估计需 ÷scale）；其余步骤纯文本（`perception:"text"`）。
- **降级**：视觉调用失败（模型不支持图片/鉴权/网络）→ 记录 `vision_degraded`（run.json + status 响应）并当场回退纯文本调用该步（`perception:"text-degraded"`），后续步骤保持可用；不因视觉失败中断任务。
- **边界**：不做 OCR、不做像素级脱敏；图片不做降采样（v0 直传模拟器原始 PNG，注意 token 成本）；多模态启发可能误判（显式 env 可覆盖）。（§13.59 已换代：默认档位 `AOS_IOS_VISION_MODE=auto` 每步视觉输入，附图为感知/决策分流，`AOS_IOS_VISION_ALWAYS=1` 并入 auto 语义。）
- **验收**：单测覆盖解析优先级/命名启发/IHDR 尺寸/附图与降级链路；真实验收用 `AOS_IOS_VISION_ALWAYS=1` + 不存在的视觉模型驱动降级（DeepSeek 不支持图片 → 400 → 回退文本完成）。（2026-10-19 修订：DeepSeek V4.1 Flash 已原生多模态，`deepseek-flash` 现走视觉通道；见 §13.127）

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
- **人工确认覆盖**：`.artemis/design/acceptance.json`（`{screens:{"<屏名>":["条目"]}}`；可附加 `data`/`questions`/`section`，见 §13.135）在生成时覆盖同名屏的注释口径（**人工确认优先**；来源可视为文件作者，无 reviewer 字段；口径侧冲突由覆盖语义解决，**不经 09 审阅面**——导航级冲突仍走 08/09；文件非法 → 忽略并回退注释，§13.135 起对非法 data/questions/section 条目出可见警告）；Jira AC 摄取留后续集成。
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

- **边界**：`ChildSupervisor` 见 §13.88（本轮补齐）；`lockedPackageFor` 暴露给崩溃扫描进程名推断。

### 13.87 实施记录（server ListTools schema 缓存）

> 实施于 2026-10-11；第二轮架构评审候选 7（功能切片）。改 `src/server.ts`（`nativeSchemaCache`/`figmaSchemaCache`——zod→JSON schema 转换按工具名缓存一次，HTTP 每 POST 新建 server 的 ListTools 不再重复转换）；测试 +0；全量 879 绿。

- **边界**：`NATIVE_TOOLS` 域文件拆分见 §13.89（本轮补齐）；stdio/HTTP 引导去重（`runtime-host`）仍暂缓——涉及两入口的 store 生命周期与 dispose 顺序，留作独立轮次（纯整理，不影响行为）。

### 13.88 实施记录（子进程生命周期抽取：`artemis/child-supervisor.ts`）

> 实施于 2026-10-11；第二轮评审候选 6（第二切片，§13.86 补齐）。新增 `src/artemis/child-supervisor.ts`（`fingerprintForEntry`/`spec`（无 LLM 回退 bare spec）/`recordSpawned`（state.child 记账）/`clearChild`/`taskCounts`/`artemisPython`/`sweep`（孤儿清理，含 cmdline 守卫））；`runtime.ts` 对应方法改为委托，`buildDefaultProxy` 的 `prepare/onSpawned` 直连 supervisor；`sweepStaleChild(runtime)` 保留为薄包装（server/http/测试零改动）；测试 +0；全量 879 绿。

- **边界**：`doActivate` 里 restart 前对 `state.child` 的删除保留在同一批 state 写入内（原子性优先，不拆到 `clearChild()`，避免快照回写复活 child 记录）。

### 13.89 实施记录（NATIVE_TOOLS 域拆分：`tools/native-tools/`）

> 实施于 2026-10-11；第二轮评审候选 7（第二切片，§13.87 补齐）。`src/server.ts` 918 → 360 行：34 个原生工具按域拆为 `tools/native-tools/{llm,aos,jira,design,figma,pen}.ts`（`NativeToolDefinition` 类型独立于 `types.ts`），server 只留 `NATIVE_TOOLS = [...域数组]` 装配、传输与门禁；测试 +0（server-smoke/usage 全绿）；全量 879 绿。

- **机制**：每域文件自持 `z` 与 handler 导入（按引用符号自动裁剪），`schema` 缓存（§13.87）按工具名继续生效。
- **边界**：加/改一个工具只动对应域文件；stdio/HTTP 引导去重见 §13.90（本轮补齐）。

### 13.90 实施记录（运行宿主：stdio/HTTP 引导去重）

> 实施于 2026-10-11；第二轮评审候选 7（第三切片，§13.87/§13.89 边界收尾）。新增 `src/runtime-host.ts`（`RuntimeHost.prepare`：日志引导 + artemis 依赖检查 + 项目存储 + 30s 同步循环；`createRuntime`：initialize → figma token 同步 → 孤儿清理 → 注册；`shutdown`：循环清除 + 逐 Runtime 代理/WDA 回收 + 存储关闭 + 停桥）；`src/server.ts` 360 → 304 行（runServer 缩为宿主装配 + stdio 生命周期）、`src/http-server.ts` 284 → 229 行（workspace 引导与 getRuntime/close 改经宿主；多项目共享 store 语义不变）；测试 +0（server-smoke / http-server / usage 全绿）；全量 879 绿。

- **边界**：进程级差异留在各入口——stdio 的 stdin/exit 钩子与初始化失败降级日志、HTTP 的 `httpServer` 关闭与每请求新建 server/transport；30s 同步循环统一由宿主持有（HTTP 不再自有 timer）。
- **行为微调（记录）**：stdio 初始化失败时若宿主已配置日志则不重复 `configureLogging`；HTTP 的 figma token 同步/孤儿清理失败现在记日志（原静默 best-effort）。

### 13.91 实施记录（视觉交互识别：`vision-inferred` + flows.json v3）

> 实施于 2026-10-12；ADR-0010。`.pen`（v2.20 无原型交互字段）与无原型链接的 Figma 节点此前只能靠画板排布推断跳转，"图标即入口"（如购物袋 FAB）不可见。新增视觉识别阶段：`src/design/vision.ts`（受控类别/意图词表 + 提示构建 + 回复解析 + bbox→nodeId grounding + `runVisionPass` 编排）、`src/pen/render.ts`（复用 `runPenInteractive` 的 `Export([ids],"png",dir,{scale:1})` 单会话批量渲染，产物落 `.artemis/design/vision/<name>/`）；`pen_extract_flows` 增 `vision: auto|true|false`（默认 auto）。产出：`screens[].elements[]`（元素清单）+ `to:null` 探索边 + `unresolvedDestinations`，flows.json 升 schemaVersion 3；provenance 新增 `vision-inferred`（low）——断言侧只出探索步骤、覆盖率侧豁免硬闸，升权沿用对账闭环（真机观测/人工确认）。测试 +7（`test/pen-vision.test.js`）；全量 888 绿。

- **证据分流（`src/provenance.ts`）**：`isUnconfirmedProvenance` 与 `isHardCoverageTarget` 同时认识新值；`normalizeFlowGraph` 对 `schemaVersion > 3` 显式报错（旧消费者把未知来源当 legacy-unknown → 硬闸，版本闸防止静默误判）。
- **降级与成本**：不可用/离线/未登录各给独立警告（`vision-unavailable`/`vision-render-unavailable`/`vision-call-failed`/`vision-no-elements`/`vision-invalid-items`/`vision-screen-cap`/`vision-screen-no-geometry`/`vision-disabled-by-env`/`vision-model-unverified`），全部落 flows.json warnings 与响应，不阻断、不静默；`AOS_VISION=0` 全局关闭，`AOS_VISION_MAX_SCREENS` 默认 50（`0`/`all` 不限；§13.130 起屏尺寸缺失时取渲染图 IHDR 兜底）；模型能力用名启发式（`isVisionCapableModel`），`vision:true` 可显式强制。（2026-10-19 修订：增补 `deepseek[^/\s]*flash`——V4.1 Flash 原生多模态但稳定别名不含 vision 词干致漏判；iOS 侧 `looksVisionCapable` 收口为同一实现；见 §13.127）
- **生成侧（`src/figma/test-gen.ts`）**：未决目的地边不计覆盖目标，但按"每条只探索一次"保留用例（否则视觉边永不执行、对账无观测）；探索步文案带元素名（`探索未知跳转「购物袋」…`）。
- **不猜目的地**：视觉识别只产意图与元素，目的地只能由真机观测或人工确认绑定（`to:null` + `unresolvedDestinations`）。

### 13.92 实施记录（远程设备宿主 + 跨机产物，ADR-0011）

> 实施于 2026-10-12；ADR-0011。集中部署（Mac mini）与分散项目间两端执行拓扑不对称：Android 可无线调试（设备侧联网），iOS 要求 Appium/WDA 宿主与设备同机且 `.ipa` 路径由宿主读取。本轮做操作层对齐：(1) `aos.config.jsonc` 高级层新增 `deviceHosts`（`ios.appiumUrl/wdaBundleId/xcodeOrgId/xcodeSigningId`、`android.adbHost`），解析优先级 config < 项目 `.env` < 进程 env（iOS 经 `deviceHostEnvFromConfig` 注入 `iosEnv` 打底层；Android 经 `buildChildEnvForEntry` 注入 `ADB_SERVER_SOCKET`，`dotenv` getter 由 Runtime 传入）；(2) `app_path` 支持 `http(s)://`——iOS 走 Appium `app` 能力（`AppiumSessionManager.acquire` 新增 `app` 选项：同 app 复用、变更轮换、无 app 观测复用；`installIpa` URL 分支建会话即安装），Android 在 Runtime 代理层下载到 `<项目>/.artemis/cache/apps/<sha16>.<ext>` 后以本地路径转发（`AOS_APP_DOWNLOAD_TIMEOUT_MS` 默认 600s），下载失败显式错误不转发；(3) `doctor` 探活宿主（iOS `GET /status`、Android adb `host:version` 握手，均短超时 best-effort，失败给 SSH 隧道/`adb -a` 暴露提示），`aos_status.deviceHosts` 显示解析结果与来源；`src/device/device-hosts.ts` + `src/device/app-artifacts.ts` 承载映射/探针/缓存。测试 +10（`test/device-hosts.test.js`、会话轮换、iOS URL 安装通道）；全量 899 绿。

- **不变量**：跨机产物不得以服务端本地路径冒充（iOS）；模拟器仍限服务本机；不新建反向隧道/常驻协议。
- **优先级细节**：`ADB_SERVER_SOCKET` 解析顺序为进程 env（含 Runtime baseEnv）> 项目 `.env` > config；`ADB_DEVICE_SERIAL`（项目级设备钉选）不受影响。

### 13.93 实施记录（生成物三件套与真实数据硬门禁）

> 实施于 2026-10-12。两项生成物强约束落地为 `suite check` 硬门禁：(1) **三件套完整性**——tests.json 存在则同名 tests.xlsx 必须存在且不早于 tests.json（防手写/裁剪与陈旧产物）；(2) **真实数据约束**——`figma_generate_tests` 为每个 taskDesc 注入 `【真实数据】` 条款（数据必须经被测应用真实请求链路准备：界面操作或其后端 API；禁止伪造/写死页面或数据、mock、手造页面、跳过真实请求；无法满足时停止并报告 blocked），`suite check` 以标记做硬校验，缺标记 exit 2。实现：`src/figma/data-policy.ts`（标记与条款唯一来源）、`preflight.ts` 增 `artifacts`/`dataPolicy` 字段、`suite-command.ts` `coverageGateIssue` 组合三类硬门禁（三件套/真实数据/流程覆盖，`--strict` 语义不变）。测试 +2（suite-command 门禁四态、preflight 字段）；全量 901 绿。

- **边缘与边界**：门禁作用于 `check`/`loop`（及 `run --fail-on-uncovered`）；`suite run` 不带该开关仍可执行（Excel 缺失不阻断设备执行），但 taskDesc 已内含真实数据条款约束执行者。
- **legacy 影响（有意）**：旧 tests.json（无标记或无 xlsx）在 `suite check` 响亮失败，需用最新 `figma_generate_tests` 重新生成——禁止手写用例进入 CI 闸。

### 13.94 实施记录（PG 连接串环境变量改名）

> 实施于 2026-10-12。`AOS_DATABASE_URL` → `MOBILE_TESTING_DATABASE_URL`（与服务名 `mobile-testing` 对齐），**硬切换、不保留旧名回退**：`src/db/index.ts`（读取与降级提示）、`src/install.ts`（CLI 写入客户端配置 env）、`src/commands.ts`（doctor/init 引导文案）、`src/usage-command.ts`（CLI usage 读取与内存降级 note）、`docker-compose.yml`、`.env.example`、README/AGENTS/接入指南/DESIGN 文档同步。旧名配置将直接进入内存降级（doctor/`aos_status` 可见警告）。测试同步更新 `test/install.test.js`、`test/usage-command.test.js`；全量测试绿。同时本机库名由 `aos` 改为 `mobile-testing`（示例连接串与 docker compose `POSTGRES_DB`/healthcheck 同步；角色仍为 `aos`）。

### 13.95 实施记录（批次清单：overview-panel T1）

> 实施于 2026-10-13（多项目总览面板 `.scratch/overview-panel/spec.md` 的 T1）。把"一次 suite run/loop"立为**批次清单一等实体**，解决"跑完即走"（此前套件报告只在内存/终端，默认不落盘）。新增 `src/figma/run-manifest.ts`：`buildRunManifest`（纯函数映射 SuiteRunReport → 清单：`summary`（含 `flaky`/`quarantinedFailed`）、`gate{result,exitCode,reasons}`、`failureDomains` 归并、preflight 摘要、tests.json 指纹 sha256+mtime；**不存 taskDesc**）、`saveRunManifest`（原子 + 独占创建：tmp + `link`，撞名换后缀重试 ≤4；同秒碰撞概率 ~1/16.7M）、判别式读取 `loadRunManifest`（`ok | missing | invalid | newer`：`missing` 含裁剪竞态 ENOENT；`newer` 仅 `BaseRunManifest`（runId/startedAt/finishedAt/ok/summary{total,passed,failed}）白名单字段逐类型校验映射并标注）、`runManifestFileNames`/`loadLatestRunManifest`（文件名倒序 = 时间序，零额外 stat，供 L1 轻量索引）、`pruneRunManifests`（`AOS_SUITE_RUNS_MAX` 默认 200、写后 best-effort、max ≤ 0 不裁剪；prune 是唯一删除者）。接线：`suite run`/`suite loop` 完成（含 retry 诊断与门禁计算）后写 `<configDir>/design/runs/run-<UTC时间戳>-<6位后缀>.json`，best-effort（写失败仅 WARN、不影响退出码）；`suite run` 新增 `--no-save`；`AOS_SUITE_RUNS=0` 全局关闭；`suite flake` 采样轮次不写。`failure-taxonomy` 增 `FAILURE_TAXONOMY_VERSION`（随清单记录，供"原判 vs 重算"区分）；`RETENTION_CATEGORIES` 增 `runs`（`suite retention` 覆盖）。测试 +13（新增 `test/suite-run-manifest.test.js` 9 例 + `test/suite-command.test.js` 4 例：落盘字段、开关、写失败降级、loop 来源）；全量 914 绿。

- **口径**：`gate.reasons` 词汇 = `suite-not-executed`（report.ok=false）/ `preflight-gate`（三件套/真实数据/覆盖/`--strict` 组合门禁）/ `failed:N`（N = 扣除隔离失败后的首跑失败数）；`summary.failed` 保留原始计数，`quarantinedFailed`/`flaky` 单列；失败域为运行期 `classifyFailure` 原判（重算对照属面板侧，T2）。
- **边缘**：`missing`/`invalid`/`newer` 均为合法读取结果（消费方占位/降级，不抛错）；清单只存 caseId/name 等，taskDesc 回查失败（用例集重生成）的降级标注留待面板侧（T2）。

### 13.96 实施记录（面板聚合层：overview-panel T2）

> 实施于 2026-10-13（`.scratch/overview-panel/spec.md` 的 T2）。新增 `src/panel/overview.ts`（跨项目只读聚合层，**无子进程 / 无网络 / 无写盘**）：`buildPanelOverview`（L1：项目集合 = PG 注册项目 ∪ workspace 子目录；逐项目软读 → 状态灯 + 固定顺序 `lampReasons` + 最新批次摘要）、`buildPanelProjectDetail`（L2：集成详情（LLM 条目/active/可用性与缺失、Figma/Jira/pen 凭证 presence、config validation、deviceHosts、设计资产存在性+mtime、宿主 deps/build）+ 批次列表（清单权威，默认 20 / 上限 100）+ 独立运行（台账行扣除已加载批次覆盖的 traceId，默认 20）+ 批次空态**原因清单**）、`buildPanelBatchDetail`（L3：判别式读取透传 + 逐用例证据链存在性校验（trace/notes/stderr/stdout 两态，null 路径不生成）+ 文件名合法性守卫）。**状态灯短路顺序**：磁盘可达性 → 灰（短路，仍展示注册层）；无可用 LLM → 红；黄按固定聚合序（Figma/Jira 凭证缺 → 宿主 deps stale|missing → 三件套不齐 → store 降级 → build stale）；全无 → 绿。**宿主级判定**：deps 为 `depsStatus(serviceRepo)` 一次、`buildStale` 由调用方注入；pen key 仅展示 presence、不参与灯（避免未用 pen 的项目一律标黄）。**软读构成**：`loadProject({AOS_PROJECT_DIR})` + `scanProjectEnv` + store LLM 条目 `entryIssues` + `detectProjectStacks` + `resolveIosHost/resolveAndroidAdbSocket` + `jiraConfigFrom`。共享口径：`outcomeOf`（台账状态映射）提至 `src/tasks/outcome.ts`，面板与 run-report 共用（行为不变）；"按当前规则重算"（`recomputed` 对照）留在渲染侧（T4）/后续增量。测试 +10（pg-mem 假 store + 临时项目 + 假批次清单）：四灯、工作区并入、内存降级标注、批次权威 + 独立运行过滤 + outcome 映射 + limit、空态原因、证据存在性、判别式读取与非法文件名、磁盘不可达降级；全量 924 绿。

- **降级口径**：磁盘不可达 → `integration:null` + 台账行按独立运行展示 + `warnings` 标注；未知项目（无注册且无磁盘）→ `null`；清单/证据缺失 → 两态占位，不猜测。

### 13.97 实施记录（面板 HTTP 路由与缓存：overview-panel T3）

> 实施于 2026-10-13（`.scratch/overview-panel/spec.md` 的 T3）。新增 `src/panel/web.ts`：`handlePanelRequest(url, deps)`（与 usage 看板同构的 `{status, contentType, body}` 处理器，`http-server` 直接接线）。路由：`GET /panel`（HTML）/ `GET /panel.json`（同源 JSON，envelope `{ok, view: "overview"|"project"|"batch", ...}`）；查询参数 `project`（项目名 / 根路径 / workspace 子目录名）、`batch`（清单文件名，配 project）、`limit`（L2 批次数，默认 20、上限 100）；未知项目 404。开关 `AOS_PANEL_WEB=0` → 两路由 404（对齐 usage，不影响 `/usage`/`/healthz`/`/mcp`）；进程内短缓存 `createPanelWebCache`（TTL 默认 5s、`AOS_PANEL_CACHE_MS` 可配、0 关闭；命中回同响应体）。HTTP 模式注入 store/workspaceRoot/serviceRepo/`buildStale`（`isBuildStale(import.meta.url, 进程启动)`）/env/缓存实例；**不建 Runtime、不 spawn、不触网、不写盘**。测试 +7（`test/panel-web.test.js` 5 例：开关与 TTL 解析与 404、总览 JSON+HTML、项目详情生命周期（空态→批次→独立运行）、批次详情与非法文件名、缓存 TTL 命中/过期；`test/http-server.test.js` +2：真实 HTTP 面板路由、`AOS_PANEL_WEB=0` 只关面板路由）；全量 931 绿。

### 13.98 实施记录（面板 HTML 渲染：overview-panel T4）

> 实施于 2026-10-13（overview-panel T4）。`src/panel/web.ts` 服务端渲染 HTML（内联 CSS、零依赖、零前端构建，与 `/usage` 同风格）：**L1** 项目表（灯色点 + `lampReasons` + 栈/最后活跃/最新批次/备注；存储与宿主徽标）；**L2** 项目页（集成信息卡 + 凭证/资产表 + 批次表（门禁/通过率/失败域/清单链接）+ 空态**原因清单** + 独立运行表 + 降级提示）；**L3** 批次页（gate/exitCode/reasons + summary 卡片 + 失败域 chips + 用例表（状态/失败域与置信度/脚本来源「断言N/探索M」/隔离与 flaky/证据）+ 选项与 tests 指纹上下文；`read != ok` 时只渲染占位与说明）。证据链按两态渲染：存在 → 路径文本；缺失 → `[已清理]`（不做未校验链接）；`escapeHtml` 提至 `src/util.ts`（usage 看板复用）。**未含**"按当前规则重算"对照（P1：需按 trace 重跑 `classifyFailure`，成本与价值待验证；清单内 `taxonomyVersion` 已预留）。测试见 §13.97（HTML 关键区块断言随路由测试）；全量 931 绿。

### 13.99 实施记录（设计流水线截图：共享模块 + 保留期，design-screenshots T1）

> 实施于 2026-10-13（`.scratch/design-screenshots/spec.md` 的 T1）。新增 `src/design/screens.ts`：`sanitizeScreenId`（文件名安全转义，空回退 `screen`）、`isPngBuffer`（魔术头）、`storeScreenPng`（sha256 相同跳过、保留 mtime；损坏/变更原子覆盖；非法 buffer 不落盘）、`importScreenFile`（pen CLI 直写产物：读取 + 校验 + 原子入库 + 清理临时文件）、`figmaScreensDir`/`penScreensDir`（`design/screens/figma-<fileKey>` / `pen-<slug>`）、`relativeScreenPath`（md 相对引用、POSIX 分隔）、`screensEnabledFrom`（arg 优先、`AOS_SCREENS=0` 关闭）与 warning 词汇 `screenshot-skipped` / `screenshot-render-unavailable` / `screenshot-mapping-missing`。`RETENTION_CATEGORIES` 增 `screens` 分类（README retention 六类→七类）。测试 +7（`test/design-screens.test.js`：转义边界、PNG 校验、写入/跳过/覆盖/损坏替换/非法不落盘、导入清理、目录与相对路径、开关、词汇与保留期）；全量 942 绿。

### 13.100 实施记录（pen 截图通道，design-screenshots T2）

> 实施于 2026-10-13（design-screenshots T2）。`pen_extract_flows` 默认渲染屏幕截图（新增 `screens?: boolean`，默认开；`AOS_SCREENS=0` 关闭、显式 true 覆盖 env）并嵌入 `flow-map.md`（每屏 `<img src="screens/pen-<slug>/<id>.png" height="200">`）。**一次渲染两用**：截图与 vision 共享 memoized 渲染（`screenAssetLoader`）——渲染落私有临时目录 → 逐张校验原子入库 `design/screens/pen-<slug>/` → 清理临时目录；vision 的 outDir 从 `design/vision/<name>/` 迁入统一目录（历史 `evidence.render` 不回溯）。**降级**：全通道失败 → `screenshot-render-unavailable`、部分缺屏 → `screenshot-skipped`，md 照常生成、不阻断；响应新增 `screenshots: { dir, rendered, skipped, skippedScreens }`（避免与既有屏幕列表 `screens` 键冲突）。**并发加固**：`runPenInteractive` 进程级串行队列 + session 输出名唯一化（`session-<pid>-<rand>.pen`）；`--export` 一次性调用不入队。测试 +4（`test/pen-flows.test.js` 3：默认渲染 + 幂等（mtime 稳定）、通道失败/部分缺屏降级、`screens:false`/`AOS_SCREENS=0` 与显式覆盖；`test/pen-cli.test.js` 1：并发不交错）与既有断言更新（`test/pen-vision.test.js`：共享渲染计数=1、证据路径改 `screens/`）；全量 942 绿。

### 13.101 实施记录（figma 截图通道：flow-map.md + 批量渲染，design-screenshots T3）

> 实施于 2026-10-13（design-screenshots T3）。`figma_extract_flows` 新增 **`flow-map.md`**（屏幕含缩略图/跳转/入口屏/未决目的地/警告/统计；`savedTo` 由字符串改为 `{ json, markdown }`，对齐 pen；仓库脚本未消费该字段）与**屏幕截图**（`screens?: boolean` 默认开、`AOS_SCREENS=0` 关闭、显式 true 覆盖）：一次批量 `fetchImages(fileKey, ids, "png", 1)` → 逐节点下载 → PNG 校验 → `storeScreenPng` 原子入库 `design/screens/figma-<fileKey>/`。**单屏 null 有界重试**：等 1s 后仅对未决屏二次请求并**绕响应缓存**（vendor 补丁：`fetchImages`/`figmaFetch` 增可选 `noCache`，NOTICE 第 6 条——缓存中的 null 会吞掉重试）→ 仍缺则逐屏降级 `screenshot-skipped`；通道级失败（无 token/限流/HTTP 错误）→ `screenshot-render-unavailable`，md 照常生成。响应增 `screenshots: { dir, rendered, skipped, skippedScreens }`。测试 +5（`test/figma-screens.test.js`：批量一次调用 + scale=1 + 嵌入 + 幂等 mtime、null-once 重试全恢复、partial 仅查询未决屏、通道失败降级、开关与 env 覆盖、`renderFigmaFlowMap` 直测）；全量 947 绿。

### 13.102 实施记录（tests.md 用例配图，design-screenshots T4）

> 实施于 2026-10-13（design-screenshots T4）。`figma_generate_tests` 的 `tests.md` 默认按用例嵌入屏幕截图（`screens?: boolean` 默认开、`AOS_SCREENS=0` 关闭、显式 true 覆盖；仅 `save !== false` 时执行——无 md 则不渲染）。**映射**：新增 `design-store.readFlowDocumentMeta`（保留 flows.json 顶层 `fileKey`/pen `source` 与屏幕名→id；**不改 `normalizeFlowGraph`**）；`figma` 来源（含 URL 直提）走 Figma 批量通道、`pen:*` 走 pen 单会话通道（新增 `src/pen/screens.ts` 共享捕获原语，pen/flows.ts 同步重构复用、行为不变）；每用例 ≤3 张 `height="160"` 缩略图、超出提示「…（共 N 屏）」；映射缺失（legacy flows 无来源 / 屏幕名对不上）→ `screenshot-mapping-missing` 无图降级。**降级**：通道级 `screenshot-render-unavailable` / 逐屏 `screenshot-skipped`；响应增 `warnings` 与 `screenshots: { channel, dir, rendered, skipped, skippedScreens }`。回归：既有 testgen 用例（手写 flows 无来源）走映射缺失路径、无渲染调用，行为不变。测试 +5（`test/figma-test-screens.test.js`：pen 通道嵌图 + 一次渲染、figma 通道批量、映射缺失降级、开关与 env 覆盖、`renderMarkdown` ≤3 截断直测）；全量 952 绿。

### 13.103 实施记录（面板磁盘资产 + 批次趋势：overview-panel T6 部分）

> 实施于 2026-10-14（overview-panel P1 第一切片）。**磁盘资产**：新增 `src/panel/assets.ts`（`collectDiskAssets`，全部只读、单项失败降级 warnings）——崩溃签名（`CrashIndexStore.list`：总数 + 最近 20 条）；对账资产（`reconciliation.json`：present/updatedAt、边数、pending/upgraded/confirmed/rejected 与 runtime-only 计数）；设备基线热点（`generation-feedback.collectVisualHotspots` 重构为导出并接收 `configDirAbs`、`VisualHotspot` 增 `serial`，feedback 行为不变）；保留期摘要（复用 `collectRetentionEntries` + `buildRetentionReport`，90 天只读、分类 chip）。**批次趋势**：L2 从已加载清单派生 `trend { points（时间升序）, domainTotals, recentPassRate }`（`buildBatchTrend`；无 ok 清单为 null）。**渲染**：项目页批次区加趋势行（最近 20 批 `passed/total` 色块序列 + 失败域累计 chips）、新增「磁盘资产」区块（崩溃/对账/基线/保留期 + 降级提示）；JSON 契约同步增 `trend`/`diskAssets`（磁盘不可达均为 null）。测试 +4（`test/panel-assets.test.js` 2：汇总 + 空态；`test/panel-overview.test.js` +2：趋势与磁盘资产聚合、无批次 trend=null；`panel-web` 增 HTML 断言；`generation-feedback` 断言同步 `serial`）；全量 956 绿。

- **边界**：保留期为整树只读扫描（含 traces），依赖面板 5s TTL 缓存限频；不改 `suite retention` 语义。

### 13.104 实施记录（面板深探层：overview-panel T6）

> 实施于 2026-10-14。新增 `src/panel/deep.ts`（`createPanelDeepProbe`）：L2 详情在 HTTP 模式下经注入 provider 懒建 Runtime（workspace 一级子目录校验后复用既有 `getRuntime`）后仅取**纯读子集**——activeProfile、LLM 条目数、setupRequired、store（kind/degraded/note/lastError）、usage、modelRefresh、artemis（repo/configDir/python/`proxy.status()`）、figma 桥状态与 token 来源、jira、logs 路径、build stale；**不拉起 artemis 子进程、不触网打外部 API**。**iOS 环境检测为显式动作**（`?ios=1`）：允许白名单本地 CLI 探测（`iosAppiumInfo`，内部超时 + 外层 45s 兜底），失败/超时如实记录 `error`，**实例内按项目 60s 时间缓存**。L2 契约增 `deep`（无 provider / 构建失败为 null）；项目页新增「深探信息」区块（含 `?ios=1` 指引与探测结果）。测试 +5（`test/panel-deep.test.js` 3：默认不探测的纯读子集、显式探测 + TTL 缓存、失败/超时如实记录；`panel-web` +1 注入断言；`http-server` 增深探与"默认不探测"断言）；全量 963 绿。

### 13.105 实施记录（CLI `panel --web`：overview-panel T6）

> 实施于 2026-10-14。新增 `src/panel-command.ts`（`aos-mcp panel --web [--port 8767] [--host 127.0.0.1] [--workspace <dir>]`；`cli.ts` 接线与 help 更新）：复用 `handlePanelRequest` 同一 handler 的独立只读看板，默认 loopback、端口占用 exit 2；存储经 `createProjectStore(MOBILE_TESTING_DATABASE_URL)`（缺省内存降级并如实提示）；`--workspace` 可选并入未注册工作区目录；独立进程无跨项目 Runtime → **深探层不可用（`deep:null`）**。测试 +3（`test/panel-command.test.js`：临时端口服务与清理、端口冲突 exit 2、help/参数错误）；全量 963 绿。

### 13.106 实施记录（回归服务 P1a：生成侧——功能切分/命名/身份继承/归档/登记）

> 实施于 2026-10-14（设计稿 `docs/superpowers/specs/2026-10-14-regression-service-design.md` §5.1–§5.3；计划 `docs/superpowers/plans/2026-10-14-regression-service-p1a-generation.md`，P1b/P1c 另立）。新增 `src/figma/features.ts`（纯函数）：`splitFeatures`（信号优先级 Figma 页面 → 屏幕名公共前缀（未覆盖屏按边邻居多数归并）→ 无向图连通分量 → 单组回退；全部按屏幕名 code-point 确定性排序）；`nameFeatures`（回退链：候选名 ≤16 字 → LLM（`ChatFn` 注入，缺省经 `runtime.activeEntry()` 仿 pen vision 解析；输出 `{"name":"…"}`，≤8 字）→ `功能N`（按组序号）+ `feature-naming-fallback` 告警）；`applyIdentity`（重叠率 |交集|/min，唯一最高且 ≥0.5 继承 key/name——名称冻结；否则新 key `f-<slug>-<sha8(排序屏幕)>` + `feature-identity-new`；同一 prior 不重复继承）；`assignCaseFeature`（用例屏幕多数归属、并列取首屏、无命中 null）。`src/figma/case-sets.ts`：`caseSetsDir`/`caseSetStem`（`<UTC YYYYMMDD_HHmmss>_<功能名>`；非法字符/空白→`-`、空→`feature`、≤40 字、目录冲突 `-2` 递增）/`saveCaseSetFiles`（三件套同 basename 原子写）。`src/figma/flows.ts`：`FlowScreen` 增可选 `page`（`buildFlowGraph` 沿 `parentOf` 链取所属 PAGE 名；`normalizeFlowGraph` 容忍缺失；**不升 schemaVersion**）。DB：`case_sets`/`case_set_features` 两表（screens 以 TEXT+JSON 存，仿既有惯例）+ `recordCaseSet`/`listCaseSets`（新→旧、默认 50；pg-mem + memory 双实现）。`figma_generate_tests` 接线：用例带 `feature`、payload 增 `features[]`；保存时每功能子集三件套归档 `.artemis/design/case-sets/`（子集 JSON 含 flows/coverage/features；md/xlsx 复用同渲染器；`savedTo.caseSets` 三路径；空功能段不产出）；生成前 `listCaseSets` 展平为 prior 做身份继承（不可用 → `case-set-registry-unavailable` 告警），保存后 `recordCaseSet` 登记（失败 → `case-set-registration-failed`，不阻断）；live 三件套契约不变；`suite retention` 增 `case-sets` 分类。测试 +33（features 15 / case-sets 4 / case-sets-gen 8 / db-case-sets 3 / flows +2 / retention +1）；全量 996 绿。

- **口径**：功能名生成后冻结（改名不改档案，后续合并走别名映射）；身份继承以屏幕重叠为唯一确定性依据（低置信不静默合并——新 key + 告警）；"份"＝功能段（回归引用与命名单位）；"磁盘归档是事实源、DB 是索引"，store 不可用一律如实降级、不阻断生成。身份修订（2026-10-19）：同屏集重复身份继承最近一份、新建 key 与已用 key 碰撞确定性消歧、自愈/回填屏集取归档声明（§13.131）。

### 13.107 实施记录（回归服务 P1b：执行与对比——suite task / run --task / 登记 / 同份对比 / 结果表）

> 实施于 2026-10-14（设计稿 §5.3/§5.5/§5.6；计划 `docs/superpowers/plans/2026-10-14-regression-service-p1b-execution.md`）。DB 增 `regression_tasks`/`suite_runs`/`suite_run_cases` 三表（多行写入提取 `withTransaction` 公共辅助，`recordCaseSet` 一并改用；`suite_run_cases` 带 name 列与裁决预留列 `verdict*`、`suite_runs` 带 `app_version`）；新增 `src/tasks/run-compare.ts`（`compareRuns`：仍通过/修复/回归/仍失败/新增失败/新增通过/消失 + 清单；pending 不计数、无基线 → `established`；`crossPlatformDeltas`）与 `src/tasks/run-registry.ts`（`platformOf`（UDID→ios / adb→android / null→unknown）、`buildSuiteRunInput`（报告→登记行；duration 诚实留空）、`resolveRunRefs`（按 `case_set_features.jsonPath` 精确匹配份血统）、`registerSuiteRun`（best-effort；createdAt＝finishedAt 保证新→旧确定性）、`baselineFor`（同（caseSetId, featureKey, platform）最近一条、可排除自身））；`suite-command.ts`：`suite task create|list|show`（引用＝feature key，取该功能**最新份**；未知 key exit 2 列可用项；`--platform` 默认 ios+android）、`suite run --task <id> --device …`（refs×设备展开；**同设备内**跨份 caseId 去重——跨设备不去重，双端回归是目的；逐子运行登记带 `regression_task_id`；任务状态机 pending→running→completed/partial/failed；**子集运行不做全图覆盖门禁**并如实标注、`--fail-on-uncovered` 忽略提示）、`suite report --task <id>`；`suite run`/`suite loop` 全部 best-effort 登记（`--no-save` 跳过；json 模式不污染输出；失败输出"登记降级"行）；`run-report.ts`：结果表增「功能」「端」列（空值 `—`；台账源经 case_sets 解析功能名）、新增 `buildTaskRunReport`（命名 `<stamp>_<功能>_回归.xlsx` / `<stamp>_多功能N项_回归.xlsx` + JUnit）；`GeneratedCaseRecord`/`GeneratedCase` 增 `feature` 解析；`assignCaseFeature` 并列决胜收窄到并列组内（P1a 缓办 minor 落地）。评审遗留口径：`case_sets.basename`＝生成时 live 用例文件名（informational，引用解析以 feature key 为准）；归档子集 `counts.screens/edges`＝设计全量（`flows` 为子集数，子集覆盖看 `coverage`）。测试 +33（db-suite-runs 4 / run-compare 4 / run-registry 6 / suite-command +5 / suite-task 11 / run-report +2 / figma-features +1）；全量 1032 绿。

- **口径**：登记与基线查询一律 best-effort（store 不可用 → 如实降级、不影响退出码）；对比血统＝同（case_set, feature, platform）份（跨份对比后置）；任务运行退出码 0 全通过 / 1 有失败 / 2 执行错误；结果表命名用 UTC 紧凑时间戳；任务报告与 `suite report` 台账报告并存（后者不动）。

### 13.108 实施记录（回归服务 P1c：面板动作层——引用创建 / 任务页 / 归因裁决 / 统计下钻 / 反馈联路）

> 实施于 2026-10-14（设计稿 §5.4/§5.7/§5.8；计划 `docs/superpowers/plans/2026-10-14-regression-service-p1c-panel-actions.md`）。DB 增 `updateCaseVerdict`（裁决写库：按（run,case）更新 `suite_run_cases.verdict/verdict_by/verdict_at/verdict_note`，项目作用域校验，未命中 → false；`CaseVerdict`＝case-defect/execution-deviation/app-defect/uncertain）；`suite_runs` 增 `runner TEXT`（`registerSuiteRun` 缺省填 `os.hostname()`——P1 语义＝执行机 hostname，P2 runner 引入后扩展为 runner 名）。
>
> - **动作层（仅 HTTP 模式）**：`POST /panel/api/tasks`（`{project, refs:[{caseSetId,featureKey}], platforms?, baseline?}`——refs 非空且需命中已登记份、platforms ⊆ {ios,android}（自动去重）、baseline ∈ {latest,none}、refs≤100；成功 → `createRegressionTask(createdBy:"panel")`；**重复提交不幂等**，会创建多个任务）；`POST /panel/api/verdicts`（`{project, items:[{runId,caseId}], verdict, note?, by?}`——items≤500，逐条 `updateCaseVerdict`；部分失败容忍（per-item 捕获，回 `{updated,missed,failed}`）；全未命中 → 400，全失败 → 500 通用错误（详情仅日志，不泄露底层错误原文））；**body ≤256KB（超限 413）**——动作层不复用 MCP 端点的 4MB 上限；`AOS_PANEL_ACTIONS=0` 整体关闭（404；与 `AOS_PANEL_WEB=0` 相互独立）；**v1 内网无鉴权**（任何能访问 HTTP 端口者可写任务/裁决——仅限受控内网部署，鉴权升级已实施：见 §13.113）；独立 `panel --web`（CLI）保持只读、不挂动作路由；写成功后清空面板缓存（`PanelWebCache.clear`；含部分失败路径），POST 后 reload 立即看到新状态；`createAosHttpServer` 增 `store` 注入缝（测试/嵌入复用外部 store）。MCP 端点保持 4MB 上限、动作层 256KB；修复轮将读体超限行为从「连接重置」统一为「排空 + 413」（动作层 413 有 http 级测试锁定，MCP 超限同样 413 不再 ECONNRESET）。
> - **视图参数优先级** `task > batch > view`（`view=review|stats`）。新视图：**任务页**（`?task=<id>`：状态/引用份（份已清理占位）/子运行（失败域/对比/清单路径）/跨端差异/触发执行指引）、**归因队列**（`?view=review`：最近 10 次运行的全部失败用例，未裁决在前、新→旧；初判域+置信+理由+证据（trace 目录两态：存在路径 / `[已清理]`）；批量裁决表单（radio 四选项+备注）→ POST 后 reload；动作指引行：重跑 `suite run --task/--tests`、隔离 `quarantine.json`）、**统计下钻**（`?view=stats`：功能维度（通过率/趋势小方块/失败域/归因构成）、最不稳用例（连败/flaky/最近裁决）、跨端差异、改进出口三清单（案例问题/执行偏差/应用缺陷，按（份,用例）取最新裁决）+ 指引行）。
> - **统计口径**（`src/panel/stats.ts`）：仅份血统运行参与（`featureKey`/`caseSetId` 为 null 的普通运行跳过；**改进出口三清单与 `suite feedback` 裁决建议同口径**）；功能级跨份连续（feature key）；**case 级仅同份累计（（caseSetId＋caseId）分组，禁止跨份按 caseId 聚合）**；跨端差异仅同份内比较；连败＝该（份,用例）序列自最新往回连续非 passed 次数；裁决取最新非空；入参乱序亦按 createdAt 自排（新→旧）。
> - **P1b 评审遗留落地**：`suiteRunTask` 两处 `updateRegressionTask` 包 try/catch（失败 → 告警 + 「注意: 任务状态回写失败（运行结果不受影响）」；退出码与结果摘要不受影响）；`suite task create` 参数白名单（`--platform` ⊆ {ios,android}、`--baseline` ∈ {latest,none}，非法 exit 2 不落库）；`suite feedback` 增 `kind:"verdict"` 建议（case-defect 按功能分组 → 「建议下一轮重新生成该功能用例」；只读按需，store 不可用跳过该维度不阻断）。
> - **两条口径确认**：`task.runIds` 为**替换语义**（每次 `suite run --task` 重写为该次子运行 id 集合；历史按 `regression_task_id` 查 `suite_runs`，任务页与 `suite task show` 均按 taskId 查询）；失败子运行对比保持现状（task 模式 `report.ok=false` 为不可达路径——子运行清单生成失败即不落盘，P2 runner 引入后重审）。
>
> 测试 +26（db-suite-runs +3 / panel-stats +5 / panel-actions +3 / panel-overview +4 / panel-web +4 / http-server +3 / suite-task +2 / generation-feedback +2）；全量 1060 绿。

- **口径**：面板动作层只写「任务创建 + 裁决」两类事实（登记/对比/状态机仍由执行侧负责）；动作层与只读层同源 store、同视图构建路径（动作后 reload 即可见）；中心侧只存索引与状态，大件（清单/截图/证据）留在项目机磁盘、面板仅展示路径。

### 13.109 实施记录（回归服务 P2：runner 心跳 + 自动领取执行 + 产物只读预览）

> 实施于 2026-10-14（设计稿 §5.3/§5.4/§5.5/§7；计划 `docs/superpowers/plans/2026-10-14-regression-service-p2-runner-dispatch.md`，经两轮独立复核修订）。DB 增 `runners` 表（id/project_id/name/hostname/platforms/devices/tools/artifact_base_url/version/last_seen_at/created_at；`devices`＝`{serial,name,platform,kind,state}` 列表、`tools`＝adb/idb/simctl/ideviceId/appium 布尔、JSON 宽容解析）；`regression_tasks` 增 `claimed_by/claimed_at`（存量库经 MIGRATIONS 补列）与状态 **claimed**；`suite_runs.manifest_path` 首次接线（此前该列无写入方，恒 null）。
>
> - **runner（`suite runner` 常驻，项目机）**：首轮心跳 upsert（`runners.id` 为身份；`--name`/缺省 hostname）→ 启动释放自己的 claimed/running（崩溃残留回 pending）→ **并行心跳循环**（独立 async；`AOS_RUNNER_HEARTBEAT_MS` 默认 30s；异常仅日志不终止——**长跑执行期间不失联**）→ 主循环原子领取（最旧 pending 且**任务 platforms ⊆ runner 设备端**；单条 `UPDATE ... AND status='pending'` 守卫、不用 SKIP LOCKED、竞争失败下轮再试；**全量 pending 扫描（PG/内存同口径，无候选窗截断）**；领取前冻结库存快照；领取累加 `attempts`）→ 复用 `suite run --task`（argv 带 `--project` 与按任务端过滤的 `--device`，可多设备）→ **执行异常或非零退出码且未达终态 → 守卫释放本次领取**（`attempts` 未达上限（`AOS_RUNNER_MAX_ATTEMPTS` 默认 3）回 pending 按 `pollMs` 重试；达上限直接置 `failed`——不再自动重试、**不饿死队列**；已终态不覆盖）＋防热循环延迟。`--once` 单轮冒烟；SIGINT/SIGTERM 优雅退出（心跳步进 ≤250ms 检查 + 退出限时等待 2s）；**需要中心 PG**（内存 store 拒启 exit 2）。设备盘点：adb devices（emulator-* → emulator）＋darwin 下 simctl Booted 可用模拟器＋`idevice_id -l` 真机（best-effort）；`AOS_RUNNER_DEVICES` 逗号分隔**覆盖全部来源**（真机 UDID 显式列入口径）；tools 探测 idb（--version）与 appium（`AOS_APPIUM_URL` 配置）。
> - **产物只读服务**（runner 同进程；`GET|HEAD /healthz`＋`/artifact/<rel>`）：根＝`<项目>/.artemis`（realpath 双重校验拒绝 `..`/绝对路径/符号链接外逃）；文件流（图片 inline、json/md/txt/log text/plain、xlsx 对应 MIME、`nosniff`）；目录浅索引（转义/不递归/父链接/>500 截断、`nosniff`）。**默认监听 `0.0.0.0`、默认无鉴权**（可选令牌见 §13.113；内网口径；暴露范围含 `.artemis/logs` 与 `.artemis/crashes`，README 点名）；`--artifact-port 0` 关闭、端口占用不阻断执行且**不广播基址**；基址＝`AOS_RUNNER_ADVERTISE_URL` 或 `http://<hostname>:<port>`；监听 `0.0.0.0`/`::` 时启动打印醒目告警。CLI 参数：`--name/--poll-ms/--heartbeat-ms/--artifact-port/--artifact-host/--once`。
> - **面板**：项目页「执行机（runner）」区块（TTL 90s（`AOS_RUNNER_TTL_MS`）在线灯、设备 chips、工具徽标、最后心跳、产物基址；有 runner 时 30s 刷新）；任务页状态标签（待执行/已领取/执行中/已完成/部分失败/失败）＋领取方（在线/失联；未知执行机）＋活跃态 10s 刷新＋「在线 runner 会自动领取执行」指引；**pending 且无单台在线 runner 端覆盖时提示原因**（双端任务需单机双端）。**产物链接**：任务页子运行「清单」（子运行各自落批次清单并登记 `manifest_path`）与引用份 json/xlsx、归因队列「打开证据」（run→task→runner 链；`artifactUrl` 相对 `.artemis` 分段编码，越界 → 纯路径文本）；中心只拼 URL 不取文件，面板/中心不触网。
> - **「一键下发」＝面板创建任务后由在线 runner 自动领取执行**（**不加按钮**）；无 runner 时手动 `suite run --task` 路径不变（claimed 不阻塞手动，契约锁）。`suite task release <taskId> [--force]`＝管理侧救济（**复用 `releaseRegressionTask` 状态守卫**——读取与写入之间任务已达终态则不覆盖；默认要求执行机离线，在线需 `--force`；`claimed_by` 为空的数据异常态默认拒绝、`--force` 可重置）；`suite_runs.runner` 经 `SuiteCliDeps.runnerName` 透传（runner 子命令把 `--name`/hostname 解析后显式传入；不经 `process.env`）。任务页显示 `attempts > 1` 的重试次数。
> - **§8 剩余项**（沿用现状/列 P3）：多实例并发迁移（init 幂等 best-effort）、`platforms/devices/tools` 无版本宽容解析、真机 iOS 自动发现。（面板动作层/产物服务鉴权升级已实施，见 §13.113；claimed 自动超时重置、按端部分领取、`upsertRunner` 原子化已实施，见 §13.116；`suite backfill` 回填扫描已实施，见 §13.117——均不在剩余项。）
>
> 测试 +54（db-runners 12 / runner-inventory 5 / runner-agent 12 / runner-artifact 6 / suite-runner-cli 6 / suite-task +6 / panel-overview +4 / panel-web +5；另含端到端缝：`artifactUrl` 构建的 URL 打到真实 loopback 服务 200）；全量 **1123 绿**（含 Review Focus 五条锁定：并发领取守卫、路径穿越、崩溃重启释放、心跳/在线边界、手动与自动并存；两轮评审修复补：非零退出未达终态释放/终态不覆盖、**重试上限不饥饿队列**、`to:"failed"`、null claimedBy 救济、>50 条饥饿锁、守卫化 release）。

- **口径**：领取＝任务端子集＋原子状态守卫；心跳 TTL 90s（3×默认周期）判定在线（字段级 now 对比）；产物 URL 一律相对 `.artemis`（与服务根一致，越界不链接）；claimed 超龄＋失联自动回收（§13.116），人工救济＝启动释放＋`suite task release`；产物服务与动作层并列**内网无鉴权**面（无鉴权为默认、已可选令牌见 §13.113；默认 `0.0.0.0`、`.artemis` 只读范围，风险在 README/DESIGN 点名）；双端任务需单机双端 runner（分机部署走手动；`AOS_RUNNER_PARTIAL_CLAIM=1` 可按端部分领取，见 §13.116）。

### 13.110 实施记录（回归服务 P3a：定时回归——schedules + runner 触发）

> 实施于 2026-10-14（设计稿 §5.5/§7 P3「定时回归」；计划 `docs/superpowers/plans/2026-10-14-regression-service-p3a-schedules.md`）。DB 增 `schedules` 表（id/project_id/name/feature_keys/platforms/baseline/every_minutes/enabled/last_fired_at/last_note/created_at/created_by；新表无迁移）。`latestFeatureRefs`/`ResolvedTaskRef` 从 suite-command 提取到 `src/tasks/feature-refs.ts`（逐字迁移、零行为变化；suite-task 既有测试为回归锁）。
>
> - **触发**（`src/runner/schedules.ts` `fireDueSchedules`；agent 主循环每轮「**先触发再领取**」）：`enabled` 且（从未触发或 `now - last_fired_at >= every_minutes`；毫秒 now 经 `Date.parse` 与 ISO 换算）→ **窗口 CAS**（`UPDATE ... WHERE enabled AND (last_fired_at IS NULL OR last_fired_at <= cutoff)`——多 runner 并发恰一个赢，败者静默跳过；**触发解析走全量**——`listSchedules`/`listCaseSets` 缺省全量，不受展示分页 50 上限影响（展示/交互路径显式传分页值：交互 `suite task create` 保持 50 且可见报错、非静默）；`listCaseSets` 读取失败 → 本轮不触发、**不消费窗口**）→ 赢得者**实时解析最新份**（featureKey → 最新 caseSetId；份重生成自动跟随，不冻结）→ `createRegressionTask({createdBy: "schedule:<name>"})` → 由既有领取循环执行（**不新增执行路径**）。部分引用缺失 → 可解析子集建任务 + `last_note` 记缺项；全缺失 → 跳过 + `last_note="引用份均不可用"`（窗口仍推进——**补跑仅补一次**，防风暴）。触发失败 best-effort（**每 due schedule 独立捕获**：窗口抢占失败仅告警跳过——窗口未消费、下轮重试；建任务失败告警 + `last_note`；均不阻断其余 schedule、不打断主循环）。`AOS_RUNNER_SCHEDULES=0` 关闭（默认开；`--once` 亦检查一次）。
> - **CLI `suite schedule add|list|show|enable|disable|remove`**：`add --ref <featureKey>… --every <minutes≥5> [--platform ios|android]… [--baseline latest|none] [--name <n>]`（key 解析校验、platform 白名单+去重、name 缺省=首个 featureKey；**同项目同名拒绝**——`UNIQUE(project_id, name)`）；enable/disable 幂等（已是目标值提示仍 exit 0）；list/show 支持 `--json`。
> - **面板（只读）**：项目页「定时回归（schedule）」区块（名称/功能 chips/端/节奏/启用/上次触发+`last_note`/最近任务链接——按 `createdBy=schedule:<name>` 在最近任务中匹配）；任务页状态行显示「来源」；空态给 CLI 提示。管理走 CLI（面板动作层扩展列 backlog）。
>
> 测试 +25（db-schedules 5（含同名拒绝）/ feature-refs 1 / fire-schedules 9（含 sets 读取失败不消费窗口、>50 份全量解析、CAS 抛错逐 schedule 隔离）/ runner-agent +4 / suite-schedule 4（含同名 exit 2）/ panel-overview +1 / panel-web +1）；全量 **1148 绿**（含 Review Focus 五条锁定：并发双触发 CAS、引用时效、补跑仅一次、触发失败不阻断、禁用/删除语义；两轮复核修复补：name 唯一、触发解析全量、sets 失败不消费窗口、窗口抢占失败不阻断其余）。

- **口径**：节奏 v1 仅 interval（最小 5 分钟；cron/每日定点/时区、错峰、schedule 编辑/改名、面板管理动作列 P3+）；触发在 runner（项目机常驻、CAS 单触发）；schedule 引用 featureKey 而非 caseSetId（份演进自动跟随）；补跑仅补一次；面板只读、CLI 管理；**schedule `name` 项目内唯一**（面板「最近任务/来源」关联前提）；**schedule platforms 无匹配 runner 时任务逐窗口累积 pending**（owner 配置责任、面板任务列表可见；v1 不自动清理）。

### 13.111 实施记录（回归服务 P3b：改进出口接线——生成反馈联路 / 环境清单 / Jira 一键建单）

> 实施于 2026-10-14～15（设计稿 `docs/superpowers/specs/2026-10-14-regression-service-p3b-design.md`（决策 D1–D10）；计划 `docs/superpowers/plans/2026-10-14-regression-service-p3b-exits.md`，经一轮独立复核修订 C1/I1–I4/M1–M6）。目标：把归因裁决（§13.108）的三个改进出口接线——**案例问题 → 生成侧只读呈现（不自动改）**、**执行偏差 → 环境改进清单（视图＋导出）**、**应用缺陷 → 面板一键建 Jira 单（证据＋回写单号）**。
>
> - **store**：`suite_run_cases` 增 `jira_issue_key TEXT`（SCHEMA 与存量库 `MIGRATIONS` 补列，同 `verdict*` 款）；`ProjectStore` 增 `setCaseIssueKey`（按（run,case）更新单号，项目作用域子查询校验、未命中 false，镜像 `updateCaseVerdict` 形状）与 `getSuiteRun`（按 runId 读单条运行＋其用例，项目作用域，未命中 null）；memory/pg-mem 双实现；`recordSuiteRun`/`cloneSuiteRun` 的 cases 映射统一 `jiraIssueKey ?? null`（M6 卫生）。
> - **共享出口聚合（单一事实源）** `src/tasks/verdict-exits.ts` `collectVerdictExits`：收编面板统计与生成反馈既有两处重复循环——**份血统口径**（`run.featureKey === null` 跳过，§13.108 契约）；入参自排 createdAt **新→旧**（乱序亦确定性）；按 `(caseSetId ?? "")|caseId` **首见即最新**；`caseDefects`/`appDefects` 按 caseId 升序（tie → `featureName` 升序 → `runId` 升序）；`environment` 按 `${device ?? ""}|${platform}` 分组（count 累加、features 去重后字典序、lastAt 取最大、notes 去重保序），组排序 **count 降序 → device 升序 → platform 升序**。面板统计视图、`suite feedback`、生成侧三处同源。
> - **Jira 服务层提取**（`src/jira/`）：`resolve.ts`（`resolveJiraClient`／`jiraMissingConfigPayload`／`jiraErrorPayload`——错误三态（限流/API/通用）随迁为 **payload 级**字段（M2）；建单条目结果统一用 `reason?` 字段（M4））、`attachments.ts`（附件去重上传核心 `uploadAttachmentsDeduped`／`deterministicAttachmentName`／`shortContentHash`，工具与 `post.ts` 共用避免循环依赖，I2）、`post.ts`（`postEvidenceToIssue`——凭证检查→key 解析→trace 存在性→幂等评论＋去重附件；**`dryRun` 且 key 为空/未提供 → 跳过 key 解析、`issue: null`**，M1）、`issue-template.ts`（`buildRegressionIssueSummary`／`buildRegressionIssueDescription`——summary 两态、description 按字段有无省略的 ADF 列表）。`src/tools/jira.ts` 改为薄封装，**输出逐字不变**（`test/jira-tools.test.js`／`test/jira-evidence.test.js` 为回归锁，未改）。
> - **面板一键建单**：`POST /panel/api/issues`（`src/panel/actions.ts` 路由 + `src/panel/issues.ts` 核心 `createRunCaseIssues`）。仅 HTTP 模式；`AOS_PANEL_ACTIONS=0` 整体关闭（404）；`items` ≤ **20**（超限 400）、逐条 `{runId, caseId}`；body ≤256KB（沿用 P1c 动作层上限）。**准入（D9，先校验后建单，不允许部分副作用后才发现格式错）**：未知运行/用例 → `skipped`；`status === passed` → `skipped`；既有裁决存在且 ≠ `app-defect` → `skipped`；无裁决允许；已有 `jira_issue_key` → `existing` 直接返回（**顺序重复点击幂等**）。**缺省链（D5）**：`projectKey`＝`payload.projectKey ?? 项目 .env JIRA_ISSUE_PROJECT`（皆空 → 400 指引）；`issueType`＝`payload.issueType ?? JIRA_ISSUE_TYPE ?? "Bug"`；`labels`＝`normalizeLabels(payload.labels ?? JIRA_ISSUE_LABELS)`（trim＋去空＋去重）。`dryRun:true` → `preview`（摘要＋附件清单，**不触网、不建单、不回写**）。建单失败 → 该条 `error`、**不回写单号、不误报 created**。证据评论＋附件经 **服务层 `postEvidenceToIssue`**（与 `jira_evidence_post` 同源），返回 `evidence: posted|skipped|error`（**best-effort**——traceId 缺失 → `skipped`；回写失败仅日志）；产物 URL 经 `regressionTaskId → runners.artifact_base_url` 复用面板 `artifactUrl` 拼法（尽力，无基址则纯路径）。建单成功回写单号（`setCaseIssueKey`，失败仅日志）；有条目 `created`/`existing` 时清面板缓存。**建单路径只读配置＋trace 产物，不拉起子进程**；`runtimeFor` 缝（HTTP 注入 `deepRuntimeFor`：仅 workspace 内**单段**项目名可解析（M3），缺省返回指引错误）。
> - **生成侧只读呈现（D1：不静默自动改产物）**：`figma_generate_tests` 响应增 `feedback.caseDefects`——**仅当匹配到本次生成的功能**时出现（`total` + `byFeature[{featureKey, featureName, count, cases[{caseId,name,note}]}]`，`src/figma/generation-feedback.ts` `collectCaseDefectFeedback`）；`tests.md` 末尾追加「上轮案例问题修订提示（裁决反馈）」段（逐功能列用例名与备注）。store 不可用 → 响应省略该块 ＋ `warnings` 记 `case-defect-feedback-unavailable`（**不阻断生成**）；`cases`/`taskDesc` 等产物**未触及**。
> - **CLI `suite feedback` 扩展**：JSON 输出增 `exits`（`caseDefects`/`environment`/`appDefects`，其中 `appDefects` 每条带 `jiraKey`）；文本输出在建议后追加「出口清单（按最新裁决）」段——案例问题（条数＋功能）/执行偏差（条数＋按设备计数）/应用缺陷（条数＋已建单数），三清单皆空 → 单行空态「出口清单为空（暂无已裁决失败）。」；`verdict` 建议含用例名与备注摘要（**截断 40 字 + `…`**，空备注省略括号）。**不新增子命令**（D2）；只读按需、store 不可用静默降级不阻断。
> - **面板 UI（统计下钻改进出口区）**：**环境清单表格**（设备/端/次数/涉及功能/最近裁决/备注摘要——备注合并 ≤120 字、超出 `…`）；**应用缺陷行 checkbox + 已建单 chip**（单号为**纯文本**——见下方降级点名）；**内联建单表单**（项目/类型/标签输入 ＋「预览」/「建单」按钮）——预览调 `dryRun`、建单成功后 reload；客户端结果用 DOM API（`createElement`/`textContent`/`replaceChildren`）渲染（无 `innerHTML` 注入面）、服务端字段 `escapeHtml`、内嵌路径 `JSON.stringify` + `<`→`\u003c`；案例问题指引行同步更新为「修订期望 / 重新生成」。
> - **降级与风险点名**：①**一键建单＝外部副作用**——v1 动作层**内网无鉴权**（沿用 P1c 口径），任何能访问 HTTP 端口者均可建立**真实 Jira 单**（仅限受控内网部署，鉴权升级已实施：见 §13.113）；②**并发双开为已接受限制**——同一条目被两个请求并发建单时可能各建一张（无 DB 级去重/锁），内网单操作员口径，与 `tasks` 路由「重复提交不幂等」同口径（顺序重复点击仍幂等）；③**已建单 chip 的 siteUrl 降级**——面板渲染层**无 Jira 站点来源**，故 chip 只显示纯文本 KEY（不生成 `browse` 链接）；建单响应内的 `url`（含 siteUrl）仅在本次结果列表可点；④**证据 best-effort**——Jira 未配置 → 400＋指引且不触网；证据回写失败不回滚已建单（`evidence:"error"` 如实标注）；⑤未配置 Jira 凭证 → 400＋`howToFix`，不消耗任何外部请求。
>
> 测试 +40（原 +38：db-suite-runs +4 / verdict-exits +7（新文件）/ jira-issue-template +4、jira-post +3 / panel-actions +9 / panel-web +3 / generation-feedback +2、suite-command +1 / figma-test-gen +5；收尾复核修复波 +2：`test/panel-actions.test.js`、`test/figma-case-sets-gen.test.js` 各 +1）；全量 **1188 绿**（含 Review Focus 五条锁定：Jira 未配置/失败不触网不误报、重复建单顺序幂等、越权/坏输入先校验后建单、注入转义、生成侧降级不阻断；回归锁 `test/panel-stats.test.js`／`test/jira-tools.test.js`／`test/jira-evidence.test.js` 未改；`test/panel-overview.test.js`／`test/generation-feedback.test.js` 随接口演进更新形状断言（口径不弱化，由 `test/verdict-exits.test.js` 新测试锁定））。

- **口径**：改进出口＝**共享聚合单一事实源**（面板/CLI/生成三面同源，份血统口径，§13.108 语义）；**生成侧只呈现不改产物**（案例问题→提示重生成，不静默改写用例）；**建单粒度＝每条一张**（不批量合并）；**证据与 `jira_evidence_post` 同源**、best-effort 不回滚；Jira 缺省值项目 `.env`（`JIRA_ISSUE_PROJECT`/`JIRA_ISSUE_TYPE`(默认 Bug)/`JIRA_ISSUE_LABELS`），payload 优先；面板建单为**外部副作用**（v1 内网无鉴权（默认；已可选令牌，见 §13.113）、并发双开接受、已建单 chip 无 siteUrl 降级）；动作层与只读层同源 store、写成功清缓存（reload 即可见）。

### 13.112 实施记录（回归服务 P3c：跨项目对比——多项目对比视图）

> 实施于 2026-10-15（设计稿 `docs/superpowers/specs/2026-10-15-regression-service-p3c-design.md`（决策 D1–D11）；计划 `docs/superpowers/plans/2026-10-15-regression-service-p3c-compare.md`，经一轮独立复核修订 I1–I2/M1–M8）。目标：补上统计维度的「项目」层——只读**多项目对比视图**（`?view=compare` ＋ `/panel.json?view=compare`），按中央台账跨项目呈现质量水位、趋势、失败域与待办，回答「哪个项目需要关注」。前置 P1（§13.106–13.108）/P2（§13.109）/P3a（§13.110）/P3b（§13.111）已落地。
>
> - **视图**（`src/panel/compare.ts` `buildPanelCompare`）：行＝项目（**复用 `buildPanelOverview`** 的项目行与**接入健康灯/lampReasons**——未注册/磁盘不可达提示与 L1 同源，不与「无批次」混淆）；列组六列：**项目**（名链接项目页＋灯）｜**最近批次**（时间·门禁·通过率）｜**趋势**（内联 SVG 迷你图，最近 ≤10 批通过率、时间升序）｜**质量**（flaky 计数·失败域 top3 chips）｜**待办**（未裁决失败条数·未建单缺陷项数·任务积压·failed）｜**运行**（runner 在线/设备·定时回归 enabled/最近触发）。**不改 L1 既有列语义**——L1 只加「多项目对比」页头链接、对比页回链 L1。
> - **窗口与口径（D4/D8/D9/D11）**：窗口＝**份血统运行**（`featureKey !== null`，adhoc 不入窗）最近 **20** 批——台账 `listSuiteRuns(rootPath,{limit:40})` 读回后 JS 过滤、取前 20（窗口稀释有界、如实短窗）；「最近批次」列与**排序键**取台账窗口最新一批（`at = finishedAt`；`gate` **非 pass/fail 一律归一 null**；`passRate = passed/total`，total 0 → null）。**D8 修订**：L1 的「最新批次」软读对磁盘不可达项目恒空、排序失效，故对比视图改用台账口径（L1 自身列与灯**不动**）。`trend`＝窗口前 ≤10 批映射后**反转为时间升序**；`flaky`＝窗口内**运行级 `run.flaky` 之和**（D11）；`domains`＝合并窗口 `failureDomains` 计数后 **count 降序 → domain 升序** 取 top3。**两列待办语义不同并如实标注**：`pendingVerdicts`＝窗口内「`status !== "passed" && verdict === null`」的**发生次数**（同归因队列精神）、`unissuedAppDefects`＝窗口内按（`caseSetId ?? ""`|`caseId`）**取最新裁决去重**后 `app-defect && jiraKey === null` 的**条数**（复用 `collectVerdictExits`，与统计/建单面同源）；**精确待办以归因队列（近 10 次口径）为准**（两窗口故意不同）。
> - **运行列（近似口径）**：任务积压＝`listRegressionTasks(rootPath, 200)` **最近 200 条近似**（超出部分旧条目不计）计数 pending/claimed/running/failed（其余状态不计）；runner 在线＝`listRunners(rootPath, 100)`（**显式放宽默认 limit 20**）经既有 `isRunnerOnline`/`runnerTtlFrom`（TTL 90s，与 overview 同源）判定，`devices`＝在线 runner 设备数之和；定时回归＝`listSchedules(rootPath)` 计 enabled 数、`lastFiredAt` 取非空最大值。
> - **排序与封顶（I1）**：固定「关注优先」，**先排序、后截断**：`rank`（无批次 0 → 最近门禁 fail 1 → 其余 2）升序 → `passRate` 升序（null 后置）→ 项目名升序（稳定）；输出封顶 **50** 行，`truncated:true` ＋ warning（避免红灯项目被 overview 最后活跃序误丢）。排序/封顶提取纯 helper `selectCompareRows(rows, cap=50)` 供单测。**行级降级（D7）**：单项目台账读取抛错 → 该行 `error`（面板显「读取失败：…」）如实标注、其余字段给空默认，**不整页失败**；无数据单元格显 `—`。
> - **D10 批量装载**：`listSuiteRuns`（postgres）内部由「逐 run 装载 cases」改为**单查询批量装载**——收集 runIds → 动态占位 `IN (…)`（占位符自 `$1` 起）一次读取 `ORDER BY run_id ASC, case_id ASC` → 按 run_id 分组装配；**零 run → 跳过批量查询**（`IN ()` 守卫）。对外**行为逐字不变**（runs 顺序（新→旧、limit 语义）与逐 run `cases` 按 `case_id` 升序），全部既有调用方同为提速、零语义变化；对比视图每项目 DB 往返 ≤3。
> - **路由/JSON/渲染**：`buildView` 在**无 `project` 参数**分支按 `view=compare` 命中（带 `project` 时**不命中**、回退项目页路径）；`toJsonView` → `{ …compare, view:"compare" }`，JSON 形状稳定 `{ok,generatedAt,store,window:{runs:20},projects,truncated,warnings,view:"compare"}`；`renderComparePage` 渲染列组＋**口径说明行**（窗口 20 批、任务积压 200/runner 100 近似、数据源＝中央台账、精确待办以归因队列为准）＋降级行＋空态，全字段 `escapeHtml`、迷你图仅由钳制后数值拼接；渲染分支置于兜底 `renderBatchPage` **之前**。`panel --web`（独立只读看板）**自动可用**（同一 handler、无运行时缝依赖）；缓存沿用 `PanelWebCache`（`AOS_PANEL_TTL_MS`）。
>
> 测试 +17（db-suite-runs +2 / panel-compare +9（新文件：聚合＋排序/封顶＋路由/JSON）/ panel-web +6（渲染＋互链＋escape））；全量 **1205 绿**（含 Review Focus 五条锁定：窗口/口径稀释、磁盘不可达但有台账项目排序照常、行级降级与 >50 截断、只读与转义/数值钳制/JSON 形状稳定、`listSuiteRuns` 批量装载后既有调用方输出逐字不变（`db-suite-runs`/`panel-overview`/`panel-web` 为装配锁））。

- **口径**：对比视图＝**项目级只读**（功能级跨项目匹配留 P3+，需先定义匹配规则与误报口径）；数据源以**中央台账为主**（磁盘不可达项目机同样可比，**不读批次清单**）；窗口＝份血统最近 20 批（趋势/flaky/域/最近批次同窗）；两列待办**故意不同口径**并如实标注（窗内发生次数 vs 最新裁决去重）；排序固定「关注优先」、**先排序后截断 50**；**行级降级不整页失败**；L1 列与灯不变（对比视图独立视图）；跨项目**动作不做**（动作层保持单项目作用域、对比视图严格只读）；`?view=compare`＋`/panel.json?view=compare` 同源构建，`panel --web` 自动可用，无子进程/无网络/无写盘。

### 13.113 实施记录（回归服务 P3d：动作层与产物服务鉴权升级——可选静态令牌）

> 实施于 2026-10-15（设计稿 `docs/superpowers/specs/2026-10-15-regression-service-p3d-design.md`（决策 D1–D8）；计划 `docs/superpowers/plans/2026-10-15-regression-service-p3d-auth.md`，经一轮独立复核修订 C1/I1–I2/M1–M6）。目标：为两个对外网络面（`serve --http` 的 `/mcp`/`/panel*`/`/panel/api/*`/`/usage*` 与 runner 产物服务 `/artifact*`）加**可选静态共享令牌**，默认行为零破坏，并对「非 loopback 且未设令牌」的 `serve --http` 给安全默认。前置 P1–P3c（§13.106–§13.112）已落地。
>
> - **机制（`src/auth.ts`，D1/D4/D5）**：**静态共享令牌**（不做账号/角色/OAuth/mTLS）。请求凭据三种形式等价：`Authorization: Bearer <token>`、`Authorization: Basic <base64(user:pass)>`（用户名任意/空、**密码＝token**，浏览器原生弹窗零改造）、产物服务另接受 URL `?t=<token>`（HTTP 服务**不开**查询参数通道）。比较经 `crypto.timingSafeEqual`（先长度归一，长度不等直接 false；等长才逐字节比较，避免时序侧信道）；**空 token 恒 false**；`Authorization` 与 token 值 `trim` 归一。令牌仅读**进程 env**（无项目 `.env` 语义、无 CLI flag）；日志用 `maskSecret` 只回 masked 预览。
> - **`serve --http` 闸门（`AOS_HTTP_TOKEN`，D2/D7）**：未设＝现状（无鉴权，loopback 本地开发不变）。设置后**先鉴权后路由**——除豁免面外一切路径（含 `/mcp/<project>`、`/panel*`、`/panel/api/*`、`/usage*`、深探层、**禁用路由与未知路径**）未认证一律 `401`（不泄露路由存在性）；豁免仅 `GET|HEAD /` 与 `GET|HEAD /healthz`（serve **补齐 `HEAD` 处理返回 200 无体**，与产物服务 parity）。401 带 `WWW-Authenticate: Basic realm="aos-mcp"`（触发浏览器弹窗）＋ JSON `{"error":"unauthorized"}`，且 **`HEAD` 抑制 body（`Content-Length: 0`）**。启动日志 `认证：已启用（Bearer/Basic，token=<masked>）` / `认证：未启用`。
> - **安全默认（D2/M1）**：绑定**非 loopback**（`0.0.0.0`/`::`/LAN 地址）且未设 token 且未显式放行 → 抛 `InsecureBindRefusedError`（检查置于 `RuntimeHost.prepare` **之前**，fail-fast 无副作用）→ CLI `serve` 分支捕获 → stderr 指引 ＋ **exit 2**（其余错误维持 exit 1）；`AOS_HTTP_ALLOW_INSECURE=1` 放行并打印**醒目 WARN**；loopback 绑定不受此限。
> - **runner 产物服务（`AOS_RUNNER_ARTIFACT_TOKEN`，D3/M5）**：未设＝现状（默认 `0.0.0.0`＋既有告警，**不因默认绑定强制**）。设置后 `/artifact/*`（GET/HEAD）要求认证（Bearer/Basic/`?t=`），未认证 → `401` ＋ `WWW-Authenticate: Basic realm="aos-artifact"`（`HEAD` 抑制 body）；**闸门覆盖非 `/artifact*` 路径**（无凭据 401、不泄露路由）；豁免仅 `GET|HEAD /healthz`（`/` **不在**豁免）。复用既有 `env?` 缝读 token（命令层无需改）、启动行 masked；令牌**不随心跳广播**（不落 PG、不出现在面板链接——面板产物链接保持纯 URL，浏览器按弹窗输入）。
> - **`install --mode http` 注入（`src/install.ts`，D6/M6）**：操作者进程 env 有 `AOS_HTTP_TOKEN` → 各 target 的 http/remote 形状注入 `headers.Authorization: Bearer <token>`（本地 stdio 条目不受影响）；输出附「已注入 Authorization 头…」提示，**但全部 target 都 `skipped_exists` 时不给该提示**（只在确有条目带 token 落位时声明）；未设 token → 不带头并提示「目标服务若启用令牌，请在客户端配置 Authorization」；**token 变更后配置视为「已存在但不同」→ 需 `--force` 重装**；输出**不打印明文**。
>
> 测试 +26（auth +7（新文件）/ http-server +9 / runner-artifact +6 / install +4；含 CLI serve 的 exit 2 缝）；全量 **1231 绿**（含 Review Focus 锁定：闸门先于路由与豁免边界、凭据形式等价与常时比较/空 token、安全默认 exit 2 与放行 WARN、`HEAD` 无体、`?t=` 仅产物服务且仅在开通道时生效、install 幂等与不泄露明文）。
>
> - **口径**：鉴权＝**可选静态共享令牌**（Bearer＋Basic 双接受；产物服务另允 `?t=`）——默认零破坏、设＝强制；**先鉴权后路由**、未认证不泄露路由；豁免**仅** `GET|HEAD /`（serve）与 `GET|HEAD /healthz`（serve＋产物服务）；`serve` 非 loopback 无 token 为**安全默认启动失败（exit 2）**，`AOS_HTTP_ALLOW_INSECURE=1` 为显式逃生门；令牌仅进程 env、比较常时、日志 masked、install 输出不落明文；`isLoopbackHost` 为**纯字符串判定**（仅 `127.0.0.1`/`::1`/`localhost` 大小写不敏感，`::ffff:127.0.0.1` 及解析到 loopback 的主机名一律按非 loopback **fail-closed**）；401 对 `HEAD` 抑制 body；账号/角色/OAuth/mTLS/令牌轮换、独立 CLI 看板鉴权、产物签名 URL/中心代理、默认绑定改变均**不在范围**（另立计划）。产物服务**目录浏览建议用 Bearer/Basic**；经 `?t=` 认证打开的目录索引会为条目与父链接**续带 `?t=`**（**仅当该 `?t=` 值自身校验通过**，Bearer/Basic 路径不带），`?t=` 仍以**单文件直链**/书签场景为主（本条对原建议的**局部反转**见 §13.115）。

### 13.114 实施记录（回归服务 P3e：跨项目功能对齐——同源功能对照）

> 实施于 2026-10-15（设计稿 `docs/superpowers/specs/2026-10-15-regression-service-p3e-feature-alignment-design.md`（决策 D1–D10）；计划 `docs/superpowers/plans/2026-10-15-regression-service-p3e-feature-alignment.md`，经一轮独立复核修订 I1–I2/M3–M9）。目标：补 P3c（§13.112）明确推迟的**功能级跨项目匹配**——先定匹配规则与误报口径，回答「同一功能在 A/B/C 三个项目里的通过率、flaky、待办各如何」。前置 P3c/P3d（§13.112/§13.113）已落地。
>
> - **匹配规则（D1/D2/D5/D8，`src/panel/feature-alignment.ts` 纯函数）**：**组＝同设计源身份 ＋ 归一化功能名**；**仅组内项目数 ≥2 展示**（名下同名不同源不成组）。**源身份归一化**（`normalizeDesignSource(source, rootPath)`）：**前缀优先判定**——`figma:` 先判，取 `figma:` 后**首个 token** 为身份（`figma:<fileKey>[ (名)]` → `figma:<fileKey>`，**不 lower**，fileKey 原样保留）；`pen:` 次判，`pen:<rel>` → posix 化＋**小写**（含分隔符仍走 pen 归一化）；其余含路径分隔符/绝对路径 → `path.relative(rootPath, source)` 后 posix＋小写（相对结果以 `..` 开头 **或** 经盘符判定后仍为绝对路径（跨盘符）→ **原样小写**）；其余形式**原样小写**。**功能名归一化**（`normalizeFeatureName`）：NFC → trim → 连续空白折叠单空格 → 小写（CJK 不变；**不剥词形**，不剥离「流程/页」等后缀、不做同义词）。**已声明边界（误报口径随视图展示）**：同一 Figma 文件「工具 url 形式（`figma:<key>`）vs 管道路径形式（相对路径）」**不互相匹配**（v1 纯文本归一化；跨形式对齐需读 flows.json 内 fileKey，列 P3+）。
> - **数据与窗口（D2/D7/D9）**：数据源＝对比视图**同一窗口**——各项目「份血统运行最近 20 批」（台账 `listSuiteRuns(limit:40)` → JS 过滤 `featureKey !== null` → 取前 20）。每项目**新增一次 `listCaseSets(rootPath)`（缺省全量）**并投影为 `sets: [{id, source, features:[{key,name}]}]`，**保证窗口内老份也能映射**（限 20 会静默漏旧份）。**聚合单位＝`(caseSetId, featureKey)`**（跨代 key 可跨多份/多源）；随后**按（项目, 源身份, 归一化名）合并**：Σ passed / Σ total / Σ runs / Σ flaky / Σ pendingVerdicts、`latestAt` 取最大时间。`passRate`＝Σ passed / Σ total（total 0 → null）；`pendingVerdicts`＝该功能窗内「`status !== "passed" && verdict === null`」的用例发生次数（P3c 同款谓词，`isPendingVerdict`）。**名称权威来源＝case set 冻结名 `features[].name`**；**补丁口径（M4）**：**set 存在但该 `featureKey` 不在 `features[]` 中（或冻结名为空串）时回退 `run.featureName`**，回退后仍为空/`null` 则跳过该运行。**跳过口径（M7）**：`featureKey === null` 的运行、以及 `caseSetId` 无对应 set（无映射）的运行**一律跳过且不产生组键、不参与 unmatched 计数**。
> - **输出与排序（D3/D4/D10）**：`PanelCompareView.featureAlignment: { groups, unmatched }`（**加性字段**，JSON 向后兼容）。`unmatched`＝**仅出现在 1 个项目中的组键数量**（distinct 组键中项目数 <2 的个数；被跳过的运行不计入）。`groups[]` 每项 `{ sourceLabel, displayName, entries }`；**`sourceLabel`＝原始 `source`（不经归一化，展示用）**——因此**路径式 source 会显示生成项目的路径**（同布局项目下文本不同、仍成组，属预期；文档如实注明）。`entries[]` 每项目一行 `{ project, featureKey（合并后取首个，展示用）, passRate, runs, flaky, pendingVerdicts, latestAt }`，**项目名升序**。**组间排序**：项目数降序 → **通过率极差**（组内非 null passRate 的 max−min，**参与值 <2 → 0**）降序 → `displayName` 升序。**只并列、不合并**——**不产出跨项目聚合通过率/总分/排名**，每行数据均标注来源项目。
> - **渲染（`src/panel/web.ts` `renderFeatureAlignmentSection`）**：对比页**第二区块**「功能对齐（跨项目）」（紧随项目级区块，不新增视图）；每组＝表头（显示名 ＋ `sourceLabel` ＋ 项目数）＋小表（项目/通过率/批次/flaky/未裁决/最近）；顶部口径说明行（匹配规则、窗口、误报口径、未匹配计数）；空态（无 ≥2 项目组）＝说明行＋未匹配计数。**对齐区块全部展示、无封顶**（M9，与项目级区块封顶 50 行不同）。**全部字段 `escapeHtml`**。`/panel.json?view=compare` 响应含 `featureAlignment`。
> - **降级与只读（D3）**：单项目 `listCaseSets` 失败 → `sets = null` → **该项目不参与对齐**（项目级区块照常、行级 `error` 不改），计数如实、不整页失败。沿用 P3c：**严格只读**（无子进程/无网络/无写盘）、输出入 `PanelWebCache`（`AOS_PANEL_TTL_MS`）。**性能**：每项目新增 1 次 store 读（`listCaseSets` 全量）——对比视图每项目 DB 往返 ≤5（原 4＋本 1）（`listCaseSets` 为全量读；case set 数量大时按 1+N 查询计）。
>
> 测试 +23（feature-alignment +16（新文件：归一化/分组/指标/降级）/ panel-compare +4（`featureAlignment` 加性字段与组装）/ panel-web +3（区块渲染/空态/未匹配置/escape））；全量 **1254 绿**（含 Review Focus 锁定：前缀优先与路径相对化/跨形式不匹配边界、set 缺 key 回退 `run.featureName`、被跳过运行不产生组键且不参与 unmatched、组排序（项目数→极差→名）与 entries 项目名升序、对齐区块无封顶与全字段转义、P3c 项目级区块/JSON 字段零回归（加性））。
>
> - **口径**：跨项目功能对齐＝**保守匹配**（同设计源身份 ＋ 归一化功能名，宁缺勿蹭；组内 ≥2 项目才展示）；**只并入对齐表、不合并统计**（无跨项目聚合通过率/总分/排名，每行标注来源项目）；名称归一化**不改词形**、名称权威＝**case set 冻结名**（set 缺 key 则回退 `run.featureName`，仍空跳过）；**被跳过运行（`featureKey === null` / 无 case-set 映射）不产生组键、不参与 unmatched**；`unmatched`＝**仅出现在 1 个项目中的组键数**；`sourceLabel` 为**原始 source**（路径式会显示生成项目路径）；同文件「url 工具形式 vs 管道路径形式」**不互相匹配**为**已声明边界**；对齐区块**全部展示**（无封顶）；**严格只读**、全字段转义、加性 JSON 向后兼容；手动别名/映射文件、模糊/AI 匹配、同名不同源「疑似」提示、跨项目合并统计与动作、历史对齐演进均**不在范围**（另立计划）。

### 13.115 实施记录（回归服务清理批次：切分加固 + 产物索引令牌续带 + 测试补强）

> 实施于 2026-10-16（计划 `docs/superpowers/plans/2026-10-16-regression-service-cleanup.md`，经一轮独立复核修订 I1–I2/M 系列；提交 779816a/f29571a ＋ 本记录）。范围＝P3 复盘遗留的**小半径加固与文档回收**，**零行为回归（未设令牌／默认路径）**。前置 P1–P3e（§13.106–§13.114）已落地。
>
> - **切分加固（`src/panel/web.ts`）**：任务表单 `refs` 与归因裁决表单 `items` 的 `value = "<左>|<右>"` 解析，由「按 `|` 全量切分」改为**首个 `|` 的 `indexOf`/`slice`**（镜像 §13.111 `issue-item` 表单既有先例）——右侧（`featureKey`/`caseId`）自身含 `|` 时不再截断；**payload 形状逐字不变**（元素仍 `{caseSetId,featureKey}` / `{runId,caseId}`），属既有声明内的类比扩展。
> - **产物索引 `?t=` 续带（`src/runner/artifact-server.ts`）**：目录索引（条目与父链接）在**且仅当该 `?t=` 值本身通过常时校验**时续带 `?t=<encodeURIComponent(queryToken)>`——Bearer/Basic 命中**不带**、未启用 token 逐字回归旧行为、保留字符 percent-encode。携带判定与请求凭据无关（`authorization: undefined`），故「有效 Bearer ＋ 陈旧/错误 `?t=`」**不携带**坏链（I2 收紧）。**本条对 §13.113 原建议「目录索引链接不携带查询串」为局部反转（I1）**——§13.113 与 README 对应句已回收改写；`?t=` 仍以**单文件直链**/书签场景为主。
> - **测试补强**：① **路由级错误分支**（issues 动作路由：`runtimeFor` 为 null／未配置 Jira → 400 指引，离线）；② **D8 直测**（「磁盘不可达但有台账」：门禁 fail → 对比行 `rank` 1、`latestBatch` 非空）；③ **零 run 守卫**（`listSuiteRuns` 批量装载在零 run／`limit:0` 下跳过批量查询，pg-mem 命中）。
> - **文档指针两处**：§13.109 产物服务口径改「默认监听 `0.0.0.0`、**默认**无鉴权（可选令牌见 §13.113）」；README 功能对齐段补「越界/不可相对化则原样小写」（与 `normalizeDesignSource` 的 `..`/跨盘符回退一致）。
>
> 测试 +9（runner-artifact +5 / panel-web +1 / panel-actions +1 / panel-compare +1 / db-suite-runs +1）；全量 **1265 绿**（Review Focus 锁定：refs/items 含 `|` 值的形状级切分、索引续带**仅随有效 `?t=`**（Bearer/Basic 与未设 token 均不带）、路由级 400 与 D8 排序/零 run 守卫）。
>
> - **口径**：本批为**加固与文档回收**，不含新功能与口径变更；`?t=` 携带＝**有效性收紧**（该值自身过校验才带，防有效 Bearer 携陈旧坏链）；**零行为回归**（未设令牌／默认路径逐字不变）；切分语义＝**声明内类比扩展**（首个 `|`）。

### 13.116 实施记录（回归服务 P2.x 加固：失联领取回收 + 按端部分领取 + upsertRunner 原子化）

> 实施于 2026-10-16（设计稿 `docs/superpowers/specs/2026-10-16-regression-service-p2x-hardening-design.md`（决策 D1–D7）；计划 `docs/superpowers/plans/2026-10-16-regression-service-p2x-hardening.md`，经 builder-check 复核（Q1–Q3）与一轮外部复核（关键点 1–2／中 3–5／低优先三条）修订；提交 3583780/999ada9/6088a0c ＋ 本记录）。范围＝§13.109 §8「剩余项」中的三项服务化加固（claimed 自动超时重置、按端部分领取、`upsertRunner` 原子性），**默认配置零行为回归**。前置 P2/P3a（§13.109/§13.110）已落地。
>
> - **失联领取回收（D1/D2/D5，`releaseStaleClaims`，`src/db/postgres.ts`/`src/db/memory.ts`）**：单条原子 `UPDATE … WHERE`（无读改写窗口）——命中 `status ∈ {claimed, running}` ∧ `claimed_at` 非空且 `<= claimedBefore`（**超龄**）∧（`claimed_by` 为空 **或** 该 runner `last_seen_at <= offlineBefore`（**失联**；`claimed_by` 悬空即查不到对应 runner 时同样回收））→ 置 `pending`、清 `claimed_by/claimed_at`；**`attempts` 不动**（`attempts` 语义＝**领取即累加**，在 `claimRegressionTask` 的 `attempts = attempts + 1`）；返回 `rows.length`（`RETURNING id` 风格）。agent 主循环**每轮**在「触发 schedules → 领取」**之前**调用（`offlineBefore = now − runnerTtlMs`（既有 90s TTL）、`claimedBefore = now − staleClaimMs`）。开关 `AOS_RUNNER_STALE_CLAIM_MS` 默认 **900000**（15min），**专用解析器**：`"0"` → 0 **关闭回收**（不回退默认）、非法/空 → 默认。回收 >0 条记日志。**自洽性质**：**无在线 runner 时无人回收**（回收由在线者执行，首个恢复的 runner 先回收再领取）。**前置依赖**：回收正确性依赖「执行期间心跳持续」——心跳循环与主循环解耦（P2 已在场，§13.109），长跑任务只要心跳在跳就不会被判失联；**毒丸守卫（外部评审关键点 2）**：crash 型循环触达不到「执行失败置 failed」路径，故领取成功后若 `task.attempts > maxAttempts` → 立即 `releaseRegressionTask(to:"failed")` ＋ 日志「毒丸防护」，**不进入执行**（毒丸在 max+1 次领取处终态化）。**成本口径**：每轮回收＝一次额外 DB 往返（单条 UPDATE；仅 `staleClaimMs > 0` 时发）。
> - **按端部分领取（D3/D6/D7，`claimRegressionTask`）**：新增可选 `onlineBefore`/`allowPartial`，**缺省＝严格旧行为**（任务端 ⊆ 自身设备端，逐字）；**四组合仅 `allowPartial === true && onlineBefore 提供` 分叉**（其余三组合＝严格子集，旧行为本就返回 null 隐式等待）。规则：**完全覆盖优先**；无则对每个 pending 候选算交集，当**无他者在线 runner**（`last_seen_at > onlineBefore`，**排除 self**，self 用 `input.platforms` 直接判定）可**完全覆盖**该任务且交集 ≥1 时领最早候选，按**交集端**执行。开关 `AOS_RUNNER_PARTIAL_CLAIM=1` **显式开启**（**默认关**）。缺端**不自动补跑**、**不新增任务状态/结果表字段**；可见性＝领取日志「部分端执行（缺 X——在线无全覆盖执行机）」＋执行侧既有控制台缺端标注。**端覆盖审计反推口径**：DB 层对「completed 但缺端」无标记，反推＝任务 `runIds` 关联的 `suite_runs.platform` 集合 vs 任务 `platforms`（统计下钻分母按实际已跑端）。**快照竞态**：双端 runner 恰在在线快照后上线的小窗口**不覆盖测试**（与既有并发测试 backlog 同口径）。
> - **`upsertRunner` 原子化与迁移（D4，`src/db/postgres.ts`）**：唯一索引**仅经 MIGRATIONS 建**——**先去重**（`DELETE FROM runners WHERE id IN (SELECT r1.id FROM runners r1 JOIN runners r2 ON r1.project_id = r2.project_id AND r1.name = r2.name WHERE r1.last_seen_at < r2.last_seen_at OR (r1.last_seen_at = r2.last_seen_at AND r1.id < r2.id))`——保留 `last_seen_at` 最大、并列取 `id` 最大；**pg-mem 3.0.14 实测唯一可行形态**：窗口函数/`DELETE…USING`/相关 EXISTS/`NOT IN`+GROUP BY 均不可用）**再** `CREATE UNIQUE INDEX IF NOT EXISTS runners_project_name_idx ON runners(project_id, name)`（幂等覆盖新库/存量库；**DDL 不加表约束**以避免新库双索引）；`project_id IS NULL` 行不参与去重（upsert 未注册项目即抛错，无实际影响）。实现改 INSERT → 命中唯一冲突（`23505`）→ 回退 `UPDATE`（按 `project_id, name`，与 `createSchedule` 归一先例同款）＝单行 upsert，双写并发最多一次回退、不产生重复行。**tie-break 口径**：并列取 `id` 最大＝UUID 字符串比较（确定性）；`last_seen_at` 文本比较依赖**统一 ISO 格式**（同格式字典序＝时间序，勿引入带时区偏移格式）。**迁移 best-effort 残余**：`MIGRATIONS` 维持仓库既有 try/catch 包装（多实例并发迁移 out-of-scope），以**迁移专项测试**（pg-mem，夹具沿用 `test/db-runners.test.js` 旧表形态）锁定去重＋索引＋单行不变量；「迁移未生效且并发插入」残余风险与现状同级。
> - **部署约束**：失联判定以**回收者自身 TTL** 为准——多机队须**统一 TTL/心跳配置**，各机心跳间隔 **≤ TTL/3**（默认 30s/90s 满足）；混配（他机心跳间隔 > 本机 TTL）会把健康但慢心跳的执行机误判失联。
>
> 测试 +19（T1 +5 / T2 +8 / T3 +6；`db-runners`/`runner-agent` 等）；全量 **1284 绿**（Review Focus 锁定：超龄＋失联回收与**超龄＋在线不回收**、`attempts` 保留、悬空 `claimed_by` 回收、`"0"` 关闭、毒丸守卫 `attempts > maxAttempts` 置 failed 不执行；部分领取四组合、完全覆盖优先、他者全覆盖则等待、排除 self、默认关旧行为；迁移专项去重＋唯一索引、23505 回退单行不变量）。
>
> - **口径**：三项加固＝**默认零行为回归**（回收仅涉「超龄＋失联」、部分领取默认关、无新参数字段＝严格旧行为）；回收＝**双条件原子 UPDATE**、`attempts` **领取累加**语义不变＋**毒丸守卫**在领取侧兜底终态化；「无在线 runner 则无人回收」为**自洽性质**；部分领取＝**全覆盖优先、仅「无他者在线全覆盖」时按交集端**、缺端**不自动补跑/无新状态字段**、opt-in；`upsertRunner`＝**唯一索引仅经 MIGRATIONS（先去重后建）＋23505 回退**，单行不变量，残余风险与现状同级；部署须**统一 TTL/心跳且心跳 ≤ TTL/3**；claim 平台下推 SQL、并发领取执行级测试、多实例并发迁移、任务页/结果表级缺端标记、自动补跑缺端、真机 iOS 自动发现、artifact TOCTOU 均**不在范围**（另立小票）。

### 13.117 实施记录（回归服务 backfill：从磁盘产物幂等重建登记）

> 实施于 2026-10-16（设计稿 `docs/superpowers/specs/2026-10-16-regression-service-backfill-design.md`（决策 D1–D12）；计划 `docs/superpowers/plans/2026-10-16-regression-service-backfill.md`，经 builder-check 复核（Q1–Q5）与一轮外部复核（关键 1–3 成立、中 4 成立且高价值、中 5 误判澄清）修订；提交 b270d21/4b02619/dad2254 ＋ 本记录）。范围＝spec §5.3「降级与回填」与 §8 遗留项「回填扫描命令形态」：中心 PG 不可用时生成/执行照常、产物落盘——**产物是事实源、登记可回填**；本命令从既有产物**幂等重建登记**，补上「漏登记的份/运行只能靠人补库、或永远缺失」的缺口。
>
> - **命令与只读契约（D1，`src/tasks/backfill.ts` / `src/suite-command.ts` `suiteBackfill`）**：`suite backfill [--dry-run] [--json] [--project <dir>] [--since <ISO>]`。只读扫描 `design/runs/*.json`（批次清单 manifest，文件名倒序（排序后逆转））与 `design/case-sets/*.json`（用例集归档三件套的 JSON，basename 升序）；**仅写 DB 登记、绝不改写磁盘任何产物**（dry-run 与实跑同）。报告 `{ scanned{runs,caseSets}, registered{runs,caseSets}, wouldRegister{runs,caseSets}, skipped, invalid, beforeSince, dryRun, warnings }`＋文本行；`--json` 出结构化报告。`--project` 沿用通用旗标（项目身份经 `AOS_PROJECT_DIR`/`aos.config.jsonc` 解析）。
> - **PG 守卫（D12）**：`store.kind !== "postgres"` → 报错并 **exit 2**（提示配置中心 PG；沿用 `suite runner` 先例）——**禁止在降级内存库上产生「成功假象」**（如实标注红线）。
> - **登记下界（D10，`getEarliestRegistrationCreatedAt`）**：默认 `since`＝该项目**最早登记时间**（对 `suite_runs`/`case_sets` 两域各取 `MIN(created_at)` 再取 min）；**全库为空 → 无下界并 warning**（将扫描全部归档）。`finishedAt < since` 的 run 与 archive stamp `< since` 的归档**不登记**（`beforeSince` 计数）——防首跑把回归服务之前的历史清单导入（与非目标自洽）。`--since <ISO>` 显式覆盖。
> - **幂等键与 DB 级约束（D2/D11）**：runs 幂等键＝**`manifest_path`**（**同源绝对路径、不 resolve/不归一/不相对化**——`saveRunManifest` 返回与 `loadRunManifest` 的 `read.file` 原样一致，逐字节一致是幂等前提）；迁移新增**部分唯一索引** `CREATE UNIQUE INDEX IF NOT EXISTS suite_runs_project_manifest_idx ON suite_runs(project_id, manifest_path) WHERE manifest_path IS NOT NULL`（`src/db/postgres.ts` MIGRATIONS），回填插入命中 **23505 → 按已登记 skip**（并发/与在线登记双写**不产生双行**）；在线登记路径维持 best-effort。**迁移不做前去重（裁定）**：`manifest_path` 由 `saveRunManifest` 独占写（tmp+link、撞名换后缀重试）保证唯一、无历史重复行可言，故既无前去重必要、也不写「潜在有害的 DELETE」；`MIGRATIONS` 维持仓库既有 try/catch best-effort 包装，迁移未生效时**降级为应用层幂等（`listRegisteredManifestPaths` 查重）**、**无数据损坏**（残余风险与既有迁移同级）。sets 幂等键＝**`features[].jsonPath`**（应用层集合去重：`listCaseSets(rootPath)` 全量摊平 `jsonPath` 集合；cases 无 DB 级约束）。
> - **路径桥（D8，读侧重映射）**：`RunManifest` 增**可选** `registration?`（additive、`schemaVersion` 不变、`loadRunManifest` 读侧宽容不回归）：写侧**保存时点可得即写**——`run --task` 写 `regressionTaskId/caseSetId/featureKey/featureName/platform/runner/caseSetJsonPath(=ref.jsonPath)`，`suite run`/`suite loop` 写 `platform/runner/testsPath(=report.testsPath，即 --tests 入参原样)`；**`appVersion` 无写侧来源 → 恒 null（字段保留）**。**runner 取 `io.runnerName ?? os.hostname()`**（与在线对齐）。回填**先 sets 后 runs**：runs 段以 `registration.caseSetJsonPath ?? registration.testsPath` 匹配本轮新登记或既有已登记归档的 `features[].jsonPath` → **重映射 `caseSetId` 并恢复 `featureKey/featureName`**（同源恢复；降级窗口内引用的悬空就此修复）；**未命中原值保留**（不猜、不悬空扩面）。**run/loop 默认 feature-null**：`suite run`/`suite loop` 的在线登记本就 feature-null（refs 解析发生在登记之后、且主 `tests.json` 与归档 `jsonPath` 不同名）——回填同口径，仅当 `testsPath` 命中归档 `jsonPath` 时才经路径桥恢复血统。此机制同时消除原 D8「`--tests <归档>` 保存前解析 refs」backlog（写侧零时序变化、解析在读侧）。
> - **字段口径（runs，D5/D9）**：`trigger`＝**`"cli"`**（与在线登记逐字一致；`manifest.source` 的 run/loop 细分属清单自身语义、不落登记列）；`status`＝`gate.exitCode === 0 ? "completed" : "failed"`；计数/gate/`failureDomains` 取自 manifest summary/gate；cases 逐条映射（`flaky`＝`retry.flaky`、`quarantined`、`traceId`、`failure.domain/confidence/reason`）；`createdAt`＝**`finishedAt`**（保历史时序）；`platform`＝`deviceSerial` 经 `platformOf` 分类 → 兜底 `registration.platform` → 再无 `"unknown"`；`manifestPath`＝`read.file`；**`manifest.runId` 不复用、不落列**（`suite_runs.id` 由 `recordSuiteRun` 生成，cases 经 `run_id` 关联新 id）；`durationMs/verdict/verdictBy/verdictAt/verdictNote/jiraIssueKey` 回填为 `null`（不伪造）。缺维度**如实 null**（platform 除外＝可分类）。
> - **字段口径（case-sets，D4/D6/Q3/Q4）**：`source`＝归档 `source`；`designName`＝**恒 null**（归档不含该字段）；`basename`＝**归档 stem**（`<stamp>_<功能>`；展示项、非身份/聚合键——与在线登记恒 `"tests"` 不同，口径注明）；`fingerprint`＝**该归档文件 sha256（crypto 直算）**（与在线登记用的主 `tests.json` 指纹**不同源**，回填行以归档自身为准）；`createdAt`＝basename 前缀 UTCstamp（`YYYYMMDD_HHMMSS`→ISO，兼容旧归档 `YYYYMMDDTHHMMSS`）解析，不可解析兜底文件 mtime；`features`＝**单条/行**（本归档仅一个功能段：`key/name` 取 `features[0]`、`caseCount`＝`flows.length` 兜底 `counts.flows`、`screens`＝`flows[].screens` 摊平去重）——**与在线登记「一次生成一行多 features」粒度不同**（语义等价可用：份血统/对比键（份,功能）均以行内 feature 为准）；三路径按同名 `.json/.md/.xlsx` 推导。
> - **失效与降级可见（`invalid` 计数）**：manifest 读取 `invalid`/`newer`/`missing`，与归档读取失败/JSON 解析失败/缺 `features[0].key|name`、登记抛错，一律计入 **`invalid` ＋ warning**（不阻断其余登记）；归档三件套缺 `.md`/`.xlsx` → 告警**仍登记**。
> - **dry-run 语义**：`registered` 恒 0（不写库）、**`wouldRegister`＝将登记数**（未登记且过下界）；文本行额外标注「dry-run 未写库」。
>
> 测试 +14（T1 manifest registration +3 / T2 db 查询＋部分唯一索引 +3 / T3 backfill 扫描·路径桥·下界·幂等·命令层 +8；`suite-run-manifest`/`db-suite-runs`/`suite-backfill`/`suite-command`）；全量 **1302 绿**（Review Focus 锁定：runs/sets 幂等复跑全 skip、23505→skip 不双行、下界 `beforeSince` 与空库 warning、路径桥重映射与未命中原值保留、字段口径（platform 分类／`createdAt=finishedAt`／sets 单 feature／指纹=归档 sha）、内存 store exit 2）。
>
> - **口径**：backfill＝**只读扫描产物（绝不写盘）＋只写 DB 登记**、幂等（runs＝`manifest_path` 部分唯一索引＋23505→skip、sets＝`jsonPath` 应用层集合去重）；**须中心 PG**（内存降级即 exit 2，杜绝成功假象）；**默认下界＝项目最早登记时间**（防历史清单倒灌，`--since` 覆盖，`beforeSince` 可见）；runs `trigger="cli"`（同在线）、`createdAt=finishedAt`、`manifest.runId` 不复用；sets 单 feature/行、`basename`＝归档 stem、`fingerprint`＝归档 sha（**均与在线口径不同源，为展示/可用性取舍，口径已注明**）；缺维度如实 null（platform 除外＝deviceSerial 分类＋registration 兜底）；失效产物计 `invalid`＋warning 不阻断；**局限**：既有任务/引用的**历史 id 不可复原**（回填产生新 id；路径桥仅修复同窗口经 `caseSetJsonPath/testsPath` 可达的悬空引用）、**回归服务之前的历史清单不回填**（下界）；增量监视/自动触发、产物改写/补全三件套均**不在范围**（另立小票）。

### 13.118 实施记录（设计×真机细节核验：区域核验「放大核验」）

> 实施于 2026-10-16（设计稿 `docs/superpowers/specs/2026-10-16-design-device-detail-verification-design.md`（决策 D1–D12；builder-check＋外部评审两轮逐条核实并入）；计划 `docs/superpowers/plans/2026-10-16-design-device-detail-verification.md`（6 任务 TDD）；提交 efbe9b7/26f137b/2b9bfd5/27bbaa6/8035b87 ＋ 本记录）。动机：**整屏缩略对比对细节级差异结构性漏报**——受控实验 `.artemis/design/zoom-exp/`（同源四类细节差异：字重加粗/元素缺失/位置偏移/细线缺失）：默认整屏 diff **0/4**、调参 2/4＋噪声、**区域放大 4/4**；fresh 模型盲测虽 4/4 但靠自写差分脚本＋放大复核。做法：**给 `design_device_diff` 增加区域核验并默认开启**——区域提议 → 设备原生栅格成对裁剪放大 → 1:1 局部判定 → 对图输出＋工作流契约。
> - **区域提议（D2/D3；`src/diff/detail.ts` 纯函数）**：`auto`＝叶子节点∪整屏 diff 命中；无节点源（拉取失败/为空）→ tiles 平铺（768px 网格、128px 重叠防跨缝）；叶子口径＝无更深节点覆盖 ≥90% 自身面积、排除零面积与 ≥95% 屏者；padding 16／相邻外扩后 ≤12 合并；截断优先级＝diff 命中＞小面积＞大面积（`detail.truncated`）；显式 `Bbox[]` 原样（按 y,x 排序、idx 1..N）。
> - **公共栅格（D1/D5）**：区域判定在**设备原生栅格** 1:1（局部引擎 `maxEdge`＝crop 尺寸、factor=1，绝不降采样；`minAreaRatio` 分母＝区域裁剪面积）；设计侧按设备倍率渲染（Figma 小数 scale；pen `--export-scale`，`renderScale` 入返回值）或几何比率上采样；越界区域截断记账（单边 <4px 视作不可见，`out-of-bounds` 计数）；v1 只核验视口内。
> - **细节档/降级档（D5/D6）**：默认 0.05/0.0005/4；有损源（JPEG 回退）或设计上采样 → 统一降级 0.1＋`lossy-source`/`design-upscaled` 警告；`DeviceCapture` 增 `lossless` 标记（adb PNG/WDA/simctl＝true；ARTEMIS live JPEG 与回退＝false；step 不设）；Android live 默认**二次无损抓图**（失败回退＋降级）；平台分等：Android adb 无损／iOS 模拟器 idb→simctl PNG／iOS 真机 WDA PNG／step 随执行器。
> - **对图与接口（D4/D7/D8；双通道隔离 D11）**：`device｜design` 并排（zoom 默认 2（1–4）；单侧 ≤640px、总高 ≤1200px、gap 24）；落盘 `diffs/<...>/regions/<idx>-<slug>.png`；内联前 `returnCrops`（默认 8，hasDiff 优先按严重度→面积）；**分页＝回传 `regionDetails[].bbox`**（idx 仅同一响应内有效——live 每次抓图 diff 命中集合会漂移）；`regions:"none"` 严格旧契约（无新键、content=2、零额外请求）；`save:false` 不落盘（crops 省略、内联保留）；dryRun 不变；**整屏通道源/参数/阈值/产物名零改动**。
> - **工作流契约（D9）**：工具描述（`design_device_diff`／`compare_design_and_device`）写入「对比结论必须来自区域级对图核对（引用区域编号）、整屏图仅定位」；属**纪律层**（机制层兜底＝对图默认产出、证据默认落盘、`localSummary` 供引用）；自动评鉴留后续。
> - **口径与边界**：**跨源误报基线未验证（D12）**——同源实证 4/4 召回；跨源（设计渲染 vs 真机渲染）细节档「验证中」，默认放行以真实项目对基线实验为准（备选机制：容差匹配/分层阈值）；`alignment.ignoreRegions` 目前仅作用于整屏通道（区域核验未继承，后续项）；「真机多出·小」「节点外·小」为 v1 声明的盲区（spec §2.5 覆盖边界矩阵）；顺带修正工具描述过期口径（iOS 真机 WDA 早已支持，旧文案「仅 macOS 模拟器」）。
> - 测试 +36（`diff-detail` 18、`diff-detail-tool` 13、`diff-pen-source`＋2、`device-screenshot`＋2、`ios-screenshot`＋1；含终审修复轮补测：C1 可见窗口对齐、out-of-bounds 部分截断记账、PNG 路径 lossless、step 保真档、nodes 截断优先级、S=3 二次渲染/失败降级/参数覆盖）；全量 **1341 绿**。

### 13.119 实施记录（统一服务 ①：`design_to_test` 一条龙 + 脚本退役）

> 实施于 2026-10-17（设计稿 `docs/superpowers/specs/2026-10-17-unified-project-service-design.md`（决策 D2/D3/D4/D10/D14/D15；② 回归＋Excel / ③ Jira / ④ 档案 另出计划）；计划 `docs/superpowers/plans/2026-10-17-design-to-test-tool.md`（5 任务 TDD）；提交 5a14564/83449e3/c0c4508/42d6308 ＋ 本记录）。动机：五步 CR 流程的编排原先做在 **MCP 之外的脚本层**（`scripts/design-to-test.mjs`、aos-call 编队）——工具 schema 被复制到脚本层、已发生两次真实漂移 bug（`penPath` vs `path`、`vision` 字符串 vs boolean），用户还要记旗标/退出码。做法：把编排收进服务内部——新增原生工具 `design_to_test`（前置自检→读设计→懂交互→出用例→校验→可选执行一条龙，内部**复用既有实现而非 shell**），**退役脚本层**。范围＝工具＋`src/workflow/`（setup + 编排）＋`src/figma/gate.ts` 门禁提取＋脚本退役；②③④ 阶段与 `project_archive` 不在本阶段。前置 M2（Figma 20 工具）/M6（pen.dev P1）/`suite check` 闭环（§6.10）已落地。
> - **工具与 schema（`src/tools/native-tools/workflow.ts`，§13.89 域装配）**：`design_to_test`——`figmaUrl`/`penPath` 互斥二选一（`nodeId` 仅 figma、`vision` 仅 pen）、`reuseExistingFlows`、`device`、`run`（**缺省 false**）；缺设计来源且未复用＝isError 用法错误；工具描述内写协议关键句（适用信号「设计稿/CR」、一条龙步骤、needs 协议、`run` 缺省）供唤醒路由。
> - **编排与前置（`src/workflow/`，全依赖注入可离线测）**：`setup.ts` 三类前置——figma token（项目 `.env`/进程 env）、pen 登录（`PEN_CLI_KEY` 短路不触子进程，否则 `pen status`；CLI 缺失/超时/未登录/非零退出分路）、LLM ping（active 条目 ＋ 一次真实 ping，默认超时 15s，**不缓存**、与真实调用分离）；`design-to-test.ts` 串 提取（figma/pen；`reuseExistingFlows:true` 跳过并校验 flows.json 存在）→ `figma_generate_tests` → 门禁 `coverageGateIssue`（§6.10 硬/探索同口径）→（`run:true`）复用 `runGeneratedTests` 执行；**禁止 shell 到 CLI/脚本**（spec 反目标）。
> - **needs 协议与错误面**：预期缺失＝**非 isError** 的结构化返回——`needs:"setup"`（`checks:[SetupNeed]`：target/missing/howTo[/note]）与 `needs:"info"`（`questions`/`context`，如多设备候选）；仅在参数冲突/全缺等用法错误用 isError；单步失败 `{failedStep:"extract"|"generate"|"check"|"run", detail, suggestions}`（人话指引，不裸抛 gate 输出）。
> - **`run` 姿态（D15）**：缺省止于校验，响应 `nextAction={tool:"design_to_test",args:{reuseExistingFlows:true,run:true[,device]}}`；`run:true` 时**执行前写服务日志**（`log()`：将跑 N 条 / 来源 / 设备）并在响应 `steps` 回显 `{step:"run",cases,source,device}`；设备缺省＝自动盘点（0 台→needs-setup(device)、>1 台→needs-info 带候选，先问不猜）；执行走共享批次（quarantine＋批次清单＋运行登记，见下条）；run 失败返回 failedStep:"run"（`report.ok:false`＝0 条提交/执行器不可达，detail 取 `report.error`；用例已执行仅失败仍 ok:true、`run.ok:false`；产物在 `.artemis/design/runs/`、`.artemis/traces/`，重跑安全）。
> - **终审修复轮（共享执行 / 失败语义 / usage / 设备 env）**：`suite run`/`suite loop`/`design_to_test` 共用 `src/figma/suite-batch.ts`（quarantine 加载 → 执行/重试 → 退出码 → 批次清单 → `suite_runs` 登记），CLI 只保留参数解析与展示、行为零回归；manifest `source=design_to_test`，响应 `artifacts.runManifest`，隔离用例不计门禁；执行失败按 `report.ok` 结构化（不再顶层 ok:true）；usage family=`workflow`，并从 payload 提取 `needs:<target>`/`needs:info`/`failed-step:<x>`/`run.gate` 信号；`checkLlm` 记录 model/ms/结果（不落 key、不记参数值）；设备盘点传入合并 env 并逐层透传到 `adb devices` 子进程（`ExecFn`/`ExecBufferFn` 增 `env`，`collectRunnerInventory`/`AdbLogcatCollector` 透传；`ADB_SERVER_SOCKET` 来自 `iosEnvironment()`＋deviceHosts/config/.env，ADR-0011）。
> - **门禁提取（零行为变化；② 阶段打底）**：`coverageGateIssue` 由 `src/suite-command.ts` 原样搬至 `src/figma/gate.ts`（仅加 export），`suite check`/`loop`/`run --fail-on-uncovered` 口径与文案逐字不变（既有测试零回归）。
> - **脚本退役（D11）**：删除 `scripts/design-to-test.mjs` 与 `test/design-to-test.test.js`；`scripts/audit-legacy-tests.mjs` 属运维扫描器**保留**；CI 如需非对话调用改 3 行 stdio 薄壳（另行）。文档同步：AGENTS 表行删除＋「设计流水线」段一句话入口注记、README 工具表新行。
> - 测试 +37（`figma-gate` 4 / `workflow-setup` 16 / `workflow-design-to-test` 14 / `native-workflow-tool` 3），脚本退役 −8（`design-to-test.test.js` 随脚本删除）；全量 **1381 绿**。

### 13.120 实施记录（统一服务 ②：`run_regression` 回归一条龙 + Excel 用例导入）

> 实施于 2026-10-17（设计稿 `docs/superpowers/specs/2026-10-17-unified-project-service-design.md`（决策 D5/D5b/D6/D12/D15/D16；③ Jira / ④ 档案 另出计划）；计划 `docs/superpowers/plans/2026-10-17-regression-run-excel-import.md`（6 任务 TDD）；提交 544980c/ca6f6ea/10dcc8d/a0ece67/eade94a ＋ 本记录）。动机：回归入口此前只有 CLI 旗标（`suite run --task/--tests`），Excel 测试文档进不了用例库（不进最新份解析/报告/证据），用户要在"文档→用例→设备→报告"之间手工搬。做法：新增原生工具 `run_regression` 与导入器，把选择/回显/执行/聚合收进服务内部（复用 `executeSuiteBatch`，禁止 shell）。
> - **门禁分档（`src/figma/gate.ts`）**：`coverageGateIssue` 拆为可组合的 `artifactGateIssue`（三件套）＋`dataPolicyGateIssue`（【真实数据】）＋私有 coverage 段，组合后文案/顺序逐字不变；`isImportedTestsFile` 读 `meta.source` 前缀 `imported:`；`gateIssueForTests` 按来源选闸——导入集只走 artifacts+dataPolicy（覆盖闸 n/a），生成集走完整三闸；`suite check`（输出 `覆盖: n/a (imported)`、JSON 增 `imported`）、`suite loop`、`suite run --fail-on-uncovered` 三面共用（生成集零回归）。
> - **xlsx 读取（`src/workflow/excel.ts`）**：复用**既有运行时依赖** exceljs（`package.json` 已在用，非新增——D6 的"最小内建优先"按此裁决：手写 zip/XML 风险更高）；fail-loud：非 `.xlsx`、损坏、合并单元格（列出范围）、空表头、维度异常（>10000 行/200 列）均显式失败＋转换指引；cell 归一（字符串/富文本/数字/布尔/公式结果）；尾部空行裁剪。
> - **导入器（`src/workflow/excel-import.ts`）**：列名别名自动识别（用例名/标题、步骤/操作、预期、前置、模块，中英）＋`columns` 覆盖；必填（用例名+步骤）缺失列出当前表头；按模块拆集（缺省＝文件 stem），每集三件套落 `.artemis/design/case-sets/`（JSON `{meta:{…},source,features:[{key,name,screens}],counts,flows}`（对齐生成归档，供 `suite backfill` 重建）、md 清单、xlsx 复用 `renderTestsWorkbook`），源文件副本**仅一份** `<UTCstamp>_<源文件>.source.xlsx`；caseId=`imp-<sha8(文件内容)>-<行号>`（名称冻结）；`taskDesc` 注入 `REAL_DATA_CLAUSE`；步骤口径：有预期→`执行「…」，应出现「…」`（assert；preflight 弱断言豁免判据"含应"），无预期→`探索：…`（expectations kind=explore）；登记每导入一条记录（多 features），`source=imported:<文件名>@<sha8>`、fingerprint=导入内容 sha256、designName=null；**功能身份稳定**：`featureKey=imp-<文档slug>[-<模块slug>]`（**不含内容哈希**——同名文档视为同一份演进，最新份按 key 去重取代旧版；sha 只在 source/fingerprint/caseId）；**幂等**：库内 source 命中→`skipped` 指向既有份（登记不可用时回退扫描归档 `meta.source`）；**失败回滚**：归档/源副本/登记任一步失败均删除本次已写文件后再报错（避免“归档在、登记无”被后续导入当成 skipped）。导入集**不参与**生成集的功能身份继承（`loadPriorFeatures` 过滤 `source` 前缀 `imported:`）。
> - **编排（`src/workflow/run-regression.ts`）**：`RunRegressionArgs {excelPath?,scope?,all?,device?}`；前置 `checkLlm`＋设备解析（`src/workflow/devices.ts`，自 `design_to_test` 抽出：0 台→needs-setup(device)、>1 台→needs-info 候选；**先于导入/选择**，避免"导完才发现没设备"）；选择三模式——`excelPath`（导入/幂等复用后执行，`scope` 时集内按用例名过滤并透传 `caseIds`）、`scope`（库内每个 feature 最新份，功能名或用例名归一化 NFKC/大小写/空白匹配）、`all`/缺省（每个 feature 最新份全量）；回显（`steps[select].targets`：功能×条数＋`导入自 x/生成自 y`）并写服务日志后才执行；逐集 `executeSuiteBatch({options:{testsPath,caseIds?,deviceSerial},source:"run_regression",registration:{platform}})`（quarantine＋批次清单＋`suite_runs` 登记；manifest source 增 `run_regression`）；聚合 `run{device,sets,total,executed,passed,failed,gate,traceIds}` 与 `artifacts.sets[].manifestPath`；任一集 `report.ok:false`→顶层 `failedStep:"run"`（detail 取 report.error），用例失败已执行仍 `ok:true`、`run.gate` 反映；用法错误（excelPath/scope 与 all 同用）isError。
> - **usage（D12）**：family=`workflow`；payload 根字段 `import:{outcome:imported|skipped|invalid}`、`scope:{hits}` → 信号 `import.outcome`/`scope.match`（只取枚举/根字段，不读参数值）。
> - **收尾硬化（① 延后 Minor）**：`design_to_test` 生成 0 条用例→`failedStep:"generate"`（不再静默 ok）；needs 措辞同步 `checks[]`（工具描述/README）。
> - 测试新增 29（`figma-gate`/`suite-command` 分档与 loop/run 口径、`workflow-excel` 5、`workflow-excel-import` 7、`workflow-run-regression` 11、`figma-case-sets-gen` 1、`suite-backfill` 1、`native-workflow-tool` 3、`usage-capture` 1、`workflow-design-to-test` 1 等）＋终审修复波 7（稳定功能身份/登记回滚/生成身份隔离/backfill 归档形状/loop·run 分档/columns 暴露）；全量 **1431 绿**。

### 13.121 实施记录（统一服务 ③：`verify_jira_issue` Jira 验证一条龙）

> 实施于 2026-10-18（设计稿 `docs/superpowers/specs/2026-10-17-unified-project-service-design.md`（决策 D8/D8b/D9/D12/D13/D15；④ 档案另出计划）；计划 `docs/superpowers/plans/2026-10-18-verify-jira-issue.md`（8 任务 TDD）；提交 6573be1/7df2626/252cbc7/b2eeee2/2d12337/5dacb97/fb553a1/bf48896/f4f9486 ＋ 本记录）。动机：Jira 验证此前只有散件（`jira_issue_get` ＋ 手工连用例 ＋ `jira_evidence_post`），"单子→用例→设备→回写"没有闭环；本工具把 读单/分档/映射/合成/执行/聚合/回写 收进服务内部（复用 `executeSuiteBatch`，禁止 shell）。
> - **共享选择原语（`src/workflow/case-selection.ts`）**：`run_regression` 私有助手迁出复用（`normalizeKeyword`/`containsKeyword`/`provenanceOf`/`latestFeatures`/`selectByScope`）＋新增 `readCaseSummaries`（现场读用例清单 id/name，坏文件→[]）；`run_regression` 改 import，行为零回归。
> - **前置（`src/workflow/setup.ts`）**：`checkJira`（`needs-setup target:"jira"`，missing 取 `jiraConfig().missing`，howTo 指向 `aos_configure`/`.env` 三键）；顺序：Jira 凭证（不触网）→ 读单 GET → 分档（粗单→needs-info，先于 LLM/设备）→ LLM ping → 设备盘点 → 选择/映射；Jira GET 失败→`failedStep:"ticket"`。
> - **分档与合成（`src/workflow/jira-issue.ts`）**：AC 段／≥2 列表项／≥120 非空白字符→`detailed`；否则 `coarse`→`needs-info` 三条提问模板（功能页面、触发条件、期望结果）。步骤提取 `issueStepItems`（ADF 列表有序/无序/嵌套展平）；「单子即用例」合成：预期分隔 `(?:预期(?:结果)?|期望(?:结果)?|应该|应当|应出现|应显示)[：:，,]` → `执行「…」，应出现「…」`（assert）/否则 `探索：…`（explore），taskDesc 注入 `REAL_DATA_CLAUSE`＋工单号；落盘 `.artemis/design/jira/<KEY>.tests.json`（覆盖式；**不进 `case-sets/`**——避免 `suite backfill` 误登记）。
> - **约束映射（`src/workflow/jira-mapping.ts`）**：LLM 只能从候选清单选 id（交集过滤编造项、保序去重、≤10 条），候选 ≤400 条（超限注明"已达上限"）；答无匹配→"单子即用例"；LLM 调用/JSON 失败→`failedStep:"mapping"`（不静默降级）；复验把上次评论「映射用例: …」行作为上下文传入（无新增存储，D13）；`scope` 给定时直接按关键词选（不调映射 LLM）。
> - **聚合与回写（`src/workflow/verify-jira.ts`）**：分类＝`report.preflight.weakCases`（weak）／`scriptProvenance`（null→weak、`asserts===0`→explore）；**任一强断言失败→FAIL**；强断言 0 条→`inconclusive`（"无强断言"文案）；强断言未失败但弱/探索失败→`inconclusive`（"弱断言失败 N 条"文案）——均披露"弱断言仅记录路径，不代表验证通过"；quarantine 失败不计门禁。回写（`dryRun` 零写回（不产生任何外部副作用；读单/评论读取不变）＋结论预览）：失败证据 `postEvidenceToIssue`（trace 幂等，≤10 条＋`evidenceTruncated`）＋结论评论 `upsertMarkedComment`（marker `AOS-VERIFY:<KEY>`、评论属性 `aos-verify`，同单更新不刷屏；`src/jira/comments.ts` 从 trace 专用泛化为通用 marker，trace 委派行为不变）＋`jira_issue_key` 关联（`setCaseIssueKey`，best-effort）；**不写 verdict**（D9）；manifest source 增 `verify_jira_issue`。复验读回上次「映射用例」行作映射上下文（`buildVerifyComment` 输出 → `adfToText` → `parseVerifyMapping` 闭环，bullet 前缀容错）。
> - **usage（D12）**：family=`workflow`；根字段信号 `ticket.detailTier`（detailed|coarse）、`mapping.selected`(N)/`mapping.none`（答没有时 `mapping:{selected:0}`）、`writeback`(sent|dryRun)。
> - 测试新增 43（`workflow-case-selection` 5、`workflow-setup` 2、`jira-comments` 3、`jira-verify-comment` 5、`workflow-jira-issue` 5、`workflow-jira-mapping` 5、`workflow-verify-jira` 14、`native-workflow-tool` 3、`usage-capture` 1）；终审修复波 +2（映射行 bullet 前缀回读闭环、inconclusive 成因文案分述）；全量 **1476 绿**。

### 13.122 实施记录（统一服务 ④：`project_archive` 项目档案只读摘要）

> 实施于 2026-10-18（设计稿 `docs/superpowers/specs/2026-10-17-unified-project-service-design.md`（决策 D7/D14；§7 `project_archive {}`）；计划 `docs/superpowers/plans/2026-10-18-project-archive.md`（4 任务 TDD；外部评审 10 条已吸收：store 静默降级/activeEntry 守卫/jiraKeys 口径 等）；提交 ca2d555/70a13d8/77e6ca4/ce93499/07aa045 ＋ 本记录）。动机：统一服务四阶段收尾——三流程工具（design_to_test/run_regression/verify_jira_issue）之外的只读档案面，一处回答"这项目现在有什么、跑过什么、缺什么"。至此统一服务 spec 范围（①设计→测试 ②回归＋Excel ③Jira 验证 ④档案）全部落地。
> - **静态就绪探针（`src/workflow/readiness.ts`）**：figma（`checkFigma`）/pen（`penEnvFrom`＋`resolvePenCliPath` 四态：key／env 路径／托管／PATH 兜底判 not ready）/jira（`jiraConfig`，email masked）/llm（`activeEntry` 包 try/catch——条目可落 PG，异常降级不炸整包；key masked）；每项显式 `verified:false`（「未复核」，D14）；不 ping、不 `pen status`、不触网、无子进程。
> - **档案装配（`src/workflow/project-archive.ts`）**：payload 六段——项目与栈（`detectProjectStacks`）／设计血统（`flows.json` 来源·mtime·屏/边/入口/未决数·provenance 构成：六值（含 legacy-unknown））／用例库（每 feature.key 首见最新份：`provenanceOf` 来源文案＋createdAt；`truncated` 披露 200 窗口）／最近运行（近 10 批 `run-*` 清单：source/时间/计数/gate/exitCode/失败域；窗口内不可用件计 `unreadable`）／裁决与 Jira（`collectVerdictExits` 三组计数＋`jiraKeys` **独立扫全部 cases** 的去重非空 `jira_issue_key`——覆盖 verify_jira_issue 的 D9 自动关联，无 verdict 亦可见）／前置状态。
> - **只读与降级**：不触网/无子进程/不写盘（测试：禁网＋目录快照）；恒 `ok:true`；**PG 不可用时 store 静默切换内存实现——以 `runtime.store.kind !== "postgres"` 探测（先例 `suite-command.ts`）并在 `degraded[]` 明示**；`degraded` 顺序：内存提示→flows 坏件→用例库降级→裁决降级→readiness.degraded。
> - **usage**：family=`workflow`（不新增信号，D12 未列；`degraded` 非空计数事件留待下轮）。
> - 测试新增 18（`workflow-readiness` 5、`workflow-project-archive` 10（含内存降级/口径交叉锁定/只读快照）、`native-workflow-tool` 2、`usage-capture` 1）；全量 **1494 绿**。

### 13.123 实施记录（统一服务 ⑤：收尾补齐——usage 事件三项＋接入指南＋精选硬化）

> 实施于 2026-10-18（完整性核查驱动；计划 `docs/superpowers/plans/2026-10-18-unified-service-closure.md`（6 任务 TDD）；提交 2f3cb3a/514170b/14b18fc/0fbe83f/96c291b/29a7460 ＋ 本记录）。动机：四阶段落地后按 spec 逐条核查发现 D12/§9 三个最小事件未落、接入指南未随统一服务更新；同时清掉 ③/④ 延续的精选 Minor。
> - **needsInfo.category（D12）**：`NeedsInfoCategory` 五值（`device-ambiguous`/`no-flows`/`scope-no-hit`/`library-empty`/`ticket-coarse`）入 `setup.ts`；`DevicePick` info 变体收紧、三工具 needs-info payload 增根 `category`；usage 信号 `needs:info.category`（紧随 `needs:info`）。
> - **needsSetup.missing[]（D12）**：usage 逐条信号 `needs:<target>.missing`（在全部 `needs:<target>` 之后、按 checks 顺序；无 missing 零新增）。
> - **各步耗时（D12）**：三工具统一 `recordStep`（`steps[].ms`＝距上一步的实测间隔），`run` 步执行完成后回填执行耗时；usage 信号 `step-ms:<step>`（`run.gate` 之后按 steps 顺序）。**中断点**沿用 `failed-step:<step>`。
> - **接入指南**：新增 §2.11「统一服务四入口」（四工具/needs 协议＋category/usage 信号清单/复用执行链）；版本行刷新（1502 用例）。
> - **精选硬化**：`project-archive` 清单校验（`usableManifest`：runId/source/起止时间/summary 三数/gate result+exitCode/failureDomains——不完整 ok 件改判 `unreadable`，替代原 try/catch 掩蔽）；`verify_jira_issue` 候选用例文件不可读经 `deps.log` WARN 且不阻断、dryRun 预览补 `evidenceTruncated`（与发送路径同式）；dryRun 文案统一「零写回/不产生外部副作用」；README/DESIGN 文案两处。
> - 未做（留档）：顶层 catch（假空载荷风险，per-path 已守）、读评论单遍、空 runs 原因提示。
> - 测试新增 8（T1 usage 1＋run 2、T2 usage 1、T3 usage 1、T5 archive 2＋verify 2）；全量 **1502 绿**。

### 13.124 实施记录（接入与下发加固 ⑥：CLI help 短路＋下发窗口假阴性修复＋接入文档三补）

> 实施于 2026-10-18（依据：接入/下发可用性评审（B1/B2，B2 三复现实测变红）＋外部评审修订；计划 `docs/superpowers/plans/2026-10-18-onboarding-dispatch-hardening.md`（4 任务 TDD）；提交 32bc772/c36cb24/396ded9/9cbc530/2146bf0 ＋ 本记录）。动机：`--help` 会实际执行命令（`suite run` 真跑机、`serve` 起常驻、`init` 写文件）；"50 份窗口"被用于正确性路径导致**假报不可用**（task create 未知 key／run --task 引用均不可用／resolveRunRefs 归因丢失；runner 经同一路径重试后置 failed）。
> - **help 短路（B1）**：`cli.ts` 顶部统一守卫（`suite`→suite 用法、其余→全局用法；jira 委托自身守卫）+`runSuiteCommand`/`runJiraCommand` 库级守卫；**`--help/-h` 优先于一切校验**（含拼写错误子命令）；修复裸 `jira --help`（原 exit 2）；零副作用经 spawn 实测（init 不写文件、suite run 不执行、runner 不启动、serve 不常驻）。
> - **下发窗口修复（B2）**：口径＝**正确性/触发路径按全量读取，展示路径显式分页**（`db/types.ts` listCaseSets 注释）。**Step 0 全枚举分类**后改全量十处：`suite task create`／`run --task`／`schedule add`／`task show`、`resolveRunRefs`、`panel/actions` 建单校验、`test-gen` 身份继承、`run-report` 名称解析、`run-regression`/`verify-jira` 默认读取（原 200 窗口）。保留并记录理由：`excel-import` 200（文件扫描兜底）、`project-archive` 200＋`truncated` 披露、`schedules`/`backfill`/`compare` 已全量、`panel/overview` 展示窗口。
> - **接入文档三补**：README/接入指南——项目机 runner **常驻化**（systemd/launchd 最小示例＋勿双开/中心 PG/产物令牌注意）、`aos-mcp init` 脚手架引用（§3.2）、**Excel 入料最小样例表**；文档提法逐一 `grep src/` 核对消费点（`AOS_RUNNER_ARTIFACT_TOKEN` 实装 `src/runner/artifact-server.ts:116`，DESIGN §13.113）。
> - 未做（留档）：主 help 的 suite 行扩展、`suite task list` 的 runner 覆盖提示、`install` 的 dist 存在校验、`listCaseSets` PG `DISTINCT ON` 下推、task create 可用列表 cap、usage/panel 命令专属帮助文案、`-h` 作 flag 值 quirk。
> - 测试新增 27（`cli-help` 15、`suite-command` 6、`jira-cli` 1、`panel-actions` 1、`run-registry` 1、`figma-case-sets-gen` 1、`workflow-run-regression` 1、`workflow-verify-jira` 1）；全量 **1530 绿**。

### 13.125 实施记录（记录底座 ①：强制持久＋审计事件＋文件台账装配）

> 实施于 2026-10-18（依据：`PRODUCT.md`「记录即产品」＋外部评审修订；计划 `docs/superpowers/plans/2026-10-18-data-foundation.md`（v2）；任务 1–3 已落地，任务 4–7 见后续记录）。动机：未配 PG 时"会话内存即弃"使接入与产出无留存；记录必须默认持久（**结果/过程/数据**三类）。
> - **T1 审计接口**：`ProjectStore.recordAudit/listAudit`（Memory/PG 双实现，PG 表 `audit_events`：TEXT 时间戳＋`refs` JSON 文本，对齐 pg-mem 先例）；`kind` 联合扩 `"file"`（17 处行为位分类见下）。
> - **T2 FileStore（`.artemis/ledger/`）**：`state.json`（原子 tmp+rename 快照，**写侧剥离 `apiKey`/`figmaToken`**）＋`usage.jsonl`/`audit.jsonl`（追加＋保留裁剪：usage 沿既有策略、audit **90 天/5 万条**；裁剪重写走原子写并先与磁盘并集）＋`journal.jsonl`（写操作取证行，**不承诺回放**）＋home `registry.jsonl`（跨进程项目索引）。**合并写**：每次读取/写前重读磁盘并合并——**同 id 冲突磁盘胜**（本地仅保留未落盘的少数记录），真并发窗口＝同步与落盘之间（毫秒级）；跨写者存活性与"更新不被陈旧写者回滚"均有测试锁定。运行期写失败经 `FileStore.writeErrors()` 暴露（`aos_status` 可见）。
> - **T3 装配与自愈**：`createProjectStore` ＝ **PG → 文件台账 → 会话内存（仅最后兜底，`degraded=true`）**；PG 故障期 reason 明示"历史不自动回流"。**凭证回落**：`withEnvKeyFallback`（store 条目 key 为空时按 provider 约定→`AOS_LLM_API_KEY`/`DEEPSEEK_API_KEY`/`OPENAI_API_KEY` 从项目 `.env`/进程 env 回填；面板可用性判定同式）。**用例集自愈**：`.artemis/design/case-sets/*.json` 首载幂等登记（按 jsonPath；≤200 份，超出记 `registry/hydrate.capped` 交由 `suite backfill`）；登记前确保项目已注册；屏集取归档 `features[0].screens`（缺省回退用例覆盖并集；2026-10-19 修订见 §13.131）。
> - **守卫再决策**：runner 仍 **PG-only**（文案改"文件台账不支持多进程"）；`suite backfill` **放行 file、仅拒 memory**；`project-archive` 仅对 memory 判降级。
> - **面板解析**：`resolveProjectKey` 改为**工作区优先**（byPath → 工作区绝对路径 → 工作区名字 → 注册表名字＋存在性守卫）——持久注册表下防跨工作区串台（http 面板深探回归实证）。
> - 测试新增 16（`db-audit` 3、`db-file` 9、`db-default` 4＋守卫 1＋env 回落 2 −重复）；全量 **1551 绿**。
> - **T4–T7 补记（同日第二轮）**：内部编排审计接线六点（suite/import/schedule/panel/verify/issues；`recordAuditSafe` best-effort 不阻断主流程）＋ `test/audit-wiring`；产物索引 `src/artifacts/`（六族与 retention 同源、浅扫、目录项 size 0）；三口径导出 `src/export/`＋CLI `export`（JSON/CSV；文件台账项目 process 非空有测试）；全表面如实文案整改（`src/db/labels.ts` 统一标签：PostgreSQL／文件台账（.artemis/ledger）／会话内存（仅本次进程，数据不持久）；doctor 缺 PG 改 OK 级说明；`test/copy-gate` 防回归）。全量 **1562 绿**。

### 13.126 实施记录（Web 控制台：CSDC 原地升级＋下发闭环）

> 实施于 2026-10-18（依据 `docs/superpowers/specs/2026-10-18-web-console-shape.md`；计划 `docs/superpowers/plans/2026-10-18-web-console-csdc.md` Task 1–9）。动机：面板/看板从"只读记录展示"升级为**可操作控制台**（CSDC 风格基准＋下发任务闭环）。
> - **视觉层**：`src/console/tokens.ts`（CSDC 唯一 CSS 变量源＋组件样式）／`shell.ts`（毛玻璃顶栏＋分区导航＋焦点可见＋窄屏媒体查询；`USAGE_STANDALONE_NAV` 子集）／`components.ts`（7 件组件，**表格双通道**：数据走 `rowsText` 自动转义）；对比度口径：正文灰 `#6E6E73`、`#86868B` 仅装饰；两处 AA 偏差记录（link-hover 采用 `#0066CC`；遗留 PAGE_CSS `#888`→`#6E6E73`）。
> - **页面**：总览（CSDC 表/徽章）、项目页**一屏三问**（健康/在跑什么/待执行/下一步＋下发入口）、对比、任务（状态徽章＋**释放重跑只读预览**）、运行机（在线/失联徽章）、统计（并入外壳）、**下发向导**（`?section=dispatch` 四步＋预览回显，派发禁用待动作层）、用例库/档案与产物/审计/运维与数据（`?section=library|archive|audit|ops`，消费 artifacts/audit/export）；遗留页统一套壳（`page()` 走 shell）。
> - **动作层（`/panel/api/*`）**：新增 release／schedules CRUD／quarantine（owner 签字）／export（POST＋GET 下载）／import（multipart 上传：Node `Response.formData`、20MB、单飞、临时文件必清、路径变体）；**同源校验**（`Sec-Fetch-Site`/`X-AOS-Console`，cross-site 403）＋Host 白名单（独立进程）；独立 `panel --web` 在 `AOS_PANEL_ACTIONS=1` 且 loopback 时开放动作层；全部写动作落审计。
> - **收尾**：`scripts/console-fixtures.mjs` 生成 7 页 fixtures → **impeccable detect 0 anti-patterns**（修 h1→h3 跳级、遗留对比度、hover 色）；a11y 结构测试（唯一 h1/表格语义/焦点/刷新纪律）。
> - 测试新增 ~30（shell/components/dispatch/pages/a11y/guard-upload/console-actions）；全量 **1597 绿**。
> - 未做（留档）：暗色主题；usage 独立进程并入主导航（暂用子集）；impeccable critique/polish 未跑；分页与导出落盘（大项目）。
> - **评审修复轮（c510554）**：C1 下发页份名转义（`rows` 通道存储型 XSS，回归测试锁）；C2 独立进程动作门改**显式 `AOS_PANEL_ACTIONS=1`**（与 README/DESIGN 文档对齐，测试锁）；I2 守卫补 **Origin↔Host 一致性**（无 Sec-Fetch-Site 的老浏览器跨站拒）；I1 部分接线：**下发向导「确认派发」**与**任务「释放重跑」**已走同源 fetch（带确认/`X-AOS-Console` 头/成功跳转；关键词模式按匹配份展开 refs）；计划/隔离/导入的表单提交留 CLI/API 指引（明示不承诺）；I4 项目页去掉整页刷新（刷新纪律，含表单页零刷新，测试翻转）；I5 遗留 `renderTable` 补 `scope="col"`、`page()` 去嵌套 `<main>`、usage 遗留灰与警示色 AA 修正；M2 上传临时文件名改**内容哈希**（导入溯源与同内容幂等）、M4 隔离/导入成功清缓存。detect 保持 **0**；全量 **1600 绿**。
> - **impeccable critique→polish 轮（2026-10-18）**：双路评估（设计评审＋检测证据）首评 **16/40**，已按用户选择完成 **P0+P1 全修**：① 导航项目上下文＋真实版块路由（`tasks/runners/schedules` 锚点、`aria-current` 逐页正确、统计按进程能力渲染、无项目时项目级项禁用）；② **能力标记**（`data-console` 页级横幅＋写 CTA 禁用＋可见原因；HTTP 模式自动隐藏）；③ **派发两段确认**（隐藏摘要→确认创建）＋ **refs 服务端重解析**（`source/ref/keyword`，不信渲染期快照）＋移除 Excel 死选项与设备手输＋默认端单选；④ **单一样式源**：`console/compat.ts` 并入（去 legacy 覆盖/去 `color-scheme:light dark`/链接色统一/危险色 `#B91C1C`/`#2563eb` 清零）；⑤ AA 与可访问名（`aria-label` 全覆盖筛选与下发字段、跳链、`role="alert"` 内联错误区）；⑥ 派发回执（任务 id＋审计互链）、失败不再 `alert`。**detect 0**（1 条 em-dash advisory 已复核为误报）；全量 **1603 绿**。
> - **该轮留档（P2/后续）**：检索闭环（份行内动作/产物可点/审计分页与时间预设/空态动作）；键盘快捷键（`/`、`g`、`?`）；legacy 异步结果区 `aria-live`；`meta refresh` 的 reduced-motion 豁免；`cConfirmForm`/`cEmpty` 死组件（接线或删除）；暗色主题；usage 页并入 a11y 扫描面。
> - **P2 第一批（2026-10-18 追加）**：**产物可点**（`GET /panel/artifact` 只读服务：`.artemis` 范围＋白名单类型＋拒绝穿越，两进程接线，含路由测试；档案页行内链接）；**审计分页＋时间预设**（`AuditQuery.offset` 贯通 Memory/PG；页内 24h/7d/30d 预设与上/下页）；**用例库行内「下发该份」**（预填 `dispatch?source=case-set&ref=`）；**空态动作**（总览零项目改 `cEmpty` 并给接入指引）；`regression/verdict/issues` 三处异步状态补 `role="status"`；**死组件处理**：删除 `cConfirmForm`（两段确认已取代）、`cEmpty` 接线。全量 **1604 绿**。
> - **P2 第二批（2026-10-18 追加）**：**键盘快捷键**（`?` 帮助面板／`/` 聚焦筛选／`g`+字母跳转，导航目标按能力与项目上下文生成）；**`prefers-reduced-motion` 豁免整页刷新**（前端移除 meta refresh）；**计划区块控制台表单**（创建/启停/删除，含能力关闭禁用与原因）；**用例库补齐**：Excel **上传导入**（multipart，失败内联回报）＋**隔离加入/移除表单**（owner 签字；空态从"动作层 add 后生成"改为真实入口）。全量 **1605 绿**（+1 用例）。
> - **critique 二评（25/40，↑9）修复轮**：P0 项目页主 CTA 携带 project（修复"回总览"回归）；派发摘要**点击时按表单现值重建**＋端为空前置校验＋选项 `data-count`；建单加前置确认（外部副作用）；**flash 回执体系**（sessionStorage→跟随页横幅＋（查看审计）链接）覆盖裁决/计划/隔离/导入/释放/建单；导航口径修正（"使用统计"改名、review/stats/batch 不再错标高亮、`/` 覆盖 usage 工具框、禁用导航项可聚焦＋aria-label）；a11y 补强（7 处表格 caption、ref 复选框可访问名、悬空 label 修正）；内联 href 全量转义（`&amp;`）。二评留档：常驻记录底座指示器、批量汇总条/全选、可点"在跑什么"、术语/原始枚举清理、建单默认值回显、/usage 组件收敛、释放后果说明。
> - **确认与后果轮（2026-10-18 第三批，二评后用户选定）**：① **顶栏记录底座指示器**（`storeHealth`：持久层＋最近写入时间＋写失败计数，链接运维页；panel 系全页由 `loadStoreHealth` 注入，usage 侧保留自徽章）；② **释放后果确认**（`data-confirm` 含领取方/在线态/已完成子运行数/可能被重新领取；失败改内联 `role="alert"` 不再 alert）；③ **建单强闸门**（默认值按项目 env 回显为 value；必须先「预览」才可建单＋二次 confirm；按钮明示"外部副作用"）；④ 派发确认支持 **Esc 关闭＋焦点到主按钮**；`?` 面板 Esc 关闭。全量 **1606 绿**。
> - **批量与对象轮（2026-10-18 第四批）**：归因队列与建单表补**批量工具栏**（全选/清空＋"已选 N 条"实时计数）；项目页"在跑什么/待领取"改为**可点任务对象**（前 3 个，直达任务页）。全量 **1606 绿**。
> - **术语与文案轮（2026-10-18 第五批）**：`?` 帮助面板增**术语表**（份/裁决/失败域/基线/执行机/隔离/记录底座就地定义）；原始枚举与内部词清理——`深探信息`→运行时细节、`对账资产`→对账信息、`份血统`→用例集份（口径句改人话）、`分类原版 vN`→分类口径、`宿主 deps：ready`→服务依赖：就绪、`setup_required`/`exit 2 · suite-not-executed` 文案人话化（代码标识保留于括号）；审计结果徽章/筛选改中文（值不变）；"runner/项目机"统一为**执行机**（首现带英文）；记录底座指示器加 title（最近写入/失败计数口径）。全量 **1606 绿**。
> - **剩余留档收敛轮（2026-10-18 第六批）**：① **/usage 并入 CSDC 组件**（徽章→`cBadge`、指标卡→`cStat`、全部表格补 `th scope`＋`caption`，纯值转义口径保留）；② **暗色主题**（`:root[data-theme="dark"]` token 映射：apple 深色面色/文本/边框/语义色、accent 黄保持且黄底强制深字、链接 `#4DA3FF`、UA `color-scheme:dark`；shell 脚本按系统偏好设置属性并监听变化——**不用媒体查询包 token**，避免静态检测器把暗色变量当全局导致黄底对比误判）；③ **存储口径同源断言**（ops 页对 memory 台账显示 `coherentStoreNote` 兜底，杜绝"内存 badge＋文件台账说明"矛盾态，测试锁）；④ **档案页**：`since` 暴露＋24h/7d/30d 预设＋**索引 CSV 导出**（`/panel/artifact?format=csv`，含筛选）。全量 **1607 绿**；detect 0。
> - **全局搜索（2026-10-18 第七批）**：顶栏 `role="search"` 搜索框（`/` 聚焦，提交 `?section=search&q=`）；结果页跨项目分组——项目（名/路径）、用例集份（份名/来源/功能，带"下发该份"）、任务（id/状态，直达任务页）；上限 50 项目×各 20 条与"结果已截断"标注；`/panel.json` 增 `view:"search"`。全量 **1608 绿**；detect 0。
> - **三评与驾驶舱轮（2026-10-18 第八批）**：三评 dual-agent **18/40**（新评审重 IA 与实机一致性；B 路首次真浏览器（Edge）证据抓到 `flashScript` 多余 `}` 自伤——已修 `f85b8d8`＋内联脚本解析回归闸）。按裁决执行：① **驾驶舱与项目导航**——项目页重排为 结论（批次/趋势）→ 在跑/待办 → 运行机/计划 → 新建回归（CTA）→ 折叠「环境自查与明细」（接入自检/运行时细节/磁盘资产/独立运行）；导航新增**「项目」**一级项（`active=project`，`g j`），任务锚点改指 `#tasks`；顶栏**项目切换器**（最近 20 项目；`setConsoleShellDefaults` 单请求注入，总览/项目/任务/批次及各版块页统一，消除逐页穿参）；空批次不再显「0/0 未通过」而显「未执行（无用例）」；H1 灯具喇叭改「点＋`sr-only` 状态播报」、文案改 健康/需关注/阻断/未知（消除「黄 AOS-ARTEMIS」读法）。② **派发唯一真相**——删除项目页内嵌表单，只保留下发向导（预填跳转）；顺带修复 `aosBindBulk` 仅存在于项目页脚本、裁决/建单页批量按钮从未生效的自伤（`bulkBindScript` 注入各表单页脚本＋「项目/裁决页内联脚本可解析」回归闸）。③ **证据链全链可点**——批次用例证据→`/panel/artifact` 链接（`artifactHref` 相对化 project 前缀；已清理仍标注）；档案分页（`offset`、每页 50、上一页/下一页）＋图片缩略图（`c-thumb`）＋文件链接新窗。④ 占位符对比度（`::placeholder` 亮 `#6E6E73`/暗 `#AEAEB2`，Edge 实测 2.5–3.0:1 → AA）。全量 **1612 绿**；lint 0；静态 detect 0；Edge 浏览器模式 script-error 0（残留 nested-cards/gray-on-color 为已复核误报）。
> - **只读一致与无障碍收口轮（2026-10-18 第九批，三评 P2 清零）**：① **能力全页同源**——`capabilities` 并入 `setConsoleShellDefaults`，archive/audit/search 等此前未传能力的页面获得真实能力态（只读横幅不再断档；standalone 下 `/usage` 导航按能力禁用而非 404 死链）；② **禁用导航不可聚焦**——去 `tabindex="0"`（保留 `role="link"`＋`aria-disabled` 供播报），键盘 Tab 不再穿过不可激活项；③ **行选择可访问名**——裁决/建单行 checkbox 带用例上下文 `aria-label`；④ **组语义**——裁决、来源、目标端、计划端组均 `<fieldset class="c-fieldset">`＋`<legend>`；⑤ **`:disabled` 可见**（`opacity .55`＋`not-allowed`）；⑥ **窄屏表格**——`cTable`/`renderTable` 统一 `.c-table-wrap{overflow-x:auto}`（消除整页横向溢出）；⑦ **整页刷新→局部轮询**——`autoRefreshSeconds` 不再渲染 `meta refresh`，改为轮询 `fetch(location.href)` 就地替换 `#console-main`（三守护：`document.hidden`、焦点在主内容内、`prefers-reduced-motion` 不启动），活动任务页与 `/usage?refresh=` 同机制（键盘焦点/滚动不丢）。全量 **1613 绿**；lint 0；静态 detect 0；Edge 浏览器模式 0 low-contrast（仅序列误报）。
> - **四评与真问题修正轮（2026-10-18 第十批）**：四评 dual-agent **23/40**（趋势 16→25→18→23）。A 侧：特异性"偏为本项目而作但交互层仍可迁移"，四个 P1 留档（下发预览与确认不同源/健康灯把可选配置当项目健康/建单预览可绕过且结果被 reload 抹掉/运行中可"释放重跑"）→ 待裁决。B 侧（Edge 真浏览器）确认第九批多数收口，**纠正一处我方过度声明**：390px 窄屏仍整页横向溢出（顶栏不换行、列向布局 `align-items:flex-start` 使主区被内容撑宽、`.c-button` 为 inline 导致换行重叠）——已修：≤960 断点顶栏换行＋搜索独占行＋`.c-layout{align-items:stretch}`＋主区/card/表格容器收宽＋`.c-button{display:inline-block}`＋`.c-main code{overflow-wrap:anywhere}`；移动视口复扫 **0 body-text-viewport-edge / 0 text-occlusion / project 页 0 条**。其余真阳性修正：`#regression` 双框（遗留全局 `section{border}` → `section:not(.c-plain)`＋CTA 区块 `c-plain`）；`input/select/textarea:disabled` 纳入禁用样式；用例库"按份下发"裸 `&` 补 `escapeHtml`；独立 `/usage` 死链（`brandHref:"/usage"`＋`hideSearch`）；遗留 `renderTable` 补 `caption`（批次/运行机/任务引用/跨端/应用缺陷/执行偏差）。全量 **1615 绿**；lint 0；静态 detect 0；Edge 移动视口仅剩已复核误报（nested-cards/gray-on-color）。
> - **下发合同化（2026-10-19 第十一批，四评裁决执行）**：预览与确认**同源**——服务端按「表单签名＋解析结果（份集合/用例数）」签发 `previewId`（16 位短哈希），页面以同式 `formSignature` 客户端判定「字段变更→预览过期」（过期横幅＋禁用「确认派发」）；确认摘要读取**服务端数据岛**（不再从 DOM 二次推导）；POST 携带 `previewId`，服务端复算比对——改端/改份/改基线或**关键词匹配范围变化**（新登记份）→ **409 `stale:true`**（无 `previewId` 缺省向后兼容 CLI/legacy）。关键词来源预览本就解析引用份与总条数（本轮补齐合同与展示）；预览区补「设备由执行机领取时确定；最终设备见任务页」。只读形态（actions off）不渲染数据岛与可点提交（无合同可签）。测试：合同单元（岛同源/签名同式/过期判定）＋动作层三态（同源 200、篡改 409、缺省兼容）＋真机实测（同源预览 ID＋篡改 → 409）。全量 **1617 绿**；lint 0；静态 detect 0；Edge 无新类别。后续已锁：健康拆两轴（回归可执行 vs 生成/集成就绪）、释放拆三动作（停止/释放回队列/重新派发）。
> - **健康拆两轴（2026-10-19 第十二批，四评裁决执行）**：`lamp`/`lampReasons` 明确为**执行轴**（磁盘不可达/宿主依赖/三件套/会话内存/构建陈旧）；新增 `integration{ready,total,missing}`（LLM/Figma/Jira）——**可选集成永不染执行灯**：LLM 缺失不再红、Figma/Jira 缺失不再黄，只标注「集成 i/3 就绪（缺 X、Y；不影响执行）」。项目页 H1 只留项目名，状态改为徽章行「执行：… · 集成：…」；总览项目列与脉冲卡同步（「执行健康」，hint 回落集成信息）；对比行透传集成轴。测试更新：LLM 缺失→执行绿灯＋集成缺 LLM；Figma/Jira 缺失→执行绿灯；内存存储→执行黄灯（保留）；磁盘不可达→灰（保留）。全量 **1617 绿**；lint 0；Edge project 页 0 条。
> - **释放拆三动作（2026-10-19 第十三批，四评裁决执行）**：任务状态机新增 **`stopped`**；原「释放重跑」拆为——**停止执行**（仅 claimed/running，保留 claimant 历史；runner 每 3s 轮询任务状态并以 `shouldAbort` 注入执行链，`runGeneratedTests` **在用例边界**停止后续（已执行结果如实入报告、未执行计 skipped）；`suite run --task` 启动与收尾双守卫：已 stopped 不启动、结束时不回写终态/不自动重试）；**释放回队列**（仅 pending/stopped/partial；claimed/running → 409「先停止执行」；清空 claimant）；**重新派发**（复制 refs/端/基线创建新任务；运行中 → 409）。三动作各自写审计（`refs.taskId`）；任务页按状态渲染动作区（确认文案＋失败内联回报＋rerun 后跳新任务页），动作脚本纳入「项目/裁决/任务」三页可解析回归闸。测试：动作层链路（运行中 409 → 停止 → 释放 → 终态 400 → 重新派发同引用）＋runner 停止协议（`shouldAbort` 注入、stopped 保持不释放）＋三页脚本解析。全量 **1618 绿**；lint 0。
> - **建单合同（2026-10-19 第十四批，四评裁决执行）**：应用缺陷建单改为**服务端预览回执**——`dryRun` 签发 `previewId`（16 位哈希：勾选排序＋项目/类型/标签归一＋标题覆盖）；**建单必须原样携带**：缺回执 → 400，回执不符（勾选/字段变化）→ **409 `stale:true`**「重新预览」。前端：预览/建单双按钮，**建单默认禁用**、任一变更立即作废回执（横幅＋禁用）；成功后**不再 reload**——结果面板（case→key→URL 与 created/existing/skipped/failed）就地保留，flash 提示刷新页面更新「已建单」列；移除 `__aosIssuesPreviewed` 布尔闸门。**Jira 未配置前置拦截**：env 可判定时不渲染预览/建单，直接给「缺 JIRA_BASE_URL/EMAIL/API_TOKEN → 配置后重启」指引（服务端仍硬闸：未配置时 dryRun 亦返回指引）。测试：路由三态（缺回执 400／篡改 409／dryRun 签发）＋单元预演链（成功路径 dryRun→create）＋UI 合同标记＋前置拦截两态。全量 **1619 绿**；lint 0。
> - **首访与入口轮（2026-10-19 第十五批，四评 A 侧 P2）**：① 总览新增**「进入最近活跃项目 →」主按钮**（按 lastSeenAt 排序首行）与**每行显式「进入项目 →」**动作（项目名去 `<code>` 外壳，保留名称链接）；② **无项目上下文时不再渲染项目级死项**——侧栏只显示总览（＋统计），就地说明「进入任一项目后显示项目级版块（任务/下发/用例库/…）」，键盘 Tab 不再穿过不可激活项；③ 未配置统计能力时仍以禁用态＋原因渲染（不静默消失）。测试更新：无上下文导航断言（隐藏＋说明＋无 tabindex 残留）、总览两处入口断言；桌面/移动 Edge 复扫仅剩已复核误报。全量 **1619 绿**；lint 0。
> - **项目切换体验轮（2026-10-19 第十六批，四评 A 侧 P2）**：① usage 项目过滤器：原生 `<select>`（大规模下 265 项）→ **可搜索组合框**（`input list`＋`datalist`；按名称提交，服务端 `resolveProject` 原样解析并回显当前项目）；② **「继续上次」**：项目页由 shell 注入 `localStorage.aos-last-project`（根路径原值），总览脚本匹配到仍存在的项目后显示「继续上次：X →」；③ **单项目自动进入**：仅 1 个项目且本会话未自动进入过（`sessionStorage` 守卫）→ `location.replace` 直达项目页，返回键回总览不再循环。测试：usage 组合框双态＋名称回显、shell 记录脚本（有/无项目两态）、总览位点与自动进入标记、总览页纳入内联脚本解析闸。全量 **1620 绿**；lint 0；Edge 总览 0 条。
> - **五评与真问题修正轮（2026-10-19 第十七批）**：五评 dual-agent **33/40（良好 B+）**——趋势 16→25→18→23→33；A 侧确认"防错合同＋审计闭环"已成产品王牌（预览回执/健康拆轴/诚实空态/术语表），新 P1＝下发向导状态自洽（空引用仍可开确认）与"归因→建单"断链＋review/stats 导航当前态；P2＝机器语汇泄漏（`figma:demo`/`suite-run`/`action.tasks`/ISO 时间）、AA 两处缺口、确认/说明三套皮。B 侧核验清单 9/9 已修、移动视口 0 溢出、静态 0 主发现；**真阳性**：`.c-nav-hint` 3.3:1 与页脚/正文 muted 4.2:1（上轮引入）＋project 两表缺 caption——**已修**：hint 改 secondary、`.c-footer`/`.c-main .muted` 改 `#5F5F66`（暗色 `#AEAEB2`）、接入凭证/磁盘资产表补 caption；Edge project/overview 复扫 **0 条**。全量 **1620 绿**；lint 0。
> - **下发自洽与断链接上（2026-10-19 第十八批，五评裁决执行）**：① **下发状态自洽**——数据岛新增 `ready`（引用份非空）；空预览时 ③ 卡显示「预览为空」横幅且「确认派发」禁用（点击拦截文案区分空/过期），不再只靠服务端 400 兜底；来源 radio **联动显隐**「份」/「关键词」字段（`dispatch-field-ref/keyword`）；**stale 横幅上移 ③ 预览卡**（改动点就地可见）；② **归因→建单断链接上**——归因页新增「下一步：去建单（应用缺陷 N 条）→」CTA（`#issues` 锚点直达统计页建单块，`<h3 id="issues">`）；review/stats 页**保留「项目」导航当前态**、batch 页保留「任务」，`page()` 系列页顶栏补「项目 X」上下文 chip。测试：空预览岛 ready:false＋空态横幅＋来源显隐＋拦截文案区分；CTA/锚点/两页 aria-current。全量 **1622 绿**；lint 0；Edge dispatch 无新类别；真机验证（只读态空预览横幅＋review 导航当前态）。
> - **全站内确认（2026-10-19 第十九批，五评裁决执行）**：原生 `confirm()` 全数退场——shell 新增 `window.aosInlineConfirm(button,message,onConfirm)`：就地插入 `.c-confirm-inline` 确认条（确认/取消双钮、`role=status`、Escape 取消且焦点回按钮、确认后自动回收并恢复按钮）；**四处接线**：任务三动作（停止/释放/重新派发）、Jira 建单、计划删除、隔离移除（此前均为原生弹窗）；与派发两段确认同属站内模式。测试：助手与样式随壳断言、四处接线断言、五页（项目/裁决/任务/统计/用例库）`[^.a-zA-Z]confirm\(` **零残留**、stats 页脚本纳入可解析闸。全量 **1622 绿**；lint 0；Edge project/overview 0 条。
> - **时间相对化（2026-10-19 第二十批，五评裁决执行）**：新增统一出口 `src/console/time.ts` `relativeTime(value, nowMs?)`——档位「刚刚／N 分钟前／N 小时前／N 天前／同年 月日 HH:mm／跨年 YYYY-MM-DD」，输出 `<time datetime="原值" title="完整本地时间">相对</time>`（`<time>` 语义＋悬停兜底；空值 `—`、非法值原样转义）。**覆盖**：总览（最后活跃、最新批次）、项目页（批次表起止、任务列表、运行机心跳、计划 lastFired、独立运行、磁盘资产、项目头）、任务页（创建时间、子运行）、归因统计（环境清单 lastAt）、审计、档案、用例库（登记时间）。测试：新增 `test/console-time.test.js`（档位/跨年/title/datetime/空值与转义）＋审计与总览页 `<time>` 断言；真机验证（`1 小时前`＋title 本地时间）。全量 **1626 绿**；lint 0；Edge audit/archive 无新类别。
> - **机器语汇中文化（2026-10-19 第二十一批，五评 P2 收口）**：新增 `src/console/vocab.ts` 映射层（**中文展示＋`title` 保留原文**，可追溯可复制）——来源（`figma:x`→「Figma 生成（x）」、`pen.dev 生成`、`Excel 导入`、`schedule:夜间回归`→「定时计划（夜间回归）」、`suite-run`→「套件运行」、`cli`/`panel`→CLI/控制台）；审计域/动作（`panel`→控制台操作、`action.tasks`→派发回归任务、`run.recorded`→批次登记…未知 `action.*` 回落「控制台动作（x）」）；档案 kind（批次/用例集/报告/差异/崩溃/轨迹，筛选下拉与徽章同步）；裁决 chip（案例问题/执行偏差/应用缺陷/不确定）；文案（「分类口径」→「失败域口径」、「六族浅扫」→列举六类、「签字 owner/到期（可选 ISO）」→「签字人/到期时间（可选，ISO）」）。测试：审计域/动作、库来源、档案筛选与徽章断言＋原断言以 title 兼容。全量 **1626 绿**；lint 0；Edge 无新类别；真机验证（审计「派发回归任务」、档案「批次/崩溃」）。
> - **杂项收口（2026-10-19 第二十二批，五评 P2 尾项）**：① **裁决部分失败如实播报**——成功 flash 由「已提交」改为「已提交 N 条 · 跳过 X · 失败 Y · 已写入审计」（服务端计数直出）；② **建单附件预览失败标注**——`dryRun` 附件预览失败不再静默：预览结果带 `attachmentsFailed`，结果面板显「附件预览失败（不影响建单）」；③ **计划功能改点选**——创建计划的功能字段由手输逗号串改为**多选**（选项＝可引用份的功能名（N 例），提交 `getAll`）；无可引用份时回落手输并就地说明；④ **usage 空态与折叠**——0 事件成功率显示 `—`（不再 0.0%）、零调用工具折叠进「零调用工具（N）」目录、最近调用/事件时间接入相对时间。测试：dryRun 附件降级断言、usage 空态「—」与折叠、计划多选与提交收集、裁决播报文案。全量 **1626 绿**；lint 0；真机验证（usage 折叠目录、项目页多选字段）。
> - **隔离用例点选（2026-10-19 第二十三批）**：用例库隔离表单的「用例 ID」改为**可搜索候选**——从最近 5 次运行收集失败用例（去重取最近，≤100 条）生成 `datalist`（`caseId` 值＋「名称（最近失败 日期）」），手输仍可用；「到期」改**日期控件**（`<input type="date">`，服务端仍接受 ISO）；候选随 `/panel.json`（`caseCandidates`）暴露。测试：候选 datalist 与日期控件断言、JSON 暴露断言（含失败运行夹具）。全量 **1626 绿**；lint 0；Edge library 无新类别；真机验证（可搜索输入＋日期控件就位）。
> - **六评与真问题修正轮（2026-10-19 第二十四批）**：六评 dual-agent **28/40（B−）**——趋势 16→25→18→23→33→28；A 侧：特异性 ≈7.5/10（"下发预览合同"仍为峰值），新 P1＝① 停止是异步请求却同步宣告"已停止"（无 stopping/确认态）② 建单证据不闭合（预览丢 attachments、完成后不显 evidence posted/skipped/error）③"失败之后"路径（项目页 CTA 永远"新建回归任务"、review 无导航入口/无运行时间列、失败域与裁决在 review/stats 仍英文枚举）；P2＝空项目五卡空转、记录底座三信号矛盾（最近写入 UTC slice）、"多份引用"文案与实现不符等。B 侧：核验 8/8 基本已修（对比度全 PASS：nav-hint 4.66/7.69、footer 5.82/7.69；提示 borderline 4.52–4.66），并点名 4 处缺口——**本轮已修**：档案 kind 徽章补 `title` 原文（`cBadge.title`）、生成时间/批次头部时间改相对、下发确认条补 `role=status`、建单结果显 attachments 与 evidence（已附/已跳过/失败）＋汇总"证据失败 N"、顶栏"最近写入"改相对时间（修 UTC 口径）、"多份引用"文案改为"关键词模式可批量匹配"、**fixtures 单项目自动进入禁用**（静态快照可完整扫描，B 曾因跳转拿到空扫描）。全量 **1626 绿**；lint 0；Edge overview 恢复可扫（仅已复核误报）。
> - **失败路径 IA（2026-10-19 第二十五批，六评裁决执行）**：① **导航加一级入口**——「归因」「回归统计」入侧栏（项目级；`v`/`y` 快捷键；review/stats 页面高亮各自项），review 空态也可达；② **项目 pulse 失败路径数字**——`reviewQueue{undecided,unissued}`（最近 10 次运行窗，与归因页同源）；**主 CTA 随未裁决切换**（有未裁决 → 「先去裁决 N 条 →」＋次按钮新建；否则新建），并显「待裁决 N 条 · 未建单缺陷 M 项」可点链接；③ **归因表行身份二列**——「运行（短 id，title 全文）＋时间（相对）」，同用例多次失败不再无法区分；④ **失败语汇中文化**——失败域（`app-defect`→应用缺陷等，title 原文）、置信度（高/中/低）、运行状态（通过/失败/跳过/错误）、裁决 chip（中文＋title 原文）覆盖归因表/stats 列头与域 chip/批次失败域/批次详情汇总；stats 标题去英文括号（「应用缺陷 → 建单」「执行偏差 → 环境核对」）。测试：review 二列与中文标签、导航当前态切至「归因/回归统计」、pulse 数字与 CTA 切换（含"先去裁决 1 条"分支）、`reviewQueue` 随详情暴露。全量 **1626 绿**；lint 0；Edge project 0 条；真机验证（两新导航项＋review 高亮）。
> - **停止两段状态＋executor ack（2026-10-19 第二十六批，六评裁决执行）**：任务状态机新增 **`stopping`**——面板「停止执行」只置 `stopping`（重复点击幂等），**runner 轮询观察到后先回写 `stopped`（ack）再在用例边界中止**（`shouldAbort` 注入；收尾再兜底 ack 一次）；**释放/重新派发在 `stopping` 期一律 409**（「等待执行机确认（离线时为下次心跳读取）」），仅 ack 后可释放；`suite run --task` 启停守卫把 `stopping` 与 `stopped` 同等对待（不启动、不回写终态）；失联领取回收（memory/SQL）纳入 `stopping`（超龄＋离线双条件兜底）。任务页：`stopping` 显「停止中」徽章＋"确认后方可释放"指引、不渲染释放/重派按钮、仍按 10s 轮询；确认文案与 flash 全部改为两段口径（「已请求停止（等待执行机确认）」）。测试：动作链改为两段（stop→stopping→重复幂等→409→模拟 ack→释放 200）、runner ack 断言（stopping→stopped＋ack 日志）、任务页 stopping 三断言（徽章/指引/无按钮）。全量 **1626 绿**；lint 0；Edge project 0 条。
> - **空项目 onboarding（2026-10-19 第二十七批，六评 P2）**：① 空项目（无批次/任务/引用份）首屏新增**三步开始卡**——接入检查（可选，链运维与数据）→ 生成或导入第一份用例（MCP 工具／用例库 Excel 导入）→ 下发第一条回归（含预览合同口径）；② **主 CTA 随状态切换**（三级）：有未裁决 → 先去裁决 N；无引用份 → 「先去生成/导入用例 →」（链用例库）；有份 → 新建回归任务；③ **空区块收敛**：批次/任务/执行机/计划四段空态折叠进「详细状态」details，首屏不再五卡空转；④ 下发块在无份时按钮改「去用例库」指引（不再指向无法完成的下发页）。测试：空项目三步卡/②步文案/CTA 切换/详细状态折叠/去用例库引导；有份项目不显示入门卡。全量 **1626 绿**；lint 0；Edge project 0 条。
> - **记录底座三轴（2026-10-19 第二十八批，六评 P2）**：项目页状态行由「执行／集成」两轴拆为**三轴**——**可运行**（`runnableAxis`：磁盘不可达→灰；无在线执行机→黄「任务将排队，可 CLI 手动执行」；有在线执行机→绿「在线执行机 N」）、**可持久**（顶栏记录底座同源：存储层＋写失败标注）、**已接入**（LLM/Figma/Jira 就绪度＋"不影响执行"）；pulse 首卡由「执行健康」改为**「可运行」**（值与提示同源三轴）；旧执行灯原因（依赖/三件套/构建）仍以列表如实展示为环境注意。真机验证：`可运行：需关注（无在线执行机…） · 可持久：PostgreSQL · 已接入：2/3 就绪（缺 Jira；不影响执行）`。测试：三轴并列断言更新。全量 **1626 绿**；lint 0；Edge project 0 条。
> - **证据重试入口（2026-10-19 第二十九批）**：建单证据闭合收尾——新增 `POST /panel/api/issues/evidence`（`retryIssueEvidence`）：对**已建单且带轨迹**的用例重试上传证据附件（无单号/无轨迹 → 400 语义，未建单不发网络）；成功写审计 `evidence.retried`（refs runId/caseId/issueKey）。前端：建单结果里 `evidence==='error'` 的条目动态渲染「**重试附件**」按钮（站内确认 → 就地重试 → 成功后移除按钮并回报"证据已补传 · 已写入审计"）。测试：单元四态（未建单 400／成功＋审计／无轨迹／上传失败如实回报）＋路由两断言＋UI 接线标记。全量 **1627 绿**；lint 0；Edge project 0 条。
> - **七评与真问题修正轮（2026-10-19 第三十批）**：七评 dual-agent **27/40（C+）**——趋势 16→25→18→23→33→28→27（视角再换：聚焦"信任链"）。A 侧 P1＝审计行不可读不可跳（摘要机器语＋丢 `refs`＋无恢复动作）与"空运行涂红／跨页口径不一"；P2＝下发双重确认与摘要缩水、建单结果英文状态与重试后同行自相矛盾、术语三称与空态过度声称；B 侧全部核验有据（对比度全过、0 overflow、markup 100% scope/caption），真轻微问题 1 条（搜索空态 h1→h3 跳级）＋观察 1 条（会话内存双括注）。**本轮已修**：① 搜索等空态标题 `cEmpty` h3→h2（跳级消除）；② 「可持久」会话内存双括注去除；③ **审计摘要中文化＋带失败原因**（`派发回归任务：失败（预览已过期：…）`，服务端从响应体提取 error）；④ **趋势空运行不再涂红**（total=0 → 中性「0/0（未执行）」＋`title` 不计门禁）；⑤ **建单结果状态中文化**（预览/已创建/已存在/跳过/失败）；⑥ **重试成功后行内证据文案就地改写为「证据已补传」**（消除同屏矛盾）；⑦ 归因空态改诚实话术（"无失败，或尚无运行记录"）。全量 **1627 绿**；lint 0；Edge search 跳级已消（仅剩表格误报）。
> - **审计可跳转＋恢复（2026-10-19 第三十一批，七评裁决执行）**：① **「关联对象」列**——审计事件的 `refs` 不再丢弃：`taskId`→任务页链接、`caseSetId`→用例库、`scheduleId`→计划锚点（短 id 展示＋`title` 全文；其余键以 `key=短值` 纯文本＋title）；② **「恢复」列**——失败行就地给恢复入口（`action.tasks`→「重新打开下发预览」、`action.issues`→「去建单」、`action.import`→「去用例库导入」、`action.verdicts`→「去归因队列」、`action.quarantine`→「去隔离」）；③ **域筛选改已知集合下拉**（vocab `AUDIT_DOMAIN_KEYS`，中文标签，替换自由文本）；列由 5 → 7。测试：关联/恢复二列、`task=t-abc123` 链接、恢复动作、域下拉与中文选项（含 refs 夹具）。全量 **1627 绿**；lint 0；Edge audit 无新类别；真机验证（列与下拉就位）。
> - **compare 显式口径＋跳转（2026-10-19 第三十二批，七评裁决执行）**：对比页口径行**显式声明来源范围**——「仅计入「用例集份」来源批次（suite run --tests／独立运行等其余来源见项目页）」；列组更名「**最近份批次**（时间·门禁·通过率）」；每行空态由「无批次」改为「**无份来源批次 · 看项目页**」（直达项目页对齐其余来源）；最近份批次时间改相对时间（title 绝对）。测试：口径行断言、空态跳转断言、列组更名断言、相对时间断言更新。全量 **1627 绿**；lint 0；Edge 无新类别；真机验证（口径行＋列组＋空态文案均就位）。
> - **usage 对齐 CSDC（2026-10-19 第三十三批，七评裁决执行）**：保留独立进程形态的对齐收口——① **表格容器**：信号/事件等全部表格统一 `.c-table-wrap`（工具表既有）；② **顶栏记录底座条目**（`记录底座：PostgreSQL/文件台账/会话内存`；独立进程无可点运维页时 chip title 不再承诺"点击进入运维"）；③ **筛选词中文化**（状态 ok/error → 成功/失败）；④ **回链按进程口径区分**：同进程（HTTP 模式 `/usage` 路由，`deps.panelUrl="/panel"`）显「← 回到控制台」；独立 `usage --web` **不渲染死链**，改说明「独立统计进程（控制台总览：`panel --web`）」。测试：容器/底座条目/筛选词/独立说明/同进程回链且不重复说明（双态）。全量 **1627 绿**；lint 0；Edge usage 0 条；真机验证（四项均就位）。
> - **下发单次确认＋术语统一＋P3 杂项（2026-10-19 第三十四批，七评留档清空）**：**Wave 1 下发确认收敛**——「确认派发」单击即弹**站内单次确认**（`aosInlineConfirm`，摘要含来源/用例/份明细（`refsDetail` 入岛）/端/基线/执行机在线态），确认后按钮禁用＋「**提交中…**」（`#dispatch-status`）；移除两段确认框；设备卡在无在线执行机时写「**待执行机领取（当前无在线）**」而非"runner 自动"。**Wave 2 术语统一**——全站归为「**执行机（runner）**」（导航/快捷键/候选/空态/完整覆盖提示/compare 口径与列组"执行（执行机·定时回归）"）；术语表补 **门禁/子运行/领取/积压/flaky** 五条。**Wave 3 P3 杂项**——① **404 站内错误页**（HTML 路由出站内页＋「← 多项目总览」，`.json` 保持 JSON）；② **「起自」改 `datetime-local`**（服务端 `normalizeSince`：无时区按本地解析转 ISO，预设链接仍 ISO）；③ **计划功能多选下拉 → 复选组**（fieldset＋checkbox，`getAll` 不变）；④ **自动刷新可见标注＋暂停**（`#aos-live-note`「自动刷新中（每 N 秒）」＋暂停/继续按钮，`clearInterval` 生效；reduced-motion 分支显示"已按系统偏好关闭自动刷新"）；⑤ **移动触达高度**（≤960 `.c-button{min-height:44px}`）。测试：单次确认/提交中/岛字段、术语表五词、导航标签、404 双态、datetime-local 与本地归一、功能复选、刷新标注与暂停脚本、44px CSS。全量 **1627 绿**；lint 0；Edge 无新类别；真机验证（执行机导航/门禁术语/404 页/刷新标注）。
> - **八评与真问题修正轮（2026-10-19 第三十五批）**：八评 dual-agent **31/40（良好上限，距优秀一步）**——趋势 16→25→18→23→33→28→27→31；A 侧确认"内容与语汇高度特异、布局语法通用骨架属正确取舍"，峰值仍是预览契约/两段停止/建单闭环；B 侧 findings 全部复核为已知误报（对比度 4.66–7.36:1 达标）。**本轮已修**：① **P1 自伤**——自动刷新每 10s `replaceChildren(#console-main)` 导致任务动作按钮与暂停按钮**静默失效**：动作绑定改为 `aosBindTaskActions`＋`data-aos-bound` 守卫＋跨页 `window.aosOnRefresh` 钩子（轮询替换后自动重绑），暂停按钮改**文档级事件委托**（替换免疫），标签每次重查节点；② usage **事件流水表补 `.c-table-wrap`**（390 页面级横向溢出消除，真机复扫 0 条）；③ 总览「生成时间」改相对（新增 `relativeTimeText` 纯文本通道，修 card subtitle 转义后露出标签的问题）；④ 审计 refs/recovery 链接 **7 处裸 `&` → `&amp;`**；⑤ **术语映射漏洞收口**——stats 最不稳用例（状态/失败域/裁决）、任务子运行（状态/失败域）、compare 质量域 chips、搜索任务状态全部中文＋`title` 原文；compare 运行/待办文案「runner/failed」→「执行机/失败」；⑥ **下发首访警告收敛**——空关键词/未选份不再推 warning（③ 空态横幅承担），无在线执行机降级为预览信息行（未知份保留真实 warning）；⑦ 文档漂移修正（`web-console/DESIGN.md` 暗色跟随系统/移动端保底取舍、compat 注释）。测试：重绑钩子与委托断言、usage 事件表容器、总览相对生成时间、审计 `&amp;`、术语映射断言更新。全量 **1627 绿**；lint 0；Edge usage@390 **0 条**。
> - **表格单源＋死类名清理（2026-10-19 第三十六批，八评结构项）**：① **表格单源**——`renderTable` 收敛为 **cTable 委托**（空态仍用页内 `<p class="empty">`，非空统一 `.c-table` 外观；项目/任务/归因/批次/统计等表格不再双轨）；usage 自有表格（工具汇总/零调用目录/事件流水/信号表）统一 `.c-table`；② **死类名落地**——`.dispatch-option`／`.c-nav-badge`／`.c-banner-actions` 补 CSS（不再悬空）；③ **兜底文案中文化**——`invalid JSON body`→「请求体不是合法 JSON（检查 Content-Type 与 body）」、`internal error`→「服务内部错误（已写入审计；可重试或查看日志）」。测试：全量 **1627 绿**（结构断言兼容）；lint 0；Edge 无新类别；真机验证（项目页 3 张、usage 5 张均为 `c-table`）。
> - 未做（留档/后续任务）：内部编排审计接线（T4）、产物索引（T5）、三口径导出（T6）、全表面文案整改（T7）。

### 13.127 实施记录（视觉能力启发式修订：DeepSeek Flash 原生多模态）

> 实施于 2026-10-19。`pen_extract_flows` 的 `vision:auto` 对 active 模型 `deepseek-flash` 误报 `vision-unavailable` 跳过：DeepSeek V4.1 Flash 已原生多模态（官方 Vision 指南：`deepseek-flash` 接受 base64 data URL/外链/Files API 图片，单边 ≤8192px，仅 user 消息可带图），但稳定别名不含 `vision` 词干，旧启发式（token `vl/vision/4v/omni/multimodal` + 厂商白名单）漏判；iOS 侧还挂着第二份名单（`src/ios/vision.ts` 的 `VISION_NAME_PATTERN`），两份名单已在细节上漂移（qwen-vl 分支/大小写处理不同）。

- **修复**：`isVisionCapableModel`（`src/design/vision.ts`）增补 `deepseek[^/\s]*flash`——命中 `deepseek-flash`/`deepseek-v4-flash`/`deepseek-v4.1-flash`（含第三方网关 `deepseek/deepseek-flash` 形态）；`deepseek-v4-pro`/`deepseek-chat` 维持不判定（官方文档仅点名 Flash 收图；`vision:true` 仍可显式强制）。`looksVisionCapable`（iOS 执行器 + 终态验证器复用）改为委托同一实现，第二份名单删除。
- **影响面**：pen 视觉识别、iOS 每步视觉输入（多模态主模型直附图）、`AOS_IOS_VISION_LLM`/`AOS_IOS_VISION_MODEL` 缺省时的 active 复用三处闸门同时放行 `deepseek-flash`；`vision-model-unverified`（`vision:true` 覆盖路径）与其余 `vision-*` 降级语义不变。
- **测试**：`test/pen-vision.test.js` 增 4 条启发式断言（flash 三形态命中/pro 不命中）＋端到端用例（fetch stub：`auto` 放行 → `makeChatFn` 真实 OpenAI 兼容通道 → user 消息附 `image_url` data URL → 元素与探索边落盘）；`test/ios-vision.test.js` 同步（`looksVisionCapable`、`resolveVisionTarget` active 复用、pro 边界）。全量 **1628 绿**；lint 0（2 条既有 warning 与本次无关）。
- **同类扫描**：全仓模型名清单复核——`src/llm/providers.ts` 厂商别名（`configure.ts`/`catalog.ts` 仅在**新鲜列表**中命中才生效，缺失回退并告警，过期影响有界）、`src/pen/agent.ts` agent 前缀判定（有显式 `agent` 覆盖）、`src/llm/catalog.ts` `CAPABILITY_TOKENS`（防能力降级的保护名单）均无同类误判风险，本轮不改。
- **边界**：仍为名启发式——稳定别名可再次掩盖能力（同形态问题大概率仍出自这里）；单源化只防名单漂移、不防认知过期；彻底方案（条目级能力声明或一次真实探测）未纳入本轮，留档。（2026-10-19 追加：已由 §13.128 落地——声明优先＋探测缓存＋未知即尝试，启发式降级为快速通道。）

### 13.128 实施记录（视觉能力判定加固：声明 → 探测缓存 → 启发式 → 未知即尝试）

> 实施于 2026-10-19（承接 §13.127）。名启发式天然随厂商改名/新档位漏判，且稳定别名会掩盖能力；本轮把「能不能视觉」从单一名字猜测改为四段判定链，pen 与 iOS 单源共用（`src/llm/vision-capability.ts`；`isVisionCapableModel` 迁入并保留 `src/design/vision.ts` re-export）。

- **判定链**：`AOS_LLM_VISION`（`1/true/yes`、`0/false/no`；active 模型声明，权威）→ 探测结论缓存（`.artemis/llm-capabilities.json`，键＝`baseUrl|model` 归一；`AOS_VISION_CACHE_DAYS` 默认 7 天，`0` 关闭缓存＝每次都探测）→ 名字启发式（§13.127 名单，快速通道）→ **未知**。
- **未知即尝试（fail-open）**：pen `vision:auto` 未知时照常渲染并调用（不再跳过；`vision-model-unverified` 提示按尝试处理）；iOS 主模型未知且未配置专用视觉模型时同样先附一次图（有 `AOS_IOS_VISION_LLM/MODEL` 时不浪费主模型调用）。
- **结论学习**：只有「模型不接受图片」一类失败（HTTP 400/415/422 且措辞同时命中图片/视觉词与 not support/unsupported/仅支持/不支持，`classifyModalityRejection`）才记为无视觉——pen 首屏即中止（新增 `vision-model-rejected` + `vision-unavailable`「已记录」）并写缓存 no；iOS 当场 latch 纯文本（`visionDegraded=多模态决策被拒…`）并写缓存 no。成功（未知或 `vision:true` 强制来源）写缓存 yes。其余失败（鉴权/网络/格式/服务端）不写缓存，保持原有响亮降级。
- **接线**：`runVisionPass` 结果新增 `rejected`（中止后屏幕计入 skipped）；iOS `resolveVisionTarget` 增 `activeVision` 参数（active 复用仅在判定为有视觉时发生——缓存 no 的模型不会被当视觉模型二次复用）；`src/ios/run-loop.ts` 捕获拒绝即 latch；`tool-entry` 按同一判定解析 vision target（启动响应 `vision` 与实际一致）。
- **测试**：新增 `test/vision-capability.test.js`（7 例：声明解析/TTL/键归一/优先级/拒绝分类/缓存 IO 容错/启发式迁移）；pen 增 3 例（声明 0 不探测、未知被拒→缓存+中止、未知成功→缓存）；iOS 增 1 例（fail-open 附图被拒→latch+缓存）；既有纯文本场景用例显式钉 `mainVision:false` 保持原意图。全量 **1639 绿**；lint 0（2 条既有 warning 与本次无关）。
- **边界/留档**：缓存是派生数据（可删可重建；多机不同步，探测成本＝一次可忽略的请求，TTL 过期自动重探）；`AOS_LLM_VISION` 作用于 active 条目，多条目细分声明留档；面板/`doctor` 展示判定与缓存状态留档。

### 13.129 实施记录（`design_to_test` 生成参数透传：`maxFlows`/`maxDepth`）

> 实施于 2026-10-19（提交 f72b125 ＋ 本记录）。动机＝一次真实复盘（starbuckstw 项目：`.pen` + `vision:true` 全量识别后探索到 38 条路径，生成步固定走默认 `maxFlows=10` → 28 条丢弃、生成报告 `truncated:true` → 覆盖闸按 fail-closed 判「流程未完整覆盖…路径截断」，响应 `failedStep:"check"`，用户无法在一条龙内调参过闸）。改法：与 `figma_generate_tests` 同口径，给 `design_to_test` 增两个可选生成参数并在编排层透传。

- **工具与 schema（`src/tools/native-tools/workflow.ts`）**：`maxFlows`（生成条数上限，1..50，默认 10）、`maxDepth`（路径最大深度，1..50，默认 30）；字段描述注明「vision 全量探索路径多时可调大以避免覆盖闸『路径截断』」。
- **编排（`src/workflow/design-to-test.ts`）**：`DesignToTestArgs` 增两字段；生成步与 `nextAction` 仅在显式提供（`typeof args.maxFlows/maxDepth === "number"` 守卫）时携带，未提供与旧行为完全一致（不产生 `undefined` 键）。
- **测试**：编排透传 +2（显式键原样传给 generate；只给 `maxFlows` 时不出现 `maxDepth` 键）；`native-workflow-tool` schema 用例扩展（暴露两字段；`maxFlows:0/51`、`maxDepth:2.5` 拒绝；`{maxFlows:50,maxDepth:12}` 合法形态放行）。全量 **1641 绿**；lint 0（2 条既有 warning 与本次无关）。
- **配套（脚本层）**：`scripts/aos-call.mjs` 增加每请求超时 `AOS_CALL_TIMEOUT_MS`（毫秒，默认 600000；上限 clamp 至 2^31−1，防 Node 定时器溢出；此前受 MCP SDK 默认 60 s 约束，长任务直跑会被截断）＋启动行 stderr 提示；README（`design_to_test` 参数）/AGENTS.md 与 docs/接入指南.md（`AOS_CALL_TIMEOUT_MS`）同步。
- **评审修正（提交 9ee4b8c）**：`nextAction` 同步携带显式 `maxFlows`/`maxDepth`（否则 run:false 的续跑第二步回到默认 10、再次截断——评审发现的真实缺陷）；`CHECK_SUGGESTION` 补「路径截断可加大 maxFlows/maxDepth 重试」；zod/透传测试对称补强（`maxDepth:0/51`、`maxFlows:2.5` 拒绝；仅 maxDepth 透传 + nextAction 断言）；`maxDepth` 描述对齐 `figma_generate_tests`（边数/续段拆分）。全量 **1642 绿**；lint 0。
- **边界**：默认值（10/30）与覆盖率口径、三闸判定均不变——「截断即 fail-closed」语义保留，只是入口可调参；`figma_generate_tests` 直调路径不受影响。（2026-10-19 修订：`maxFlows` 上限 50 → 1000，见 §13.132。）

### 13.130 实施记录（pen 视觉识别全量屏：几何兜底 + 上限语义）

> 实施于 2026-10-19。真实复盘（starbuckstw：`.pen` 23 屏）中 `vision` 只处理了 4 屏：`collectVisionScreens` 以 `numberProp(frame,"width"/"height")` 取尺寸，而该文件是 auto-layout 为主——绝大多数屏是 `width:"fill_container"`、`width:"fit_content(948)"` 或完全没有 `height`（由布局引擎解析），全部被当作「无可用屏幕几何」静默跳过。`AOS_VISION_MAX_SCREENS`（默认 20）根本没触发，`vision-screen-cap` 也就没出现，用户只看到 `screensRequested:4`。

- **几何兜底（`src/pen/flows.ts`）**：`collectVisionScreens` 增 `sizeFor(screenId)` 兜底——frame 的数字宽/高缺失时取已渲染 PNG 的 IHDR 尺寸（`pngDimensions`，渲染为 scale 1，与设计坐标系一致，已用真实文件逐屏核对）。渲染在 vision 之前已完成（截图与 vision 共享一次渲染），因此兜底不增加渲染成本；`screens:false` 时仍会为 vision 渲染。逐屏读取结果缓存，避免重复读盘。
- **静默跳过改为响亮降级**：新增 warning `vision-screen-no-geometry`——既无数字几何、又无渲染图的屏逐条计入并在响应/flows.json 中列出（≤5 个具名，其余「等」），不再无声消失。
- **上限语义（`AOS_VISION_MAX_SCREENS`）**：默认 20 → **50**（覆盖常见设计文件全量屏，仍为多模态调用成本留闸）；`0` / `all` / `unlimited` 显式表示不限。`vision-screen-cap` 只在真实截断时出现。
- **单源化（`src/design/screens.ts`）**：`pngDimensions` 从 `src/ios/vision.ts` 迁入设计截图模块（IHDR 读取与 PNG 校验同处），`ios/vision.ts` 保留 re-export，iOS 调用点零改动。
- **测试**：`test/pen-vision.test.js` +6（`AOS_VISION_MAX_SCREENS=0`/`all` 解除上限；默认 50 放行 23 屏、仍截断 60 屏并告警；auto-layout 屏用 PNG 尺寸且 bbox 按渲染尺寸换算、grounding 命中设计节点；无几何无渲染的屏出 `vision-screen-no-geometry`；全屏皆无几何时跳过原因仍带该警告）；`test/design-screens.test.js` +1（`pngDimensions` 边界）。全量 **1650 绿**；lint 0（2 条既有 warning 与本次无关）。
- **真实验证**：starbuckstw 23 屏 `screensRequested/Processed` 均为 23（改前 4），无 `vision-screen-cap`、无 `vision-screen-no-geometry`。
- **边界**：无数字几何的子节点仍不参与 bbox→nodeId grounding（元素与探索边照常产出，`nodeId` 缺省）；成本随屏数线性上升，全量识别前应确认 active 模型的图片计费口径。

### 13.131 实施记录（功能身份：碰撞消歧＋重复身份去重＋屏集口径修正）

> 实施于 2026-10-19。真实复盘（starbuckstw）：`到店自取` 在 ledger 中出现两次（**同一 key**、各 30 条）、`到店自取-2` 与 `到店自取` 三件套**字节相同**、`再次訂購/結帳流程/選擇取餐時間` 等 0 用例、每次生成重复落盘。根因链（逐层复现，非猜测）：

- **① 自愈/回填屏集放大**：`hydrate` 与 `suite backfill` 登记功能屏集时取「用例覆盖过的屏幕并集」（`collectScreens(flows)`/`uniqueScreens(flows)`），而归档 `features[0].screens` 才是功能组屏集。starbuckstw 的 genesis 功能真实 6 屏被登记成 23 屏 → 与所有组假重叠 1.0。
- **② 假重叠 → 抢注 → 新建键碰撞**：`applyIdentity` 比例继承下，首个组（4 屏 cluster）借假重叠抢走 genesis key `K`；被 `assigned` 挡下的另一 `到店自取` 组（6 屏、name-prefix）走新建路径，而 `f-<slug>-<sha8(排序屏幕)>` 恰好重算回同一个 `K`——同一调用内两组同 key，`cases.filter(feature===key)` 对两组返回同一子集 → 三件套字节相同（`-2`）、ledger 双登记、身份复用失效。
- **③ 历史键抖动**：被挡组每轮用「当前 LLM 命名 + 屏集哈希」重算 key（命名方差 → key 变）；且自身历史多键与假重叠项并列最高 → 永远判「新」，无法复用。

修复：

- **`applyIdentity` 碰撞消歧**：新建 key 与本次已产出 key 相同时确定性递增 `-2`/`-3`…，出 `feature-identity-collision` 告警（不变量：同一调用内各组 key 唯一）。
- **`applyIdentity` 重复身份去重**：prior 中屏集与组完全相同的条目优先继承——取最近一份（prior 新→旧）且未被占用者；无精确匹配/全被占用才回退比例继承（唯一最高 ≥0.5），再回退新建。「并列最高但屏集不同」（真歧义）仍不合并、新 key + `feature-identity-new`。
- **屏集口径**：`hydrate`/`backfill` 登记屏集优先取归档 `features[0].screens`（字符串去重），缺省才回退用例覆盖并集。
- **测试**：`test/figma-features.test.js` 替换 1＋新增 2（同屏集并列继承最近一份；屏集不同并列仍新 key；碰撞消歧 `-2`、同调用 key 唯一）、`test/db-default.test.js` hydrate 增屏集优先/回退断言、`test/suite-backfill.test.js` +1；全量 **1653 绿**；lint 0 error（2 条既有 warning）。
- **真实验证（starbuckstw，修复构建 stdio 重跑）**：vision `23/23` 屏（360 元素/215 导航边/0 失败，无 cap/no-geometry 告警）；`到店自取` 双组键分为 `f-到店自取-06f2c8a0` 与 `f-到店自取-06f2c8a0-2`（带 `feature-identity-collision`）、`行動點餐首頁` 组继承其最近历史键；case-set 仅 1 份（50 用例），不再有字节相同的 `-2` 双份；用真实 ledger 回放模拟下一轮，六组键完全稳定（同键复用）。
- **边界**：既有 ledger 历史记录（含 genesis 23 屏）不回写——`-2` 键自本轮起稳定，`K` 名义屏集与 slug 归属的历史差异可见但无害。用例→功能归属仍按「屏幕多数归属」：全应用级长路径（平均 19 屏）下最大功能组恒胜，`再次訂購/結帳流程` 等 0 用例属分配口径现状（非身份缺陷；按功能生成/归属另立）。

### 13.132 实施记录（生成上限：`maxFlows` 50 → 1000）

> 实施于 2026-10-19（承接 §13.130/§13.131 的 starbuckstw 全量视觉复盘）。现象：23 屏全量视觉后（237 边，其中 215 条 vision 未决探索边 `to:null`——生成侧口径为「每条保留一次探索用例」），`design_to_test`/`figma_generate_tests` 的 check 报「路径截断」；而 `maxFlows` 已顶到 schema 上限 50。真实图纯函数探测（`linearizeFlowsWithStats`，不落盘不调 LLM）：50/100/200 均截断（探索 207/215 条即被 `maxFlows*4` 探索帽截停），**≥300 全量收敛**（kept=215、dropped=0、`truncated=false`）；`maxDepth` 30 已足够（depthSplits 0）。即「加大上限」的建议因 50 封顶实际不可用——上限本身是唯一堵点。

- **工具与 schema**：`figma_generate_tests` 与 `design_to_test`（透传）两侧 `maxFlows` 上限 50 → **1000**（默认 10 不变；`maxDepth` 上限 50 不变）；描述注明「大体量流程/视觉未决探索边多时可调大以避免覆盖闸『路径截断』」。
- **测试**：`native-workflow-tool` zod 拒绝点 `maxFlows:51` → `1001`（51 自此合法）、合法形态增 300/1000；新增 `test/native-figma-tool.test.js`（300/1000 通过；1001/0/2.5 拒绝；`maxDepth` 50/51 边界）。全量 **1654 绿**；lint 0 error（2 条既有 warning）。
- **真实验证（starbuckstw，`reuseExistingFlows` 重生成，不重跑视觉）**：`maxFlows=300` → `explored=kept=215`、`dropped=0`、**check 通过**、`coverage.complete=true`（explore 类亦全绿）；用例分布 行動點餐首頁 73 · 到店自取 142（其余组 0，属归属口径现状，见 §13.131 边界）；case-set 两文件各自独立（500KB / 1.34MB），ledger 键唯一。

### 13.133 实施记录（设计链路「不静默省略」P0：候选四态 + 变体 target + 守恒 + 警告可见面）

> 实施于 2026-10-20（承接 §13.130–§13.132 的 starbuckstw 全量视觉复盘）。现象：pen 视觉只处理主屏，合并进主屏的状态变体（`screen.states[]`）从未成为独立 target；设计稿里的候选交互元素没有词表与核验，识别不全时无逐条交代；回复 >40 条、候选 >200、grounding >300 的截断只留内部计数；且设计警告只写 `flows.json`，生成/检查/执行/面板各层看不到。本阶段分 **P0-A（生产侧不静默）** 与 **P0-B（消费侧可见）** 两部分；P1（交互解析、状态路径生成等）不在本计划。

**P0-A：警告管道与候选四态**

- **统一形态**（`src/design/warnings.ts`）：`DesignWarning = {code, message, details?}`；`flows.json.warnings` 与 `tests.json.designWarnings` 同构。`normalizeWarnings` 逐条丢弃无 `code`/`message` 的条目；`readFlowsWarnings`/`readTestsWarnings` 缺文件、坏 JSON、顶层非对象均返回 `available:false` 而不抛；**字段缺失 ≠ 零警告**——缺 `warnings`/`designWarnings` 字段即不可用，回退另一来源；显式空数组才是「可用且 0 条」。`mergeWarnings` 按 `code + message` 去重并保留首次顺序（`bySource` 把每条唯一警告记给首个来源，各值之和 = 条数）；`summarizeWarnings` 出 `total/byCode/codes`（可选 `bySource/snapshotAt/stale`）；`resolveDesignWarnings` 默认 **tests 快照优先、flows 回退**；仅当采用 tests 快照且 flows.json 的 mtime 在**毫秒精度**上严格更新（`flows.mtimeMs > tests.mtimeMs`）时 `stale:true`，mtime 相等不算陈旧。
- **候选词表与四态**（`src/design/element-coverage.ts`）：默认词表 13 个英文词（`Button`/`Tab`/`Link`/`Input`/`Toggle`/`Switch`/`Checkbox`/`Search`/`Menu`/`Cart`/`Bag`/`CTA`/`Sticky button`）＋ 11 个中文词（`按钮`…`关闭`）；名称按 `/` 分段匹配（英文按词序列连续命中、中文按子串），大小写不敏感；`AOS_VISION_CANDIDATE_TOKENS` 追加项目词（逗号/中文逗号/换行分隔，去空去重转小写；**项目 `.env` 优先、进程 env 回退**，`applyVision` 解析一次后贯穿候选采集）。候选判定除词表外还认 `type === "ref"` 与 `reusable === true`（组件实例），无名称时以 `type`（再回退 `component`）作候选名；`Flow/*` 子树排除、嵌套候选只保留最外层。
- **四态判定**（按 target 隔离）：`covered`（nodeId 命中 → 几何命中：IoU ≥ 0.2 或元素中心落在候选 bbox → 文本 fallback）／`uncovered`（有几何但未命中）／`unverifiable`（无几何且无可匹配文本、`no-geometry`/`no-text`，或文本被同 state 多候选共享 `ambiguous-text`；后者 `details[].matches` 附匹配候选数）／`not-evaluated`（target 未进入 vision，带原因）。计数与 `details`（逐候选 nodeId/name/status/reason/bbox）写入 `FlowElementCoverage`；告警 `vision-candidate-uncovered`（逐屏×state 一条＋具名明细）、`vision-candidate-unverifiable`（整屏一条汇总，`message`/`details` 按主屏/状态分列，避免主屏与变体折叠）、`vision-candidate-vocabulary-unmatched`（有设计节点但零候选，提示词表不适配；未评估 target 不误报）。
- **变体 target**（`src/design/vision.ts` + `src/pen/flows.ts`）：主屏与其状态变体都成为独立 target（`stateOf`/`stateName`），`collectVisionScreens` **主屏在前、变体在后**；上限先裁变体、主屏仅在自身超限时被裁。`screensRequested` 恒指主屏、`statesRequested` 指变体、`targetsRequested = 两者之和`（均只计进入 pass 的 target：`processed + skipped + failed`）；`screensInput`/`statesInput` 另计全部输入（含 capped/排除）。变体元素落 `screens[].states[].elements`，变体边只进 `stateEdges` 与 `counts.visionStateEdges`（审计专用，**不并入 `result.edges`/`unresolvedDestinations`**，生成侧边界不变，见「已知边界」）。`counts` 增 `visionMainElements`/`visionStateElements`（与总数 `visionElements` 对齐），避免只有合计时看不出主屏/变体构成。
- **静默截断可见**：回复元素 >40 → `vision-response-truncated`（含屏名与条数）；每 target 候选 >200 → `vision-candidate-cap`（并记 `vision.accounting.candidatesTruncated`，含被排除/被 cap 的 target）；grounding >300 记 `groundingTruncated`（只进 accounting）；上限截断出 `vision-screen-cap`，`details` 逐 target 具名并区分主屏/变体，附 `AOS_VISION_MAX_SCREENS=0` 行动提示；缺帧/缺几何/重复 id 分别 `vision-screen-frame-missing`/`vision-screen-no-geometry`/`pen-duplicate-node-ids`（重复 id 按文档中最后出现的帧解析，last-wins）。
- **grounding 行为变更（>300）**：节点选取不再是遍历先到先得，而是**候选优先 → 叶子优先 → 容器兜底**；候选子树继续下钻以统计 `designNodes`/几何，但不再采集嵌套候选。`designNodes` 改为计**全部访问到的非 `Flow/*` 节点**（含无完整几何的 auto-layout 子节点），零候选兜底 `vision-candidate-vocabulary-unmatched` 据此生效。大屏（>300 几何节点）的 `nodes` 排序与 `groundNodeId` 结果因此与旧版不同；`test/pen-flows.test.js` 用 309 节点 fixture 锁定排序、容器被挤出与 grounding 结果。
- **未评估候选**：`vision:false`、`AOS_VISION=0`、无可用/无视觉能力 LLM、渲染通道失败都在早退前离线采集候选并落 `not-evaluated` 覆盖（原因 `vision-off`/`vision-unavailable`/`render-missing`；缺帧/缺几何保留 `frame-missing`/`no-geometry`），即使 vision 未激活也写入 `screens[].elementsCoverage`/`states[].elementsCoverage`，不伪造 `covered`。
- **坐标空间**：`VisionScreenInput.width/height` 在 `renderScale !== 1` 时表示**渲染图像像素**；识别 bbox（归一化）先乘图像尺寸、再除以 `renderScale` 得到设计 px。`test/pen-vision.test.js` 以 780×1688 的 2× 图锁定换算与不换算的差异。
- **守恒公式**（D7，`visionAccounting`）：`screensInput = processed + skipped + failed + capped + noGeometry + frameMissing`；states 同式；`targetsRequested = screensRequested + statesRequested`；`screensRequested = processed + skipped + failed`；states 同式；`elements = grounded + ungrounded`；`rawElements = elements + invalid + truncated`。任一不成立出 `vision-accounting-mismatch`（消息带全部数字，不静默）；`candidatesTruncated`/`groundingTruncated` 明确不参与公式。截图侧 `screens + states = rendered + skipped`，不成立出 `screenshot-accounting-mismatch`；`screenshots.accounting` 可见。
- **env**：`AOS_VISION_MAX_TARGETS` 为首选名（上限覆盖主屏＋变体），`AOS_VISION_MAX_SCREENS` 保留为兼容旧配置；两者均为默认 50、`0`/`all`/`unlimited` 不限。`AOS_VISION_CANDIDATE_TOKENS` 追加候选词表（默认词表始终生效）。**优先级**：`AOS_VISION_MAX_TARGETS` 非空即生效，否则回退 `AOS_VISION_MAX_SCREENS`；同一变量先读项目 `.env`、再读进程 env（项目 `.env` 胜出，`visionMaxScreens` 实现如此）。
- **flow-map**：每主屏/每变体一行覆盖摘要「识别 / 候选 / 覆盖 / 未覆盖 / 不可核验 / 未评估（未评估：原因）」，零候选的未评估 target 也能与「已评估但无候选」区分；视觉识别区补变体元素行。

**P0-B：警告的消费面**

- **`design_to_test`**：提取后响应带 `warnings[]` 与 `designWarnings` 摘要（`bySource` 含 `extract`/`flows`，提取响应与磁盘 `flows.json` 按 code+message 去重）；提取成功后合并 `generatePayload.warnings`（来源 `generated`，只计入去重后的新增条数），`warningsAvailable` 由实际可读来源推导（不再恒 `true`）；`steps[extract].warnings` 计数；`artifacts.flowMap` 在 check 之前计算，文件存在即返回（check 失败响应同样携带）。提取后的失败响应（生成 0 用例/检查失败/执行失败/needs-setup/needs-info）同样携带已收集警告；**提取前的 setup/no-flows 响应刻意保持原形状**（此时尚无设计源）。
- **`figma_generate_tests`**：flows 警告与生成期警告（功能命名/身份、用例集登记、截图降级）按 code+message 合并，写入响应 `warnings`/`designWarningsSummary` 与 tests.json 的 `designWarnings`/`designWarningsSummary`（`bySource` 为 `flows`/`generated`）；tests.md 顶部增「警告（设计源与生成期，不阻断生成）」小节（覆盖 flows 与生成期警告，无警告不出现）。快照在 tests.json 落盘前定稿；登记失败等晚到警告只留在响应 `warnings`，不改写已登记指纹。
- **`suite check` / `suite loop`**：preflight 经 `resolveDesignWarnings` 取一份快照，文本统一由 `renderDesignWarningLine` 渲染（`设计源警告: N 条（codes）· 来源 · 快照 · [stale-snapshot]`）；`check --json` 增 `designWarnings`/摘要/来源/快照/陈旧字段，`loop` 的 check 步骤与 markdown 同源；**退出码与门禁语义不变**（警告不阻断）。
- **manifest / report / 回归 / Jira**：批次清单写入运行期 `designWarningSummary` 快照（历史清单缺字段 → `null`，面板显式「未记录」而非 0 条）；`suite report` 用当前快照，文本普通与 `--task` 两分支都打印 `设计源警告: N 条（codes）`（`null` → 未知、`available:false` → 不可用，不伪造 0）；`run_regression`/`verify_jira_issue` 跨 set 合并去重，并用 `missingSets` 披露「部分 set 无摘要」的覆盖缺口（全部缺失仍 `null`，不伪造 0）；两者的执行失败响应同样携带已收集的 `designWarnings`。
- **面板 / 档案 / pipeline**：`/panel.json` 项目行、项目页「磁盘资产」、批次详情（清单冻结值）均显示设计源警告（无快照显式「不可用」）；`project_archive.design.warnings` 与面板/套件同源；`scripts/design-pipeline.mjs` 在提取后打印警告行（响应无 `warnings` 时打印不可用）。

**测试与验收**：`npm run build && npm test && npm run lint` → build 0 error、**1727/1727 通过**、lint 0 error（2 条既有 warning 与本阶段无关）；覆盖 `test/design-warnings.test.js`、`test/design-element-coverage.test.js`、`test/pen-flows.test.js`、`test/pen-vision.test.js`、`test/workflow-design-to-test.test.js`、`test/figma-testgen.test.js`、`test/suite-command.test.js`、`test/suite-loop.test.js`、`test/suite-run-manifest.test.js`、`test/run-report.test.js`、`test/workflow-run-regression.test.js`、`test/workflow-verify-jira.test.js`、`test/panel-assets.test.js`、`test/panel-web.test.js`、`test/workflow-project-archive.test.js`。

**已知边界**

- **原始原因码**：flow-map 的 `not-evaluated` 原因直接用 `frame-missing`/`no-geometry`/`capped`/`render-missing`/`rejected`/`failed`，未另做中文映射；候选 `reason` 同样保留原始码（`no-geometry`/`no-text`/`ambiguous-text`/`vision-off`/`vision-unavailable`/`capped`/`render-missing`/`frame-missing`/`rejected`/`failed`）。
- **变体仍为审计面**：变体元素/边只在 `states[]` 与 `stateEdges` 留证，不进入生成路径（`result.edges`/探索边仍是主屏边）；状态路径生成属 P1。
- **手工回放延期**：本阶段**未执行** starbuckstw 真实项目回放（会写入外部项目）。待手工验收的期望是：23 主屏＋30 变体全部有 target 记录；默认 50 时 3 个变体具名 `capped`；`unverifiable` 有计数；`maxFlows=300` 下 215 条探索边全保留；一条龙响应含 design warnings。该项在真实项目验收时补记，不影响本阶段代码/测试结论。
- **截图守恒的集成路径**：真实链路由构造保证 `screens + states = rendered + skipped`，不会自然触发不平；目前以 `screenshotAccounting` 纯函数单测锁定破坏路径，未做真实截图失败的端到端注入。
- **候选判定是启发式**：词表不适配（尤其自定义命名）可能产生 `uncovered`/`vocabulary-unmatched`；同一归一化文本被多候选共享时保守判 `unverifiable`（不虚报覆盖）。宽松包含匹配（如 `结算` 命中 `去结算`）为既定行为。
- **快照语义**：批次详情读清单冻结值，项目页/档案读当前快照；两者时间差会在详情中体现为「未记录/旧值」而不是自动刷新。

### 13.134 实施记录（用例集归档命名 + 存储接入防静默）

> 实施于 2026-10-20。`caseSetStem` 归档 basename 由 `<UTC YYYYMMDDTHHmmss>_<功能>` 改为 `<UTC YYYYMMDD_HHmmss>_<功能>`（示例 `20261019_105551_到店自取`；未指定 `excelTemplate` 时仍用内置工作簿，不套模版）；`suite backfill` 的 `createdAt` 解析同时接受新旧两种前缀（旧归档不迁移、不重命名）。`createProjectStore` 在仅配置已废弃 `AOS_DATABASE_URL` 时把原因写进 `store.reason`（明确旧名不生效、当前落文件台账），避免接入项目静默丢中心库记录。starbuckstw 接入配置已切换 `MOBILE_TESTING_DATABASE_URL`（`127.0.0.1:5432/mobile-testing`），`suite backfill` 回填 17 份 case sets；历史 usage_events（60 条，含当日 44 条）与 1 条 regression task 仍在文件台账，未自动回流。测试 +1（db-default 旧名提示；case-sets/backfill 断言随命名更新）；全量 1728 绿。

### 13.135 实施记录（测试用例字段与 Excel 契约 P0）

> 实施于 2026-10-20。来源：人工用例 `v4.9.0- Test Case.xlsx` 的字段经验；设计见 `docs/superpowers/specs/2026-10-20-test-case-authoring-design.md`（P0 已实施，P1/P2 未实施）。
> 数据模型：`GeneratedTest` 增 `displayId/module/section/testData/openQuestions`（P1 字段 `relatedCases/designRefs/variant` 已预留类型）；`displayId` 取机器 `id` 后 6 位（`TC_xxxxxx`，冲突 `-2`），不替代既有机器 `caseId`；`tests.json` 增 `schemaVersion:2` 与 `summary`（live/每个功能归档子集分别计算）。
> 生成规则：`module`＝功能名；`section`＝入口屏（acceptance `section` 可覆盖）；`testData/openQuestions` 只从 `acceptance.json` 的 `data/questions` 按用例屏幕收集（各上限 12/10），无来源显式 `n/a`，不臆造；设计警告不逐条挂用例（仍走 warnings 面）；`taskDesc` 在 `【真实数据】` 后注入 `【测试数据】`/`【待确认】`（空不注入）。
> Excel/Markdown：`src/figma/case-view.ts` 统一预期结果/测试数据/待确认/设计引用/汇总派生；默认 `tests.xlsx` 保留前 6 列并追加 `用例编号/模块/Section/测试数据/关联用例/预期结果/设计引用/备注待确认` + `汇总` sheet（执行统计留空，不伪造结果）；模板新增 `{{case.displayId}}` 等占位符，未知占位符原样保留；`tests.md` 标题与新增小节同步；Excel 导入路径共用同一 14 列契约（缺字段 `—/n/a`）。
> 验收文件：`acceptance.json` 兼容旧 `{screens}`，新增 `data/questions/section`；非法条目/超限出 `acceptance-details-invalid`/`acceptance-details-truncated` 警告，不阻断生成。
> 测试：新增/更新 `test/figma-testgen.test.js`（acceptance v2 端到端、非法 acceptance、legacy 回退、模板占位符）；`npm run build && npm test && npm run lint` → 全量 **1732 绿**，lint 0 error（2 条既有 warning）。

### 13.136 实施记录（文件台账 usage/regression_task 一次性补 PG，已退役）

> 2026-10-20。曾新增 `scripts/migrate-ledger-to-pg.mjs`（dry-run/`--write` 幂等补 `usage_events`/`regression_tasks`）。**同日判定退役并删除**：外部脚本可接受任意路径/DB URL、无审计，绕过服务边界；历史迁移改由 P1 服务内事件消费者承担。`suite backfill` 仍只覆盖 runs/case-sets。

### 13.137 实施记录（P0）：项目事件入口

> 实施于 2026-10-20。完整设计见 `docs/superpowers/specs/2026-10-20-project-event-ingress-design.md`。
> **协议**：`src/events/payload.ts`（stable stringify/hash/bytes、`since` 归一）、`src/events/protocol.ts`（type/source/status allowlist、per-type 最小必填、payload ≤32 KiB、`at` 规范化）。
> **存储**：`project_events`（PG `seq BIGSERIAL` + `payload_bytes` + `(project_id,event_id)` 唯一；文件态 `events.jsonl` + `events.meta.json` 启动索引判重、seq 持久化、裁剪不回收；内存同语义）。保留 30 天/5 万条异步裁剪；文件台账 P0 不做 fsync；事件不计入 `usage_events`。
> **入口**：`POST/GET /events/<project>`（202 携带 `storage/degraded`；重复取既有 `serverId/receivedAt`；`since` 规范化后比较；列表默认不带 payload）；原生工具 `aos_event_report`/`aos_events`。轻量项目解析 `src/events/project-resolver.ts`（loadProject + store upsert，不建 Runtime；`.`/`..` 拒绝、rootPath 与 `getRuntime` 共用 realpath 归一）。
> **安全/口径**：项目身份来自路由/runtime，无路径/DB URL 参数；审计异步且不记 payload；P0–P2 权威仍为 `suite_runs`，AOS runId 复用 manifest；中心 HTTP + PG 为推荐拓扑，file/memory 仅单实例兜底。
> **删除**：外部迁移脚本与其测试（4 例）移除；历史 usage/regression task 迁移留 P1。
> **测试**：新增 `events-protocol` 4、`events-store-memory` 2、`events-store-file` 2、`events-store-pg` 1、`events-project-resolver` 2、`events-ingress` 2、`events-http` 2、`events-tools` 1；`npm run build && npm test && npm run lint` → 全量 **1748 绿**，lint 0 error（2 条既有 warning）。

### 13.138 实施记录（P0 加固）：事件入口评审修复

> 2026-10-20，对 `fae3f70..8b359c3` 评审发现的问题做修复；P0 范围与协议不变。
> **并发**：`FileStore` 事件读写/裁剪按桶串行（`eventQueue`，读也入队），事件索引加载共享同一 Promise；并发同 `eventId` 只接受一次，`seq` 不重复。
> **ack 诚实**：新增 `degradedReason(store, note)`，仅 `memory` 返回 `degraded`（无 note 时给显式原因）；file/postgres 不再把“未配置 PG / 回退文件台账”误报为降级，`storage` 仍如实返回。
> **HTTP 映射**：项目配置损坏从 500 改为 400 `project-config-invalid`（`ProjectConfigError`）。
> **路径归一**：HTTP workspace、`resolveProjectRoot`、`Runtime` 构造统一 `realpath`，symlink 项目根不再产生第二身份；测试夹具 `makeTempDir` 同步返回 canonical 路径（面板“待领取”邻近断言放宽以容纳更长路径）。
> **裁剪写入**：文件事件压缩改用异步原子写，避免大文件阻塞事件循环。
> **测试**：`events-http` +2（默认 FileStore ack 不误报、配置损坏 400）、`events-project-resolver` +1（symlink）、`events-store-file` +1（并发幂等/seq）；`events-store-memory`/`events-store-pg` 补秒级 `since` 断言；`npm run build && npm test && npm run lint` → 全量 **1752 绿**，lint 0 error（2 条既有 warning）。

### 13.139 实施记录：MCP initialize instructions

> 2026-10-20。`src/server.ts` 的 `createServerForRuntime()` 在 `Server` 选项里返回 `instructions`，stdio 与 HTTP 两个入口共用同一份说明，客户端 `initialize` 后可直接向 agent 注入服务定位（此前只有 npm `package.json` description，客户端不可见）。
> **内容**：AOS × ARTEMIS 统一服务；Android 设备/模拟器与 iOS 设备/模拟器；Figma/.pen 设计到用例、回归、Jira 验单、项目档案；`aos_status` 自检；`mobile_run_task`/`mobile_manage_task`/`mobile_get_device_state`/`mobile_inspect_trace` 的用途；`device_serial` 兼容 Android serial 与 iOS UDID；多设备先问用户、不猜测；工具异常先 `mobile_diagnose`；凭证项目级、不回显密钥；设计结论需真机核验。
> **测试**：新增 `test/server-instructions.test.js`（in-memory initialize 断言说明非空且含 Android/iOS/workflow/mobile/.artemis 关键词）；`npm run build && npm test && npm run lint` → 全量 **1753 绿**，lint 0 error（2 条既有 warning）。

### 13.140 实施记录（P1 第 1 批）：seq 游标、长轮询与消费态

> 2026-10-20。P1 的“无丢失轮询 + consumed_at 消费态”先落地；反馈规则/历史迁移/fsync 仍待实施。
> **查询**：`ProjectEventQuery.afterSeq`（非负整数，`seq > afterSeq`）与 `consumed`（true=已消费/false=未消费）在 PG/file/memory 三实现一致；`EventList.nextSeq` 为本页最大 seq（空页回显 `afterSeq`），作为下一轮游标。
> **长轮询**：`pollProjectEvents` 在无事件时每 250ms 重查，最长 `waitMs` 30s；`GET /events/<project>/poll?afterSeq=&waitMs=&consume=`（GET-only；客户端断开经 `res.close` 中止）与原生工具 `aos_event_poll` 共用。
> **消费态**：`markProjectEventsConsumed` 幂等写入 `consumed_at`（PG 单条 UPDATE、file 原子重写、memory 就地）；`consume:true` 时返回事件带 `consumedAt`，重复消费返回 0。
> **fsync**：`AOS_EVENTS_FSYNC=1` 时文件事件追加、消费态/裁剪重写后对 events json/meta 执行 fsync（默认关，保持 ack 延迟优先）。
> **兼容**：`GET /events/<project>` 保持原语义，新增 `afterSeq/consumed` 参数与 `nextSeq` 字段；`since` 的同毫秒窗口仍只用于展示，游标轮询用 `seq`。
> **测试**：三存储补 `afterSeq`/`consumed` + 非法值断言；ingress 补“空页→等待→新事件”与消费幂等；HTTP 补 `/poll` 长轮询、`consume` 与 400/405；file 补 `AOS_EVENTS_FSYNC=1` 写入；工具补注册与游标推进；全量 **1756 绿**，lint 0 error（2 条既有 warning）。

