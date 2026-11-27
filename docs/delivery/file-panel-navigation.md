# 文件面板状态保值、收藏与键盘快速过滤交付记录

- **范围与分级**：M 级完整小方案（[方案文档](../specs/file-panel-navigation.md)），覆盖 `tabby-ssh` 与 `tabby-adb` 共用文件面板（`SFTPPanelComponent`）的状态保值、逐级回退与重试、星标收藏与最近目录、直接敲字模糊过滤与纯键盘逐层钻取、路径栏单击编辑、L0/L2 自动化验收及上游改动白名单登记。
- **分支与提交**：
  - 功能分支：`feat/file-panel-navigation`
  - 基线提交：`e6083033`（来自 `feat/macos-install-and-ci`，上游基线为 Tabby v1.0.238 `54869e10`）
  - 实现与测试提交：`dd1369e9`（`dd1369e9ccb56bda550b66d9355d2125d8a0b827`）
- **当前状态**：`L4 就绪`（L0 与 L2 全部自动验收通过、deliver 内部自查通过、已提交功能分支 commit；未覆盖 `/Applications/Coport.app`、未推送、未创建 PR）
- **累计审查轮次**：0（等待编排方派发独立 Codex 审查）
- **累计 CI 修复轮次**：0（未推送 / 无远端 CI 触发）
- **下一动作**：返回编排方，由编排方派发独立 Codex 审查增量 diff（`e6083033..HEAD`）；审查通过后再决定本机安装 `/Applications/Coport.app` 并进入 G3/L4 真机人工验收。

## 实现摘要与偏差记录

1. **零 DOM 纯逻辑模块（`tabby-ssh/src/utils/`）**：
   - `filePanelState.ts`：实现 POSIX 路径规范化（大小写敏感去重）、`'adb:shared'` 全局作用域与 `'ssh:<user>@<host>:<port>'` 作用域隔离、历史 20 / 收藏 50 / SSH 主机 50 LRU 裁剪（永不淘汰 ADB）、多窗口写入前重载合并，以及损坏 JSON / 非法版本 / `QuotaExceededError` 容错。
   - `filePanelFilter.ts`：实现大小写不敏感精确 > 前缀 > 连续子串 > 顺序子序列分级排序（同档目录优先 + `Intl.Collator` 字典序）、合并 `[start, end)` 高亮区间与安全分段渲染（无 `innerHTML`）。
   - `filePanelFallback.ts`：实现 ADB（`reason === 'unreadable_directory'`）与 SFTP（`No such file`/`Permission denied`/`Not a directory`/`ENOENT`/`EACCES`/`ENOTDIR`/状态码 `2`/`3` vs 断线/超时/channel closed）错误分类、逐级回退至 `/` 与过期并发请求取消。
   - 三个模块均无外部/相对运行时导入、无 TS `enum`、无构造函数参数属性，同时兼容 webpack TypeScript 4 编译与 Node `--experimental-strip-types` 直接单测。
2. **后端与标签页适配**：
   - `tabby-ssh/src/api/fileBackend.ts` 扩展可选方法 `isDirectoryUnavailable?`。
   - `tabby-adb/src/adbFileBackend.ts` 在 `adbRequest` 抛出的 `Error` 上透传 `reason` 与 `stderr`，实现 `isDirectoryUnavailable`。
   - `tabby-ssh/src/session/sftp.ts` 实现 `SFTPSession.isDirectoryUnavailable`。
   - `tabby-adb/src/adbTab.component.ts` / `adbPanel.pug` 移除 `/sdcard` 硬编码，改为 `stateScope='adb:shared'`、`defaultPath='/'`、`path=null`（打开时从共享状态恢复，无历史则开 `/`）。
   - `tabby-ssh/src/components/sshTab.component.ts` / `sshTab.component.pug` 透传 `sftpStateScope`（`ssh:<user>@<host>:<port>`）并保留检测到的 CWD 优先。
