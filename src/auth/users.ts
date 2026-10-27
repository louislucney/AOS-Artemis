import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  generateAuthToken,
  hashAuthToken,
  type AuthUser,
  type StoredAuthUser
} from "../auth.js";
import type { PanelRole } from "../panel/roles.js";

const ROLES: PanelRole[] = ["viewer", "dispatcher", "maintainer", "admin"];

export interface HttpUserFile {
  version: 1;
  users: StoredAuthUser[];
}

export interface UserFileRead {
  users: StoredAuthUser[];
  errors: string[];
}

export function defaultUsersFile(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AOS_HTTP_USERS_FILE?.trim();
  return configured && configured !== ""
    ? path.resolve(configured)
    : path.join(os.homedir(), ".aos", "http-users.json");
}

function validateRole(role: string): role is PanelRole {
  return ROLES.includes(role as PanelRole);
}

function validateName(name: string): string | null {
  return name.trim() === "" ? "name 不能为空" : null;
}

function validateToken(token: string): string | null {
  return token.length < 16 ? "token 至少 16 字符" : null;
}

function parseRecord(raw: unknown, index: number, errors: string[]): StoredAuthUser | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push(`users[${index}] 不是对象`);
    return null;
  }
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const role = typeof record.role === "string" ? record.role.trim().toLowerCase() : "";
  const tokenSha256 = typeof record.tokenSha256 === "string" ? record.tokenSha256.trim() : "";
  if (name === "") errors.push(`users[${index}] 缺 name`);
  if (!validateRole(role)) errors.push(`users[${index}] role 必须是 viewer/dispatcher/maintainer/admin`);
  if (!/^[0-9a-f]{64}$/i.test(tokenSha256)) {
    errors.push(`users[${index}] tokenSha256 必须是 64 位十六进制`);
  }
  if (name === "" || !validateRole(role) || !/^[0-9a-f]{64}$/i.test(tokenSha256)) return null;
  return {
    name,
    role: role as PanelRole,
    tokenSha256: tokenSha256.toLowerCase(),
    ...(record.disabled === true ? { disabled: true } : {}),
    ...(typeof record.createdAt === "string" ? { createdAt: record.createdAt } : {}),
    ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {})
  };
}

