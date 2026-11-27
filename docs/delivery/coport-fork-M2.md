# Coport fork M2 交付记录

- 功能分支 `feat/coport-fork`，目标 `main`，M2 起始提交 `b414202e`。原 Swift / Tabby 插件基线 `2c1ea46`。
- 执行授权涵盖 M2–M4。M2 的范围包括 MCP host、Swift shim、串口 exec 和 prepare_shell、Swift 仲裁回归、R1 的 socket 与 R7 完整生命周期。
- 受测版本是 `b414202e` 加本工作区 M2 改动。macOS arm64、Electron 43.7.0、Node 22.23.5。产品联调使用 `dist/coport-m2/mac-arm64/Coport.app`、临时数据目录和私有 PTY。所有串口验证仅用私有 PTY。异 UID 补测及重建使用 Node 26.4.0。独立审查 6 轮。前五轮的 1 项 P1 和 9 项 P2 均已修复，第六轮针对最终修复复审无发现。CI 修复 0 轮，M2 提交为 `69984e92`，作为 M3 产品代码基线。尚无 PR。

## 已确认裁决

AI 调用 `open_serial` 遇到配置冲突时返回与原 Swift 完全一致的 `code`、`message`、`retryable`。活动波特率、数据位、校验、停止位和流控出现在 `message`。人侧 `coport-serial:ensure` 同样报告 `config_conflict`，另返回包含六个参数的结构化 `active`。规格的共享 fd 验收行已分开列出两端判据。

快照通过 M0 的 Swift 参考包 `Tabby-M3-Serial-Settings-Coport.app` 及包内 shim 重新采集。六工具使用独立 socket。冲突样本启动参考包的 `--tabby-host`，只在独立 `tabby.sock` 上注册最小 owner 夹具并打开私有 PTY，Swift 实际生成错误响应。快照位于 [swift-mcp.json](../../scripts/coport/sim/swift-mcp.json)。

异 UID 验收由编排方按用户授权拆成 L2 文件系统验证和 L1 凭据分支测试。此机不能免密切换 UID，原手动用例的 `sudo -n` 返回 `sudo: a password is required`。隔离包实测 socket 权限 0600、父目录权限 0700，且属主均为进程 UID，其他普通用户无法穿过父目录访问 socket。保留 `--foreign-uid` 供有 root 的环境手动运行。

## 实现期设计决定

1. 主进程通过 CommonJS 加载锁定的 MCP SDK 1.29.0。SDK 的 Zod 4 类型声明需要 TypeScript 5，本仓库的 TypeScript 4 保持原版。低层 SDK handler 保留 Swift 六工具及结果字段，socket 传输沿用换行 JSON。连接校验用同一 Node-API 模块提供的 Darwin `getpeereid`。
2. 人侧 `active` 的第六项 `flowControl` 包含 `rtscts`、`xon`、`xoff`、`xany`，保留 Tabby 配置可表达的组合。MCP 继续使用原来的流控枚举与错误文案。
3. Serial exec 和提示符解析按 Swift 状态机转写。输入操作由当前 MCP 连接绑定，连接 EOF 保护遗留半行。显式 Disconnect 后旧绑定的输入和执行报告 `channel_lost`，已经提交的历史仍可读取。
4. Headless 对终端查询沿用原渲染器的设备属性回复，并用 xterm 默认调色板处理 OSC 颜色查询。主进程对队列已满时尚未入队的终端回复采用原插件的 64 KiB 上限和 3.5 秒重试窗口。
5. 测试 shim 的冷启动分支只在显式提供测试包和 socket 时直接启动隔离包，由 DevTools 查询所有 renderer targets。正常拉起分支用原 bundle ID 和 `open -g -j`，本阶段验收使用隔离分支。M2 包沿用 M1 目录产物的 ad-hoc 签名方式，M4 负责正式构建落地。直接使用 electron-builder 的 ad-hoc identity 同时开启 hardened runtime 时，本机遇到了 Electron Framework 的 Team ID 加载错误。
6. 对端 UID 来源可由测试通过构造参数注入。应用默认从同一个原生模块读取对端 UID。单测对真实 Unix socket 连接注入不同 UID，断言无响应且未调用 MCP 接收路径。
7. 首审后，路径只在会话管理器中解析。应用保留做人侧配置比较的原始路径，AI 读取活动会话的规范路径。串口原生绑定缺少 errno 时，识别其 open / lock 错误格式，保留 Swift 的 `port_busy` 和无效路径契约。AI 重绑保留同一连接的输入所有权，实际 EOF 才在活动 hub 上触发遗留半行保护。

8. 第二轮审查后，文件系统路径解析异步执行。后完成解析的旧请求仍先进入设备打开队列，解析时间计入同一个 15 秒截止。恢复 Swift 的 16 台串口设备上限，达到上限后现有会话继续可复用。
9. 旧版 JSON-RPC 批处理沿用当前持有连接的 MCP SDK 和工具处理器。按 Swift 顺序执行批内请求并汇总一条响应，批处理结束后再派发后续帧。尚未派发的数据达到 1 MiB 时暂停读取，积压排空至阈值以下后恢复，单帧长度仍独立校验。暂停期间用同一个原生模块通过 Darwin `EVFILT_READ/EV_EOF` 监视对端关闭，每 20 ms 和下一次批内派发前检查，以保留 EOF 对半行的保护。没有批处理时独立消息依旧可并发。空批次和格式不合法的帧沿用 Swift 的错误码、文案及 detail。

