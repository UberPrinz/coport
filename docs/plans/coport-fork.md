# Coport（Tabby fork）首版交付计划

- 方案与基线：[docs/specs/coport-fork.md](../specs/coport-fork.md)，随功能分支首个提交入库。fork `main` 为 Tabby v1.0.238 `54869e1`。原实现基线为 `~/project/coport` 的 `2c1ea46`。
- 目标与现状：用一个 Coport.app 取代"原 Swift App + Tabby 插件"的双进程组合。当前 fork 仍是原版 Tabby，原实现的仲裁、MCP 和 ADB 能力分散在 Swift 与插件 JS 中，需要迁入主进程，并改造 `tabby-serial` 和 SFTP 面板。
- 约束：首版只做 macOS arm64。真机只有 CH340（`/dev/cu.wchusbserial1130`，921600 8N1）和 Android 设备 `0000000000000000000000000000004`，没有 SSH 授权目标，SSH 只用本机回环。Tabby 内的 UI 自动化通过验收夹具完成，Codex 的桌面工具不能操作 Tabby。
- 确认与授权：G1 确认的 R1–R8 即为 MVP。G2 已选主进程 headless 解析器，P1 未准出时回退到隐藏 owner 窗口。M0 预研已获授权。按 dev-flow，授权由 Codex 在 `~/project/coport-tabby` 的功能分支上执行 M0–M4，直到汇总 PR 就绪；不合并，不指派 reviewer。
- MR 汇总边界：只涉及一个仓库 `UberPrinz/coport`，功能分支为 `feat/coport-fork`（从 `main` `54869e1` 拉出）。各里程碑以验收通过并提交 commit 结束。M4 结束后统一创建一个指向 `main` 的 PR，并完成 CI。原仓库 `~/project/coport` 只读，作为移植来源。

## MVP 建议

**推荐的首期闭环：**开发者在 macOS 上只装 Coport.app，用 Tabby 原有的 serial profile 打开 CH340。AI 通过 `coport-mcp` 加入同一会话读写，双方互不拼接；同一窗口里可以打开 ADB Shell 并浏览、传输设备文件。首期要验证的价值是：单一应用能完整替代原 App 与插件组合，且不退化。

| 范围 | 需求引用与能力 | 保留或推迟的理由 | 去向 |
|---|---|---|---|
| 首期包含 | R1 单一应用 | 不能独立运行就谈不上替代 | M1 打骨架，M4 收尾签名 |
| 首期包含 | R2 唯一串口、R6 遗留问题、R7 生命周期 | 人这一侧的核心链路，也是原架构缺陷集中的地方 | M1 |
| 首期包含 | R3 仲裁一致、R4 MCP 兼容 | 人与 AI 共享是产品的核心价值，现有 AI 配置必须能继续使用 | M2 |
| 首期包含 | R5 ADB Shell 与文件面板 | 用户 G1 明确要求首版包含 | M3 |
| 首期包含 | R8 可维护 | fork 能否长期跟进上游 | M4（各里程碑随时登记改动） |
| 首期推迟 | 日志查看器与高亮规则；`get_view_state` 暂时固定返回 `log: null` | 用户已确认放到第二期，并计划迁移成熟编辑器 | 第二期待排期 |
| 不做 | Windows/Linux、本地缓存、AI 设置面板 | 用户确认不在首版范围内 | 无 |

- 成功判据：spec 验收矩阵中全部 L0–L2 行通过；M4 的 G3 真机人工验收项通过；汇总 PR 不是 Draft，且所需 CI 通过。
- 价值反馈：用户日常使用 Coport.app 替代原 App 后的反馈，在 PR 就绪后由用户试用提供。在此之前不算价值已验证。
- 主要风险与前置验证：P1 headless 解析器一致性（失败时回退方案 A，验收不变）；P2 主进程 serialport 与 busy 成因；P3 MCP SDK 经 socket 的兼容性。三项都在 M0 先行验证。
- 取舍与待决定事项：范围和关键设计已由 G1/G2 确认。由用户决定按现有证据准出 P2，把真机对端收包核对推迟到 M4 G3（L4），由用户在已上电并进入 shell 的 FTDI 板上执行。FTDI 仍由原 Coport 占用，本阶段保留现有设备连接。

## 里程碑计划

MVP 由 M1 至 M4 共同构成。M0 是前置预研，只产出准出结论，不算 MVP 的一部分。

