# 文件面板状态保值、收藏与键盘快速过滤交付记录

- **范围与分级**：M 级完整小方案（[方案文档](../specs/file-panel-navigation.md)），覆盖 `tabby-ssh` 与 `tabby-adb` 共用文件面板（`SFTPPanelComponent`）的状态保值、逐级回退与重试、星标收藏与最近目录、直接敲字模糊过滤与纯键盘逐层钻取、路径栏单击编辑、L0/L2 自动化验收及上游改动白名单登记。
- **分支与提交**：
  - 功能分支：`feat/file-panel-navigation`
  - 基线提交：`e6083033`（来自 `feat/macos-install-and-ci`，上游基线为 Tabby v1.0.238 `54869e10`）
  - 首版实现提交：`dd1369e9`（`dd1369e9ccb56bda550b66d9355d2125d8a0b827`）
  - Codex 第 1 轮审查修复提交：`f00e4bba`（`f00e4bbad8d02f615046f472ffc43b9bf2b517b1`）
- **当前状态**：`L4 就绪`（Codex 第 1 轮审查全部 13 项问题已修复并完成全量 L0/L2 自动验收；未覆盖 `/Applications/Coport.app`、未推送、未创建 PR）
- **累计审查轮次**：1（已完成 Codex 第 1 轮独立审查与修复，等待编排方派发第 2 轮独立复审）
- **累计 CI 修复轮次**：0（未推送 / 无远端 CI 触发）
- **下一动作**：返回编排方，由编排方派发独立 Codex 审查复核第 1 轮修复（`0ae36567..HEAD` / `e6083033..HEAD`）；复审通过后再决定本机安装 `/Applications/Coport.app` 并进入 G3/L4 真机人工验收。

## 实现摘要与偏差记录

1. **零 DOM 纯逻辑模块（`tabby-ssh/src/utils/`）**：
   - `filePanelState.ts`：实现 POSIX 路径规范化（大小写敏感去重、保留合法尾随空格与 SFTP 可选 `..` 语义）、按作用域分键 `coport.filePanelState.v1:<scope>`（`'adb:shared'` 全局作用域与 `'ssh:<authUsername>@<host>:<port>'` 作用域隔离）、历史 20 / 收藏 50 / SSH 主机 50 LRU 裁剪（严格递增 `updatedAt` 且永不淘汰当前写入作用域与 ADB）、同窗口变更订阅通知，以及损坏 JSON / 非法版本 / `QuotaExceededError` 容错。
   - `filePanelFilter.ts`：实现大小写不敏感精确 > 前缀 > 连续子串 > 顺序子序列分级排序（同档目录优先 + `Intl.Collator` 字典序）、UTF-16 变长小写索引映射（修复如 `İxa.txt` 高亮偏移）、合并 `[start, end)` 高亮区间与安全分段渲染（无 `innerHTML`）。
   - `filePanelFallback.ts`：实现 ADB（`reason === 'unreadable_directory'`）与 SFTP（`No such file`/`NoSuchFile`/`Permission denied`/`PermissionDenied`/`Not a directory`/`ENOENT`/`EACCES`/`ENOTDIR`/状态码 `2`/`3` vs 断线/超时/channel closed）错误分类、逐级回退至 `/` 与过期并发请求取消。
   - 三个模块均无外部/相对运行时导入、无 TS `enum`、无构造函数参数属性，同时兼容 webpack TypeScript 4 编译与 Node `--experimental-strip-types` 直接单测。
