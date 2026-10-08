# 02 — WDA 设备 façade 与会话管理

**What to build:** WebDriver 客户端 + 会话管理 + WDA 设备 façade（与模拟器 façade 同接口：截图/层级/动作/复位）+ XCTest page source XML → `IosUiNode` 解析。完成后真机具备可编程的观测与动作能力（尚未接路由）。

**Blocked by:** 00（spike 确认链路）、01（检测与生命周期）。

**Status:** ready-for-agent

- [ ] WebDriver 客户端：创建/删除会话、`screenshot`（PNG）、`source`（XML）、W3C actions（tap/swipe）、文本输入组合动作（有 `at` 聚焦 → 键盘有界等待 → `typeText`；无键盘给可行动错误；非 ASCII 走 setValue 路径）、`mobile: terminateApp/activateApp`；超时（`AOS_IOS_APPIUM_TIMEOUT_MS`）与错误映射
- [ ] 会话管理：同 UDID 互斥 + FIFO；任务级 lease（finally 释放）；观测会话空闲回收默认 30min（`AOS_IOS_SESSION_IDLE_MS`，0=进程存活期保活）；观测拿锁有界等待（`AOS_IOS_OBSERVE_WAIT_MS` 默认 5s）→ `device_busy` + 最近缓存帧（`capturedAt`/`stale`）；自愈阶梯 best-effort `DELETE` → `POST` →（仅托管模式）有界重启 appium 一次并退避
- [ ] capabilities：`useNewWDA=false` 显式；签名/隧道参数 env 覆盖（`AOS_IOS_WDA_BUNDLE_ID` / `AOS_IOS_XCODE_ORG_ID` / `AOS_IOS_XCODE_SIGNING_ID`）
- [ ] XML 解析：`fast-xml-parser`（新运行时依赖）→ 现有 idb 层级同构；实体/嵌套/自闭合/畸形 fixture；解析失败降级 `hierarchy:"parse_failed"`（只回截图，不阻断）
- [ ] 测试：`test/ios-appium-*.test.js` 全 mock（fetch 打桩、假时钟、假客户端）覆盖会话/互斥/有界等待/自愈/键盘组合动作；不触网不用设备

## Comments

- 2026-10-08 进行中：已完成 `src/ios/appium/xml.ts`（WDA page source → IosUiNode，`fast-xml-parser` + XMLValidator 预校验，畸形输入返回 null）与 `src/ios/appium/client.ts`（WebDriver 客户端：session/截图/source/actions/typeText/键盘状态/terminate/activate/install，错误映射与超时）；测试 `test/ios-appium-{xml,client}.test.js` 9 例，全量 642 绿、lint 干净。待做：会话管理、WDA façade、capabilities/签名注入。
- 2026-10-08 续：会话管理与 façade 完成——`src/ios/appium/session.ts`（同 UDID FIFO 互斥、任务/观测 lease、空闲回收默认 30min、观测有界等待→`IosDeviceBusyError`+缓存帧、markInvalid 清理→重建→可选托管恢复、dispose）与 `src/ios/appium/facade.ts`（IosDevice 全接口：tap/swipe/inputText 键盘组合动作/launch/terminate/openUrl deepLink/nodes（解析失败 `IosHierarchyParseError`）/size/screenshot（noteFrame）/handleAlerts）；测试 `test/ios-appium-{session,facade}.test.js` 12 例。全量 654 绿、lint 干净。待做：capabilities/签名注入（01 接线）与路由集成（03）。
- 2026-10-08 票 00 真机结论回填：`client.typeText` 从 `mobile: typeText`（未实现）改为标准 `POST /session/:id/keys`（`{value:[...chars]}`，真机实测通过）；签名参数 xcodeOrgId 用团队 `Z35S33J39R`；键盘链路与 H1 数据见票 00 Comments。
