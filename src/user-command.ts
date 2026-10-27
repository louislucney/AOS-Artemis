import type { StoredAuthUser } from "./auth.js";
import {
  activeAdminCount,
  addStoredUser,
  defaultUsersFile,
  enableStoredUser,
  listStoredUsers,
  revokeStoredUser,
  rotateStoredUser,
  setStoredUserRole
} from "./auth/users.js";
import { PANEL_ROLE_LABELS } from "./panel/roles.js";
import { errorMessage } from "./util.js";

interface ParsedFlags {
  positional: string[];
  get: (key: string) => string | null;
  bool: (key: string) => boolean;
}

function parseFlags(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }
  return {
    positional,
    get: (key) => {
      const value = flags.get(key);
      return typeof value === "string" ? value : null;
    },
    bool: (key) => {
      const value = flags.get(key);
      return value !== undefined && value !== "false";
    }
  };
}

export interface UserCliDeps {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
}

export function printUserUsage(log: (line: string) => void): void {
  log(`mobile-testing-mcp user — HTTP 命名用户生命周期（令牌只存 SHA-256）

Usage:
  mobile-testing-mcp user add <name> --role <viewer|dispatcher|maintainer|admin> [--token <token>]
       [--file <path>] [--json]
       新增用户；未提供 --token 时自动生成，令牌仅在本次输出显示一次
  mobile-testing-mcp user list [--file <path>] [--json]
       列出用户（含已吊销；不含令牌与 hash）
  mobile-testing-mcp user revoke <name> [--file <path>] [--json] [--allow-last-admin]
       吊销用户（保留记录、令牌立即失效；HTTP 服务热加载，无需重启）
  mobile-testing-mcp user enable <name> [--file <path>] [--json]
       重新启用已吊销用户（清除 disabled；令牌不变、立即生效）
  mobile-testing-mcp user role <name> --role <role> [--file <path>] [--json] [--allow-last-admin]
       修改角色（保留令牌/吊销状态；降级最后一个启用管理员需显式 --allow-last-admin）
  mobile-testing-mcp user rotate <name> [--file <path>] [--json]
       轮换令牌（仅显示一次；不改变角色与吊销状态）
common:
  --file <path>   用户文件（默认 $AOS_HTTP_USERS_FILE 或 ~/.aos/http-users.json）
  --allow-last-admin  允许 revoke/role 把启用中的管理员降为零（break-glass）
exit codes: 0 成功 / 1 操作失败（文件非法、用户不存在、最后一个管理员等） / 2 用法错误`);
}

function usageError(errorLog: (line: string) => void, message: string): number {
  errorLog(message);
  printUserUsage(errorLog);
  return 2;
}

