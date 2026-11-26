# Coport fork M1 交付记录

- 功能分支 `feat/coport-fork`，目标 `main`，M1 起始提交 `39ab33f2`。原实现读取基线 `2c1ea46`。
- 两项启动前裁决由 `5285dfca` 落实到规格与计划。依赖锁文件裁决已登记。恢复时核对验收矩阵，发现 R7 的 MCP 生命周期证据需要 M2 的 MCP host。当前没有 M1 产品代码，审查和 CI 修复均为 0 轮，无 PR。
- M0 已准出。[M0 交付记录](coport-fork-M0.md) · [验收证据](coport-fork-M0-evidence.txt)

## 已确认裁决

1. R1 要求界面没有更新入口。禁用主进程更新器和默认自动更新后，设置页仍会显示检查更新按钮与自动更新开关。R8 白名单未列入负责这些入口的模板。已授权将 `tabby-settings/src/components/settingsTab.component.pug` 加入白名单，在模板删除这两个入口、加注释并登记上游改动。[R1](../specs/coport-fork.md#需求与验收) · [上游白名单](../specs/coport-fork.md#上游改动清单与同步流程) · [检查更新按钮](../../tabby-settings/src/components/settingsTab.component.pug#L17) · [自动更新开关](../../tabby-settings/src/components/settingsTab.component.pug#L91)
2. 计划把构建和独立启动列入 M1。规格的独立启动行还要求创建 `mcp.sock`，计划将 MCP host 放在 M2。已授权在 M1 验收隔离启动日志 `coport: ready` 且进程树无原 Swift App，M2 使用完整 MCP host 重跑该用例并核对 socket，另验收后台拉起。[验收矩阵](../specs/coport-fork.md#验收矩阵) · [里程碑计划](../plans/coport-fork.md#里程碑计划)

## 隔离准备验证

使用 Electron 43.7.0、现有 Darwin 串口绑定与本次新开的私有 PTY 验证 `FIONREAD`。一次性 Node-API 探针在现有绑定持有的 fd 上读到 9 个缓冲字节，消费后读到 0，fd 与 PTY 的 `st_rdev` 一致。此结果验证了在同一个 fd 上保留 Swift 的陈旧输出水位判断的可行性。产品移植仍待实现。完整输出位于忽略目录 `dist/coport-m1/evidence/fionread-private-pty.log`。

## 已裁决：主进程依赖锁文件

规格要求从 app 包解析 `@xterm/headless`、`@xterm/addon-serialize` 和 `@modelcontextprotocol/sdk`。前两项用于 M1 的 headless 解析，SDK 用于 M2。R8 白名单列出了 `app/package.json`，未列出 `app/yarn.lock`。

在 `5285dfca` 上，`git ls-files --error-unmatch app/yarn.lock` 退出 0，确认锁文件已受版本控制。静态检查确认三个依赖在该锁文件内均无条目。仓库安装脚本在 `app/` 独立运行 Yarn，渲染包的锁文件不能为主进程解析这些依赖。M0 探针使用的是忽略目录中的单独依赖安装。

编排方已批准 `app/yarn.lock` 随 `app/package.json` 更新，仅限三个新增依赖及其传递依赖的锁定记录。[规格白名单](../specs/coport-fork.md#上游改动清单与同步流程)和[上游改动记录](../coport/upstream-changes.md)已同步，锁项随实现生成。

## 已裁决：R7 生命周期分阶段验收

- M1 在隔离 Coport.app 与私有 PTY 验证关窗后串口会话保留、Dock 重开后挂回原代次并恢复历史、Disconnect 后 fd 为 0、退出后释放 fd、重启不自动重连。
- M2 接入 MCP host 后重跑完整 R7，补齐关窗后通过 MCP 读写、Disconnect 后旧绑定返回 `channel_lost`，以及退出后删除 `mcp.sock` 的证据。
- 后续有跨里程碑依赖的验收行按同一规则执行。当前里程碑验证已有能力并记录剩余判据和重跑里程碑。依赖交付后重跑整行，首版保留全部原判据。
