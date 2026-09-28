# AOS × ARTEMIS 合并 MCP 服务 — 设计文档

- **版本**: v0.3（容器化多租户 + PostgreSQL 版）
- **日期**: 2026-09-28
- **状态**: 已按新需求（容器部署 / 多项目 / PG 存储 / 全 OpenAI 兼容端点）重构，待实现
- **部署形态**: 容器化部署，挂载共享工作区（如 `/workspace`），为公司内部多个项目提供服务
- **仓库布局**: 三者在同一根目录 —— 本服务源码（根目录 `src/`）、artemis（`artemis/`）、design-context-bridge（`design-context-bridge/`）

> **v0.3 变更摘要**（相对 v0.2）：
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

| # | 目标 | 验收方式 |
|---|------|----------|
| G1 | 单 MCP 入口，聚合 Figma 20 + mobile 5 + llm/配置类工具 | `ListTools` 返回 30+ 工具 |
| G2 | 项目 `.env` 首扫导入（新名优先兼容旧名） | 集成测试：temp 项目 + 内存/PG 存储 |
| G3 | 缺失时 `setup_required` + `aos_configure` 可写入补全 | 工具输出含 `setup_required` / `configure` 成功 |
| G4 | 项目多条 LLM + active 切换（PG 持久化） | 切换后 PG `is_active` 唯一；下个任务用新模型 |
| G5 | Figma token 可选；调用 REST 时缺失则提醒 | 无 token 时 REST 工具返回引导 |
| G6 | 项目信息/任务统计写入 PG；DB 不可用降级不阻断 | `aos_status.db` 状态 + 任务仍可运行 |
| G7 | 任意 CLI 接入（stdio）；传输层可扩展 HTTP | 冒烟测试 + 设计评审 |

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

| 结论 | 证据 |
|------|------|
| artemis 的独立任务运行器支持项目级 LLM 配置覆盖 | `artemis/mcp_server/background/task_runner.py:72-110`（`ARTEMIS_CONFIG_DIR` → `llm-config.override.jsonc`）、`:210-214` |
| 覆盖文件深合并 | `artemis/artemis/config/llm.py:334-373` |
| **artemis `custom` provider = OpenAI 兼容**：key 读 `OPENAI_API_KEY`、端点读 `OPENAI_BASE_URL` | `artemis/artemis/llm/router.py:369-383`（`ModelProvider.OLLAMA/VLLM/CUSTOM` 分支） |
| 用户运行时即 `provider: custom` + `deepseek-flash`（`.env`: `DEEPSEEK_API_KEY` + `OPENAI_BASE_URL`） | `/Users/louis/artemis/config/artemis.jsonc` 本地改动 + `.env` 变量名 |
| 任务进程 detached，任务（含排队）不依赖网关进程 | `artemis/mcp_server/utils/env_utils.py:52-65`、`tools/task_runner.py:445-509` |
| 基础配置将 `object_detector`/`hopper` 钉死为 Google 模型 → 非 Google 需覆盖 | `artemis/config/artemis.jsonc:77-103` |
| Figma 插件硬编码 `localhost:3055` 且 manifest 仅允许该域 | `design-context-bridge/figma-plugin/code.ts:283,394,402`、`manifest.json` |
| PostgreSQL 访问：Node `pg`；测试可用 `pg-mem`（SQL 级模拟） | — |

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

| 来源 | 角色 | 优先级 |
|------|------|--------|
| PostgreSQL `project_llms` | **运行时事实源**（active 指针、多条目、动态修改） | ① |
| 项目 `.env` | 首次导入来源 + 无 DB 时降级运行；Figma token | ② |
| `aos.config.jsonc`（可选高级层） | 多 profile/nodeOverrides/设备固定等精细控制 | ③（条目合并时高于 env、低于 PG） |

---

## 4. 项目配置与 .env 契约

### 4.1 `.env` 契约（新名优先 + 兼容旧名）

