/** 面板进程级角色（内网单租户演进路径）：角色来自 `AOS_PANEL_ROLE`，
 * 未配置时按 `AOS_PANEL_ACTIONS` 回退；服务端按动作路由强制，UI 据此禁用入口。 */

export type PanelRole = "viewer" | "dispatcher" | "maintainer" | "admin";

export type PanelActionScope =
  | "dispatch"
  | "tasks"
  | "verdicts"
  | "issues"
  | "library"
  | "schedules"
  | "export";

const ROLE_RANK: Record<PanelRole, number> = {
  viewer: 0,
  dispatcher: 1,
  maintainer: 2,
  admin: 3
};

export const PANEL_ROLE_LABELS: Record<PanelRole, string> = {
  viewer: "只读",
  dispatcher: "派发",
  maintainer: "维护",
  admin: "管理"
};

function actionsEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.AOS_PANEL_ACTIONS;
  return typeof raw !== "string" || raw.trim() !== "0";
}

export function panelRoleFrom(env: NodeJS.ProcessEnv): PanelRole {
  if (!actionsEnabled(env)) return "viewer";
  const raw = env.AOS_PANEL_ROLE?.trim().toLowerCase();
  if (raw === "viewer" || raw === "dispatcher" || raw === "maintainer" || raw === "admin") {
    return raw;
  }
  // 非法值 fail closed；未配置时默认 admin（HTTP 模式既有行为）。
  if (raw !== undefined && raw !== "") return "viewer";
  return "admin";
}

export function panelRoleRank(role: PanelRole): number {
  return ROLE_RANK[role];
}

export function panelRoleAtLeast(role: PanelRole, required: PanelRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

export function panelRequiredRoleForPath(pathname: string): PanelRole | null {
  if (pathname === "/panel/api/export") return "dispatcher";
  if (
    pathname === "/panel/api/tasks" ||
    pathname === "/panel/api/tasks/cancel" ||
    pathname === "/panel/api/tasks/stop" ||
    pathname === "/panel/api/tasks/release" ||
    pathname === "/panel/api/tasks/rerun" ||
    pathname === "/panel/api/queue/pause" ||
    pathname === "/panel/api/queue/resume"
  ) {
    return "dispatcher";
  }
  if (
    pathname === "/panel/api/verdicts" ||
    pathname === "/panel/api/schedules" ||
    pathname === "/panel/api/quarantine" ||
    pathname === "/panel/api/import" ||
    pathname === "/panel/api/projects/assets" ||
    pathname === "/panel/api/hosts/register"
  ) {
    return "maintainer";
  }
  if (pathname === "/panel/api/issues" || pathname === "/panel/api/issues/evidence") {
    return "admin";
  }
  if (pathname === "/panel/api/projects" || pathname === "/panel/api/projects/archive") {
    return "admin";
  }
  return null;
}

export function panelRoleScopes(role: PanelRole): Record<PanelActionScope, boolean> {
  const dispatcher = panelRoleAtLeast(role, "dispatcher");
  const maintainer = panelRoleAtLeast(role, "maintainer");
  const admin = panelRoleAtLeast(role, "admin");
  return {
    dispatch: dispatcher,
    tasks: dispatcher,
    export: dispatcher,
    verdicts: maintainer,
    library: maintainer,
    schedules: maintainer,
    issues: admin
  };
}