2. **后端与标签页适配**：
   - `tabby-ssh/src/api/fileBackend.ts` 扩展可选属性/方法 `closed$?` 与 `isDirectoryUnavailable?`。
   - `tabby-adb/src/adbFileBackend.ts` 在 `adbRequest` 抛出的 `Error` 上透传 `reason` 与 `stderr`，实现 `isDirectoryUnavailable`。
   - `tabby-ssh/src/session/ssh.ts` 与 `tabby-ssh/src/session/sftp.ts`：监听 `sftp.closed$` 清除 `SSHSession.sftp` 缓存，同时在 `SFTPSession.readdir` 遇到非目录不可读错误时触发缓存失效回调，且 `openSFTP(forceNew = false)` 支持强制重建新 SFTP 通道；实现 `SFTPSession.isDirectoryUnavailable`；`readdir` 保持路径原样拼接不提前折叠 `..`。
   - `tabby-adb/src/adbTab.component.ts` / `adbPanel.pug` 移除 `/sdcard` 硬编码，改为 `stateScope='adb:shared'`、`defaultPath='/'`、`path=null`。
   - `tabby-ssh/src/components/sshTab.component.ts` / `sshTab.component.pug` 透传 `sftpStateScope`（优先 `sshSession.authUsername`，缺失回退 `profile.options.user`），移除 `(pathChange)` 写回以保证无历史首次优先 CWD、有历史始终恢复 `savedLastPath`。
   - `tabby-ssh/src/index.ts` 收敛公开导出，仅导出 `tabby-adb` 所需的 `ADB_FILE_PANEL_SCOPE`。
3. **共用文件面板（`tabby-ssh/src/components/sftpPanel.component.{ts,pug,scss}`）**：
   - 初始化路径优先级：`overrideStartPath ?? savedLastPath ?? initialPath ?? defaultPath`。
   - 修复初始化 `readdir` 失败吞异常死循环卡 `Loading` 问题；监听 `backend.closed$` 与非目录不可读异常，点击「Retry」强制通过 `openSFTP(true)` 重建后端恢复列表。
   - `open()`、`downloadItem()`、`openCreateDirectoryModal()`、`upload()`、`uploadFolder()`、`uploadOne()`、`uploadOneFolder()` 均在异步前捕获 `navigation` 编号，过期则放弃导航/下载。
   - 实现星标收藏按钮、横向滚动紧凑收藏芯片条、收藏+最近目录快捷下拉（收藏在前，支持跳转与移除且保留最近目录）、同窗口事件订阅与跨窗口 `storage` 事件实时同步。
   - 实现直接键入可见字符即展开并实时过滤（0 次远端请求）、虚拟窗口渲染（`VIRTUAL_THRESHOLD = 80`）保障 1,000 条目下完整 Angular 变更检测与 DOM 更新 ≤ 16 ms、`<mark>` 命中高亮、`↑/↓` 移动选中并滚动可见、`Enter` 进入目录（自动清空过滤并保持面板焦点）或下载文件、过滤为空且 `!event.repeat` 的 `Backspace` 返回上级、`Esc` 依次取消路径编辑/关闭下拉/清空过滤而不误关面板、无匹配保留 `Go up`。
   - 路径输入 `onPathInputKeyDown` 增加 IME 组字防护（`isComposing || keyCode === 229`），`confirmPath()` 保留绝对路径尾随空格且 SFTP 不在客户端折叠 `/link/..`，手动跳转失败保留列表后调用 `focusPanel()` 立即恢复键盘焦点。
4. **偏差记录**：无影响验收标准、对外协议或架构职责的方案偏差。`docs/specs/file-panel-navigation.md` 已同步更新按作用域分键 `coport.filePanelState.v1:<scope>`、`authUsername` 作用域规则与 SSH 已有历史优先于 CWD 契约。

## 独立审查与修复记录

### 第 1 轮（Codex 独立审查，修复提交 `f00e4bba`）

