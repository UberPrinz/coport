# Coport fork M4 交付记录

- 功能分支 `feat/coport-fork`，目标 `main`，M4 起点 `af1833ce`。上游基线是 Tabby v1.0.238 `54869e1`，产品代码基线是 M3 `b39dc20a`。
- 范围为 ad-hoc 签名、上游差异检查、累计审查、最终隔离回归和 G3 真机人工验收。夹具修正后编排方独立复跑通过（split-attach-final-review.log），G3 按用户确认的范围完成。M4 的实现及交付记录留在同一工作区，汇总 PR 和 CI 在 G3 之后继续。
- 候选为 Coport `1.0.239-nightly.0`、macOS arm64、Electron 43.7.0。由 `af1833ce` 加当前未提交的 M4 源码构建。构建时 `HEAD` 为 `af1833ce`，工作区 15 个修改文件和 2 个新增文件均属 M4。产品改动 SHA-256 为 `2a99c6abc390d91aaa24c8543757c45a4be75b4d5381d3808c9d5f2db6f9966a`，`app.asar` SHA-256 为 `1d72d6d606570855bc6c6db5cd6ca786e967a569a5351e534a5d46cb82af9128`。串口插件、ZIP、DMG 校验值亦见 `dist/coport-m4/evidence/artifact.sha256`。验证环境使用私有 PTY、假 adb 与本机 OpenSSH。

## 实现期设计决定

1. macOS 构建在 Electron fuse 更新后、归档前调用系统 codesign 对 Coport.app 执行 ad-hoc 签名与严格校验。关闭依赖签名身份的 hardened runtime、Team ID 和 notarization，复用 M1–M3 运行验证过的签名方式。
2. [上游改动记录](../coport/upstream-changes.md) 首列是可执行白名单。已存在的上游文件需逐项匹配，fork 专用路径前缀只接受新增文件。同步时可传入目标上游 tag，默认比较首版基线。
3. 全量 webpack 编译修正了 ADB stat 路径的空数组类型推断和串口异步解析的队列释放函数类型，运行时顺序和契约保持原样。
4. G3 使用最终目录包与独立数据路径。真实串口、Android USB 授权和 Finder 拖放由用户执行。P2 FTDI 仍用 M0 的独立 Electron probe 记录原始字节。
5. 编排复审发现普通视图可能在半个 UTF-8 字符或 ANSI 控制序列后挂接，xterm 快照只捕获已解析内容。普通视图最多等待 2 秒，超时可重试。完整批次优先整批解析。读批次以未完成的 UTF-8 字符或 ESC/CSI 结尾且此前解析状态完整时，快照包括该批前缀，后缀使用下一序号。历史继续处理整批数据，沿用已有全屏限制。等待挂接时的工具栏断开取消等待并释放 fd，设备掉线应用标签结束策略。
6. 串口生命周期和 exec 隔离测试显式设置不存在的测试 adb 路径。首轮复跑发现这两项测试继承了宿主 ADB，两个只用于断言的 `true` 调用被路由到 ADB。最终串口测试使用固定的隔离路径。

## 自动验收

| 项目 | 执行入口 | 证据 |
|---|---|---|
| 可发布归档的本机 ad-hoc 签名 | `node scripts/build-macos.mjs`，随后对目录包和归档内的 Coport.app 运行 `codesign --verify --deep --strict` | 目录包、ZIP 解包和 DMG 只读挂载的应用都通过严格校验。签名为 ad-hoc，应用 ID 为 `local.coport.app`。主包和串口插件逐字节相符。见 `signing.log`、`archive-verify.log` 与 `artifact.sha256` |
| 上游差异检查 | `node scripts/coport/check-upstream-diff.mjs` | 基线 `54869e10` 正向通过。临时未登记文件命中拒绝分支，清除后通过。见 `upstream.log`、`upstream-reject.log` |
| 最终隔离回归 | `npm run build`、lint、Node 单测、对 M4 包重跑全部受影响的串口和 ADB 路径 | 全量构建、lint、16 项 Coport 单测、14 项 SSH 单测和 11 项终端/Electron 单测通过。MCP wire、独立启动、后台冷启动、R7、几何、十六进制、历史 20,001 行与 239 项 exec/prepare_shell 检查通过。假 adb 的 exec 路由、真实回环 SFTP 和四类同窗终端通过。见 `rebuild.log`、`rebuild-main.log`、`rebuild-serial.log`、`wire.log`、`lifecycle.log`、`serial-exec-all.json`、`adb-exec.log`、`shells.log` |
| 普通串口分帧挂接和增量 | `python3 -B scripts/coport/sim/coport_serial.py "$bundle" --split-attach` | 旧签名包提前返回快照，见 `split-attach-before.log`。新签名包实测 UTF-8 及带颜色的 CSI 分帧、等待期 MCP 历史继续提交、每帧仍以含 CR/LF 的半条 CSI 结尾时的批内挂接、快照与增量连续序号、保存和恢复光标、等待中改尺寸、超时重试、拆离、工具栏断开和设备掉线，见 `split-attach.log` |
| 累计审查及修复复审 | 上游 `54869e1` 到 M4 工作区，修复轮从 `af1833ce` 检查增量与前序交互 | 编排方接替跨模型复审并复现原始 P2。四轮独立增量核对后，末轮无剩余 P0–P2 |

