# CMS 开放服务 API

Base URL（调试环境）：`http://192.168.102.165:8780`

- 当前 CORS：`*`（回显实际 Origin）；Host 白名单：`192.168.102.165`、`louisdeMacBook-Pro.local`、loopback
- 默认无鉴权；设置 `--token` 或 `AOS_CMS_OPEN_TOKEN` 后，除 `GET /healthz` 与 CORS 预检外需 `Authorization: Bearer <token>`（缺失/错误 → 401 `unauthorized`）
- JSON body ≤ 1 MB；multipart 单文件 ≤ 50 MB、总量 ≤ 55 MB
- 并发 3、队列 20、单任务 10 分钟无进度超时、产物保留 2 小时；任务台账落 `workRoot/jobs.json`，进程重启后运行中/排队任务标记 `job_interrupted`，已完成任务在保留期内仍可查询/下载
- 可选限流：`--rate-limit <n>` 或 `AOS_CMS_OPEN_RATE_LIMIT`（每客户端每分钟请求上限，0=关闭）；超限返回 429 `rate_limited` 与 `Retry-After` 秒数，`GET /healthz` 不计入

## 通用端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/jobs` | 创建任务，返回 `202 {"jobId":"..."}` |
| GET | `/jobs/{jobId}` | 状态 / 步骤 / 错误 |
| DELETE | `/jobs/{jobId}` | 取消 |
| GET | `/jobs/{jobId}/download` | 下载 zip |
| GET | `/healthz` | 健康检查，返回 `{"ok":true,"bootId":"..."}` |

---

# 一、Figma

## 方式 A：JSON（推荐）

```jsonc
{
  "source": {
    "type": "figma",
    "url": "https://www.figma.com/design/<fileKey>/<name>?node-id=1-2",
    "token": "figd_xxx",
    "nodeId": "1:2"
  },
  "llm": {
    "baseUrl": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    "apiKey": "sk-xxx"
  },
  "maxFlows": 10,
  "maxDepth": 30,
  "staticFallback": true
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `source` | 对象 | 是 | JSON 模式必须是对象；不能只写 `"figma"` |
| `source.type` | 字符串 | 是 | 固定 `figma` |
| `source.url` | 字符串 | 是 | Figma `file` / `design` 链接 |
| `source.token` | 字符串 | 否 | 本次请求的 Figma REST token；省略时回退服务进程的 `FIGMA_ACCESS_TOKEN` |
| `source.nodeId` | 字符串 | 否 | 限定节点，如 `1:2`；URL 里的 `node-id=1-2` 会自动转成 `1:2` |
| `llm` | 对象 | 否 | 三项必须同时非空：`baseUrl` / `model` / `apiKey`；用于注释解析、功能命名、视觉识别 |
| `llm.baseUrl` | 字符串 | 是（若传 llm） | OpenAI 兼容端点 |
| `llm.model` | 字符串 | 是（若传 llm） | 模型名 |
| `llm.apiKey` | 字符串 | 是（若传 llm） | key，只在请求生命周期内使用 |
| `maxFlows` | 数字 | 否 | 最大用例条数，默认 10 |
| `maxDepth` | 数字 | 否 | 路径最大深度，默认 30 |
| `staticFallback` | 布尔 | 否 | 无原型交互时是否按箭头/注释/画布顺序合成，默认 `true` |

### Figma 处理顺序

1. 原型交互边优先（`explicit` / `high`）
2. 没有原型边 → 静态合成：箭头/连线 → 画板旁文字注释 → 画布顺序（`inferred` / `low`）
3. 截图默认生成，落 `screens/figma-<fileKey>/`
4. `design.md` 来自 `flow-map.md`，静态推断会标注“需复核”

### Figma 失败码

| code | 场景 |
|---|---|
| `figma_auth` | 401/403、token 无效 |
| `figma_not_found` | 404、坏 URL、fileKey 不存在 |
| `figma_rate_limit` | 429 / 冷却中 |
| `figma_extract_failed` | 其他提取失败 |

## 方式 B：multipart（需要上传 Excel 模版时）

```bash
curl -s http://192.168.102.165:8780/jobs \
  -F 'source={"type":"figma","url":"https://www.figma.com/design/<key>/<name>","token":"figd_xxx"}' \
  -F 'llm={"baseUrl":"https://api.deepseek.com/v1","model":"deepseek-chat","apiKey":"sk-xxx"}' \
  -F 'template=@company-template.xlsx' \
  -F 'staticFallback=true'
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `source` | 文本 | 是 | JSON 字符串，或直接 `figma` |
| `sourceType` | 文本 | 否 | `source` 的别名 |
| `figmaUrl` | 文本 | Figma 时 | 当 `source=figma` 时可分开传 |
| `figmaToken` | 文本 | 否 | 同上 |
| `figmaNodeId` | 文本 | 否 | 同上 |
| `llm` | 文本 | 否 | JSON 字符串 |
| `template` | 文件 | 否 | `.xlsx` 用例模版 |
| `maxFlows` / `maxDepth` | 文本 | 否 | 数字 |
| `staticFallback` | 文本 | 否 | `true` / `false` |

