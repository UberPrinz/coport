# Coport fork M0 交付记录

- P1–P3 已满足 M0 准出条件，独立复审无阻塞项。由用户决定把 P2 真机对端收包推迟到 M4 G3（L4）。授权范围为 M0–M4 至汇总 PR 就绪。
- 分支为 `feat/coport-fork`，目标为 `main`。基线 `54869e1`，定稿文档提交 `0efd1d52`。M0 结束提交见交付计划。原实现基线 `2c1ea46`，工作区保持只读。
- 本地环境为 macOS arm64、Node 22.23.5、Yarn 1.22.22、Electron 43.7.0。P1 使用 xterm 5.5.0、serialize 0.12.0。P2 使用 fork app 包安装并针对 Electron 构建的 serialport 11.0.1 与 bindings-cpp 11.0.3。P3 使用 TS SDK 1.29.0。
- 独立审查 2 轮。首轮指出旧 PTY 日志混有失败输出、验收证据未入库。已替换为通过的原始字节复测和可随提交查看的摘录，复审无 P0–P2。CI 修复 0 轮，无 PR，无功能分支远端提交。

## 执行与证据

主要运行输出摘录已入库。[M0 验收证据](coport-fork-M0-evidence.txt)

本机全量日志保存在仓库忽略的 `dist/coport-m0/evidence/`。表中标注历史的结果来自恢复交付前的运行。除原版 Swift 对照包以外，探针运行版本为 `0efd1d52` 加本次 M0 改动。

| 项目 | 入口 | 结果 |
|---|---|---|
| P1 | `env -u ELECTRON_RUN_AS_NODE "$electron" scripts/coport/probe/history-main.cjs` | 退出 0。12 个样本步骤的状态与原 History 一致。20,008 条提交记录逐条相等，主进程解析 1,180,000 字节耗时 32 ms，复测 48 ms。回放后 152 行的文本及前景、背景颜色一致。`p1-resume.log` |
| P2 隔离 PTY | `env -u ELECTRON_RUN_AS_NODE python3 -B scripts/coport/probe/serial_pty.py "$electron"`，合并 stdout/stderr | 复测退出 0。符号链接与真实路径的 `st_rdev` 一致。主进程打开时持有一个 fd，关闭后为零。打开前注入被清掉，同时注入在本次到达解析器，两个场景的 master 都只收到 `61 69 0d`。本机日志 `p2-pty-raw.log` |
| P2 CH340（历史） | `env -u ELECTRON_RUN_AS_NODE "$electron" scripts/coport/probe/serial-main.cjs ch340 /dev/cu.wchusbserial1130` | 探针退出 0。921600 8N1 收到 575 字节，含 3 行可读文本和 0 个 UTF-8 替代字符。1 字节写入和 drain 成功，对端收字节待观测。关闭清理后主进程 fd 为 0，系统 `lsof` 未发现占用。`p2-ch340.log` |
| P2 FTDI（历史） | `env -u ELECTRON_RUN_AS_NODE "$electron" scripts/coport/probe/serial-main.cjs ftdi-shell /dev/cu.usbserial-A45P861Z` | 2026-11-26 一次短借。921600 8N1、无流控，打开时 fd 为 1。写入 `\r` 后 drain 成功，约 1.5 秒内未匹配到以 `#` 或 `$` 结尾的 shell 提示符，探针退出 1。未发送算术回显或 256 字节比对命令。关闭后 fd 为 0，重开原 Coport 后 `lsof` 确认其 PID `40880` 持有该端口。`p2-ftdi.log` |
| P3 | `env -u ELECTRON_RUN_AS_NODE python3 -B scripts/coport/probe/mcp_parity.py "$electron" ../coport ../coport/build/Tabby-M3-Serial-Settings-Coport.app` | 退出 0。使用原 Python 客户端与包内 Swift shim。Swift 参考包为 `bcc365c`，与 `2c1ea46` 仅交付文档有差异。六工具清单、schema、代表性结果逐字段一致。SDK 探针在客户端被杀后 1.4 ms（复测 1.59 ms）内标记半行，另一连接收到 `busy`。结果快照和半行状态为探针夹具，完整仲裁与工具逻辑在 M2 验收。`p3-resume.log` |
| 本地构建（历史） | `yarn --frozen-lockfile --network-timeout 1000000`、`yarn run build`、`node scripts/prepackage-plugins.mjs`、`CI=true ARCH=arm64 CSC_IDENTITY_AUTO_DISCOVERY=false node scripts/build-macos.mjs` | 构建与打包退出 0。产物为 arm64 `dist/mac-arm64/Tabby.app` 与对应 DMG/ZIP。采用上游 CI 所用的 app Electron 依赖软链接。安装日志中的上游可选补丁版本告警未影响构建。`build.log` · `package.log` |
| 隔离启动 | `env -u ELECTRON_RUN_AS_NODE "$electron" scripts/coport/probe/startup-main.cjs` | 退出 0。从 fork 构建的主进程包收到渲染器 `app:ready`。使用新的用户目录，关闭该次运行的统计与更新，保护宿主的 `tabby://` 处理器。`startup-resume.log` |
| 上游回归 | `yarn run test:ssh-term`、`yarn run test:unit` | 14 和 11 个用例通过。`test-ssh-resume.log` · `test-unit-resume.log` |

`$electron` 指校验过 SHA-256 的 Electron arm64 发行包中的可执行文件。本次路径为 `dist/coport-m0/electron/Electron.app/Contents/MacOS/Electron`。探针所需 JS 包安装在忽略目录 `dist/coport-m0/probe-deps`，使用 `npm install --prefix dist/coport-m0/probe-deps --no-save --no-package-lock @xterm/xterm@5.5.0 @xterm/headless@5.5.0 @xterm/addon-serialize@0.12.0 @modelcontextprotocol/sdk@1.29.0`。

## 推迟到 G3 的 P2 真机验收

CH340 对端是日志源，成功 drain 的证据覆盖本机写入路径。由用户决定按 CH340 读取、本机写入与 drain、两组隔离 PTY 双向收发和单一 fd 的现有证据准出 M0。真机对端收包在 M4 G3（L4）由用户核对。一次 FTDI 短借已结束，原 Coport 已恢复。此次恢复 M0 仅运行隔离 PTY。

串口探针现将每段接收的原始字节记录为 `receivedHex` 和 `receivedText`，其中不可打印字节显示为 `.`；PTY 驱动也记录 master 收到的字节。先前的真机探针日志保留历史结果。

G3 时，用户给 FTDI 板接好电并进入 shell，释放原 Coport 对该端口的占用后，从 fork 仓库根目录运行：

```sh
set -o pipefail
env -u ELECTRON_RUN_AS_NODE "$electron" scripts/coport/probe/serial-main.cjs \
  ftdi-shell /dev/cu.usbserial-A45P861Z 2>&1 | tee dist/coport-m0/evidence/p2-g3-ftdi.log
```

预期在 921600 8N1、无流控下收到 shell 提示符、`COPORT_P2_42` 和完整 256 字节模式，探针退出 0 并记录 `closed fd=0`。保留十六进制日志供核对。

原 G3 的 busy 此次未复现。M1 分别覆盖终端自动应答、启动陈旧输出与人工半行互斥。
