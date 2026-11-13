# Android 原生执行层 Phase 0 Spike 运行手册

> 关联：`docs/superpowers/specs/2026-11-09-android-deterministic-executor-design.md` §8 Phase 0
>
> 脚本：`scripts/android-native-spike.mjs`

## 目的

在目标真机上验证原生执行层依赖的底层能力，不接 LLM、不跑业务用例：

1. `ADBKeyboard` 安装与 IME 切换
2. `ADB_INPUT_B64` 中文广播输入
3. UI tree dump 耗时（raw `uiautomator dump` 基线）
4. `visible-to-user` + bounds 过滤后的可见文本断言

## 前置

- Windows runner 已连接目标 Android 设备（当前注册：`10CF6609P900059`）
- `adb` 可用（runner 包内 platform-tools）
- `ADBKeyboard.apk` 可访问
- 目标应用有一个可聚焦的输入框；用 `--package` + `--activity` 启动，`--tap x,y` 聚焦

## 命令

在 Windows runner 的项目目录执行：

```bat
node scripts\android-native-spike.mjs ^
  --device 10CF6609P900059 ^
  --adb "C:\RUNNER\aos-artemis-runner-0.3.27-win32-x64-offline\project\platform-tools\adb.exe" ^
  --adbkeyboard-apk "C:\path\to\ADBKeyboard.apk" ^
  --package com.android.settings ^
  --tap 540,300 ^
  --text "中文测试 AOS" ^
  --expect "中文测试" ^
  --rounds 5 ^
  --json
```

如果目标应用/输入框不同，替换 `--package`、`--activity`、`--tap`、`--text`、`--expect`。

没有 `ADBKeyboard.apk` 时，先手动安装并切换 IME；脚本仍会检查 `com.android.adbkeyboard` 是否存在。

## 输出

```json
{
  "ok": true,
  "device": "...",
  "rounds": 5,
  "input": { "ime": "com.android.adbkeyboard/.AdbIME", "adbKeyboardInstalled": true },
  "dump": { "p50Ms": 420, "p95Ms": 780 },
  "step": { "p50Ms": 900, "p95Ms": 1500 },
  "passes": 5,
  "failures": [],
  "environmentErrors": []
}
```

退出码：

- `0`：全部通过且 p95 门槛达标
- `1`：有轮次失败或 p95 超门槛
- `2`：环境错误（adb/IME/安装/设备）

## 判定

| 指标 | 建议门槛 |
|---|---|
| dump p95 | ≤ 1000ms |
| 稳态单步 p95 | ≤ 2000ms |
| 中文输入 | 5/5 正确 |
| 可见文本断言 | 不可见/屏外不命中 |

不达标时：

- 先换观测工具（uiautomator2/atx-agent 或 Appium UiAutomator2 server）重跑
- 仍不达标则 **不进入 Phase 2**，保留 Artemis + 事后观测门禁

## 注意

- 本脚本的 dump 是 raw `uiautomator dump` 基线，不是最终观测方案；它用于测量最差情况。
- `--tap` 只负责聚焦输入框；如果输入框未聚焦，广播文本不会出现。
- 脚本结束会恢复原 IME；如果进程被强杀，需手动切回。
- 本脚本不修改项目代码/用例，只做环境验证。
