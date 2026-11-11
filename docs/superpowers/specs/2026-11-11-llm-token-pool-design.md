# LLM Token 资源池与按项目/模型/时间计量（v1 设计）

- 日期：2026-11-11
- 状态：Draft（待实现前确认）
- 范围：第一版＝**请求级 token 账本 + token 级硬额度 + 项目级只读统计**；项目级硬配额留到 v2。

## 1. 为什么做

当前 LLM 配置是“项目级条目”（`project_llms`：name/provider/model/baseUrl/apiKey），存在三个问题：

1. 想用一个不在预设目录里的模型时，没有规范的登记入口；没有 token 时也没有明确状态，只会在调用时失败。
2. 多个项目共用同一个真实 key 时无法分账：不知道哪个项目、哪个模型、哪段时间花了多少 token/金额。
3. key 被某个项目刷爆时没有 token 级护栏；也无法在多个 key 之间轮换。

目标不是“再加一个模型下拉”，而是把 **token 作为受控资源**：管理员维护池子，项目引用池子；所有调用记请求级账本；token 有独立预算，项目有独立统计。

## 2. 目标与非目标

### 目标（v1）

- 新增全局 **LLM Token 资源池**：一个池 token＝provider + baseUrl + key（+ 允许的模型）。
- 项目可绑定池 token 的某个模型，或继续使用项目自己的条目（`project_llms`）。
- 模型不在预设目录时，管理员可登记自定义 provider/model/token；没有 token 时状态为 `pending_token`，不静默调用。
- 每次 LLM 请求记录：项目、模型、池 token、prompt/completion/cache token、金额、价格版本、时间、来源。
- 支持按 **项目 × LLM（模型/池 token）× 时间（小时/天/月）** 聚合；项目级只读。
- 池 token 支持周期预算（日/月/总额）的**硬额度**；超额时优先切换同模型其他 token，否则明确失败。
- key 永不出现在工具响应/日志/面板；只能 masked 预览；管理动作可审计。
- **v1 计量范围**：中心代理（runner `AOS_LLM_FROM_CENTER`）+ Node `chat.ts`。本地 Android Artemis 子进程直连厂商的请求不纳入；这类项目继续使用自有 key，不受池预算。使用池 token 的项目必须走中心代理或 Node chat。

### 非目标（v1）

- 不做 provider 账单拉取/对账。
- 不做项目级硬配额（只做统计；v2 再加）。
- 不做按用户/会话的配额。
- 不做自动抓取厂商价格；价格由管理员维护，未知价格显式标记。
- 不做多地域/权重路由、复杂负载均衡；v1 只做优先级+健康降级。
- 不重算历史已发生的工具调用 usage；新账本从功能上线后开始。

### 反目标（做了就算失败）

- 为了“能用”把真实 key 回显到响应、日志或面板。
- 价格未知时按 0 元入账，导致成本看起来正常。
- 额度耗尽后静默换模型/降级能力（例如 reasoner → flash）而没有显式记录。
- 多项目共用 key 时只记总量、不记项目维度。

## 3. 术语与边界

- **Provider preset**：内置 8 家厂商目录（`src/llm/providers.ts`），只是默认 baseUrl/模型别名参考。
- **Pool token**：全局真实凭证；有 owner（管理员）、状态、允许模型、预算、优先级、健康度。
- **Pool binding**：项目 → 池 token + 模型 的绑定；可选择 `pinned`（固定 token）或 `auto`（同模型按优先级/健康度选 token）。
- **Project LLM entry**：现有 `project_llms` 条目；v1 增加可选的 `poolTokenId`，没有 key 时从池解析。
- **Usage event**：一次 LLM 请求（非一次工具调用）的 token/金额记录。
- **Price book**：按 provider/model 的单价表，带生效时间和币种；价格版本写入 usage。

## 4. 数据模型

### 4.1 `llm_pool_tokens`

