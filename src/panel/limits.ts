/** 面板动作请求体上限（JSON 与 multipart 导入共用；HTTP 与独立 `panel --web` 同口径）。 */
export const MAX_PANEL_BODY_BYTES = 256 * 1024;
export const MAX_PANEL_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_PANEL_IMPORT_BYTES = MAX_PANEL_BODY_BYTES + MAX_PANEL_UPLOAD_BYTES;

/** 项目资产上传（`/panel/api/projects/assets`）专用传输上限：210MB 含 multipart 头开销，
 * 覆盖 package 200MB 上限；其余面板动作仍用 `MAX_PANEL_IMPORT_BYTES`（约 20MB）。 */
export const MAX_PANEL_ASSET_UPLOAD_BYTES = 210 * 1024 * 1024;

/** 请求体超限（外层映射 413，区别于解析失败）。 */
export class PanelBodyTooLargeError extends Error {
  constructor(message = "request body too large") {
    super(message);
    this.name = "PanelBodyTooLargeError";
  }
}
