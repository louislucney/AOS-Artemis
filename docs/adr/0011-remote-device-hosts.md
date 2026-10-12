# 远程设备宿主与跨机产物（device host）

MCP 服务集中部署（Mac mini）而项目分散在各自机器时，两端执行拓扑不对称：Android 的 adbd 可监听网络（无线调试），设备连到哪台机器都行；iOS 要求承载 Appium/WDA 的 Mac 与设备同机（WDA 需在该机编译签名），且 `app_path`（.ipa）在服务端校验存在性、由 Appium 宿主读取——宿主指向开发者 Mac 时跨机安装失败。决定 v1 只做操作层对齐：(1) 「设备宿主」升为项目概念——`aos.config.jsonc` 高级层 `deviceHosts: {ios?: {appiumUrl?, wdaBundleId?, xcodeOrgId?, xcodeSigningId?}, android?: {adbHost?}}`，项目 `.env`/进程 env 覆盖（config < dotenv < 进程 env），内部映射到既有 `AOS_APPIUM_URL` / `AOS_IOS_WDA_BUNDLE_ID` / `AOS_IOS_XCODE_ORG_ID` / `AOS_IOS_XCODE_SIGNING_ID` / `ADB_SERVER_SOCKET`，不新建协议或常驻进程；签名键覆盖宿主差异（WDA 在宿主上编译，team ID 必须在宿主有证书）。(2) `app_path` 接受 `http(s)://` URL：由宿主侧获取并安装（iOS 经 Appium app 能力、Android 由服务端下载后安装），本地路径语义保留（宿主同机直装）；**跨机不得以服务端本地路径冒充产物**——若做缓存，须以「稳定 URL」形态供宿主拉取。(3) 远端模拟器 v1 明确不支持（iOS 模拟器仍限服务本机），下一刀评估「模拟器经宿主 Appium」。(4) 信任边界按 LAN/VPN 假设 + SSH 隧道模板文档化，doctor/`aos_status` 显示宿主可达性（iOS 探 `/status`、Android 探 adb `host:version`）与暴露提示，不做自研反向隧道。

## Considered Options

- 自研反向隧道/宿主常驻 agent（宿主主动回连服务端）：消除暴露面，但引入新进程与新协议，v1 收益不足，拒绝。
- 依赖 idb 远程 companion 解决模拟器：成熟度未验证，不押注，拒绝（列入后续评估）。
- 只要求共享挂载/同路径：把成本转嫁给用户且宿主=开发者 Mac 时仍不可行，拒绝作唯一方案（URL 化后仍保留本地路径）。
- 服务端下载产物后把本地路径交给远端 Appium：跨机时宿主读不到服务端路径（即本 ADR 要修的原坑），拒绝；缓存仅允许以稳定 URL 形态存在。
- 服务端产物仓库 + 上传端点：可作为后续；v1 的 URL 已覆盖「产物在 CI/静态服务器」的常见情形。

## Consequences

- Android 的 adb 宿主属特殊场景（无法开无线调试、或复用某台 Mac 上的模拟器）；默认仍是设备侧联网。
- iOS 鸿沟缩减为一条不可消除的约束：设备宿主必须是一台带 Xcode 的 Mac。
- URL 安装需在真实 Appium 环境冒烟一次（XCUITest `app` 能力对 URL 的支持）后再定案；未冒烟前预装 App 仍是无风险路径。
