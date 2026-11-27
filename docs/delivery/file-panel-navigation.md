# 文件面板状态保值、收藏与键盘快速过滤交付记录

- **范围与分级**：M 级完整小方案（[方案文档](../specs/file-panel-navigation.md)），覆盖 `tabby-ssh` 与 `tabby-adb` 共用文件面板（`SFTPPanelComponent`）的状态保值、逐级回退与重试、星标收藏与最近目录、直接敲字模糊过滤与纯键盘逐层钻取、路径栏单击编辑、主进程原子持久化 IPC、L0/L2 自动化验收及上游改动白名单登记。
- **分支与提交**：
  - 功能分支：`feat/file-panel-navigation`
  - 基线提交：`e6083033`（来自 `feat/macos-install-and-ci`，上游基线为 Tabby v1.0.238 `54869e10`）
  - 首版实现提交：`dd1369e9`（`dd1369e9ccb56bda550b66d9355d2125d8a0b827`）
  - Codex 第 1 轮审查修复提交：`f00e4bba`（`f00e4bbad8d02f615046f472ffc43b9bf2b517b1`）
  - Codex 第 2 轮审查修复提交：`ae12c12f`（`ae12c12f86e84e845fc6aaa29b61a261b5dc0b9e`）
  - Codex 第 3 轮审查修复提交：`a0ee4ad5`（`a0ee4ad568694fb01dfd09bfc2d96be6fbb582ab`）
  - Codex 第 4 轮审查修复提交：`6501dc77`（`6501dc77370ffaf45b19ee4bffd1c323e360c7ae`）
- **当前状态**：`L4 就绪`（Codex 第 4 轮独立复审全部 5 项发现已根因修复并完成全量 L0/L2 自动验收；未覆盖 `/Applications/Coport.app`、未推送、未创建 PR）
- **累计审查轮次**：4（已完成 Codex 第 1/2/3/4 轮独立审查与全部修复，等待编排方确认或派发后续复核）
- **累计 CI 修复轮次**：0（未推送 / 无远端 CI 触发）
- **下一动作**：返回编排方，由编排方复核第 4 轮修复（`4ab9117c..HEAD` / `e6083033..HEAD`）并决定是否进入本机安装 `/Applications/Coport.app` 与 G3/L4 真机人工验收。

## 实现摘要与偏差记录

1. **主进程原子状态协调器与零 DOM 纯逻辑模块（`app/lib/coport/filePanelStateCoordinator.ts`、`app/lib/coport/filePanelStateIpc.ts`、`tabby-ssh/src/utils/`）**：
   - `app/lib/coport/filePanelStateCoordinator.ts`（零 Electron 依赖纯模块，供 `filePanelStateIpc.ts` 与 L0 单测直接导入）：封装快照加载、单线程原子执行 `coport-file-panel-state:op`、仅由主进程内部单调时钟分配时间戳（完全拒绝/忽略渲染端传入 `now`）、临时文件 + `renameSync` 原子持久化至 `userData/coport-file-panel-state.json`（`writeFileSync`/`renameSync` 失败时清理临时文件并保留内存最新态不回滚）以及变更与 LRU 淘汰广播（携带 `scope` 与 `evictedScopes`）。`app/lib/coport/filePanelStateIpc.ts`（在 `app/lib/index.ts` 注册，仅接受主窗口主 frame 请求）仅保留薄 Electron 接线，向全部未销毁 `BrowserWindow` 广播 `coport-file-panel-state:changed`。
   - `filePanelState.ts`：提供 `IpcFilePanelStateClient`（不向主进程透传 `now`、透传 `evictedScopes`）与 `createDefaultFilePanelStateClient()`，`pruneSSHScopes`/`pruneMemorySSHScopes` 返回 `evictedScopes: string[]` 并随通知与 IPC 响应下发；非 Electron/单测回退至 `FilePanelStateStore` + `FilePanelStorageLike`，通过 `failedStorageRaw` 保留写入失败后的内存最新副本不被旧存储值覆盖。
   - `filePanelFilter.ts`：实现大小写不敏感精确 > 前缀 > 连续子串 > 顺序子序列分级排序（同档目录优先 + `Intl.Collator` 字典序）；始终基于完整原串 `name.toLowerCase()` 匹配并将希腊语词尾 `ς`（`\u03C2`）1:1 归一化为 `σ`（`\u03C3`），仅在 `lowerName.length !== name.length` 时按前缀增量长度差构造 `lowerToOrig` 映射换算高亮区间（支持 `'İΟΣ'` 分别命中 `'ος'`、`'Σ'`、`'σ'`、`'ς'` 并准确高亮 `'ΟΣ'` / `'Σ'`，以及 `'İxa.txt'` 命中 `'x'`）。
   - `filePanelFallback.ts`：实现 ADB/SFTP 目录不可读、瞬时断线（`isTransientConnectionError`）与通道关闭错误分类（`isSFTPChannelClosedError` 区分普通 SFTP `Status(Failure)` 与真实通道断开）、逐级回退至 `/`、共享 SFTP 通道池 `SFTPChannelPool`、基于 `readlink` 的 POSIX 相对路径解析 `resolvePosixPathWithReadlink`（含深度 40 循环保护、通道关闭错误透传，普通路径 0 额外 RTT）、规范化目录二次列表 `finalizeCanonicalDirectoryListing` 及递归待传文件清理 `cancelPendingFileUpload`/`cancelPendingDirectoryUpload`。
   - 三个纯逻辑模块均无外部/相对运行时导入、无 TS `enum`、无构造函数参数属性，与 `filePanelStateCoordinator.ts` 均兼容 webpack TypeScript 4 编译与 Node `--experimental-strip-types` 直接单测。