前次累计审查核对了上游文件登记、签名入口、产物与 G3，P3 的 CI 自动集成和上游注释留待同步维护。本轮更新串口工具栏的上游登记。独立复审先后补齐了持续分片、工具栏断开、完整帧上的保存光标与制表位、G0 字符集、待挂接掉线，以及半条 CSI 内含 CR/LF 的场景。末轮用锁定的 xterm 回放方逐一比对纯色 CSI、UTF-8 和含 CR/LF 的 CSI 分帧，并核对保存光标、HTS 和 G0 的完整帧。现有 CI 尚未运行此白名单和隔离 sim，证据使用本机执行结果。

## 分帧挂接复跑

编排方的失败发生在同一进程重开第二个窗口之后。CLI 已匹配 profile，夹具已看到挂接请求并发出 ANSI 尾帧，之后窗口只剩一个空标签头，`serialTabs:0`。对照实验中，延迟尾帧超过 2 秒会得到 `timeout`，串口标签仍在。主动关闭私有 PTY master 会得到 `ended` 和 `channel_lost`，此前恢复出的空标签头会保留。原失败日志缺少这些 IPC 结果，且原夹具连续 5 轮及仅加诊断后连续 10 轮均通过，原事件的直接触发条件尚未证实。对照见 `split-attach-induced-timeout.log` 和 `split-attach-induced-loss.log`。

分帧夹具现在禁用标签恢复，以免显式打开 profile 时混入空的 split wrapper。每次通过 PID 定向的 macOS reopen 事件重建窗口后，核对新窗口属于同一候选进程、同一隔离数据目录，且标签数为零。ANSI 的 CR/LF 帧和尾帧等待对应 MCP 提交行，防止旧的空当前行提前满足等待。改变尺寸时等待实际 resize 请求到达仍在等快照的前端，再提供后续字节。挂接失败立即报告串口 IPC 结果，保留 2 秒快照等待及全部验收场景。独立的生命周期、几何和十六进制用例继续使用标签恢复设置。此次调整只涉及测试夹具，可复用原目录签名包及归档。

同一 macOS arm64 签名候选连续 6 轮退出 0，每轮验证 4 个同进程窗口、5 次可见终端和 MCP 历史一致性，以及 `100×25` 的 ANSI 挂接。见 `dist/coport-m4/evidence/split-attach-repeat-summary.log` 与 `split-attach-repeat-01.log` 至 `split-attach-repeat-06.log`。M3 签名包在第一个半 UTF-8 字符上提前返回快照，修正后的夹具仍判定失败。见 `split-attach-repeat-m3-negative.log`。同一 M4 包上的 `--lifecycle`、`--geometry`、`--hex-monitor` 均通过，见 `split-attach-repeat-regression-*.log`。目录包严格签名、四项产物 SHA-256、白名单和 `git diff --check` 均通过。

在原仓库根目录复核。

```sh
(
  set -e
  bundle="$PWD/dist/coport-m4/mac-arm64/Coport.app"
  codesign --verify --deep --strict "$bundle"
  shasum -a 256 -c dist/coport-m4/evidence/artifact.sha256
  for round in 1 2 3; do
    python3 -B scripts/coport/sim/coport_serial.py "$bundle" --split-attach
  done
)
```

## G3 已反馈结果

2026-11-26，用户确认 CH340 的 WCH 节点在 921600 下输出正常。在 G3 实例中打开 Nexus 4 的 ADB Shell 后，用户确认 Android 文件传输验证通过。早先报找不到 adb 的窗口属于指定了 no-adb 的自动测试实例。设备文件哈希数值未随反馈提供。使用签名候选自带的 MCP relay 附着到实际持有 WCH 端口的实例（PID 57677）。open_serial 返回 reused=true，read_terminal 读取 5 行，附着前后该进程均只有一个 WCH fd。该实例使用 smoke profile，Android 验收使用独立 G3 profile。只读探针仅保存计数和代次，见 dist/coport-m4/evidence/g3-ch340-readonly.log。

2026-11-27，按用户要求跳过真机半行互斥测试。使用签名候选与独立测试配置连接空闲 CH340（921600）。关闭最后一扇窗口后，通过 macOS 的 kAEReopenApplication 事件重开，重新打开同一串口配置。窗口 ID 已变化，MCP 两次绑定均复用同一会话，关窗前、无窗口期间和重开后均只有一个 WCH fd。向重开窗口发送鼠标拖选事件后，系统剪贴板文字与选区一致，并在 MCP 历史中匹配。首次复制取样未得到可比文本，改为等待非空设备输出并按终端字符坐标拖选后通过。桌面当时锁定，覆盖的是 Dock 所用的系统重开事件，图标点击本身未观察。测试实例已退出并释放串口。