| 编号 | 级别 | 审查发现 | 修复措施 | 验证状态 |
|---|---|---|---|---|
| 1 | P0 | SSH 已有历史后重开面板仍可能被 CWD 覆盖 | `SFTPPanelComponent` 改为 `overrideStartPath ?? savedLastPath ?? initialPath ?? defaultPath`，移除 `sshTab.component.pug` `(pathChange)` 回写，`coport_shells.mjs` 断言首次 CWD、重开与重启均恢复 `savedLastPath` | 通过（L2） |
| 2 | P1 | SSH 交互登录账号未纳入作用域隔离 | `sshTab.component.ts` `sftpStateScope` 优先取 `sshSession.authUsername` 再回退 `profile.options.user`；L0/L2 均新增同主机同端口不同 `authUsername`（`alice` vs `bob`）隔离验证 | 通过（L0 + L2） |
| 3 | P2 | SFTP 通道关闭后 Retry 复用已关闭缓存导致无法恢复 | `ssh.ts` 监听 `sftp.closed$` 清理缓存并支持 `openSFTP(true)` 强制重建；`sftp.ts` 在非目录不可读错误时触发缓存失效；`sftpPanel.component.ts` 监听 `closed$` 并在 `retryLoad()` 调用 `openSFTP(true)`；L2 覆盖真实 SFTP 通道关闭后 Retry 恢复 | 通过（L2） |
| 4 | P2 | 慢速符号链接/新建目录/上传完成后可能覆盖较新导航 | `open()`、`downloadItem()`、`openCreateDirectoryModal()`、`upload()`/`uploadOne()`、`uploadFolder()`/`uploadOneFolder()` 均在异步前捕获 `navigation` 编号，过期放弃导航/下载；L2 `staleOps` 覆盖慢速 `stat`、慢速 `mkdir` 与慢速 `uploadOne` | 通过（L2） |
| 5 | P2 | 多窗口并发保存不同作用域存在单键覆写风险 | `filePanelState.ts` 改为按作用域分键 `coport.filePanelState.v1:<scope>`；L0 新增可控交错读写测试验证双方作用域均保留 | 通过（L0） |
| 6 | P2 | 50 个 SSH 作用域同毫秒写入可能误淘汰新写入主机 | 写入生成严格大于现有最大值的 `updatedAt` 且 `pruneSSHScopes` 保护当前写入作用域（永不淘汰 `adb:shared`）；L0 新增双 Store 冻结同毫秒测试 | 通过（L0） |
| 7 | P2 | 同窗口两个 ADB 面板星标与收藏芯片未实时同步 | `filePanelState.ts` 新增同窗口 `subscribeFilePanelStateChanges`，`SFTPPanelComponent` 在 `ngOnInit`/`ngOnDestroy` 订阅与反注册；L2 `sameWindowSync` 覆盖双 ADB 标签实时同步 | 通过（L0 + L2） |
| 8 | P2 | 路径输入缺 IME 组字防护，手动错误跳转后未恢复面板焦点 | `onPathInputKeyDown` 检查 `isComposing || keyCode === 229`；手动跳转不可读保留列表时调用 `cdr.detectChanges()` 与 `focusPanel()`；L2 真实驱动路径 `<input>` 验证 | 通过（L2） |
| 9 | P2 | SSH 路径编辑裁剪尾随空格及客户端提前折叠 `/link/..` | `confirmPath()` 保留非空路径尾随空格，SFTP（无 `backend.normalizePath`）不折叠 `..`；L2 覆盖真实 sshd 带尾随空格目录 `trail ` 与跨父目录 `/link/..` | 通过（L0 + L2） |
| 10 | P2 | L2 1,000 条目基准未计入完整 DOM 更新且首键焦点流未校验 | 面板增加列表虚拟窗口渲染（`VIRTUAL_THRESHOLD = 80`）；L2 校验首键激活后 `document.activeElement === filterInput` 并经聚焦 `<input>` 键入，1,000 条目基准计入 `cdr.detectChanges()` 与 DOM 更新（实测 `maxMs=2.8ms <= 16ms`，`readdirCalls=0`） | 通过（L2） |
| 11 | P2 | 过滤态下点击/右键/Enter 缺少真实 DOM 目标路径断言 | L2 `filteredActions` 在 `rawIndex=4` 与过滤后行 `0` 不同下标下，通过真实 DOM 行触发点击、右键菜单（Download 与 Delete）及 `Enter`，断言实际下载与删除目标均为 `z-target.txt` 且其他文件不受影响 | 通过（L2） |
| 12 | P2 | 缺少真实本机 `sshd` 下目录缺失与无权限逐级回退验收 | L2 构造本机 `sshd` 不存在深层目录与 `chmod 0o000` 无权限目录（`finally` 恢复 `0o700`），验证真实 `russh` `NoSuchFile`/`PermissionDenied` 触发逐级回退与提示条 | 通过（L2） |
| 13 | P3 | UTF-16 变长小写高亮偏移、`upstream-changes.md` 通配路径与过多公开导出 | `filePanelFilter.ts` 增加 UTF-16 索引映射并增补 `İxa.txt` L0 用例；`upstream-changes.md` 精确逐项登记工具与测试文件；`tabby-ssh/src/index.ts` 收敛为仅导出 `ADB_FILE_PANEL_SCOPE` | 通过（L0） |

