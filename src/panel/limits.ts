/** 面板动作请求体上限（JSON 与 multipart 导入共用；HTTP 与独立 `panel --web` 同口径）。 */
export const MAX_PANEL_BODY_BYTES = 256 * 1024;
export const MAX_PANEL_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_PANEL_IMPORT_BYTES = MAX_PANEL_BODY_BYTES + MAX_PANEL_UPLOAD_BYTES;

/** 请求体超限（外层映射 413，区别于解析失败）。 */
export class PanelBodyTooLargeError extends Error {
  constructor(message = "request body too large") {
    super(message);
    this.name = "PanelBodyTooLargeError";
  }
}