| 里程碑与归属 | 可验收结果与范围 | 需求／验收引用 | 主要负责方 | 前置条件 | 结束条件 |
|---|---|---|---|---|---|
| M0 · 前置工作 | P1、P2、P3 的预研结论与证据：通过、未通过并启用回退、或证据不足。同时确认 fork 能在本机构建并启动 | spec 中"前置预研与准出标准"的 P1–P3；验收矩阵的三条预研行 | Codex（coport-tabby） | 功能分支已建立 | 各项结论写回 spec 的"验证状态与结论"，探针代码和证据提交到 commit。P1 未通过时在 spec 中改用方案 A 并记录原因 |
| M1 · MVP | 人能用 Coport.app 中的 serial profile 共享打开串口：品牌与构建骨架、关闭统计和更新、主进程 sessionManager/serialHub/headless/IPC、`tabby-serial` 改为会话代理、WCH 优先与波特率提示、15 秒统一截止、R6 busy 修复、关窗保留与 Dock 挂回、退出释放、重启不重连、迁移 sim 框架与验收夹具 | R1（构建与隔离独立启动，socket 在 M2 验收）、R2、R6、R7；验收矩阵中对应的构建、启动、唯一串口类型、单一 fd、WCH、无输入 busy、统一截止、生命周期和视图尺寸各行（M1 用私有 PTY 验证串口生命周期） | Codex | M0 准出 | 上述验收行通过，独立审查通过，提交 commit |
| M2 · MVP | AI 经 `coport-mcp` 接入同一会话：mcpHost、Swift shim 打包与拉起、exec/prepare_shell 移植、仲裁单测转写、sim 全量回归 | R1（重跑独立启动并核对 `mcp.sock`）、R3、R4、R7（接入 MCP host 后重跑完整生命周期行）；验收矩阵中的防拼接仲裁、exec 全路径、MCP 工具兼容与后台拉起、socket 安全与连接上限 | Codex | M1 提交 | 同上 |
| M3 · MVP | ADB：新增 `tabby-adb` 包，SFTP 面板改用 FileBackend，实现 ADB 后端，exec 优先走 ADB，SFTP 不回退 | R5；验收矩阵中的 ADB exec 路由、ADB 文件面板后端、SFTP 面板泛化不回退、同窗多类会话 | Codex | M2 提交 | 同上 |
| M4 · MVP | 收尾：签名、`check-upstream-diff` 脚本、`upstream-changes.md` 与同步流程、G3 真机验收（含 P2 的 FTDI 对端收包）、汇总 PR 与 CI | R1（签名）、R8；上游改动白名单；人工验收项（含 P2 的 L4） | Codex；G3 由用户操作 | M3 提交 | 跨模型审查通过，G3 通过，汇总 PR 非 Draft 且 CI 通过 |

估时：每个里程碑以"验收与审查通过"为准，不承诺工期。仲裁移植约 2k 行，加上 sim 迁移，M1 和 M2 成本最高。

### 当前里程碑 M3

M2 已提交。M3 实现 ADB Shell、ADB 优先的 MCP exec 和共用文件面板。本阶段用假 adb、私有 PTY 与本机 OpenSSH 回环验证，真机操作留到 M4。

## 当前进展与问题

| 里程碑 | 当前状态与实际结果 | 起止 commit／证据／交付记录／汇总 MR | 下一动作与负责方 |
|---|---|---|---|
| M0 | 已提交，独立复审无阻塞项。P1、P3、arm64 构建与隔离启动通过。P2 两组私有 PTY 双向收发和单一 fd 通过，采用既有 CH340 读取、本机写入与 drain 证据。由用户决定将真机对端收包推迟到 M4 G3（L4） | `54869e1` → `39ab33f2`。[M0 交付记录](../delivery/coport-fork-M0.md) · [验收证据](../delivery/coport-fork-M0-evidence.txt) | M4 G3 时由用户使用已上电并进入 shell 的 FTDI 板核对收包 |
| M1 | 已提交。尺寸同步、R7 私有 PTY 生命周期、独立启动与第 4 轮复审通过 | `39ab33f2` → `b414202e`，裁决 `fb57641a`。[交付记录](../delivery/coport-fork-M1.md#实现期设计决定) · [验收证据](../delivery/coport-fork-M1-evidence.txt) | M2 接入 MCP host 后重跑完整 R1 启动和 R7 生命周期 |
| M2 | 已提交。完成 MCP 六工具、Swift shim、串口 exec、仲裁移植和 R1/R7 回归。异 UID 的 L1 凭据测试和 L2 文件系统实测通过，末轮独立复审无发现 | `b414202e` → `69984e92`。[M2 交付记录](../delivery/coport-fork-M2.md) | M3 接入 ADB 路由与文件面板 |
| M3 | 进入实现与隔离验收 | 起点为 M2 提交及其状态记录 | 实现 ADB 与 SFTP 后端并验证同窗共存 |
| M4 | 等待 M3 | G3 L4、P2 真机写入和汇总 PR 待后续 | M3 提交后准备签名及人工验收 |