| 字段 | 说明 |
|---|---|
| `id` | UUID |
| `name` | 唯一展示名（如 `deepseek-prod-1`） |
| `provider` | `custom/openai/...`；不在预设也可 |
| `base_url` | OpenAI 兼容根地址 |
| `api_key` | 真实 key；存储见 §6；只回 masked |
| `key_env` | 可选；部署时从环境变量读取而不是落库 |
| `model_allowlist` | JSON 数组；空＝该端点全部模型 |
| `status` | `active` / `disabled` / `invalid` / `pending_token` |
| `priority` | 数字，越小越优先（与现有 task priority 区分） |
| `budget_period` | `daily` / `monthly` / `total` / `none` |
| `budget_limit_micros` | 额度（微单位，避免浮点）；`null` 不限 |
| `currency` | `CNY` / `USD`，默认取价格表 |
| `rate_limit_per_min` | 可选；v1 只记录/告警，不强制 |
| `last_validated_at` / `last_error` | 最近一次验证/错误 |
| `created_by` / `created_at` / `updated_at` | 审计 |

### 4.2 `llm_pool_bindings`

| 字段 | 说明 |
|---|---|
| `id` | UUID |
| `project_id` | 项目 |
| `pool_token_id` | 池 token |
| `model` | 绑定的模型（必须在该 token allowlist 内） |
| `mode` | `pinned` / `auto` |
| `priority` | 同项目多个绑定的顺序（fallback） |
| `enabled` | 布尔 |
| `created_by` / `created_at` | 审计 |

一个项目同一时间只有一个 active 绑定；`auto` 模式下 token 轮换不改变项目绑定。

### 4.3 `llm_usage_events`

| 字段 | 说明 |
|---|---|
| `id` | UUID（请求幂等键；中心代理可用 upstream request id） |
| `at` | ISO 时间（UTC） |
| `project_id` | 项目；无法归属时为 null（并显式标注） |
| `host_id` / `session_id` | 可选来源 |
| `task_id` / `trace_id` | 可选；runner 请求头透传时记录 |
| `pool_token_id` | 池 token；项目自带 key 时为 null |
| `provider` / `model` | 实际调用 |
| `base_input_tokens` | 标准化：未命中 cache 的输入 token |
| `cache_creation_tokens` / `cache_read_tokens` | 标准化：写/读 cache token |
| `output_tokens` | 标准化：输出 token |
| `total_tokens` | `base_input + cache_creation + cache_read + output` |
| `usage_source` | `provider`（厂商原值）/ `estimated`（预扣估算）/ `partial`（断开时按已收 chunk 估算） |
| `estimated_tokens` / `reserved_micros` | 请求前预扣估算与预留金额 |
| `reservation_id` / `settled_at` | 冻结预留 id / 结算时间；未结算的预留在 reconciler 中处理 |
| `cost_micros` / `currency` | 原币金额与币种；价格未知时 null（但预算按惩罚价预扣） |
| `cost_micros_base` / `base_currency` | 统一本位币金额与币种（项目级聚合只用该字段） |
| `fx_rate_to_base` | 发生时汇率快照 |
| `price_book_id` / `price_version` | 价格版本 |
| `source` | `center_proxy` / `local_chat` / `web_job` / `imported` |
| `request_id` | 厂商 request id（如有） |
| `status` | `ok` / `http_error` / `usage_unavailable` / `settled_estimated` |
| `error_class` | 401/429/402/timeout/disconnect 等 |

索引：`(project_id, at)`、`(pool_token_id, at)`、`(model, at)`、`(reservation_id)`；PG 用 `date_trunc` 聚合。

### 4.4 `llm_price_book`

