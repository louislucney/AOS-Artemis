/** Appium 只回一句 “xcodebuild failed” 时，把可排查的位置直接带进失败信息。 */
export function iosBuildFailureHint(message: string | null | undefined): string {
  const text = message ?? "";
  if (!/xcodebuild failed|Unable to launch WebDriverAgent|WebDriverAgent.*build/i.test(text)) {
    return "";
  }
  return "（WDA 构建失败：查看执行机项目 .artemis/logs/appium.log 的 xcodebuild 输出；常见原因：签名团队/设备未注册/Xcode 版本不匹配）";
}
