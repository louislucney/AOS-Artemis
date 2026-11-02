# Runner 控制面：执行机只连中心 HTTP，不直连数据库

中心当前把 PostgreSQL 同时当作协调面（runner 心跳、任务领取、设备租约、状态机）和数据面（面板、资产、结果）。`suite runner` 与 `web-runner` 启动时直接 `openCenterStore()`，因此每台执行机都必须持有中心 PG 连接串；`PostgresStore.create()` 还会执行幂等建表/迁移，执行机实际需要 DDL 权限。对不在可信内网的设备池，这是过大的信任边界。

本 ADR 决定新增一套**中心侧 runner 控制面 HTTP API**，把协调操作收敛到中心进程；执行机只持控制面地址与 runner 令牌。首个落地范围是 `web-runner`；`suite runner` 使用本地 FileStore + 中心 suite 资源 API（不是任意 `ProjectStore` RPC），已去掉 PG 依赖；定时回归、审计与显式租约令牌也走该 API。

## Decision

1. **新增控制面 API**（`/panel/api/runners/*`），至少覆盖：
   - 注册/心跳：主机身份、设备清单、工具、版本、队列暂停、取消指令；
   - 领取：按设备领取 web job；服务端内部完成选机、预占、过期回池与失联回收；
   - 租约：续租/释放，响应带服务端时间与租约过期时间；
   - 任务生命周期：`begin` / `progress` / `terminal` / `cancel-ack` / `release`；
   - `stop`：优雅停机，标记 runner 实例陈旧。
2. **保留现有数据面接口**：`GET /panel/api/jobs/:id/spec`、`GET /panel/api/jobs/:id/assets/:assetId`、`POST /panel/api/jobs/:id/results` 不变；大文件与结果不经过控制面。
3. **web 控制面不做 `ProjectStore` 的 HTTP 代理**：窄命令协议，服务端持有状态机与事务。suite 侧提供 **suite 资源 API**（`/panel/api/runners/suite/*`，host/项目校验），覆盖任务、任务包、用例集、run、租约、runner 注册、定时回归与审计；HTTP handler 只做鉴权/路由，领域逻辑集中在 `SuiteControlService` 的 typed 方法；不是通用存储代理，旧的 `/suite/op` 已移除。
4. **契约单一来源**：`src/runner/control/contract.ts` 用 Zod 定义请求/响应，`z.infer` 推导类型；路由、处理器、客户端共享同一份 schema。
5. **鉴权**：优先每主机 token（`AOS_RUNNER_HOST_TOKENS=[{hostId,token}]` 或 `AOS_RUNNER_HOST_TOKENS_FILE` 文件（0600；mtime 热加载；优先于 env，建议用 `scripts/write-runner-tokens.mjs` 原子替换）；`X-AOS-Host-Id` 必须等于 token 所属主机，否则 403；token ≥16）；未配置时回退全局 `MOBILE_TESTING_RUNNER_JOB_TOKEN` + `X-AOS-Host-Id` 兼容模式。控制面不读取管理员令牌，也不受 `AOS_PANEL_ACTIONS=0` 影响；持久化 token 表仍是后续项。
6. **兼容路径**：未配置 `AOS_RUNNER_CONTROL_URL` 时，`web-runner` 仍走现有直连 PG 路径（中心本机/内网过渡）；配置后不要求 `MOBILE_TESTING_DATABASE_URL`。两条路径共用同一份 service 逻辑，避免行为漂移。
7. **服务端调度权**：`assignPendingWebJobs`、`reassignExpiredWebJobs`、`recoverStaleWebJobs` 从 runner 移到控制面心跳/领取处理。否则执行机仍需直连 PG 才能选机与回收。
8. **范围**：`suite runner` 已可通过 `AOS_RUNNER_CONTROL_URL` 使用「本地 FileStore + 中心 suite 资源 API」运行（任务读取/状态、case set、run 登记/基线、租约、runner 注册/停止、stopping 清扫、定时回归窗口、审计）；`/suite/op` 已移除。未配置控制面时仍直连 PG。
9. **TLS/mTLS**：`serve --http` 可用 `AOS_HTTP_TLS_CERT`/`KEY` 直接终止 HTTPS，`AOS_HTTP_TLS_CA` + `AOS_HTTP_MTLS=1` 要求客户端证书；runner 用 `AOS_RUNNER_TLS_CA`/`CERT`/`KEY` 携带 CA/客户端证书。支持 CRL 与按间隔证书热加载、TLS 上 HTTP/2+HTTP/1.1；OCSP stapling 由前置代理完成（示例 `deploy/nginx/aos-mtls.conf`）。

## Contract sketch

```ts
type WebHeartbeatAck = {
  runnerId: string;
  queuePaused: boolean;
  cancelTaskIds: string[];
  leaseLostTaskIds: string[];
  assigned: number;
  reassigned: number;
  recovered: number;
  serverTime: string;
};

type WebClaimResult =
  | { kind: "claimed"; task: WebJobTask; projectSlug: string; maxAttempts: number }
  | { kind: "idle" }
  | { kind: "paused" }
  | { kind: "exhausted"; taskId: string; projectSlug: string };
```

web-runner claim 现在返回 `leaseToken = HMAC(runner token, hostId|taskId|serial)`；`leases/renew|release` 必须回传，服务端常数时间比较后执行，不新增数据库列。suite 资源 API 的 `leases/renew|release` 同样校验每个 serial 的 `leaseTokens`（客户端按同一 HMAC 规则派生）；acquire 仍由行/任务校验。独立持久化 token 列仍是后续项。

## Consequences

- 执行机不再需要 PG 凭据；中心仍是唯一写入方，PG 只部署在中心。
- `web-runner` 的控制面调用频率：心跳 30s、空闲领取按 `AOS_RUNNER_POLL_MS`（默认 5s）；后续可加长轮询/批量领取。
- 每主机 token 通过中心进程 env `AOS_RUNNER_HOST_TOKENS` 或 `AOS_RUNNER_HOST_TOKENS_FILE` 提供（JSON 数组，文件按 mtime 热加载；不落项目 `.env`）；web/suite/job 三类路由共用同一鉴权。
- 服务端 handler 必须做 host 绑定与状态 CAS 校验，不能信任客户端上报的 `taskId`/`runnerId`；失败返回类型化错误（401/403/409）。
- 现有直连 PG 的测试与部署不变；新增 HTTP 路径需独立测试（假 fetch + MemoryStore），不依赖真实网络/PG。
- 配置控制面后，`suite runner` 也不再打开 PG；suite 使用资源 API。未配置控制面时仍是有 DB 凭据的执行机。