2. **后端与标签页适配**：
   - `tabby-ssh/src/api/fileBackend.ts` 扩展可选属性/方法 `closed$?`、`resolvePath?` 与 `isDirectoryUnavailable?`。
   - `tabby-adb/src/adbFileBackend.ts` 在 `adbRequest` 抛出的 `Error` 上透传 `reason` 与 `stderr`，实现 `isDirectoryUnavailable`。
   - `tabby-ssh/src/session/ssh.ts` 与 `tabby-ssh/src/session/sftp.ts`：通过 `SFTPChannelPool` 维护共享 SFTP 通道缓存与并发打开复用，`openSFTP(failedBackend?)` 仅在 `this.sftp === failedBackend.rawSftp` 时关闭并替换失效通道；`SFTPSession` 暴露 `rawSftp`、实现 `resolvePath` 与 `isDirectoryUnavailable`，`readdir` 仅在真实通道关闭错误时失效会话缓存而不因普通 `Failure` 泄漏/孤立通道。
   - `tabby-adb/src/adbTab.component.ts` / `adbPanel.pug` 移除 `/sdcard` 硬编码，改为 `stateScope='adb:shared'`、`defaultPath='/'`、`path=null`。
   - `tabby-ssh/src/components/sshTab.component.ts` / `sshTab.component.pug` 透传 `sftpStateScope`（优先 `sshSession.authUsername`，缺失回退 `profile.options.user`），移除 `(pathChange)` 写回以保证无历史首次优先 CWD、有历史始终恢复 `savedLastPath`。
   - `tabby-ssh/src/index.ts` 收敛公开导出，仅导出 `tabby-adb` 所需的 `ADB_FILE_PANEL_SCOPE`。
3. **共用文件面板（`tabby-ssh/src/components/sftpPanel.component.{ts,pug,scss}`）**：
   - 初始化路径优先级：`overrideStartPath ?? savedLastPath ?? initialPath ?? defaultPath`。
   - 实现 `ngOnChanges` 与严格递增 `sessionEpoch`：在面板保持打开状态下切换 `session` 或 `stateScope`（如 SSH 同主机重连换账号）以及 `ngOnDestroy` 时，递增 `sessionEpoch` 与 `navigation`、主动关闭面板打开中的删除/新建目录弹窗、取消旧请求与订阅，并暴露 `isSessionActive(epoch, backend)`；所有删除、上传、拖拽上传（经 `dropZone.directive.ts` 在拖放瞬间捕获 `{ path, backend, epoch, request }` 快照）、下载（经 `PlatformService.startDownload`/`startDownloadDirectory` 可选 `canOpen` 守卫在 `fs.open('w')` 截断前校验）、新建目录与符号链接解析均在首个 `await` 前捕获 `backend` 与 `epoch` 并逐点校验，并在目录上传提前退出或异常时递归清理全部未提交剩余 `FileUpload`，确保账号切换后绝不误删、写入新账号文件、清空已有本地文件或泄漏文件句柄。
   - 区分真实通道关闭与普通 SFTP 业务错误：仅在 `closed$` 触发或 `isSFTPChannelClosedError(error)` 为真时标记 `failedBackendForReopen`，普通 `Status(Failure)` 下 Retry 直接复用当前健康通道而不关闭同会话兄弟面板共享通道；活动后端触发 `closed$` 时立即递增 `navigation` 并结合 `isNavigationStale(request, epoch, backend)` 在导航每个 `await` 后校验，确保路径解析期间断线后迟到结果不会覆盖 `loadError` 或隐藏 Retry。
   - SSH 含 `..` 路径先将原始路径直接发往服务端 `readdir` 校验，仅在 `readdir` 成功后若含相对段再后置调用 `backend.resolvePath` 确定服务器真实规范目录；若 `canonicalPath !== listedPath`，重新执行 `backend.readdir(canonicalPath)`（前后均校验请求号与后端有效性）而非机械改写旧条目 `fullPath`，既阻断 `/普通文件/..` 绕过服务端错误列出 `/`，又在 `/link/../missing` 回退或符号链接中途改指后保证列表条目与后续操作路径严格来自最终规范目录。
   - 订阅状态变更广播时同时匹配 `event.scope === this.stateScope` 与 `event.evictedScopes?.includes(this.stateScope)`，SSH 作用域被 LRU 淘汰后已打开面板立即清空收藏条、历史与星标。
   - 保留星标收藏按钮、紧凑收藏芯片条、收藏+最近快捷下拉、直接敲字模糊过滤（0 次远端请求，1,000 条目首键与后续键入均 `≤ 16 ms`）、`<mark>` 高亮、`↑/↓/Enter/Backspace/Esc` 纯键盘钻取（`Enter` 触发文件下载后同步清空过滤词并保持面板焦点）与路径栏单击编辑（含 IME 组字防护与尾随空格保留）。