| 字段 | 说明 |
|---|---|
| `id` / `version` | 版本 |
| `provider` / `model` | 匹配 |
| `currency` | 原币种（CNY/USD） |
| `fx_rate_to_base` | 到部署本位币的汇率快照（`base_currency` 由 `AOS_LLM_COST_CURRENCY` 决定，默认 CNY） |
| `input_micros_per_mtok` / `output_micros_per_mtok` | 每百万 token（base input / output） |
| `cache_read_micros_per_mtok` / `cache_write_micros_per_mtok` | 可选（cache read/write 单独计价） |
| `effective_from` / `effective_to` | 生效区间 |
| `created_by` / `note` | 审计 |

同一 model 同一时间只能有一个生效价；未知价格不写 0，usage 的 `cost_micros=null` 并在面板显示 `unpriced`。**未定价模型在仅有金额预算时按“惩罚单价”（池内同币种最高已知单价或 `AOS_LLM_UNPRICED_MICROS_PER_MTOK`）预扣**，绝不允许绕过预算。

### 4.5 现有 `project_llms` 的兼容

- 增加可选 `pool_token_id`；有值时 `apiKey` 不落项目条目，运行时从池解析。
- `llm_list` 返回 `source: "pool"` + masked key + 预算/状态；`llm_switch` 仍按条目名切换。
- 现有项目条目（自己的 key）保持不变；不做迁移。

## 5. 调用与记账流程

### 5.1 中心代理（runner / AOS_LLM_FROM_CENTER）

1. 从代理 URL 解出项目根路径；按项目 active 绑定选择池 token/model（`pinned` 或 `auto`）。
2. **流式能力探测**：`llm_pool_tokens.supports_stream_usage`（`true/false/unknown`）。只有 `true` 才注入 `stream_options.include_usage`；`unknown` 先做一次非流式/dryRun 探测，探测失败按 `false` 处理，**绝不无条件注入**导致 400。
3. **请求前估算 + 原子预扣**：用 tokenizer（如 `tiktoken` 的 Node 移植；非 OpenAI/Anthropic 无精确 tokenizer 时用保守字符上限）估算 prompt；按 `prompt + max_tokens`（或默认 completion 上限）计算预留 token/金额；估算只用于预扣，最终以真实 usage 多退少补；在 PG 用原子 `UPDATE ... RETURNING`（或 advisory lock）增加 `reserved`，预算比较 `used + reserved`；FileStore 用单进程锁并强制并发上限。达到上限 → 同模型下一 token；全部耗尽 → `402 llm-budget-exhausted`（不静默换模型）。
4. 转发请求（保留 provider adapter 的 `json_schema → json_object` 等特例）。
5. **结算**：非流式直接读 `usage`；流式仅在 `supports_stream_usage=true` 时解析最后一个 usage chunk。拿到真实 usage → 多退少补；客户端中途断开/无 usage → 按预扣值或已收 chunk 估算**强制入账**（`usage_source=estimated/partial`），绝不允许不计预算。
6. **预留 TTL 回收**：超过 `AOS_LLM_RESERVATION_TTL_MS` 未结算的预留在 reconciler 中按估算扣款或释放，释放必须审计；防止僵尸额度耗尽池子。
7. 401/429/402 更新 token 健康度/错误；不自动删除 token；v1 不在单个请求内换 token（避免 SSE/重复计费）。

### 5.2 本地 chat（`src/llm/chat.ts`）

- 现有 `onUsage` 回调接入记账；项目上下文由调用方传入。
- 没有池 token 的项目自带 key：记 `pool_token_id=null`，金额按价格表算，项目维度仍可见。
- 本地模式没有中心代理时，记账写项目台账；多进程并发额度只在 PG 下严格。

### 5.3 时间聚合

- API/CLI 接受 `since/until`、`bucket=hour|day|month`、`groupBy=project|model|token`。
- 返回：tokens（prompt/completion/cache）、cost、currency、请求数、unpriced 计数。
- 默认时区 UTC；面板展示本地时区但 SQL 按 UTC 分桶。
- 保留期：沿用 usage 保留期或独立 `AOS_LLM_USAGE_RETENTION_DAYS`（默认 365，0 不清理）。