2026-11-27，FTDI A45P861Z 已枚举，端口空闲。独立探针在 921600 8N1、无流控下收到 shell 提示符和 COPORT_P2_42，完整匹配板端返回的 256 字节，退出码 0，closed fd=0。证据 p2-g3-ftdi.log 仅保存结果摘要。签名严格校验和清单中的四项 SHA-256 复核通过。

## G3 操作清单

从仓库根目录校验 G3 候选，校验均显示 OK 后打开 Coport.app。下列变量仅用于这次人工运行。候选以本记录开头的构建版本和校验值为准。

```sh
set -o pipefail
shasum -a 256 -c dist/coport-m4/evidence/artifact.sha256
bundle="$PWD/dist/coport-m4/mac-arm64/Coport.app"
profile="$PWD/dist/coport-m4/g3-profile"
mkdir -p "$profile"
env -u COPORT_TEST_ADB -u COPORT_TEST_SOCKET TABBY_PLUGINS='' \
  "$bundle/Contents/MacOS/Coport" --user-data-dir="$profile" \
  > dist/coport-m4/evidence/g3-app.log 2>&1 &
coport_pid=$!
printf '%s\n' "$coport_pid" > dist/coport-m4/evidence/g3-app.pid
printf 'G3 Coport PID %s\n' "$coport_pid"
```

1. 在该 Coport 窗口的快速连接中选择 CH340 的 WCH 节点与 `921600`。核对同设备的 WCH 节点排在前面、输出可读。通过只读 MCP 探针核对会话复用。保留 WCH 排序截图和 `lsof` 输出，核对进程只有一个该设备的 fd。
2. 授权 Android USB 后打开 Coport ADB Shell 和 Files。将已准备的 `dist/coport-m4/g3-android-test.txt` 从 Finder 拖入 `/sdcard`，用下面的命令检查设备文件与 SHA-256，再下载并以 `shasum -a 256` 和原文件核对。原始哈希见 `evidence/g3-android-fixture.sha256`。
3. 关闭隔离 Coport 的最后一扇窗口，从该候选的 Dock 图标重开并重新打开同一 WCH profile。拖选并复制一段可辨认的终端输出，和 CH340 探针的 `read_terminal` 文字核对。确认探针中的 `open_serial` 仍显示 `reused:true`，`session_id` 和关闭窗口前一致。
4. P2 FTDI 由用户给板上电、进入 shell 并临时释放原 Coport 的 FTDI 端口。按下面命令验收 `921600 8N1`、无流控。核对先收到 shell 提示符，再收到 `COPORT_P2_42` 和完整 256 字节模式。探针应退出 0 并记录 `closed fd=0`。[M0 真机验收依据](coport-fork-M0.md#推迟到-g3-的-p2-真机验收)

CH340 探针。把第一行的占位符替换成在隔离窗口选中的 WCH 节点。

```sh
export COPORT_G3_WCH_PORT='<当前 WCH 路径>'
coport_pid=$(cat dist/coport-m4/evidence/g3-app.pid)
lsof -a -p "$coport_pid" "$COPORT_G3_WCH_PORT" | tee dist/coport-m4/evidence/g3-ch340-fd.log
COPORT_TEST_SOCKET="$profile/mcp.sock" COPORT_G3_SHIM="$bundle/Contents/MacOS/coport-mcp" \
  python3 -B - <<'PYTHON' | tee dist/coport-m4/evidence/g3-ch340-mcp.log
import json, os, sys
from pathlib import Path
sys.path.insert(0, 'scripts/coport/sim')
import mcp_client
mcp_client.SHIM = Path(os.environ['COPORT_G3_SHIM'])
client = mcp_client.Client('coport-g3-ch340', env=os.environ.copy())
try:
    opened = client.call('open_serial', {'path': os.environ['COPORT_G3_WCH_PORT'], 'baud': 921600})
    assert opened['reused'], opened
    print(json.dumps(opened))
    history = client.call('read_terminal', {'max_lines': 5})
    print('last_line', history['last_line'], 'lines_read', len(history['lines']))
finally:
    client.close()
PYTHON
```

Android 文件核对。把设备序列号和下载路径替换为本次实际值。

```sh
adb -s '<Android serial>' shell 'ls -l /sdcard/g3-android-test.txt && sha256sum /sdcard/g3-android-test.txt'
shasum -a 256 dist/coport-m4/g3-android-test.txt '<下载的文件路径>'
```

P2 FTDI 探针。

```sh
set -o pipefail
electron="$PWD/dist/coport-m0/electron/Electron.app/Contents/MacOS/Electron"
env -u ELECTRON_RUN_AS_NODE "$electron" scripts/coport/probe/serial-main.cjs \
  ftdi-shell /dev/cu.usbserial-A45P861Z 2>&1 | awk '!/receivedHex/' | tee dist/coport-m4/evidence/p2-g3-ftdi.log
```

验收后回复各步骤的结果、证据和异常。M4 提交、汇总 PR 和 CI 从该验收结果继续。