| 新变量（优先） | 兼容旧变量 | 说明 |
|----------------|------------|------|
| `AOS_LLM_NAME` | — | 条目名（可选；默认取 model 名） |
| `AOS_LLM_MODEL` | — | 模型名（必填；如 `deepseek-flash`） |
| `AOS_LLM_BASE_URL` | `OPENAI_BASE_URL` | OpenAI 兼容端点（必填；如 `https://api.deepseek.com/v1`） |
| `AOS_LLM_API_KEY` | `DEEPSEEK_API_KEY` → `OPENAI_API_KEY` | 密钥 |
| `FIGMA_ACCESS_TOKEN` | — | 可选；Figma REST 用 |

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
```

降级策略：`AOS_DATABASE_URL` 缺失或连接失败 → `MemoryStore`（会话内有效）+ `aos_status` 警告，**不阻断**任务执行。

---

## 5. 运行时装配（项目 active LLM → artemis）

### 5.1 子进程环境（统一 OpenAI 兼容）

```
<artemis.repo>/.venv/bin/python -m mcp_server     # cwd = <artemis.repo>
env:
  ARTEMIS_STANDALONE=1
  ARTEMIS_CONFIG_DIR=<project>/.artemis            # 生成 llm-config.override.jsonc
  OPENAI_API_KEY=<active 条目的 key>
  OPENAI_BASE_URL=<active 条目的 base_url>
  PYTHONUNBUFFERED/PYTHONUTF8=1；PYTHONPATH=<artemis.repo>
  ADB_DEVICE_SERIAL（若配置）
  （主动删除 ARTEMIS_DAEMON_PORT）