## 6. 密钥与权限

- key 只存服务端：PG `llm_pool_tokens.api_key` 或 `key_env` 指向环境变量；文件台账存 `~/.aos/ledger/llm-pool.json`（0600）。
- 所有响应只回 `maskSecret` 预览（如 `****9f53`），不返回原文；日志不打印。
- 角色：
  - `admin`：增删改池 token、价格表、查看 masked；
  - `maintainer`：项目绑定/切换、查看统计；
  - `viewer`：只读统计（key 仍 masked）。
- 审计：`llm.pool.create/update/disable`、`llm.binding.set`、`llm.budget.override`。
- 文件台账快照剥离 key，和现有 `project_llms` 一样靠项目 `.env`/服务文件回填。

## 7. 模型不在预设/没有 token 的规范路径

1. 管理员在“LLM 资源池”新增：
   - provider `custom`（或预设）；
   - baseUrl、模型、key；
   - 保存时验证：`GET {baseUrl}/models` 或一次 1-token chat（可 dryRun）；
   - 成功 → `active`；失败 → `invalid` + `last_error`；
   - 只有模型没有 token → `pending_token`，不允许项目调用，返回明确 `needs-token`。
2. 项目侧在运维页/`llm_list` 看到 `pending_token` 条目，显示“等待管理员补充 token”，而不是调用时 401。
3. 管理员补 token 后验证 → 项目绑定 → `llm_switch`；模型/端点变化按现有语义重启 Artemis 子进程。
4. 自定义模型进入 `llm_models` 的模型列表（复用 `/models` 缓存），项目可切换。

## 8. 切换与降级规则

- 项目 active 绑定优先级高于项目自带条目；`llm_switch` 可切回自带条目。
- `auto` 绑定：同模型按 token priority/健康度选；只换 token，不换模型。
- 同模型 token 全部失败：按绑定的 fallback 顺序尝试下一个 **同模型** 绑定；再失败才使用条目 fallback（现有 `fallback`），且必须在任务/trace 中记录实际模型。
- 禁止静默降级能力模型（reasoner/pro/vision 等）；沿用现有 alias/capability 规则。
- 变更对下一个任务生效；baseUrl/key 变化重启子进程（现有机制）。

## 9. API / CLI / 面板

### MCP 工具（原生 zod，放 `src/tools/native-tools/llm.ts`）

- `llm_pool_list`：tokens（masked）、状态、预算使用、绑定项目数。
- `llm_pool_add` / `llm_pool_update` / `llm_pool_disable`：管理员；`dryRun` 验证。
- `llm_pool_bind`：项目 → token+model；`mode`/priority。
- `llm_usage`：按项目/模型/token/时间聚合；`groupBy`/`bucket`；只读。
- `llm_price_set`：价格表维护（管理员）。

### CLI

- `node dist/cli.js llm pool list|add|update|disable|bind`
- `node dist/cli.js llm usage [--project <dir>|--all] [--model <m>] [--token <id>] [--since ISO] [--until ISO] [--bucket hour|day|month] [--json]`
- 退出码 0/1/2（无数据 0、配置/参数错误 2、预算拒绝 1）。

### 面板

- 运维页新增「LLM 资源池」：token 表（masked key/模型/预算条/状态/最近错误）、价格表、绑定。
- 项目页模型选择：池条目 + 自带条目；显示预算与 `pending_token`。
- 统计：项目 × 模型 × token 的日/月柱状/表格；`unpriced` 显式标记；导出 JSON/CSV。
- 角色控制：非 admin 不显示 key 操作；动作审计。

## 10. 预算与并发