4. **偏差记录**：无影响验收标准、对外协议或架构职责的方案偏差。`docs/specs/file-panel-navigation.md` 已统一影响范围、交互协议总述、内部契约一/二与验收矩阵为「不改对外协议/MCP/`coport-adb:*`，新增应用内部 `coport-file-panel-state:*` IPC」，与实现 100% 一致。

## 独立审查与修复记录

### 第 1 轮（Codex 独立审查，修复提交 `f00e4bba`）

| 编号 | 级别 | 审查发现 | 修复措施 | 验证状态 |
|---|---|---|---|---|
| 1 | P0 | SSH 已有历史后重开面板仍可能被 CWD 覆盖 | `SFTPPanelComponent` 改为 `overrideStartPath ?? savedLastPath ?? initialPath ?? defaultPath`，移除 `sshTab.component.pug` `(pathChange)` 回写，`coport_shells.mjs` 断言首次 CWD、重开与重启均恢复 `savedLastPath` | 通过（L2） |
| 2 | P1 | SSH 交互登录账号未纳入作用域隔离 | `sshTab.component.ts` `sftpStateScope` 优先取 `sshSession.authUsername` 再回退 `profile.options.user`；L0/L2 均新增同主机同端口不同 `authUsername`（`alice` vs `bob`）隔离验证 | 通过（L0 + L2） |
| 3 | P2 | SFTP 通道关闭后 Retry 复用已关闭缓存导致无法恢复 | `ssh.ts` 监听 `sftp.closed$` 清理缓存并支持强制重建；`sftpPanel.component.ts` 监听 `closed$` 并支持 Retry 重建；L2 覆盖真实 SFTP 通道关闭后 Retry 恢复 | 通过（L2） |
| 4 | P2 | 慢速符号链接/新建目录/上传完成后可能覆盖较新导航 | `open()`、`downloadItem()`、`openCreateDirectoryModal()`、`upload()`/`uploadOne()`、`uploadFolder()`/`uploadOneFolder()` 均在异步前捕获 `navigation` 编号，过期放弃导航/下载；L2 `staleOps` 覆盖慢速 `stat`、慢速 `mkdir` 与慢速 `uploadOne` | 通过（L2） |
| 5 | P2 | 多窗口并发保存不同作用域存在单键覆写风险 | `filePanelState.ts` 改为按作用域分键 `coport.filePanelState.v1:<scope>`；L0 新增可控交错读写测试验证双方作用域均保留 | 通过（L0） |
| 6 | P2 | 50 个 SSH 作用域同毫秒写入可能误淘汰新写入主机 | 写入生成严格大于现有最大值的 `updatedAt` 且 `pruneSSHScopes` 保护当前写入作用域（永不淘汰 `adb:shared`）；L0 新增双 Store 冻结同毫秒测试 | 通过（L0） |
| 7 | P2 | 同窗口两个 ADB 面板星标与收藏芯片未实时同步 | `filePanelState.ts` 新增同窗口 `subscribeFilePanelStateChanges`，`SFTPPanelComponent` 在 `ngOnInit`/`ngOnDestroy` 订阅与反注册；L2 `sameWindowSync` 覆盖双 ADB 标签实时同步 | 通过（L0 + L2） |
| 8 | P2 | 路径输入缺 IME 组字防护，手动错误跳转后未恢复面板焦点 | `onPathInputKeyDown` 检查 `isComposing || keyCode === 229`；手动跳转不可读保留列表时调用 `cdr.detectChanges()` 与焦点恢复；L2 真实驱动路径 `<input>` 验证 | 通过（L2） |
| 9 | P2 | SSH 路径编辑裁剪尾随空格及客户端提前折叠 `/link/..` | `confirmPath()` 保留非空路径尾随空格，SFTP（无 `backend.normalizePath`）不折叠 `..`；L2 覆盖真实 sshd 带尾随空格目录 `trail ` 与跨父目录 `/link/..` | 通过（L0 + L2） |
| 10 | P2 | L2 1,000 条目基准未计入完整 DOM 更新且首键焦点流未校验 | 面板增加列表虚拟窗口渲染（`VIRTUAL_THRESHOLD = 80`）；L2 校验首键激活后 `document.activeElement === filterInput` 并计入完整 DOM 更新 | 通过（L2） |
| 11 | P2 | 过滤态下点击/右键/Enter 缺少真实 DOM 目标路径断言 | L2 `filteredActions` 通过真实 DOM 行触发点击、右键菜单（Download 与 Delete）及 `Enter`，断言实际下载与删除目标均为 `z-target.txt` 且其他文件不受影响 | 通过（L2） |
| 12 | P2 | 缺少真实本机 `sshd` 下目录缺失与无权限逐级回退验收 | L2 构造本机 `sshd` 不存在深层目录与 `chmod 0o000` 无权限目录（`finally` 恢复 `0o700`），验证真实 `russh` `NoSuchFile`/`PermissionDenied` 触发逐级回退与提示条 | 通过（L2） |
| 13 | P3 | UTF-16 变长小写高亮偏移、`upstream-changes.md` 通配路径与过多公开导出 | `filePanelFilter.ts` 增加 UTF-16 索引映射并增补 `İxa.txt` L0 用例；`upstream-changes.md` 精确逐项登记工具与测试文件；`tabby-ssh/src/index.ts` 收敛为仅导出 `ADB_FILE_PANEL_SCOPE` | 通过（L0） |