```

`env 指纹` = hash(provider + key + base_url + configDir + deviceSerial)；**模型/label 变化不触发重启**。

### 5.2 生成的 `llm-config.override.jsonc`

```jsonc
{
  "default": {
    "provider": "custom",
    "model": "deepseek-flash",
    "fallback": { "provider": "custom", "model": "deepseek-flash" }
  },
  "nodes": {
    // 非 Google 条目自动重指（v0.3：替代 v0.2 的阻断式 H2；附精度警告）
    "object_detector": { "provider": "custom", "model": "deepseek-flash" },
    "hopper":          { "provider": "custom", "model": "deepseek-flash" }
  }
}
```
若条目显式提供 `nodeOverrides`（来自 config 高级层或 aos_configure 扩展）→ 以显式值为准。

---

## 6. MCP 工具面

### 6.1 新增/变更（zod）

| 工具 | 输入 | 输出要点 |
|------|------|----------|
| `llm_list` | `{}` | 条目列表（name/source/model/baseUrl/key masked/isActive）+ `setupRequired` + 警告 |
| `llm_switch` | `{name, force?}` | 激活条目（PG/内存）；模型下个任务生效；key/base_url 变化触发网关重启（H1 守卫：运行中任务存在时默认拒绝，`force:true` 跳过） |
| `aos_configure` | `{model, baseUrl, apiKey, name?, makeActive?, writeEnv?, figmaToken?}` | 新增/更新条目（PG 或内存）+ 回写项目 `.env`（`AOS_LLM_*`）+ 可选置 active；返回 masked 摘要 |
| `aos_status` | `{}` | 项目、DB 状态、条目数、active、子进程、Figma 桥/就绪性、setup 状态 |
| `aos_tasks` | `{limit?, sync?}` | 任务/调用统计（trace/状态/模型/时间）；默认先向 artemis 同步完成态 |
| `compare_design_and_device` | `{figmaUrl, nodeId?, deviceSerial?}` | 组合工具：Figma 节点渲染图（PNG@2x）+ 真机截图，一并以 image content 返回供多模态比对 |

`setup_required` 语义：无任何可用条目时，`llm_list` 正常返回并带 `setupRequired: true` + 指引；`mobile_run_task` 直接返回结构化 `setup_required` 错误（不调用子进程）；其余 mobile 工具放行。

### 6.2 Figma 20 工具（M2，vendor + zod）

沿用 dcb 工具名；token 解析顺序：PG 项目记录 → `.env`；REST 工具在 token 缺失时返回"请提供 `FIGMA_ACCESS_TOKEN`（或通过 `aos_configure` 写入）"的引导；插件模式不受影响。

### 6.3 mobile 5 工具（代理，schema 透传）

同 v0.2（原样透传，不做 zod 镜像，契约测试锁定）。

### 6.4 任务统计

本服务的 `CallTool` 拦截 `mobile_run_task`：成功后从结果中提取 `trace_id`，向 `task_stats` 记录（项目、trace、model、profile、desc、submitted）。**完成态同步**：后台定时（30s）与 `aos_tasks` 调用时，通过 `mobile_manage_task(status)` 轮询 pending 行，终态（completed/failed/cancelled/orphaned）写回 `finished_at`；网关子进程不在线时跳过本轮，不打断任务。

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
  6) PG 事务：清 active → 置 active；写 .artemis/llm-config.override.jsonc
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

| 项 | 措施 |
|----|------|
| 密钥存储 | 项目 `.env`（gitignore）+ PostgreSQL（**按需求明文**）；工具响应仅 masked；日志不落 key |
| PG 明文风险缓解 | 连接走内网 + TLS；独立 DB/role 最小权限；审计（last_seen/updated_at）；文档明示风险与轮换流程 |
| 多租户隔离 | 一切记录以项目 `root_path` 为键；工具只读写当前项目条目；跨项目访问无路径可寻 |
| dcb 桥（M2） | 端口锁 3055；CORS 收紧；store 前缀命名空间化 |
| 子进程 | 只杀 mcp_server 直接子进程；detached 任务进程不动；启动孤儿清理 |
| 降级 | DB 不可用不阻断；但 `aos_status` 明确警告"条目仅会话内有效" |

---

## 10. 测试策略

| 层 | 内容 |
|----|------|
| 单元 | .env 扫描（新名/旧名/缺项）、entry 合并与 active 决议、configure 写入 .env 的幂等、masked 输出 |
| 存储 | `MemoryStore` 语义测试 + `pg-mem` 跑真实 SQL（schema/upsert/active 唯一/任务记录） |
| 集成 | 假 artemis 子进程：透传/重启/stderr；`setup_required` → `aos_configure` → 切换 → 重启全链路 |
| 契约 | mobile schema 透传逐字节一致 |
| E2E（手动） | 容器内真实项目：首扫导入 → 切 DeepSeek → 真机任务使用新模型 |
| CI | lint + build + node:test（不依赖真实 PG/设备） |

---

## 11. 里程碑

| 阶段 | 内容 | 状态 |
|------|------|------|
| M0 | 脚手架/配置加载/init/doctor | ✅ 已完成（v0.2 基线） |
| M1 | artemis 代理 + 透传/env 装配/重启 + llm 工具 + 退出钩子 | ✅ 已完成（v0.2 基线） |
| **M1.5** | **v0.3 重构：PG 存储层 + .env 首扫导入 + aos_configure + 多条目 active 切换 + 任务统计记录** | ✅ 已完成（56 测试全绿） |
| M2 | Figma 20 工具内嵌（zod）+ 桥补丁 + REST token 引导 | ✅ 已完成（63 测试全绿） |
| M3 | 容器化打包（Dockerfile）+ 客户端安装器 + 真机 E2E | ✅ 已完成（镜像构建 + docker exec 端到端验证：29 工具含容器内 artemis） |
| M4 | HTTP 传输 + 任务状态同步 + 组合工具 | ✅ 已完成（79 测试全绿；HTTP/stdio 双入口实测） |

---

## 12. 风险与未决问题

| 风险 | 影响 | 缓解 |
|------|------|------|
| PG 不可用 | 动态切换/持久化失效 | 降级内存 + 告警；恢复后下次启动重新导入 |
| 明文密钥入库 | DB 泄露面 | 内网/TLS/最小权限/审计；文档提示轮换；后续可加列级加密 |
| 旧名解析歧义（OPENAI_API_KEY 指向别处） | 导入错误 key | 优先级：`AOS_LLM_API_KEY` > `DEEPSEEK_API_KEY` > `OPENAI_API_KEY`；`aos_status` 显示实际采用变量名 |
| 多项目并发写 PG | active 竞态 | 事务内先清后置 + 应用层互斥；后续可加行级锁 |
| 容器内 ADB 设备访问 | 任务不可用 | 镜像含工具链；USB 透传/网络 ADB；doctor 检查 |

**未决**：① 是否引入列级加密（当前按需求明文）；② HTTP 模式下的多用户鉴权（v1 为内网无鉴权 + 项目名约束）。