- 周期：`daily`（UTC 00:00 重置）、`monthly`、`total`；`none` 不限制。
- **原子预留是硬额度的前提**：PG 用 `UPDATE llm_pool_budget_counters SET reserved = reserved + $x WHERE ... AND used + reserved + $x <= limit RETURNING ...`（或事务/咨询锁）；Redis `INCRBY` 可选；FileStore 为单进程内存锁 + `max_concurrency`。**没有原子预留就不宣称“硬额度”**。
- 预检比较 `used + reserved`；`budget_tokens` 按标准化 `total_tokens`（base input + cache creation + cache read + output）；金额按 `cost_micros_base`。
- 未定价模型：仅有金额预算时，按**惩罚单价**（同币种池内最高已知单价，或 `AOS_LLM_UNPRICED_MICROS_PER_MTOK`）预扣；仅有 token 预算时按 token 上限。禁止“未定价＝不受限”。
- 并发闸门：每个池 token 有 `max_concurrency`（默认 8）；原子预留失败/队列满时排队或 429，不能无限并发。
- 结算：请求结束用真实 usage 结算；中途断开/超时按预扣或部分估算强制结算；预留 TTL（默认 10min）由 reconciler 清理，释放/扣款都写审计。
- 超额动作：同模型下一 token → 否则 402；不静默换模型；管理员可临时提高/关闭额度（审计）。
- 告警：80%/100% 在面板与 `aos_status` 显示；v1 不发外部通知。
- **多币种**：所有价格写入时带 `fx_rate_to_base`，usage 落 `cost_micros_base`；项目/全局聚合只用本位币字段，禁止直接相加不同币种。

## 11. 迁移与兼容

- PG：新增 4 张表；`project_llms` 加 `pool_token_id` 可空列；迁移幂等。
- FileStore：`~/.aos/ledger/llm-pool.json`（tokens/prices/bindings，0600）+ 项目 ledger 的 usage；启动时读取；不写明文到日志。
- 现有 `usage_events`（工具调用）不变；新 `llm_usage_events` 独立，避免混淆。
- Web LLM 已有的 `tokenUsage/tokenTotals` 可作为 v1 后补导入（`source=imported`），默认不做。
- 没有池 token 时行为与现在完全一致（opt-in）。

## 12. 失败模式与可观测性

- 401/403：token `invalid`，项目请求返回明确错误；不自动删除。
- 429/5xx：token 短冷却 + 同模型下一 token；记录错误。
- 预算耗尽：402 + `llm-budget-exhausted`，面板显示剩余/周期。
- 价格未知：usage 入账 `unpriced`，统计里 token 数与金额分开显示；不得按 0；预算按惩罚价预扣。
- 无项目归属（本地调用没有项目上下文）：`project_id=null` 并告警；不计入任何项目统计。
- 流式能力不支持：不注入 `stream_options`，请求正常转发；用量走预扣+估算结算，状态 `settled_estimated`，绝不免费。
- 客户端中途断开：已收 chunk 可估算则按 `partial` 入账；否则按预扣入账；预留必须结算，不能悬挂。
- 预留超时：reconciler 按 `AOS_LLM_RESERVATION_TTL_MS` 结算/释放并审计；面板显示未结算预留数。
- 多币种：聚合只用 `cost_micros_base`；缺少汇率时该条目标 `fx-missing`，不得混加。
- FileStore 多进程并发：硬额度不保证严格；`aos_status` 显示 `store.kind=file` 时提示；必须配置并发上限。

## 13. 测试策略

- 单元：预算周期/币种/价格版本；token 选择/健康降级；masked key；时间分桶；未知价格。
- 集成（pg-mem + FileStore）：
  - 添加自定义模型+pending token → 绑定被拒 → 补 token → 绑定 → 代理调用 → usage 入账 → 项目/模型/天聚合；
  - 预算耗尽 → 402/切换同模型 token，不换模型；
  - 401/429 健康度与冷却；
  - 代理流式/非流式 usage；
  - 面板/CLI/工具 JSON 形状与权限。
- 不依赖真实厂商：fetch 注入/本地 mock provider。

## 14. 已定与待定

### 已定（用户确认）