### 第 2 轮（Codex 独立复审，修复提交 `ae12c12f`）

| 编号 | 级别 | 审查发现 | 修复措施 | 验证状态 |
|---|---|---|---|---|
| 1 | P0 | 定版方案架构图与测试的 SSH 启动优先级存在不一致，重启恢复测试未带不同 CWD 断言 | 方案第 45 行架构图已统一为「无历史时首开用 CWD，已有历史时优先恢复上次目录」；`coport_shells.mjs` 在 SSH 重开面板与重启应用（`sshAfterRestart`）两处均提供不同的 `reportedCWD`（`cwd-dir`），共同断言优先恢复 `savedLastPath`（`sub-a`/`sub-b`） | 通过（L2） |
| 2 | P1 | SSH 保持面板打开时重连换账号，原面板未重新初始化且沿用旧账号状态 | `sftpPanel.component.ts` 实现 `ngOnChanges`，当 `session` 或 `stateScope` 变化时递增 `navigation`、取消旧 `closed$` 订阅、清空旧后端/旧错误/旧路径/下拉与过滤态、切到新作用域收藏与历史并重新 `initializeBackendAndNavigate()`；L2 `liveReconnectAccountSwitch` 保持原面板实例不关闭切换账号验证收藏/历史/Retry 均严格隔离 | 通过（L2） |
| 3 | P2 | 两个共享同一 `SSHSession` 的面板依次 Retry 会关闭已恢复的新共享通道 | `filePanelFallback.ts` 新增 `SFTPChannelPool`，`ssh.ts` 改为 `openSFTP(failedBackend?)` 仅在 `this.sftp === failedBackend.rawSftp` 时关闭失效通道并复用进行中的 `openingChannel` Promise；`sftpPanel.component.ts` 在 `retryLoad()` 传入失效 `failedBackend`；L0/L2 均验证第二个面板复用已恢复新通道且不关闭它 | 通过（L0 + L2） |
| 4 | P2 | 普通 SFTP 操作失败（如 `Failure`）误清会话缓存导致远端 SFTP 通道泄漏/孤立 | `filePanelFallback.ts` 新增 `isSFTPChannelClosedError`，`sftp.ts` 的 `readdir` 仅在通道/传输关闭错误时触发 `onInvalidate`（调用 `close()` 并清空精确通道引用），普通 `Failure`/`NoSuchFile`/`PermissionDenied` 不清空缓存不泄漏；L0 覆盖全部错误分类与 `close()` 调用次数 | 通过（L0 + L2） |
| 5 | P2 | 慢速 `openSFTP()` 与连续打开两个符号链接未分配并沿用独立请求编号 | `initializeBackendAndNavigate` 在 `openSFTP()` 之前分配 `request = ++this.navigation` 并透传给 `navigateWithFallback`；`open()` 分配独立 `request = ++this.navigation` 并透传给 `navigateWithRequest`；L2 `staleOps` 覆盖慢速 `openSFTP('/data/app')` 被 `/etc` 覆盖，及双符号链接两种解析顺序均由第二个胜出 | 通过（L2） |
| 6 | P2 | 多窗口并发时间戳分配、写入与 50 SSH 作用域 LRU 裁剪缺少主进程原子边界 | 新增 `app/lib/coport/filePanelStateIpc.ts`（在 `app/lib/index.ts` 注册，校验主窗口主 frame），复用 `FilePanelStateStore` 在 Node 单线程内原子执行 `coport-file-panel-state:op`、临时文件 + `renameSync` 持久化 `userData/coport-file-panel-state.json` 并广播 `coport-file-panel-state:changed`；渲染端通过 `IpcFilePanelStateClient` 接入；L0 验证双窗口同毫秒交错写入与 50 主机 LRU 原子裁剪，L2 验证重启从 JSON 文件恢复 | 通过（L0 + L2） |
| 7 | P2 | 作用域已有存储记录时，写入失败（配额不足/磁盘只读）会被旧记录覆写 | `FilePanelStateStore` 改用 `failedStorageRaw` 记录失败时的底层旧值，读取时若底层值未变则保留内存最新副本，待写入成功或外部写入新值后清除；主进程落盘失败保留内存态不回滚；L0 覆盖先成功写入 `/old` 再注入 `QuotaExceededError`/`EACCES` 写入 `/new` 与收藏并验证完整保留 | 通过（L0） |
| 8 | P2 | 含 `..` 的 SSH 路径向上浏览抵达根目录后持续追加 `/..` 无法收敛 | `FileBackend` 新增 `resolvePath?`，`sftp.ts` 实现 `resolvePath` 调用 `resolvePosixPathWithReadlink` 按服务器 `readlink` 语义解析含 `..` 路径（普通路径 0 额外 RTT，深度上限 40）；`SFTPPanelComponent` 导航前经 `resolvePath` 得到真实规范路径；L0 覆盖根下 `/link/..`→`/`、相对链接与循环保护，L2 真实 `sshd` 验证连续 `Backspace` 收敛至 `/`、`Go up` 消失且历史无 `..` | 通过（L0 + L2） |
| 9 | P2 | ADB 异步列表加载完成后从终端抢回键盘焦点 | `SFTPPanelComponent` 在 `ngAfterViewInit` 首次聚焦，异步加载完成回调改用 `focusPanelIfOwned()`（仅在焦点为空、`document.body` 或面板内部时聚焦，绝不抢占外部 `.xterm-helper-textarea`）；L2 `staleOps` 覆盖慢速 ADB 加载期间切回终端后焦点保持在终端 | 通过（L2） |
| 10 | P2 | 1,000 条目 L2 基准未将未展开过滤栏时的首键纳入 `≤ 16 ms` 计时 | `coport_shells.mjs` `/bulk` 基准取消预热，确保 `showFilter === false` 后直接计时首键 `'i'`（含创建过滤栏、过滤 1,000 条目、聚焦 `<input>` 与 DOM 更新），实测 `firstKeyMs=2.9ms`、后续键入 `maxMs=2.9ms`（均 `≤ 16 ms`）且 `readdirCalls=0` | 通过（L2） |
| 11 | P3 | 增高窗口后虚拟列表未重算可见范围导致底部留白 | `sftpPanel.component.ts` 在 `ngAfterViewInit` 对 `bodyContainer` 挂载 `ResizeObserver`（`ngOnDestroy` 断开），视口尺寸变化时在虚拟模式下重算可见范围并触发变更检测；L2 `/bulk` 验证增高视口后挂载行数由 `36` 增至 `70` | 通过（L2） |
| 12 | P3 | UTF-16 变长小写路径丢失上下文小写规则（`İΟΣ` 无法匹配 `ος`） | `filePanelFilter.ts` 始终对完整原串 `name.toLowerCase()` 执行匹配，仅在长度变化时用前缀增量长度差构建 `lowerToOrig` 映射换算高亮区间；L0 增补 `'İΟΣ'` 匹配 `'ος'` 命中并高亮 `'ΟΣ'`，同时保留 `'İxa.txt'` 断言 | 通过（L0） |