## L0–L2 自动验收矩阵证据

被测实现与测试提交：`f00e4bba`（构建产物隔离于 `dist/coport-file-panel-nav/mac-arm64/Coport.app`，未触碰 `/Applications/Coport.app`）。

| 验收项 | 级别 | 执行命令与环境 | 退出码 | 关键证据 |
|---|---|---|---|---|
| 代码规范静态检查 | L0 | `npm run lint` | 0 | ESLint 0 errors / 0 warnings |
| 状态存储、作用域隔离、并发交错与容量上限（20/50/50） | L0 | `npm run test:ssh-term`（Node v26.4.0，`--experimental-strip-types`） | 0 | `filePanelState` 8/8 用例通过（路径规整/大小写/尾随空格/`..`、按作用域分键与 `authUsername@host:port` 隔离、20 历史/50 收藏裁剪、50 SSH LRU 不删 ADB、双 Store 冻结同毫秒不淘汰第 51 台新主机、多窗口交错写入零丢失、同窗口变更订阅、损坏 JSON/`QuotaExceededError` 容错） |
| 目录不可读逐级回退与瞬时错误不误回退 | L0 | `npm run test:ssh-term` | 0 | `filePanelFallback` 5/5 用例通过（逐级向上回退、断线/超时立即停止、`/` 不可读退出不死循环、ADB/SFTP 错误分类含 `NoSuchFile`/`PermissionDenied`、过期请求取消） |
| 子串与模糊匹配、UTF-16 高亮映射与 1,000 条目性能 | L0 | `npm run test:ssh-term` | 0 | `filePanelFilter` 4/4 用例通过（含 `İxa.txt` UTF-16 变长小写高亮映射）；1,000 条目实测 `p95=0.80ms, max=0.86ms`（远低于 `≤ 16 ms`）；`test:ssh-term` 总计 31/31 通过 |
| 既有终端/Electron 单元测试回归 | L0 | `npm run test:unit` | 0 | 11/11 通过（`BaseSession.destroy()`、`BaseSession output before the terminal is shown`、`disposeWebglAddon`） |
| 上游改动白名单校验 | L0 | `node scripts/coport/check-upstream-diff.mjs` | 0 | `Coport upstream diff passed against 54869e10 (124 registered paths)`，0 未登记路径 |
| 模块构建与隔离 macOS 打包 | L0 | `npm run build`、`node scripts/prepackage-plugins.mjs`、`COPORT_BUILD_OUTPUT="$PWD/dist/coport-file-panel-nav" COPORT_ELECTRON_DIST="$PWD/dist/coport-m0/electron" node scripts/build-macos.mjs`（macOS arm64，隔离工具链 yarn 1.22.22，ad-hoc 签名） | 0 | 14 个插件 typings、全部 webpack bundle 与 `dist/coport-file-panel-nav/mac-arm64/Coport.app` 构建与 ad-hoc `codesign --verify` 全部通过 |
| ADB 无 `/sdcard` 启动、保值恢复、同窗口双面板同步、跨设备回退与根目录断线重试 | L2 | `python3 -B scripts/coport/sim/coport_shells.py "$PWD/dist/coport-file-panel-nav/mac-arm64/Coport.app"`（隔离 `--user-data-dir` + 假 ADB + 本机 `sshd` + 私有 PTY） | 0 | `noSdcardBoot.path="/"`, `loadError=null`，`embedded` 0 次请求 `/sdcard`；重启恢复 `/data/only-on-embedded/deep` 与收藏 `/etc`；`two` 自动回退至 `/data` 并展示回退提示条；`sameWindowSync` 双 ADB 标签实时同步星标与芯片；`two` 离线时 `/` 展示 `loadError` + `Retry` 并恢复成功 |
| SSH SFTP 按 `authUsername@host:port` 隔离、首次 CWD 优先/已有历史恢复、尾随空格、`/link/..`、通道关闭 Retry 与真实 `sshd` 逐级回退 | L2 | 同上 `coport_shells.py` | 0 | 首次有 CWD 打开 `cwd-dir`，切 `sub-a` 后重开与重启均恢复 `sub-a`；`trail ` 尾随空格目录与 `link-parent/to-real-child/..` 服务器解析正确；真实 SFTP 通道关闭后 `channelClearedOnClose=true`、`retryShownAfterClose=true`、`retryRecovered=true`；真实 `sshd` `NoSuchFile` 与 `chmod 0o000` `PermissionDenied` 均触发回退至 `readable` 并展示提示条；`alice` vs `bob` 同主机同端口完全隔离 |
| 直接敲字过滤、真实焦点键盘钻取、过滤态点击/右键/Enter、过期异步防护与 1,000 条目真实 DOM 基准 | L2 | 同上 `coport_shells.py` | 0 | 首键激活 `activeIsFilterInputAfterFirstKey=true`、`callsAfterType=0`、命中 `["g_comp","good_config.txt"]`、连续钻取至 `/data/app/g_comp/nested`、`Backspace`/`Esc` 语义正确；`filteredActions`（`rawIndex=4`, `row0Name="z-target.txt"`）点击/右键 Download/Enter 下载及右键 Delete 目标均准确；`staleOps` 慢速 `stat`/`mkdir`/`uploadOne` 均不覆盖新导航；1,000 条目真实 DOM 基准 `readdirCalls=0`、`maxMs=2.8ms`（`≤ 16 ms`） |
| 路径栏单击编辑、IME 防护、手动错误保列表复焦与既有回归 | L2 | 同上 `coport_shells.py` 及 `python3 -B scripts/coport/sim/prepare_adb.py "$PWD/dist/coport-file-panel-nav/mac-arm64/Coport.app"` | 0 | 单击编辑、IME 组字 `Enter`/`Esc` 透传不误提交、`Esc` 取消复焦、手动跳转 `/does-not-exist-manual` 保留 `/etc` 与 `hosts` 且 `focusedAfterInvalidManual=true` + 直接敲 `h` 过滤生效；ADB/SSH 上传/下载/目录上传/新建目录/删除/符号链接/拖拽/原子下载清理与 `prepare_adb.py` 全部退出 0 |

## L4 真机人工验收清单（待独立复审通过后执行）

1. 独立复审通过后，构建并安装至 `/Applications/Coport.app`，连接真实无 `/sdcard` ADB 设备（及可选 SSH 主机）。
2. 打开 Files 面板确认首次直接打开 `/`、无 `/sdcard` 报错且不卡 `Loading`。
3. 切换至可读目录并重启 Coport，确认目录恢复；切换另一设备验证共享与缺失目录自动回退提示条。
4. 点击星标收藏，在快捷芯片条与收藏/最近下拉中完成一键跳转与移除（确认收藏在最近之上、移除后保留最近记录）。
5. 不点 Filter 直接敲字模糊过滤，用 `↑/↓/Enter/Backspace/Esc` 连续逐层钻取，确认高亮清晰、布局无遮挡、手感流畅且 `Esc` 不误关面板。
