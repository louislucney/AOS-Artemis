# 对账观察读取：受控只读 schema 绑定

对账证据（探索命中用的 OCR 标签、归一 taps、屏间转移）经 `src/artemis/android-trace.ts` 只读直读上游 `data_engine.db`。ADR-0003 只约束「失败步骤截图」的来源（必须走上游工具编排），不影响本读取。绑定范围受控：`node:sqlite` 动态加载（Node ≥ 22.5，缺失静默跳过）、只读打开、显式 PRAGMA 列守卫（`steps`: session_id/step_number/action_taken/pre_image_name/post_image_name；`images`: image_name/ocr_result），缺表/缺列/不可读均降级为 `null` 跳过（schema 漂移记 warn，其余静默），不抛错、不影响套件执行；本模块是 AOS 源码中唯一的 SQLite schema 绑定处。

## Considered Options

- 经上游工具面读取（`mobile_inspect_trace` 的 search / view_step_details）：上游返回渲染文本，pre/post 标签集合与归一 tap 坐标无法无损还原，拒绝。
- 等待上游暴露结构化观察读取后再迁移并删除本绑定：记入候选（非本 ADR 义务）。
- 富化读取结果（`{ok, reason}` 而非 `null`）：消费方（对账摄取）只需"有/无"语义，拒绝。

## Consequences

- `data_engine` schema 为增量迁移（无 `user_version`），只能按列探测：上游列改名/迁移会以 warn + 跳过呈现，升级 artemis 子模块时应人工核对；
- 本读取只服务对账证据（不生成硬断言、不参与门禁），静默/降级不改变既有报告口径；
- 若未来上游提供结构化观察读取，删除本绑定并移除本 ADR 的适用性。