### 第 3 轮（Codex 独立复审，修复提交 `a0ee4ad5`）

| 编号 | 级别 | 审查发现 | 修复措施 | 验证状态 |
|---|---|---|---|---|
| 1 | P0 | 定版方案协议口径与主进程 `coport-file-panel-state:*` IPC 新增说明未全面统一 | 统一 `docs/specs/file-panel-navigation.md` 影响范围、交互协议总述、内部契约一/二与验收矩阵为「不改对外协议/MCP/`coport-adb:*`，新增应用内部 `coport-file-panel-state:*` IPC」，与实现 100% 对齐并纳入提交 | 通过（静态核对 + 契约对齐） |
| 2 | P1 | SSH 换账号后，旧面板上发起的删除/上传等异步操作可能误删或写入新账号的文件 | `sftpPanel.component.ts` 维护严格递增 `sessionEpoch`（切换 `session`/`stateScope` 及销毁时递增并关闭打开中弹窗）与 `isSessionActive(epoch, backend)`；`sftpContextMenu.ts`、`sftpDeleteModal.component.ts` 及面板全部上传/下载/建目录/链接解析在首个 `await` 前捕获 `backend` 与 `epoch` 并逐点校验、仅使用捕获后端；L2 `coport_shells.mjs` 为 `bob` 构造独立 `SFTPSession` 后端，验证切账号后确认旧 Delete 弹窗与完成旧上传选择器时 `bobOps={unlink:0,rmdir:0,upload:0,mkdir:0}` 且 `uploadTransferCancelled=true` | 通过（L2） |
| 3 | P2 | 普通 SFTP 业务错误（如 `Status(Failure)`）后的 Retry 误关闭健康的共享通道 | `sftpPanel.component.ts` 仅在 `closed$` 或 `isSFTPChannelClosedError(error)` 为真时标记 `failedBackendForReopen`；普通 `Status(Failure)` 下 Retry 直接复用当前健康 `this.backend` 重试，绝不传给 `session.openSFTP(failed)` 关闭共享通道；L0 与 L2 均验证 `healthyCloseCalls=0`、兄弟面板持续可用，同时保留真实 `Channel closed` 后重建通道断言 | 通过（L0 + L2） |
| 4 | P2 | SSH 含 `..` 路径在 `readdir` 前调用 `resolvePath` 会绕过服务端错误列出 `/` 并污染历史 | 取消 `readdir` 前的预解析，先将原始路径直接发往服务端 `readdir` 校验；仅在 `readdir` 成功后若含相对段再后置调用 `backend.resolvePath` 收敛为服务器真实规范目录并改写列表项 `fullPath`；L0 与 L2 真实 `sshd` 验证手动跳 `/<普通文件>/..` 报错保留原列表且不写历史，以及 `/to-root-child/../missing` 回退至 `/to-root-child/..` 成功后收敛为 `/`、`Go up` 消失且历史记 `'/'` | 通过（L0 + L2） |
| 5 | P2 | SSH 作用域被 LRU 淘汰后，变更广播未携带被淘汰作用域导致已打开面板未同步刷新 | `filePanelState.ts` 的 `pruneSSHScopes`/`pruneMemorySSHScopes` 返回 `evictedScopes: string[]` 并随 `FilePanelStateOpResponse` 与 `coport-file-panel-state:changed` 全窗口广播；`sftpPanel.component.ts` 订阅同时响应 `event.evictedScopes?.includes(this.stateScope)` 立即刷新；L0 与 L2 `lruEvictionLiveRefresh` 验证写入 50 个新 SSH 作用域后已打开面板立即清空收藏条、历史与星标 | 通过（L0 + L2） |
| 6 | P2 | 主进程 IPC 入口仍接受渲染端传入的 `now`，存在时间戳伪造破坏 LRU 顺序风险 | `executeFilePanelStateOp` 与 `IpcFilePanelStateClient` 移除并完全忽略渲染端 `now`，由主进程协调器内部时钟单调递增分配（`nowProvider` 仅作工厂构造参数供单测注入）；L0 直接调用生产协调器传入伪造倒退/重复 `now`（`5000`/`4000`/`4000` 及递减 `now`）验证 `updatedAt` 严格单调递增且 LRU 顺序正确 | 通过（L0） |
| 7 | P2 | 主进程状态协调逻辑与 Electron 耦合导致 L0 未直接验证生产落盘失败与广播路径 | 抽出零 Electron 依赖纯模块 `app/lib/coport/filePanelStateCoordinator.ts`（导出 `createFilePanelStateCoordinator({ filePath, fsOps?, broadcast?, nowProvider? })`），`filePanelStateIpc.ts` 仅保留薄接线；`filePanelNavigation.test.ts` 直接导入生产模块并在 `fsOps` 注入 `writeFileSync`/`renameSync` 失败验证内存态保留、临时文件清理及广播 `scope`/`evictedScopes` | 通过（L0） |
| 8 | P2 | 过滤态按 `Enter` 下载文件后未清空过滤词 | `sftpPanel.component.ts` 在 `activateSelectedItem()` 调用 `open(item, { clearFilterOnDownload: true })`，文件下载分支同步调用 `this.clearFilter(true)` 并保持面板焦点；L2 `filteredActions` 断言按 `Enter` 下载后 `filterText=""`、`showFilter=false`、`focusedAfterEnterDownload=true` | 通过（L2） |
| 9 | P3 | 希腊语词尾 Sigma 大小写不敏感匹配不一致（`'İΟΣ'` 未命中 `'Σ'`/`'σ'`） | `filePanelFilter.ts` 对 `lowerName` 与 `lowerQuery` 统一将 `\u03C2`（`ς`）1:1 归一化为 `\u03C3`（`σ`），保持 `lowerToOrig` 索引映射精确；L0 验证 `'İΟΣ'` 分别搜索 `'ος'`、`'Σ'`、`'σ'`、`'ς'` 均命中并准确高亮 `'ΟΣ'`/`'Σ'` | 通过（L0） |

