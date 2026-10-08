# 05 — .ipa 安装支持

**What to build:** 真机 `app_path` 语义 = 安装本地 `.ipa`（经 appium `mobile: installApp`，需合法签名）；已安装应用/系统 App 路径不变；安装失败返回可行动错误（签名不匹配、设备锁定、ipa 损坏）。模拟器路径不受影响。

**Blocked by:** 04 — 真机执行器与套件。

**Status:** ready-for-agent

- [ ] `mobile_run_task(app_path=xxx.ipa, device_serial=<真机>)` 先安装再执行；安装结果计入任务台账
- [ ] 已安装 app 与系统 App 流程不回归；失败分类（签名/设备/文件）可行动
- [ ] 测试：安装请求形状与错误映射（mock）；真机冒烟人工

## Comments