---

# 二、.pen

**必须用 multipart**，JSON 模式无法携带文件。

```bash
curl -s http://192.168.102.165:8780/jobs \
  -F 'source=pen' \
  -F 'llm={"baseUrl":"https://api.deepseek.com/v1","model":"deepseek-chat","apiKey":"sk-xxx"}' \
  -F 'penFile=@design.pen' \
  -F 'template=@company-template.xlsx'
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `source` | 文本 | 是 | `pen`，或 `{"type":"pen"}` |
| `penFile` | 文件 | 是 | `.pen` 文件，≤50 MB；`@` 后是调用方本机路径 |
| `llm` | 文本 | 否 | JSON 字符串；提供且模型支持视觉时做元素识别，否则 `vision-*` 降级警告 |
| `template` | 文件 | 否 | `.xlsx` 模版 |
| `maxFlows` / `maxDepth` | 文本 | 否 | 数字 |

## 依赖与行为

- 渲染/截图使用**服务机登录态**：`pen login` 或进程环境 `PEN_CLI_KEY`，不按请求传 pen key
- 任务开始前预检 `pen` CLI 可用性与登录状态；未就绪 → `pen_unavailable`
- 流程按 `.pen` 标签/状态/画板排布推断，推断边 `INFERRED`
- 截图落 `screens/pen-<文件名>/`
- 当前服务机状态：`/usr/local/bin/pen 0.3.10`，`Status ● Active`（tclulouis@gmail.com）

## Pen 失败码

`pen_unavailable` / `pen_extract_failed`。

---

# 三、状态与下载

```json
{
  "jobId": "<uuid>",
  "id": "<uuid>",
  "status": "queued | running | done | failed | cancelled",
  "step": "queued | extracting | generating | packaging | done | failed | cancelled",
  "createdAt": "2026-10-22T02:00:00.000Z",
  "finishedAt": null,
  "error": null,
  "cancelRequested": false
}
```

- 状态响应不返回服务端绝对路径；下载统一走 `GET /jobs/{jobId}/download`
- `error` 失败时为 `{ "code": "...", "message": "...", "hint": "..." }`
- 未知 job：`404 {"code":"job_not_found","hint":"请重新提交生成任务"}`
- 服务重启：运行中/排队任务变为 `failed`（`error.code="job_interrupted"`）；已完成任务在保留期内仍可查询/下载
- 未完成下载：`409 {"code":"job_not_ready"}`
- 产物过期：`410 {"code":"job_expired"}`

## zip 内容

```
design.md      # 设计流程理解（含截图引用）
cases.xlsx     # 测试用例
screens/...    # 截图
meta.json      # source/model/maxFlows/maxDepth/counts/warnings
```

---

# 四、错误码汇总

| HTTP | code | 场景 |
|---|---|---|
| 400 | `invalid_request` | 缺字段、JSON/LLM 格式错、数字非法 |
| 400 | `invalid_source` | 缺 figmaUrl / penFile，或类型不支持 |
| 403 | `forbidden` | `Origin` 不在 CORS 白名单，或 `Host` 不在允许列表 |
| 401 | `unauthorized` | 已启用 `--token`，但缺少/错误的 `Authorization: Bearer` |
| 404 | `job_not_found` | job 不存在或服务已重启 |
| 409 | `job_not_ready` | 未完成就下载 |
| 410 | `job_expired` | 产物已过期 |
| 413 | `payload_too_large` | 超过 body/文件上限 |
| 429 | `queue_full` | 队列已满 |
| 429 | `rate_limited` | 超过每客户端每分钟请求上限（响应带 `Retry-After`） |
| 500 | `internal` | 未预期错误 |

任务执行失败不改变 HTTP 状态：`GET /jobs/{id}` 返回 `status=failed`，`error.code` 可能为：

`figma_auth` / `figma_not_found` / `figma_rate_limit` / `figma_extract_failed` / `pen_unavailable` / `pen_extract_failed` / `generation_failed` / `no_cases` / `template_invalid` / `job_timeout` / `job_interrupted` / `cancelled`。

---

# 五、Excel 模版

- 有 `{{case.*}}` / `{{index}}` → 占位符填充
- 无占位符 → 表头映射
  - 必需：`用例名称`、`操作步骤`、`预期结果`
  - 可选：`用例编号`、`功能`、`前置条件`、`优先级`
  - 别名：`用例标题`→`用例名称`、`步骤`→`操作步骤`、`预期`→`预期结果`
  - 缺必需列 → `template_invalid`，任务 failed

---

# 六、最小调用流程

```bash
JOB=$(curl -s http://192.168.102.165:8780/jobs \
  -H 'Content-Type: application/json' \
  -d '{"source":{"type":"figma","url":"https://www.figma.com/design/<key>/<name>","token":"figd_xxx"},"llm":{"baseUrl":"https://api.deepseek.com/v1","model":"deepseek-chat","apiKey":"sk-xxx"}}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["jobId"])')

# 轮询
curl -s http://192.168.102.165:8780/jobs/$JOB

# 下载
curl -OJ http://192.168.102.165:8780/jobs/$JOB/download
```