- 双层：token 级硬额度 + 项目级只读统计（v1）。
- 统计维度：项目 × LLM（模型/池 token）× 时间。
- 支持不在预设目录的模型与无 token 的规范状态。

### Builder check 后已定的边界（2026-11-11）

1. **绑定表简化**：不新增 `llm_pool_bindings`；复用 `project_llms`，新增 `pool_token_id`、`pool_mode`（`pinned`/`auto`）、`pool_model`。一个项目仍只有一个 active 条目；`llm_switch` 按条目名切换。`pinned`＝固定 token，token 不健康/超额即明确失败；`auto`＝同模型按 token 优先级/健康度选择。fallback 使用现有条目 fallback，不做请求内重试（避免 SSE/重复计费）。
2. **代理权限**：请求体 `model` 与绑定/allowlist 不一致时返回 typed 400，不静默覆盖；只对 `/chat/completions` 做预算与计量，`/models` 等透传不计量；上游 401/429/5xx 只更新 token 健康度并返回错误，v1 不在单个请求内换 token。
3. **FileStore 范围**：池 token/价格存服务级 `~/.aos/ledger/llm-pool.json`（0600）；项目绑定在各自 `project_llms`；usage 在项目台账。FileStore 的 token 级硬额度是单进程 best-effort；严格跨进程额度需要 PG（文档与 `aos_status` 明确）。
4. **预算口径**：池 token 的所有 Node/中心代理请求都受预算；`budget_tokens` 按标准化 `total_tokens`（base input + cache creation + cache read + output）；金额按本位币 `cost_micros_base`；默认周期 `monthly`；默认本位币 `CNY`，可用 `AOS_LLM_COST_CURRENCY` 覆盖；价格表同一模型同一时间只允许一个币种价格，并记录 `fx_rate_to_base`。
5. **Usage 归一协议**：provider adapter 输出统一字段 `base_input_tokens` / `cache_creation_tokens` / `cache_read_tokens` / `output_tokens`，**不做“prompt - cache_read”的通用减法**。OpenAI 的 `prompt_tokens` 含 cached 时，base_input = prompt - cached；Anthropic 的 `input_tokens` 本身就是未命中，cache_creation/read 独立；DeepSeek 用 hit/miss 映射。计费按四个字段分别乘对应单价。
6. **权限**：池管理只在中心 HTTP（admin）或中心 CLI；stdio 项目会话只读本项目 usage，不提供池修改；runner 不暴露池管理工具。
7. **流式**：不无条件注入 `stream_options.include_usage`；每个池 token 有 `supports_stream_usage`（true/false/unknown，unknown 先探测）。只有 true 才注入；否则正常转发，用量按“预扣+估算/部分结算”入账，绝不免费。客户端中途断开按预扣或已收 chunk 估算强制结算。
8. **项目自带 token 入池**：v1 **不做**；项目自己的 `project_llms` 条目继续存在，但不进池、不受池预算。
9. **历史导入**：v1 不导入 Web LLM 历史 tokenUsage；新账本从功能上线后开始。
10. **统计金额**：同时显示 token 与金额；价格未知显示 `unpriced`，不按 0；预算按惩罚价预扣。
11. **原子预留**：PG 用原子 `UPDATE ... RETURNING`/咨询锁增加 `reserved`；FileStore 单进程锁 + `max_concurrency`；没有原子预留就不宣称硬额度。
12. **预留回收**：`AOS_LLM_RESERVATION_TTL_MS`（默认 10min）超时后 reconciler 按估算扣款/释放并审计；面板显示未结算预留。

### 已确认（2026-11-11）

- **v1 只覆盖中心代理 + Node `chat.ts`**。本地 Android Artemis 直连厂商的请求不纳入池/预算；这类项目继续使用自有 key。若未来要覆盖，另做 loopback 计量代理（v2），不在本次范围。

## 15. Provider-neutral 约束（重要）

当前测试环境的默认 DeepSeek 只是临时默认，不是目标形态。池与计量必须 provider-neutral：