3. **共用文件面板（`tabby-ssh/src/components/sftpPanel.component.{ts,pug,scss}`）**：
   - 修复初始化 `readdir` 失败吞异常死循环卡 `Loading` 问题；实现逐级回退非阻塞提示条、手动跳转不可读保留当前有效列表与错误提示条，以及根目录/断线失败错误与「Retry」按钮。
   - 实现星标收藏按钮、横向滚动紧凑收藏芯片条、收藏+最近目录快捷下拉（收藏在前，支持跳转与移除且保留最近目录）、跨窗口 `storage` 事件同步。
   - 实现直接键入可见字符即展开并实时过滤（0 次远端请求）、`<mark>` 命中高亮、`↑/↓` 移动选中并滚动可见、`Enter` 进入目录（自动清空过滤并保持面板焦点以连续敲字钻取）或下载文件、过滤为空且 `!event.repeat` 的 `Backspace` 返回上级、`Esc` 依次取消路径编辑/关闭下拉/清空过滤而不误关面板、无匹配保留 `Go up`。
   - 实现路径栏空白区单击与编辑按钮进入编辑态（保留双击），面板全区域阻止点击冒泡防止误触发 `SSHTabComponent` 关闭面板。
4. **偏差记录**：无影响验收标准、对外协议或架构职责的方案偏差。实现中在 `SFTPPanelComponent` 内部以私有 `backend: FileBackend | null` 配合对外 `sftp: FileBackend` 保持既有上下文菜单插件类型零破坏；在 `scripts/coport/fixtures/adb` 新增按序列号根路径与 `offline_serials` 夹具能力以支持无 `/sdcard` 设备、跨设备回退与根目录断线重试的 L2 真实仿真。

## L0–L2 自动验收矩阵证据

被测实现与测试提交：`dd1369e9`（构建产物隔离于 `dist/coport-file-panel-nav/mac-arm64/Coport.app`，未触碰 `/Applications/Coport.app`）。

