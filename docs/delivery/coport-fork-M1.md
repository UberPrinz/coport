# Coport fork M1 交付记录

- 功能分支 `feat/coport-fork`，目标 `main`，M1 起始提交 `39ab33f2`。原实现读取基线 `2c1ea46`。
- 状态为启动前核对后等待方案裁决。当前没有 M1 产品代码，审查和 CI 修复均为 0 轮，无 PR。
- M0 已准出。[M0 交付记录](coport-fork-M0.md) · [验收证据](coport-fork-M0-evidence.txt)

## 待裁决项

1. R1 要求界面没有更新入口。禁用主进程更新器和默认自动更新后，设置页仍会显示检查更新按钮与自动更新开关。R8 白名单未列入负责这些入口的模板。建议将 `tabby-settings/src/components/settingsTab.component.pug` 加入白名单，在模板删除这两个入口并登记上游改动。[R1](../specs/coport-fork.md#需求与验收) · [上游白名单](../specs/coport-fork.md#上游改动清单与同步流程) · [检查更新按钮](../../tabby-settings/src/components/settingsTab.component.pug#L17) · [自动更新开关](../../tabby-settings/src/components/settingsTab.component.pug#L91)
2. 计划把构建和独立启动列入 M1。规格的独立启动行还要求创建 `mcp.sock`，计划将 MCP host 放在 M2。建议 M1 先验收隔离独立启动，M2 使用完整 MCP host 重跑该用例并核对 socket 与后台拉起。[验收矩阵](../specs/coport-fork.md#验收矩阵) · [里程碑计划](../plans/coport-fork.md#里程碑计划)

## 隔离准备验证

使用 Electron 43.7.0、现有 Darwin 串口绑定与本次新开的私有 PTY 验证 `FIONREAD`。一次性 Node-API 探针在现有绑定持有的 fd 上读到 9 个缓冲字节，消费后读到 0，fd 与 PTY 的 `st_rdev` 一致。此结果验证了在同一个 fd 上保留 Swift 的陈旧输出水位判断的可行性。产品移植仍待实现。完整输出位于忽略目录 `dist/coport-m1/evidence/fionread-private-pty.log`。

下一步是确认上述范围与验收时点，同步规格和计划后从本分支实现 M1。FTDI、CH340 和原 Coport 会话均保持原状态。
