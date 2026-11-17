# P0-3 公开历史处置方案（dry-run，2026-11-17）

> 状态：**只生成方案，未执行任何历史重写或 force-push**。
>
> **决策（2026-11-17）：选择 A（接受公开历史暴露 + 账号处置），不执行本方案的历史重写。** 本文保留为备选记录；除非决策变更，不要执行第 3 节。
>
> 关联：[跨端一致性实现审计](cross-platform-consistency-audit-2026-11-16.md) P0-3、[账号处置清单](p0-3-account-disposal-checklist.md)、[iOS 回归追溯](ios-regression-2026-11-13.md)

## 1. 事实

- `origin`：`https://github.com/louislucney/AOS-Artemis.git`
- GitHub API 未认证返回 `"private": false`，仓库**公开**。
- 工作树已脱敏（报告/spec/测试夹具/UDID），但**已推送历史仍含原值**。
- 仓库规模：约 1029 个提交，pack 约 8.5 MiB；重写成本可控。

### 暴露分档

| 档 | 内容 | 涉及提交 | 风险 |
|---|---|---|---|
| T1 | 真实 UAT 邮箱、手机号 | `66d2e75`、`d00302c`、`527729e`、`5af580d` | 高：可直接定位测试账号 |
| T2 | 真实设备 UDID 两个 | 约 15 个提交（2026-10-06 起） | 中低：设备标识，非凭证 |

本文**不复述具体值**；执行时从受控凭证/审计记录中取值，写入本地临时 replacements 文件，不要提交该文件。

## 2. 选项

### A. 接受暴露 + 账号处置（成本最低）

1. 与 App/UAT 团队确认邮箱/手机号是否仍可用；如可用，停用或更换。
2. 按“已泄露”记录，不删除历史。
3. 保留本方案作为决策记录。

适用：测试账号已失效/可轮换，或仓库公开是预期。

### B. 重写公开历史（彻底，但破坏性）

适用：要求历史中不再出现这些值，且能协调所有协作者。

**前提**：仓库所有者确认；冻结推送；通知所有协作者；准备镜像备份。

## 3. 重写步骤（建议在独立 mirror 上执行）

```bash
# 1) 备份（不要跳过）
git clone --mirror https://github.com/louislucney/AOS-Artemis.git \
  ../AOS-Artemis.git.backup-20261117.git

# 2) 在 mirror 上执行
cd ../AOS-Artemis.git.backup-20261117.git
git filter-repo --replace-text /secure/path/replacements.txt

# replacements.txt 由 owner 在受控环境填写（不要提交）：
# literal:<真实邮箱>==><redacted-email>
# literal:<真实手机号>==><redacted-phone>
# literal:<真实 UAT 邮箱>==><redacted-email-2>
# literal:<真实 UDID-1>==>00008101-0000000000000000
# literal:<真实 UDID-2>==>00008110-0000000000000000

# 3) 验证（应无输出）
git log --all -S '<真实邮箱>' --oneline
git log --all -S '<真实手机号>' --oneline
git log --all -S '<真实 UDID-1>' --oneline

# 4) 重新挂远端并强制推送（filter-repo 会移除 origin）
git remote add origin https://github.com/louislucney/AOS-Artemis.git
git push --force --all origin
git push --force --tags origin
```

### 重写后仍需处理

1. **GitHub 缓存/引用**：旧 SHA 可能仍可通过直达链接/PR 引用访问；必要时联系 GitHub Support 清理缓存与失效引用。
2. **协作者副本**：所有 clone/worktree 必须重新 clone 或 `git fetch --all && git reset --hard origin/main`；旧分支会分叉。
3. **分支保护**：强制推送可能需要临时放开；完成后恢复。
4. **账号处置**：即使重写，已抓取/缓存的副本无法保证清除，仍建议停用/轮换 T1 账号。
5. **验证工作树**：`git grep -nE '<真实值>' -- .` 应为空；`scripts/audit-silent-catches` 不受影响。

## 4. 风险与回滚

- 重写会改变**所有提交 SHA**，破坏 fork、PR、外部引用与部分 CI 缓存。
- `git filter-repo` 默认会移除 origin；按上面步骤重新添加。
- 失败回滚：删除重写后的 mirror，重新从 `../AOS-Artemis.git.backup-20261117.git` 克隆；不要在没有备份时操作原仓库。
- **不要**在 CI 或共享工作树上直接执行；由 owner 在受控机器上做。

## 5. 建议

1. 先做 **A 的账号处置**（立即降低风险）。
2. 若 owner 要求历史干净，再执行 **B**（T1+T2 一次替换）。
3. 完成后更新审计报告 P0-3 状态为“已处置”，并记录选择了 A 还是 B。

## 6. 当前状态

- 决策：**A（接受暴露 + 账号处置，不重写历史）**。
- 工作树脱敏：已完成。
- 历史重写：**不执行**（本方案保留为备选）。
- 账号轮换：待 App/UAT 团队按[账号处置清单](p0-3-account-disposal-checklist.md)执行。