| 验收项 | 级别 | 执行命令与环境 | 退出码 | 关键证据 |
|---|---|---|---|---|
| 状态存储、作用域隔离与容量上限（20/50/50） | L0 | `npm run test:ssh-term`（Node v26.4.0，`--experimental-strip-types`） | 0 | `filePanelState` 6/6 用例通过（路径规整与大小写保留、ADB/SSH 隔离、20 历史/50 收藏裁剪、50 SSH LRU 不删 ADB、多窗口重载合并、损坏 JSON/`QuotaExceededError` 容错） |
| 目录不可读逐级回退与瞬时错误不误回退 | L0 | `npm run test:ssh-term` | 0 | `filePanelFallback` 5/5 用例通过（逐级向上回退、断线/超时立即停止、`/` 不可读退出不死循环、ADB/SFTP 错误分类、过期请求取消） |
| 子串与模糊匹配、排序、高亮区间与 1,000 条目性能 | L0 | `npm run test:ssh-term` | 0 | `filePanelFilter` 3/3 用例通过；1,000 条目实测 `p95=0.49ms, max=0.84ms`（远低于 `≤ 16 ms` 阈值）；`test:ssh-term` 总计 28/28 通过 |
| 既有终端/Electron 单元测试回归 | L0 | `npm run test:unit` | 0 | 11/11 通过（`BaseSession.destroy()`、`BaseSession output before the terminal is shown`、`disposeWebglAddon`） |
| 代码规范与模块构建打包 | L0 | `npm run lint`、`npm run build`、`node scripts/prepackage-plugins.mjs`、`COPORT_BUILD_OUTPUT="$PWD/dist/coport-file-panel-nav" COPORT_ELECTRON_DIST="$PWD/dist/coport-m0/electron" node scripts/build-macos.mjs`（macOS arm64，Electron 43.7.0，ad-hoc 签名） | 0 | ESLint 0 errors / 0 warnings；14 个插件 typings 与全部 webpack bundle 编译通过；`Coport.app` ad-hoc `codesign --verify --deep --strict` 通过 |
| 上游改动白名单校验 | L0 | `node scripts/coport/check-upstream-diff.mjs` | 0 | `Coport upstream diff passed against 54869e10 (122 registered paths)`，0 未登记路径 |
| ADB 无 `/sdcard` 首次启动、保值恢复、跨设备共享、回退提示与根目录断线重试 | L2 | `python3 -B scripts/coport/sim/coport_shells.py "$PWD/dist/coport-file-panel-nav/mac-arm64/Coport.app"`（内部调用 `node scripts/coport/sim/coport_shells.mjs`，隔离 `--user-data-dir` + 假 ADB + 本机 sshd + 私有 PTY） | 0 | `noSdcardBoot.path="/"`, `loadError=null`，且 `calls.jsonl` 中 `embedded` 0 次请求 `/sdcard`；重启后恢复 `/data/only-on-embedded/deep` 与收藏 `/etc`；第二台设备 `two` 自动回退至 `/data` 并展示回退提示条；`two` 离线时 `/` 展示 `loadError` + `Retry`（不卡 `Loading`），恢复后点击重试正常列出 `data`/`etc` |
| SSH SFTP 按主机隔离保值、CWD 优先与独立收藏 | L2 | 同上 `coport_shells.py` / `coport_shells.mjs` | 0 | `127.0.0.1:<port>` 与 `localhost:<port>` 首次均打开 `/` 且不串 ADB/对端收藏；设置 `reportedCWD` 时优先打开 `cwd-dir`；重启后 `ssh1` 恢复 `sub-a`+收藏、`ssh2` 恢复 `sub-b`+收藏；面板点击不冒泡关闭面板 |
| 收藏星标、快捷条与历史下拉跳转和移除 | L2 | 同上 `coport_shells.py` / `coport_shells.mjs` | 0 | 星标同步、`favoritesAboveRecent=true`、下拉与芯片跳转正常、移除收藏后星标同步取消且 `appStillInRecent=true` |
| 直接敲字即过滤、键盘逐层钻取、零远端请求与 1,000 条目实时响应 | L2 | 同上 `coport_shells.py` / `coport_shells.mjs` | 0 | 未点 Filter 直接敲 `g_c` 自动展开过滤，`callsAfterType=0`，命中 `["g_comp","good_config.txt"]` 且高亮 `<mark>`；`↑/↓/Enter` 连续钻取至 `/data/app/g_comp/nested`；连发 `Backspace` 防误触、单次 `Backspace` 回上级；无匹配保留 `Go up`；`Esc` 清空过滤且面板保持打开；1,000 条目 `/bulk` 界面过滤 `readdirCalls=0`、`maxMs=0.4` ms（`≤ 16 ms`） |
| 路径栏单击编辑、手动错误保列表与既有上传/下载/删除/拖拽/右键/MCP 回归 | L2 | 同上 `coport_shells.py` / `coport_shells.mjs` 及 `python3 -B scripts/coport/sim/prepare_adb.py "$PWD/dist/coport-file-panel-nav/mac-arm64/Coport.app"` | 0 | 单击空白区编辑 + `Esc` 取消 + `Enter` 跳转通过；手动跳转 `/does-not-exist-manual` 保持 `/etc` 与 `hosts` 列表且不写入历史；ADB/SSH 上传、下载、目录上传、新建目录、删除、符号链接、拖拽目标锁定、窗口关闭原子下载清理与 ADB 路由测试全部退出 0 |

## L4 真机人工验收清单（待独立审查通过后执行）

1. 独立审查通过后，构建并安装至 `/Applications/Coport.app`，连接真实无 `/sdcard` ADB 设备（及可选 SSH 主机）。
2. 打开 Files 面板确认首次直接打开 `/`、无 `/sdcard` 报错且不卡 `Loading`。
3. 切换至可读目录并重启 Coport，确认目录恢复；切换另一设备验证共享与缺失目录自动回退提示条。
4. 点击星标收藏，在快捷芯片条与收藏/最近下拉中完成一键跳转与移除（确认收藏在最近之上、移除后保留最近记录）。
5. 不点 Filter 直接敲字模糊过滤，用 `↑/↓/Enter/Backspace/Esc` 连续逐层钻取，确认高亮清晰、布局无遮挡、手感流畅且 `Esc` 不误关面板。