### 第 4 轮（Codex 独立复审，修复提交 `6501dc77`）

| 编号 | 级别 | 审查发现 | 修复措施 | 验证状态 |
|---|---|---|---|---|
| 1 | P1 | SSH 换账号后，旧账号的拖拽上传可能在目录扫描完成后写入新账号 | `tabby-core/src/directives/dropZone.directive.ts` 将 `dropTarget`/`transferAt` 扩展为兼容任意目标上下文（保持对 `string` 向后兼容）；`sftpPanel.component.ts` 的 `getDropTarget` 在拖放瞬间捕获 `{ path, backend, epoch, request }`，`uploadOneFolder` 校验 `isSessionActive(resolvedEpoch, resolvedBackend)`，失效时立即递归取消全部待传文件并退出；L2 `coport_shells.mjs` 触发 Alice 真实 `drop` 并在扫描完成前切换至独立 `bobBackend`，断言 `bobOps.upload=0, bobOps.mkdir=0` 且 `dragCancelCounts={root:1,nested:1}` | 通过（L2） |
| 2 | P2 | 取消过期的 SSH 下载时，`showSaveDialog` 返回后先 `fs.open(target, 'w')` 会清空已有本地文件 | `tabby-core/src/api/platform.ts` 与 `tabby-electron/src/services/platform.service.ts` 为 `startDownload`/`startDownloadDirectory` 新增可选 `canOpen?: () => boolean` 守卫，在对话框返回后、`fs.open('w')`/`fs.mkdir` 之前校验并在返回 `false` 时直接返回 `null`；`SFTPPanelComponent.download()` 与 `downloadFolder()` 传入 `() => this.isSessionActive(epoch, backend)`；L2 `coport_shells.mjs` 在真实 `ElectronPlatformService.startDownload` 的 `showSaveDialog` 等待期间切换 Alice→Bob 后确认覆盖非空本地文件 `keep-existing-download.txt`，断言文件内容保持 `'MUST-NOT-BE-TRUNCATED\n'` 未被截断且 `bobOps.download=0` | 通过（L2） |
| 3 | P2 | 符号链接变化后机械改写旧列表项 `fullPath` 可能导致列表与最终规范目录不一致 | 移除 `rebaseEntriesIfNeeded`，在 `filePanelFallback.ts` 实现 `finalizeCanonicalDirectoryListing` 并在 `navigateWithFallback` 与 `navigateWithRequest` 共用：当后置 `resolvePath` 返回 `canonicalPath !== listedPath` 时重新执行 `backend.readdir(canonicalPath)`（前后均校验请求号与后端有效性），确保展示与操作条目严格来自最终规范目录；L0 与 L2（手动跳转与启动回退双路径，真实 `sshd` 磁盘符号链接改指）均断言最终仅展示新父目录 `only-in-parent-b.txt` 且 `fullPath` 准确 | 通过（L0 + L2） |
| 4 | P2 | 路径解析期间断线（`backend.closed$` 触发）时，迟到的旧解析结果可能覆盖 `loadError` 导致 Retry 消失 | `SFTPPanelComponent.attachBackend` 在 `backend.closed$` 触发时递增 `++this.navigation` 使所有基于旧后端的在途导航失效；新增 `isNavigationStale(request, epoch, backend)`（校验 `destroyed || request !== navigation || !isSessionActive(epoch, backend)`）并在 `navigateWithFallback` 与 `navigateWithRequest` 的每一个 `await`（`readdir`、`resolvePath`、规范化二次 `readdir`）及 `catch` 中严格校验；`resolvePosixPathWithReadlink` 透传通道关闭错误；L0 与 L2（手动跳转与启动回退双路径）均断言 `loadError` 与 Retry 保持可见、不被旧列表覆盖且点击 Retry 可恢复 | 通过（L0 + L2） |
| 5 | P2 | 目录上传中途取消或异常提前返回时未清理剩余未提交 `FileUpload` 导致文件句柄与传输项泄漏 | 在 `filePanelFallback.ts` 实现 `cancelPendingFileUpload` / `cancelPendingDirectoryUpload` 并在 `sftpPanel.component.ts` 的 `cancelDirectoryUpload` / `uploadOneFolder` / `uploadDirectoryEntries` 中跟踪已交给后端的 `handled` 集合：在会话切换、面板销毁、后端失效或中途抛错提前返回时，递归遍历整棵 `DirectoryUpload` 树（含嵌套子目录与 0 字节未提交文件），对每个尚未处理、未取消且未完成的 `FileUpload` 恰好调用 1 次 `cancel()`（避免重复 `close()`）；L0 与 L2（多文件+两层嵌套目录在首文件上传期间切账号至 Bob）均断言 `midDirCancelCounts={first:0,second:1,third:1,fourth:1}` 且 `bobOps.upload=0, bobOps.mkdir=0` | 通过（L0 + L2） |

