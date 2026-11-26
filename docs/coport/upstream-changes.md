# Coport 上游改动记录

基线为 Tabby v1.0.238（`54869e1`）。[规格中的白名单和同步流程](../specs/coport-fork.md#上游改动清单与同步流程)

| 上游文件 | Coport 改动 |
|---|---|
| `app/lib/index.ts` | 注册主进程串口 IPC、MCP host 与安全退出流程，处理后台启动和隔离数据目录，避免隔离启动改写宿主协议注册 |
| `app/lib/app.ts`、`app/lib/window.ts` | 菜单、托盘和窗口使用打包后的名称。移除主进程自动更新器 |
| `app/lib/sentry.ts` | 保留构建和 preload 入口，移除 Sentry 初始化 |
| `app/package.json` | 为 Electron 声明产品名，加入 headless、serialize 与锁定的 MCP SDK 1.29.0 |
| `app/yarn.lock` | Yarn 生成的 headless、serialize、MCP SDK 及其传递依赖锁项 |
| `app/webpack.config.main.mjs` | 从 app 包解析 serialport 和 MCP SDK，外部加载 FIONREAD 与 getpeereid Node-API 模块 |
| `build/mac/icon.icns`、`electron-builder.yml` | 更换为 Coport 图标、产品名、bundle ID 与 macOS 产物名称。将 Node-API 模块从 asar 解包，将 Swift shim 放在 Contents/MacOS |
| `package.json` | 在 macOS 构建时编译 Coport 的原生组件 |
| `tabby-core/src/api/hostWindow.ts`、`services/app.service.ts`、`tabby-electron/src/services/hostWindow.service.ts` | 窗口拒绝关闭时通知主进程取消退出请求，保留活动串口 |
| `tabby-core/src/api/selector.ts`、`services/profiles.service.ts`、`components/selectorModal.component.ts` | 在快速连接及过滤结果中保留同一适配器的驱动顺序 |
| `tabby-core/src/configDefaults.yaml` | 关闭默认统计与自动更新 |
| `tabby-core/src/components/appRoot.component.ts`、`appRoot.component.pug` | 移除更新定时检查和工具栏更新入口 |
| `tabby-settings/src/components/settingsTab.component.ts`、`settingsTab.component.pug` | 移除设置中的更新入口及对应状态，应用标题改为 Coport |
| `tabby-serial/src/api.ts`、`components/serialTab.component.ts`、`index.ts` | 串口标签经主进程 IPC 打开、写入、挂回和断开，重复打开聚焦原视图。显示非标准波特率确认并取消该类标签的恢复 |
| `tabby-serial/src/services/serial.service.ts`、`services/serialPorts.ts`、`profiles.ts` | WCH 串口排在前面，同一适配器的苹果节点加提示 |
| `tabby-terminal/src/frontends/frontend.ts`、`xtermFrontend.ts` | 仅对共享串口丢弃自动上报，渲染器在 xterm 完成写入后确认输出，按主进程输出顺序应用尺寸 |
| `tabby-terminal/src/api/connectableTerminalTab.component.ts`、`tabby-ssh/src/components/sshTab.component.ts` | 允许可连接的标签选择不保存恢复令牌，保留 SSH 恢复行为 |
