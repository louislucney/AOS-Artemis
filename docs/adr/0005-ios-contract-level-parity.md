# iOS 平台对等：契约层对齐，内部实现可薄

AOS 在 ARTEMIS（Android）之外新增了 iOS 模拟器执行路径。为避免把该路径膨胀成对 ARTEMIS Pro（Planner/Checker/notes/ADB）的重写，平台对等只在工具契约层成立：入参语义、响应字段、产物与闭环（trace/证据/套件/崩溃/报告）同名同形可用；iOS 执行器内部允许是单模型反应式、能力更薄。凡无法等价的差异必须显式（结构化降级标记 + 文档 + 测试），禁止静默忽略参数或返回伪造数据（如跨进程后伪造 stdout_log 路径）。验收设备以 macOS 模拟器为准，真机保持 best-effort、不纳入验收。

## Considered Options

- 完全同形（iOS 复刻 ARTEMIS Pro 的 Planner/Checker/notes）：工作量等于重写 ARTEMIS，且 iOS 无 ADB 等基础设施，拒绝。
- 只修已暴露 bug、其余以文档声明：支撑不了「同一处理流程」目标（suite/evidence/baseline 在 iOS 上断链），拒绝。