## L0–L2 自动验收矩阵证据

被测实现与测试提交：`6501dc77`（构建产物隔离于 `dist/coport-file-panel-nav/mac-arm64/Coport.app`，未触碰 `/Applications/Coport.app`）。

| 验收项 | 级别 | 执行命令与环境 | 退出码 | 关键证据 |
|---|---|---|---|---|
| 代码规范静态检查 | L0 | `npm run lint` | 0 | ESLint 0 errors / 0 warnings（覆盖 `*/src` 与 `*/lib` 含本次改动的 `tabby-core`、`tabby-electron`、`tabby-ssh` 与 `app/lib/coport`） |
| 状态存储、生产协调器、落盘失败保留、单调时钟与容量上限（20/50/50） | L0 | `npm run test:ssh-term`（Node `--experimental-strip-types`） | 0 | `filePanelState` 10/10 用例通过：直接导入生产 `app/lib/coport/filePanelStateCoordinator.ts`，验证伪造倒退/重复 `now` 全部被忽略且 `updatedAt` 严格递增（`5000→5001→5002`）、`fsOps` 注入 `writeFileSync`/`renameSync` 失败时 `/new` 与收藏保留在内存不被旧磁盘 JSON 覆写且清理临时文件、51st SSH 淘汰广播携带 `evictedScopes` |
| 目录回退、规范化二次列表、断线过期丢弃与嵌套上传递归取消 | L0 | `npm run test:ssh-term` | 0 | `filePanelFallback` 10/10 用例通过（含普通 `Status(Failure)` 后 Retry 复用健康通道 `close()` 为 0、真实 `Channel closed` 后重建通道且兄弟面板复用、符号链接改指后二次 `readdir('/parent-b')` 严格返回新目录条目、`resolvePath`/二次 `readdir` 期间断线丢弃迟到结果、`cancelPendingDirectoryUpload` 递归幂等清理多文件/0 字节/嵌套目录每个剩余项恰好调用 1 次 `cancel()`） |
| 子串与模糊匹配、希腊语词尾 Sigma 高亮与 1,000 条目性能 | L0 | `npm run test:ssh-term` | 0 | `filePanelFilter` 4/4 用例通过（含 `'İΟΣ'` 命中 `'ος'`/`'Σ'`/`'σ'`/`'ς'` 准确高亮 `'ΟΣ'`/`'Σ'` 与 `'İxa.txt'` 映射）；1,000 条目实测 `p95=0.54ms, max=0.61ms`（远低于 `≤ 16 ms`）；`test:ssh-term` 总计 38/38 通过 |
| 既有终端/Electron 单元测试回归 | L0 | `npm run test:unit` | 0 | 11/11 通过（`BaseSession.destroy()`、`BaseSession output before the terminal is shown`、`disposeWebglAddon`） |
| 上游改动白名单校验 | L0 | `node scripts/coport/check-upstream-diff.mjs` | 0 | `Coport upstream diff passed against 54869e10 (126 registered paths)`，0 未登记路径 |
| 模块构建与隔离 macOS 打包 | L0 | `npm run build`、`node scripts/prepackage-plugins.mjs`、`COPORT_BUILD_OUTPUT="$PWD/dist/coport-file-panel-nav" COPORT_ELECTRON_DIST="$PWD/dist/coport-m0/electron" node scripts/build-macos.mjs`（macOS arm64，隔离 yarn 1.22.22，ad-hoc 签名） | 0 | 14 个插件 typings、主进程 `tabby-main` 与全部 webpack bundle、隔离 `dist/coport-file-panel-nav/mac-arm64/Coport.app` 构建与 ad-hoc 签名校验全部通过 |
| ADB 无 `/sdcard` 启动、主进程 JSON 持久化恢复、同窗同步、终端焦点保护与根目录重试 | L2 | `python3 -B scripts/coport/sim/coport_shells.py "$PWD/dist/coport-file-panel-nav/mac-arm64/Coport.app"`（隔离 `--user-data-dir` + 假 ADB + 本机 `sshd` + 私有 PTY） | 0 | `noSdcardBoot.path="/"`, `loadError=null`；`userData/coport-file-panel-state.json` 原子落盘并跨重启恢复 `/data/only-on-embedded/deep` 与收藏 `/etc`；`two` 自动回退 `/data` 并展示提示条；`sameWindowSync` 双 ADB 标签实时同步；慢速 ADB 加载期间切回终端后 `focusedTermBeforeLoad=true`, `focusedTermAfterLoad=true`；根目录离线重试恢复成功 |
| SSH 隔离、换账号拖拽/下载/目录上传防护、符号链接改指二次列表、解析断线保 Retry 与 LRU 热刷新 | L2 | 同上 `coport_shells.py` | 0 | `liveReconnectAccountSwitch` 构造独立 `bobBackend`（`distinctBobBackend=true`），覆盖旧 Delete 弹窗、旧上传选择器、真实 `drop` 延迟扫描、真实 `ElectronPlatformService.startDownload` 的 `showSaveDialog` 覆盖非空本地文件（磁盘实测保持 `'MUST-NOT-BE-TRUNCATED\n'`）及多文件嵌套 `DirectoryUpload` 中途切账号，全部断言 `bobOps={unlink:0,rmdir:0,upload:0,mkdir:0,download:0}`, `uploadTransferCancelled=true`, `dragCancelCounts={root:1,nested:1}`, `midDirCancelCounts={first:0,second:1,third:1,fourth:1}`；`symlinkRetargetManual`/`symlinkRetargetFallback` 均落于 `retarget-parent-b` 且仅含 `only-in-parent-b.txt`；`disconnectDuringResolveManual`/`disconnectDuringResolveFallback` 均保持 `hasLoadError=true, retryVisible=true, fileListIsNull=true, recoveredAfterRetry=true`；`operationalFailureRetry`、`manualFileDotDot`、`sshSymlinkRootFallback`、`lruEvictionLiveRefresh` 全通过 |
| 直接敲字过滤、Enter 下载清过滤、过期异步、1,000 条目首键基准与虚拟列表 ResizeObserver | L2 | 同上 `coport_shells.py` | 0 | `filteredActions`（`rawIndex=5`, `row0Name="z-target.txt"`）点击/右键 Download/Enter/Delete 目标均准确，按 `Enter` 下载后 `filterTextAfterEnterDownload=""`, `showFilterAfterEnterDownload=false`, `focusedAfterEnterDownload=true`；`staleOps` 慢速 `openSFTP`/双符号链接双序/慢速 `stat`/`mkdir`/`uploadOne` 全通过；1,000 条目未展开过滤栏首键 `firstKeyMs=3.7ms`、后续全查询 `maxMs=3.7ms`（`≤ 16 ms`, `readdirCalls=0`）；视口增高后挂载行数由 `36` 增至 `70` |
| 路径栏单击编辑、IME 防护、手动错误复焦与既有回归 | L2 | 同上 `coport_shells.py` 及 `python3 -B scripts/coport/sim/prepare_adb.py "$PWD/dist/coport-file-panel-nav/mac-arm64/Coport.app"` | 0 | 单击编辑、IME 组字 `Enter`/`Esc` 透传、`Esc` 取消复焦、手动错误保留列表复焦；ADB/SSH 既有上传/下载/目录上传/新建目录/删除/符号链接/拖拽/原子下载清理与 `prepare_adb.py`（10/10 项全 `true`）全部退出 0 |

## L4 真机人工验收清单（待独立复审通过后执行）

1. 独立复审通过后，构建并安装至 `/Applications/Coport.app`，连接真实无 `/sdcard` ADB 设备（及可选 SSH 主机）。
2. 打开 Files 面板确认首次直接打开 `/`、无 `/sdcard` 报错且不卡 `Loading`。
3. 切换至可读目录并重启 Coport，确认目录恢复；切换另一设备验证共享与缺失目录自动回退提示条。
4. 点击星标收藏，在快捷芯片条与收藏/最近下拉中完成一键跳转与移除（确认收藏在最近之上、移除后保留最近记录）。
5. 不点 Filter 直接敲字模糊过滤，用 `↑/↓/Enter/Backspace/Esc` 连续逐层钻取，确认高亮清晰、布局无遮挡、手感流畅且 `Esc` 不误关面板。
