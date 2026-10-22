# CMS 开放服务 API

Base URL（调试环境）：`http://192.168.102.165:8780`

- 无鉴权；仅建议内网调试。
- 浏览器跨源需要服务端 `--cors` 放行；`Host` 必须命中 `--allowed-hosts` 或 loopback。
- JSON body ≤ 1 MB；multipart 单文件 ≤ 50 MB、总量 ≤ 55 MB。
- 并发 3、队列 20、单任务 10 分钟、产物保留 2 小时；进程重启后 job 丢失。

## POST /jobs

创建生成任务。支持 `application/json` 与 `multipart/form-data`。

### JSON（Figma）

```jsonc
{
  "source": {
    "type": "figma",
    "url": "https://www.figma.com/design/<fileKey>/<name>?node-id=1-2",
    "token": "figd_xxx",          // 可选；Figma REST token
    "nodeId": "1:2"               // 可选；限定节点
  },
  "llm": {                         // 可选；不传则只做确定性合成/命名
    "baseUrl": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    "apiKey": "sk-xxx"
  },
  "maxFlows": 20,                  // 可选，默认 10
  "maxDepth": 30                   // 可选，默认 30
}
```

成功：`202 { "jobId": "<uuid>" }`

### multipart（Figma / .pen + 模版）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `source` | 文本 | 是 | JSON 字符串 `{"type":"figma",...}`，或 `figma` / `pen` |
| `sourceType` | 文本 | 否 | `source` 的别名 |
| `figmaUrl` | 文本 | Figma 时 | 当 `source=figma` 时可直接分开传 |
| `figmaToken` | 文本 | 否 | 同上 |
| `figmaNodeId` | 文本 | 否 | 同上 |
| `llm` | 文本 | 否 | JSON 字符串 `{"baseUrl","model","apiKey"}` |
| `penFile` | 文件 | `.pen` 时 | `.pen` 文件；JSON 模式无法上传，`.pen` 必须用 multipart |
| `template` | 文件 | 否 | `.xlsx` 用例模版 |
| `maxFlows` / `maxDepth` | 文本 | 否 | 数字 |

```bash
curl -s http://192.168.102.165:8780/jobs \
  -F 'source={"type":"pen"}' \
  -F 'llm={"baseUrl":"https://api.deepseek.com/v1","model":"deepseek-chat","apiKey":"sk-xxx"}' \
  -F 'penFile=@design.pen' \
  -F 'template=@company-template.xlsx'
```

## GET /jobs/{jobId}

```jsonc
{
  "jobId": "<uuid>",
  "id": "<uuid>",                  // 兼容字段，同 jobId
  "status": "queued | running | done | failed | cancelled",
  "step": "queued | extracting | generating | packaging | done | failed | cancelled",
  "createdAt": "2026-10-22T02:00:00.000Z",
  "finishedAt": "2026-10-22T02:01:30.000Z", // 未完成时 null
  "error": null,                   // 或 { "code": "...", "message": "...", "hint": "..." }
  "artifactPath": null,            // 完成后的服务端路径（下载请用 download 接口）
  "cancelRequested": false
}
```

未知 job / 服务重启后：`404 { "error": "...", "code": "job_not_found", "hint": "请重新提交生成任务" }`。客户端遇到 404 应停止轮询并提示重新提交。

## DELETE /jobs/{jobId}

- `queued` → 立即 `cancelled`
- `running` → `cancelRequested: true`，在步骤边界协作式中止，完成后为 `cancelled`
- 已终态幂等返回当前状态

## GET /jobs/{jobId}/download

- `200` `application/zip`，`Content-Disposition: attachment; filename="design-tests-<jobId>.zip"`
- `409 { "code": "job_not_ready" }` 未完成
- `410 { "code": "job_expired" }` 产物过期
- `404 { "code": "job_not_found" }`

zip 内容：

```
design.md        # 设计流程理解（静态稿推断会标注需复核）
cases.xlsx       # 测试用例（默认 7 列或调用方模版）
screens/...      # design.md 引用的截图
meta.json        # source/generatedAt/model/maxFlows/maxDepth/counts/warnings
```

## GET /healthz

```json
{ "ok": true, "bootId": "<uuid>" }
```

`bootId` 可用于判断服务是否重启。

## 错误码

| HTTP | code | 场景 |
|---|---|---|
| 400 | `invalid_request` | 缺字段、JSON/LLM 格式错、数字非法 |
| 400 | `invalid_source` | 缺 figmaUrl / penFile，或类型不支持 |
| 403 | `forbidden` | `Origin` 不在 CORS 白名单，或 `Host` 不在允许列表 |
| 404 | `job_not_found` | job 不存在或服务已重启 |
| 409 | `job_not_ready` | 未完成就下载 |
| 410 | `job_expired` | 产物已过期 |
| 413 | `payload_too_large` | 超过 body/文件上限 |
| 429 | `queue_full` | 队列已满 |
| 500 | `internal` | 未预期错误 |

任务执行失败不改变 HTTP 状态：`GET /jobs/{id}` 返回 `status=failed`，`error.code` 可能为 `figma_extract_failed` / `generation_failed` / `no_cases` / `pen_unavailable` / `job_timeout` / `cancelled`。

## Excel 模版

- 有 `{{case.*}}` / `{{index}}` 占位符：按占位符填充。
- 无占位符：按表头映射；必需 `用例名称`、`操作步骤`、`预期结果`；可选 `用例编号`、`功能`、`前置条件`、`优先级`；别名 `用例标题`/`步骤`/`预期` 可用；其它列留空。
- 缺必需列 → 任务 failed，`error.code=template_invalid`。

## 最小调用流程

```bash
# 1) 创建
JOB=$(curl -s http://192.168.102.165:8780/jobs \
  -H 'Content-Type: application/json' \
  -d '{"source":{"type":"figma","url":"https://www.figma.com/design/<key>/<name>","token":"figd_xxx"},"llm":{"baseUrl":"https://api.deepseek.com/v1","model":"deepseek-chat","apiKey":"sk-xxx"}}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["jobId"])')

# 2) 轮询
curl -s http://192.168.102.165:8780/jobs/$JOB

# 3) 下载
curl -OJ http://192.168.102.165:8780/jobs/$JOB/download
```