## 独立审查

首轮修复活动路径、原生错误码和重绑后的输入所有权。第二轮修复路径解析截止、共享设备上限和旧版批处理。第三轮补齐旧版非法批次响应，并恢复批次间执行顺序，避免把重绑后的数据写入上一台设备或让后续取消阻塞批次。第四轮将批处理积压改为套接字背压，累计超过单帧上限的合法帧仍可完成。第五轮复现了暂停读取导致 EOF 延后，修复后在私有隔离包中实测积压期间断开约 21 ms，后续写入 0 字节。第六轮复审确认修复。第二轮 P3 延后，原 Swift 为渲染端协议预留槽位而限制同时等待的历史请求，本版通过主进程 headless 直接读取，暂沿用每次最长 10 秒的等待上限。

## 验收

命令均从 fork 根目录执行。`$bundle` 是 M2 的隔离包。`$electron` 是 M0 缓存的独立 Electron 43.7.0。完整日志位于 `dist/coport-m2/evidence/`。

| 验收项 | 执行入口 | 证据 |
|---|---|---|
| arm64 构建及目录签名 | `node scripts/coport/build-native.mjs`、主进程 webpack、electron-builder 目录包、`codesign --verify --deep --strict "$bundle"` | 主进程构建和隔离目录签名通过 |
| R1 独立启动 | `node scripts/coport/smoke.mjs "$bundle"` | `coport: ready`，进程树无 Swift App 后代，启动创建属主模式 0600 的 `mcp.sock`，退出删除。见 `r1-reviewed.log` |
| R7 生命周期、人侧冲突与打开顺序 | `python3 -B scripts/coport/sim/coport_serial.py "$bundle" --lifecycle`，另跑 `--geometry`、`--hex-monitor` | 实际 renderer IPC 和 Swift shim。关窗后读写私有 PTY，Dock 重挂同代次和历史。人侧结构化 `active` 六项。人先、AI 先、IPC/MCP 并发及别名各自复用代次。Disconnect 后旧绑定输入和执行返回 `channel_lost`，退出 fd 为 0 且 socket 删除，重启无串口标签和 fd |
| MCP wire 与后台拉起 | `python3 -B scripts/coport/sim/wire_test.py "$bundle"`、`python3 -B scripts/coport/sim/shim_autostart.py "$bundle"` | 六工具清单、schema、代表性响应及真实 Swift 冲突快照逐字段相同，分片 JSON、同一连接长轮询、遗留半行和中断通过。保留活跃 socket，0600 文件、0700 目录，第 17 条连接拒绝，进程未监听 TCP/UDP。40 条终端查询在串口写队列饱和后完整应答。遗留半行保护低于 200 ms，shim 冷启动时 renderer targets 为 0。旧版批处理验证成功响应、空批次、无效元素、迟到取消、连续重绑后只写入新设备，以及两个约 600 KiB 合法帧积压时连接保持并按顺序响应。第 17 台共享串口设备返回可重试的 `queue_full`，已有会话仍可复用 |
| R3 仲裁与历史 | `node scripts/coport/sim/build-fixtures.mjs`、`node --test scripts/coport/sim/serial-arbitration.test.cjs`、`python3 -B scripts/coport/sim/coport_history.py "$bundle"` | 13 项单测，覆盖统一打开截止、解析顺序、原生错误码以及队列预留、旧完成、Ctrl-O、Ctrl-C、取消未发送的中断和强制断开。历史通过实际 PTY 提交 20,001 行，验证缺口、游标、清屏、长轮询、单解析器应答及原始输出不落盘。M0 已记录 xterm 序列化的滚动区域及保存光标限制 |
| 串口 exec / prepare_shell | `scripts/coport/sim/serial_exec.sh "$bundle" all` | 实际 /bin/sh 作业控制 PTY，239 个断言，含静默 100 条、持续模拟内核日志 100 条、2 MiB 输出截断、命令返回码、引号、中断和恢复 |
| M1 既有回归 | `coport_serial.py "$electron"` 依次使用 `--extended`、`--open-noise`、`--history`、`--timeout`；另运行 `npm run lint`、`npm run test:ssh-term`、`npm run test:unit` 和 `serial-profiles.test.mjs` | 复用同一 fd，打开噪声和鼠标上报不会伪造半行，真实人工半行继续受保护，统一打开截止实测约 15 秒，之后无 fd。SSH 14 个、终端 11 个、profile 2 个用例通过 |
| 非属主 UID | L2：`python3 -B scripts/coport/sim/wire_test.py "$bundle"`。L1：`node scripts/coport/sim/build-fixtures.mjs` 后运行 `node --test scripts/coport/sim/mcp-peer-uid.test.cjs` | L2 用重建并重新验证签名的隔离包测得 socket `uid=501 gid=0 mode=0600`、父目录 `uid=501 gid=0 mode=0700`，第 17 条连接拒绝。见 `peer-uid-stat.log`。L1 注入 UID 502 后连接关闭，响应 0 字节，MCP 接收调用 0 次。与仲裁一起运行共 14 项通过。见 `peer-uid-unit.log` |

隔离包使用原 Electron 43.7.0 重建，`codesign --verify --deep --strict` 退出 0。M2 验收和独立审查完成，提交后继续 M3。M4 的 G3（含 P2 FTDI 对端验收）与汇总 PR 待后续里程碑。