- 池 token 支持任意 `provider` + `baseUrl` + `model`；不把 DeepSeek 写进核心逻辑。
- v1 只要求 **OpenAI-compatible HTTP** 端点；非 OpenAI 兼容的原生 SDK 走 provider adapter，后续扩展。
- Provider adapter 负责：请求形状、鉴权头、`usage` 字段归一（prompt/completion/cache 的差异）、`response_format` 支持矩阵、价格表。
- `DeepSeek json_schema → json_object` 只是 adapter 的一个特例，不是池的通用规则。
- 价格表按 provider/model/币种维护，不内置 DeepSeek 价格；默认 DeepSeek 条目仅用于测试。
- UI/CLI/统计文案统一显示 `provider/model`，不显示“默认模型”；模型不在预设目录是正常路径，不是异常。

## 16. 实现拆分（供后续 plan 使用）

0. **Phase 0 破坏性 Spike（先做，未通过不进入 Phase 1）**。
1. Schema/storage：池 token/价格/usage/预算计数器 + migrate + FileStore。
2. Usage 归一协议 + provider adapter fixtures（OpenAI/DeepSeek/Anthropic 的 usage 形状）。
3. 池管理：工具/CLI/面板、密钥 masked、验证、`supports_stream_usage` 探测。
4. 绑定与切换：`project_llms.pool_token_id`、active 解析、子进程重启。
5. 记账：中心代理 usage 捕获/预扣/结算 + 本地 `onUsage` + 价格/汇率计算。
6. 预算：原子预留、并发闸门、未定价惩罚价、预留 TTL reconciler。
7. 统计：本位币聚合 API + CLI + 面板图表/表格。
8. 测试/迁移/文档。

## 17. Phase 0 破坏性 Spike（通过标准）

在写产品代码前，用现有代理/网关做一个最小 spike，必须拿到可复现证据：

1. **不支持 `stream_options` 的端点**
   - 用本地 Ollama/vLLM 或 mock 端点（遇到未知参数返回 400）发流式请求；
   - 代理探测后不注入该参数，请求成功；能力标记落库；
   - 反例：无条件注入导致 400 → 不通过。

2. **客户端中途断开**
   - 流式请求开始后 `kill -9` 客户端，重复 50 次；
   - 每次预留都被结算（真实/部分/估算）或 TTL 后释放，`reserved` 不泄漏；
   - 审计可见，面板未结算预留数回到 0；账单不出现免费请求。

3. **Anthropic Cache 计费**
   - 用官方 usage fixture（`input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens` + `output_tokens`）核对归一化与金额；
   - 与官方账单/手工计算一致；不能用 `prompt - cache_read` 的通用减法。

4. **高并发预算**
   - 小额度 token、50 个并发长请求；
   - 原子预留保证只放行额度内的请求，其余 402/排队；超发不超过一个请求的预留；
   - 无负余额、无超卖。

5. **未定价模型**
   - 只配金额硬额度、不配价格；请求仍被惩罚价预扣/拦截；
   - 不会因为 `cost=null` 绕过预算。

## 18. No-go / 降级条件

- Spike 1 失败：v1 只支持已知 `supports_stream_usage=true` 的端点；其余端点禁用流式或按估算结算，不能无条件注入。
- Spike 2 失败：不能宣称硬额度；必须改为“并发闸门 + 非流式硬额度”，并在 UI 明确。
- Spike 3 失败：Anthropic 等非 OpenAI cache 字段的 provider 标记 `usage-unverified`，只记 token 不记金额，暂不纳入预算。
- Spike 4 失败：硬额度降级为“单请求上限 + 并发闸门”，项目级只读统计仍保留。
- Spike 5 失败：未定价模型禁止启用金额预算，必须配置 `budget_tokens` 或惩罚价。

**原则：失败、断开、协议不支持都必须有确定的账务结果；不能以“记 usage_unavailable”作为免单。**