export function readUserFile(file: string): UserFileRead {
  if (!fs.existsSync(file)) return { users: [], errors: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (error) {
    return {
      users: [],
      errors: [`用户文件读取失败：${error instanceof Error ? error.message : String(error)}`]
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      users: [],
      errors: [`用户文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`]
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { users: [], errors: ["用户文件顶层必须是对象"] };
  }
  const list = (parsed as { users?: unknown }).users;
  if (!Array.isArray(list)) return { users: [], errors: ["用户文件缺少 users 数组"] };
  const users: StoredAuthUser[] = [];
  const errors: string[] = [];
  const names = new Set<string>();
  const hashes = new Set<string>();
  list.forEach((entry, index) => {
    const user = parseRecord(entry, index, errors);
    if (user === null) return;
    if (names.has(user.name)) errors.push(`用户名字重复：${user.name}`);
    if (hashes.has(user.tokenSha256)) errors.push(`用户令牌 hash 重复：${user.name}`);
    names.add(user.name);
    hashes.add(user.tokenSha256);
    users.push(user);
  });
  return { users, errors };
}

export function writeUserFile(file: string, users: StoredAuthUser[]): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const payload: HttpUserFile = { version: 1, users: [...users].sort((a, b) => a.name.localeCompare(b.name)) };
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(temp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows / 非 POSIX 文件系统忽略 */
  }
}

function loadForWrite(file: string): StoredAuthUser[] {
  const read = readUserFile(file);
  if (read.errors.length > 0) throw new Error(`用户文件非法：${read.errors.join("；")}`);
  return read.users;
}

export function addStoredUser(
  file: string,
  input: { name: string; role: string; token?: string }
): { user: StoredAuthUser; token: string } {
  const name = input.name.trim();
  const nameError = validateName(name);
  if (nameError !== null) throw new Error(nameError);
  const role = input.role.trim().toLowerCase();
  if (!validateRole(role)) throw new Error("role 必须是 viewer/dispatcher/maintainer/admin");
  const token = (input.token ?? generateAuthToken()).trim();
  const tokenError = validateToken(token);
  if (tokenError !== null) throw new Error(tokenError);
  const users = loadForWrite(file);
  if (users.some((user) => user.name === name)) throw new Error(`用户已存在：${name}`);
  if (users.some((user) => user.tokenSha256 === hashAuthToken(token))) {
    throw new Error("令牌已被其他用户使用");
  }
  const now = new Date().toISOString();
  const user: StoredAuthUser = {
    name,
    role: role as PanelRole,
    tokenSha256: hashAuthToken(token),
    createdAt: now,
    updatedAt: now
  };
  users.push(user);
  writeUserFile(file, users);
  return { user, token };
}

export function listStoredUsers(file: string): StoredAuthUser[] {
  return loadForWrite(file).sort((a, b) => a.name.localeCompare(b.name));
}

export function revokeStoredUser(file: string, name: string): StoredAuthUser | null {
  const users = loadForWrite(file);
  const user = users.find((entry) => entry.name === name);
  if (!user) return null;
  user.disabled = true;
  user.updatedAt = new Date().toISOString();
  writeUserFile(file, users);
  return user;
}

export function enableStoredUser(file: string, name: string): StoredAuthUser | null {
  const users = loadForWrite(file);
  const user = users.find((entry) => entry.name === name);
  if (!user) return null;
  if (user.disabled !== true) return user;
  delete user.disabled;
  user.updatedAt = new Date().toISOString();
  writeUserFile(file, users);
  return user;
}

export function setStoredUserRole(
  file: string,
  name: string,
  role: string
): StoredAuthUser | null {
  const normalized = role.trim().toLowerCase();
  if (!validateRole(normalized)) throw new Error("role 必须是 viewer/dispatcher/maintainer/admin");
  const users = loadForWrite(file);
  const user = users.find((entry) => entry.name === name);
  if (!user) return null;
  if (user.role === normalized) return user;
  user.role = normalized;
  user.updatedAt = new Date().toISOString();
  writeUserFile(file, users);
  return user;
}

/** 仅统计启用中的 admin（吊销用户不计），供 CLI 防止把最后一个管理员锁死。 */
export function activeAdminCount(users: StoredAuthUser[]): number {
  return users.filter((user) => user.disabled !== true && user.role === "admin").length;
}

export function rotateStoredUser(
  file: string,
  name: string
): { user: StoredAuthUser; token: string } | null {
  const users = loadForWrite(file);
  const user = users.find((entry) => entry.name === name);
  if (!user) return null;
  const token = generateAuthToken();
  user.tokenSha256 = hashAuthToken(token);
  user.updatedAt = new Date().toISOString();
  writeUserFile(file, users);
  return { user, token };
}

/** HTTP 用户目录：文件按 mtime+size 热加载；非法更新保留上一次有效记录。 */
export class HttpUserDirectory {
  private records: StoredAuthUser[] = [];
  private mtimeMs = -1;
  private size = -1;
  private lastError: string | null = null;

  constructor(
    private readonly file: string,
    private readonly inlineUsers: AuthUser[] = []
  ) {}

  initialize(): string[] {
    this.refresh(true);
    return this.lastError === null ? [] : [this.lastError];
  }

  snapshot(): { plain: AuthUser[]; hashed: StoredAuthUser[]; errors: string[] } {
    this.refresh(false);
    return {
      plain: this.inlineUsers,
      // 含已吊销记录：仅剩吊销用户时认证仍开启（fail closed），不能因过滤而放开匿名访问。
      hashed: [...this.records],
      errors: this.lastError === null ? [] : [this.lastError]
    };
  }

  private refresh(force: boolean): void {
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(this.file);
    } catch {
      if (force || this.mtimeMs !== -1 || this.size !== -1) {
        this.records = [];
        this.mtimeMs = -1;
        this.size = -1;
        this.lastError = null;
      }
      return;
    }
    if (!force && stat.mtimeMs === this.mtimeMs && stat.size === this.size) return;
    const read = readUserFile(this.file);
    if (read.errors.length > 0) {
      // 记录非法文件的 stat，避免每个请求重复解析；保留上一次有效用户。
      this.mtimeMs = stat.mtimeMs;
      this.size = stat.size;
      this.lastError = `用户文件非法（保留上次有效用户）：${read.errors.join("；")}`;
      return;
    }
    this.records = read.users;
    this.mtimeMs = stat.mtimeMs;
    this.size = stat.size;
    this.lastError = null;
  }
}
