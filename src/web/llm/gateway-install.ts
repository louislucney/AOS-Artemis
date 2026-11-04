export type GatewayInstallPlatform = "android" | "ios";

export interface GatewayInstallRequest {
  hostId: string;
  deviceSerial: string;
  platform: GatewayInstallPlatform;
  assetId: string;
  /** 安装包内容 sha256（中心资产表值）。 */
  sha256: string;
  filename: string;
  /** 中心控制面可下载的资产 URL。 */
  downloadUrl: string;
}

export interface GatewayInstallResult {
  ok: boolean;
  packageName: string | null;
  version: string | null;
  cached: boolean;
  reason?: string;
}

export interface GatewayInstallBackend {
  install(
    request: GatewayInstallRequest
  ): Promise<{ packageName: string | null; version: string | null }>;
}

/**
 * P1 gateway 安装骨架：中心按 `(host, device, sha)` 去重，runner 负责下载/校验/安装。
 * 真实 HTTP 端点/设备安装由 GatewayInstallBackend 注入；当前 P0 Android 走 ARTEMIS app_path。
 */
export function createGatewayInstaller(backend: GatewayInstallBackend): {
  install(request: GatewayInstallRequest): Promise<GatewayInstallResult>;
} {
  const cache = new Map<string, GatewayInstallResult>();
  return {
    async install(request) {
      if (!/^[a-f0-9]{64}$/i.test(request.sha256)) {
        return {
          ok: false,
          packageName: null,
          version: null,
          cached: false,
          reason: "invalid-sha256"
        };
      }
      if (request.filename.trim() === "" || request.downloadUrl.trim() === "") {
        return {
          ok: false,
          packageName: null,
          version: null,
          cached: false,
          reason: "invalid-asset"
        };
      }
      const key = `${request.hostId}\u0000${request.deviceSerial}\u0000${request.sha256}`;
      const hit = cache.get(key);
      if (hit !== undefined) return { ...hit, cached: true };
      const result = await backend.install(request);
      const installed: GatewayInstallResult = {
        ok: true,
        packageName: result.packageName,
        version: result.version,
        cached: false
      };
      cache.set(key, installed);
      return installed;
    }
  };
}
