import type { ProjectStore } from "../../db/types.js";
import { errorMessage } from "../../util.js";
import { authenticateRunner } from "./auth.js";
import { RunnerControlError } from "./errors.js";
import { resolveSuiteResource } from "./suite-routes.js";
import { SuiteControlService } from "./suite-service.js";

export interface SuiteControlHttpInput {
  method: string;
  url: URL;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  store: ProjectStore;
  env?: NodeJS.ProcessEnv;
  /** 中心对外基址（如 `http://192.168.3.91:8765`），用于生成 LLM 代理 URL。 */
  publicBaseUrl?: string;
}

export interface SuiteControlHttpResponse {
  status: number;
  contentType: string;
  body: string;
  /** 二进制文件响应（安装包下载）：由 HTTP 层流式返回。 */
  streamPath?: string;
  streamSize?: number;
  headers?: Record<string, string>;
}

const JSON_TYPE = "application/json; charset=utf-8";

function json(status: number, payload: unknown): SuiteControlHttpResponse {
  return { status, contentType: JSON_TYPE, body: JSON.stringify(payload) };
}

function errorJson(status: number, code: string, error: string): SuiteControlHttpResponse {
  return json(status, { ok: false, code, error });
}

export async function handleSuiteControlRequest(
  input: SuiteControlHttpInput
): Promise<SuiteControlHttpResponse> {
  const env = input.env ?? process.env;
  if ((env.AOS_RUNNER_CONTROL ?? "").trim() === "0") {
    return errorJson(404, "control-disabled", "runner 控制面已关闭（AOS_RUNNER_CONTROL=0）");
  }
  const auth = authenticateRunner(input.headers, env);
  if (!auth.ok) return errorJson(auth.status, auth.code, auth.error);
  const route = resolveSuiteResource(input.method, input.url, input.body);
  if (route === null) {
    return errorJson(404, "not-found", "未知 suite 数据面路由");
  }
  const hostId = auth.hostId;
  try {
    const rawInstance =
      input.headers["x-mobile-testing-instance-id"] ?? input.headers["x-aos-instance-id"];
    const instanceId = (Array.isArray(rawInstance) ? rawInstance[0] : rawInstance ?? "").trim();
    const service = new SuiteControlService(
      input.store,
      hostId,
      env,
      instanceId,
      input.publicBaseUrl ?? ""
    );
    if (route.op === "getTaskApp" || route.op === "getTaskMaterials") {
      const value = (await service.execute(route.op, route.args)) as {
        filename: string;
        sha256: string;
        size: number;
        filePath: string;
      };
      return {
        status: 200,
        contentType:
          route.op === "getTaskMaterials"
            ? "text/plain; charset=utf-8"
            : value.filename.toLowerCase().endsWith(".ipa")
              ? "application/octet-stream"
              : "application/vnd.android.package-archive",
        body: "",
        streamPath: value.filePath,
        streamSize: value.size,
        headers: {
          "Content-Length": String(value.size),
          "Content-Disposition": `attachment; filename="${value.filename.replace(/["\\\r\n]/g, "_")}"`,
          "X-Aos-Sha256": value.sha256
        }
      };
    }
    return json(200, { ok: true, value: await service.execute(route.op, route.args) });
  } catch (error) {
    if (error instanceof RunnerControlError) {
      return errorJson(error.status, error.code, error.message);
    }
    return errorJson(500, "internal", errorMessage(error));
  }
}
