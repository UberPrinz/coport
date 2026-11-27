# Coport 上游改动记录

基线为 Tabby v1.0.238（`54869e1`）。[规格中的白名单和同步流程](../specs/coport-fork.md#上游改动清单与同步流程)

| 上游文件 | Coport 改动 |
|---|---|
| `app/lib/index.ts` | 注册主进程串口与 ADB IPC、MCP host 及安全退出流程，处理后台启动和隔离数据目录，避免隔离启动改写宿主协议注册 |
| `app/lib/app.ts`、`app/lib/window.ts` | 菜单、托盘和窗口使用打包后的名称。移除主进程自动更新器 |
| `app/lib/sentry.ts` | 保留构建和 preload 入口，移除 Sentry 初始化 |
| `app/package.json` | 为 Electron 声明产品名，加入 headless、serialize 与锁定的 MCP SDK 1.29.0 |
| `app/yarn.lock` | Yarn 生成的 headless、serialize、MCP SDK 及其传递依赖锁项 |
| `app/webpack.config.main.mjs` | 从 app 包解析 serialport 和 MCP SDK，外部加载 FIONREAD、getpeereid 与 socket EOF 探测共用的 Node-API 模块 |
| `build/mac/icon.icns`、`electron-builder.yml` | 更换为 Coport 图标、产品名、bundle ID 与 macOS 产物名称。将 Node-API 模块从 asar 解包，将 Swift shim 放在 Contents/MacOS。ad-hoc 模式关闭 hardened runtime，移除 ElectronTeamID |
| `package.json` | 在 macOS 构建时编译 Coport 的原生组件，并提供 `coport:install` 本机安装入口 |
| `.github/workflows/build.yml`、`.github/workflows/docs.yml`、`.github/workflows/release.yml` | 将 CI 收敛为 Lint 与 macOS arm64 ad-hoc 签名构建，接入白名单与 Coport 单测，在 `v*` tag 时发布 GitHub Release；停用上游自动文档部署与旧版空草稿发布 |
| `tabby-core/src/api/hostWindow.ts`、`tabby-core/src/services/app.service.ts`、`tabby-electron/src/services/hostWindow.service.ts` | 窗口拒绝关闭时通知主进程取消退出请求，保留活动串口 |
| `tabby-core/src/api/selector.ts`、`tabby-core/src/services/profiles.service.ts`、`tabby-core/src/components/selectorModal.component.ts` | 在快速连接及过滤结果中保留同一适配器的驱动顺序 |
| `tabby-core/src/configDefaults.yaml` | 关闭默认统计与自动更新 |
| `tabby-core/src/components/appRoot.component.ts`、`tabby-core/src/components/appRoot.component.pug` | 移除更新定时检查和工具栏更新入口 |
| `tabby-settings/src/components/settingsTab.component.ts`、`tabby-settings/src/components/settingsTab.component.pug` | 移除设置中的更新入口及对应状态，应用标题改为 Coport |
| `tabby-serial/src/api.ts`、`tabby-serial/src/components/serialTab.component.ts`、`tabby-serial/src/components/serialTab.component.pug`、`tabby-serial/src/index.ts` | 串口标签经主进程 IPC 打开、写入、挂回和断开，重复打开聚焦原视图，等候挂接时可从工具栏断开。显示非标准波特率确认并取消该类标签的恢复 |
| `tabby-serial/src/services/serial.service.ts`、`tabby-serial/src/services/serialPorts.ts`、`tabby-serial/src/profiles.ts` | WCH 串口排在前面，同一适配器的苹果节点加提示 |
| `tabby-terminal/src/frontends/frontend.ts`、`tabby-terminal/src/frontends/xtermFrontend.ts` | 仅对共享串口丢弃自动上报，渲染器在 xterm 完成写入后确认输出，按主进程输出顺序应用尺寸 |
| `tabby-terminal/src/api/connectableTerminalTab.component.ts`、`tabby-ssh/src/components/sshTab.component.ts` | 允许可连接的标签选择不保存恢复令牌，保留 SSH 恢复行为 |
| `scripts/vars.mjs` | 注册内置 `tabby-adb` 包，沿用上游插件构建、依赖安装和打包入口 |
| `tabby-core/src/api/profileProvider.ts`、`tabby-core/src/api/platform.ts` | 设备选择取消时返回空标签参数。ADB 分阶段上传在远端提交前保持处理中 |
| `tabby-ssh/src/components/sftpPanel.component.ts`、`tabby-ssh/src/components/sftpPanel.component.pug`、`tabby-ssh/src/components/sftpDeleteModal.component.ts`、`tabby-ssh/src/session/sftp.ts`、`tabby-ssh/src/index.ts`、`tabby-ssh/src/sftpContextMenu.ts`、`tabby-ssh/src/api/fileBackend.ts` | 文件面板、目录处理与删除复用 `FileBackend`，保留原 SSH/SFTP 会话和标签入口 |
| `tabby-electron/src/sftpContextMenu.ts` | 将依赖 SSH chmod 和断开事件的本地编辑限制在 SFTP 后端 |
| `tabby-electron/src/services/platform.service.ts` | ADB 下载经同目录暂存后原子替换本地文件。保留既有 SFTP 下载路径 |
| `tabby-core/src/directives/dropZone.directive.ts` | 在 Finder 文件扫描前记录目标目录，保留既有 transfer 事件 |
| `scripts/build-macos.mjs` | 创建 DMG 和 ZIP 前强制执行 ad-hoc 签名和校验。停止 Team ID 与 notarization 配置，支持通过 COPORT_BUILD_OUTPUT 和 COPORT_ELECTRON_DIST 指定隔离构建路径与缓存 Electron |
| `app/lib/coport/*`、`extras/coport-mcp/*`、`scripts/coport/*`、`tabby-adb/*` | fork 新增的串口、MCP、ADB 代码与自动验收 |
| `docs/coport/*`、`docs/delivery/coport-fork-*`、`docs/plans/coport-fork.md`、`docs/specs/coport-fork.md` | fork 新增的规格、交付证据和进度记录 |

## 同步上游

1. 从目标上游稳定 tag 建立同步基线，在 `sync/<tag>` 分支合入它并按表处理冲突。
2. 运行 `node scripts/coport/check-upstream-diff.mjs <tag>`。表格首列是执行清单，使用从仓库根目录开始的路径。带星号的前缀只允许新增文件，已有上游路径需要逐项登记。
3. 完成签名、P1 历史一致性和隔离全量测试，把差异检查与测试证据放进同步 PR。本版汇总 PR 的 CI 尚未接入差异检查和 Coport 隔离 sim，由同步或交付时执行。