export function runUserCommand(argv: string[], deps: UserCliDeps = {}): number {
  const log = deps.log ?? ((line: string) => console.log(line));
  const errorLog = deps.errorLog ?? ((line: string) => console.error(line));
  if (argv.includes("-h") || argv.includes("--help")) {
    printUserUsage(log);
    return 0;
  }
  const flags = parseFlags(argv);
  const action = flags.positional[0];
  if (action === undefined || action === "help") {
    printUserUsage(log);
    return action === undefined ? 2 : 0;
  }
  const file = (flags.get("file") ?? defaultUsersFile(deps.env ?? process.env)).trim();
  if (file === "") return usageError(errorLog, "--file 不能为空");
  const json = flags.bool("json");
  const name = flags.positional[1]?.trim() ?? "";

  const output = (payload: Record<string, unknown>, lines: string[]): void => {
    if (json) log(JSON.stringify(payload, null, 2));
    else for (const line of lines) log(line);
  };
  const guardLastAdmin = (
    users: StoredAuthUser[],
    target: StoredAuthUser | undefined,
    keepsAdmin: boolean
  ): boolean => {
    if (
      target === undefined ||
      target.disabled === true ||
      target.role !== "admin" ||
      keepsAdmin ||
      activeAdminCount(users) > 1 ||
      flags.bool("allow-last-admin")
    ) {
      return false;
    }
    errorLog(
      `拒绝把最后一个启用的管理员（${target.name}）降级/吊销：会锁死管理面；如已确认，加 --allow-last-admin。`
    );
    return true;
  };

  try {
    switch (action) {
      case "add": {
        if (name === "") return usageError(errorLog, "用法：user add <name> --role <role>");
        const role = flags.get("role");
        if (role === null || role.trim() === "") {
          return usageError(errorLog, "user add 需要 --role <viewer|dispatcher|maintainer|admin>");
        }
        const token = flags.get("token") ?? undefined;
        const added = addStoredUser(file, { name, role, token });
        output(
          {
            ok: true,
            action: "add",
            file,
            user: { name: added.user.name, role: added.user.role },
            token: added.token
          },
          [
            `已添加用户 ${added.user.name}（角色 ${added.user.role} / ${PANEL_ROLE_LABELS[added.user.role]}）：${file}`,
            `令牌（仅显示一次，请立即保存）：${added.token}`
          ]
        );
        return 0;
      }
      case "list": {
        const users = listStoredUsers(file);
        output(
          {
            ok: true,
            action: "list",
            file,
            users: users.map((user) => ({
              name: user.name,
              role: user.role,
              disabled: user.disabled === true,
              createdAt: user.createdAt ?? null,
              updatedAt: user.updatedAt ?? null
            }))
          },
          users.length === 0
            ? [`用户文件无用户：${file}`]
            : [
                `用户（${file}）：`,
                ...users.map(
                  (user) =>
                    `- ${user.name}  角色=${user.role}（${PANEL_ROLE_LABELS[user.role]}）` +
                    `  状态=${user.disabled === true ? "已吊销" : "启用"}` +
                    (user.updatedAt === undefined ? "" : `  更新=${user.updatedAt}`)
                )
              ]
        );
        return 0;
      }
      case "enable": {
        if (name === "") return usageError(errorLog, "用法：user enable <name>");
        const enabled = enableStoredUser(file, name);
        if (enabled === null) {
          errorLog(`用户不存在：${name}（${file}）`);
          return 1;
        }
        output(
          {
            ok: true,
            action: "enable",
            file,
            user: { name: enabled.name, role: enabled.role, disabled: false }
          },
          [`已启用用户 ${enabled.name}（角色 ${enabled.role}；令牌未变、立即生效）：${file}`]
        );
        return 0;
      }
      case "role": {
        if (name === "") return usageError(errorLog, "用法：user role <name> --role <role>");
        const role = flags.get("role");
        if (role === null || role.trim() === "") {
          return usageError(errorLog, "user role 需要 --role <viewer|dispatcher|maintainer|admin>");
        }
        const normalized = role.trim().toLowerCase();
        if (!(normalized in PANEL_ROLE_LABELS)) {
          errorLog("role 必须是 viewer/dispatcher/maintainer/admin");
          return 1;
        }
        const users = listStoredUsers(file);
        const target = users.find((user) => user.name === name);
        if (guardLastAdmin(users, target, normalized === "admin")) return 1;
        const updated = setStoredUserRole(file, name, normalized);
        if (updated === null) {
          errorLog(`用户不存在：${name}（${file}）`);
          return 1;
        }
        output(
          {
            ok: true,
            action: "role",
            file,
            user: { name: updated.name, role: updated.role, disabled: updated.disabled === true }
          },
          [
            `已更新用户 ${updated.name} 的角色为 ${updated.role}（${PANEL_ROLE_LABELS[updated.role]}）；令牌不变、HTTP 热加载：${file}`
          ]
        );
        return 0;
      }
      case "revoke": {
        if (name === "") return usageError(errorLog, "用法：user revoke <name>");
        const users = listStoredUsers(file);
        const target = users.find((user) => user.name === name);
        if (guardLastAdmin(users, target, false)) return 1;
        const revoked = revokeStoredUser(file, name);
        if (revoked === null) {
          errorLog(`用户不存在：${name}（${file}）`);
          return 1;
        }
        output(
          { ok: true, action: "revoke", file, user: { name: revoked.name, role: revoked.role } },
          [`已吊销用户 ${revoked.name}；令牌立即失效（HTTP 服务热加载，无需重启）：${file}`]
        );
        return 0;
      }
      case "rotate": {
        if (name === "") return usageError(errorLog, "用法：user rotate <name>");
        const rotated = rotateStoredUser(file, name);
        if (rotated === null) {
          errorLog(`用户不存在：${name}（${file}）`);
          return 1;
        }
        output(
          {
            ok: true,
            action: "rotate",
            file,
            user: {
              name: rotated.user.name,
              role: rotated.user.role,
              disabled: rotated.user.disabled === true
            },
            token: rotated.token
          },
          [
            `已轮换用户 ${rotated.user.name} 的令牌${rotated.user.disabled === true ? "（该用户仍处于已吊销状态）" : ""}：${file}`,
            `新令牌（仅显示一次，请立即保存）：${rotated.token}`
          ]
        );
        return 0;
      }
      default:
        return usageError(
          errorLog,
          `未知 user 子命令 "${action}"（支持 add/list/revoke/rotate）`
        );
    }
  } catch (error) {
    errorLog(`user ${action} 失败：${errorMessage(error)}`);
    return 1;
  }
}
