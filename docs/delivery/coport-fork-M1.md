# Coport fork M1 交付记录

- 功能分支 `feat/coport-fork`，目标 `main`，M1 起始提交 `39ab33f2`。原实现读取基线 `2c1ea46`。
- 两项启动前裁决由 `5285dfca` 落实到规格与计划。依赖锁文件裁决已登记。恢复时核对验收矩阵，发现 R7 的 MCP 生命周期证据需要 M2 的 MCP host。恢复后以 `fb57641a` 提交阶段验收与锁文件裁决，随后在本工作区实现 M1。
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


## 实现与验证

- 主进程按真实字符设备 `st_rdev` 管理代次和 fd，渲染器仅挂接已有会话。串口在窗口关闭后保留，退出确认通过后释放。原 Coport 仲裁逐分支移入 TS，使用同一 fd 的 FIONREAD 水位与 headless 提示符令牌。
- 基于 Tabby v1.0.238 和 Electron 43.7.0，运行环境 macOS arm64、Node 22.23.5、Yarn 1.22.22。串口验收只用脚本生成的私有 PTY，启动和数据目录均隔离。
- 测试夹具由 `node scripts/coport/sim/build-fixtures.mjs` 生成。完整日志在 `dist/coport-m1/evidence/`，关键输出见[验收证据](coport-fork-M1-evidence.txt)。

| 规格矩阵行与回归 | 命令 | 观察 |
|---|---|---|
| 历史与提示符一致性 | `python3 -B scripts/coport/sim/coport_serial.py "$electron" --history` | 14 个步骤、20,008 条逻辑行、152 个重放行逐项相同，含颜色。1,180,000 字节约 33 ms。 |
| 共享 fd、配置冲突、就地改速和无人工输入 busy | `python3 -B scripts/coport/sim/coport_serial.py "$electron" --extended` | 三个打开顺序及符号链接复用同一代次，fd 为 1，关闭为 0。改速到 57600 保持代次，旧参数报冲突。终端应答是一次 DSR 回复，真实人工半行拒绝冲突方，设备只收到已接受的字节。 |
| 打开绝对截止和清理 | `python3 -B scripts/coport/sim/coport_serial.py "$electron" --timeout` | 包含真实迟到打开及释放，复测为 15.002 秒，活动表为空；退出不等待挂起的原生打开。 |
| 打包及独立启动 | `npm run build` · `node scripts/prepackage-plugins.mjs` · `CI=true ARCH=arm64 CSC_IDENTITY_AUTO_DISCOVERY=false node scripts/build-macos.mjs` · `node scripts/coport/smoke.mjs` | 生成 arm64 Coport.app、DMG 和 ZIP。隔离验证使用 ad-hoc 签过的目录产物，`codesign --verify --deep --strict` 退出 0。bundle ID 为 `local.coport.app`，日志出现 `coport: ready`，进程树无原 Swift App。最终归档签名落在 M4。 |
| 旧 profile 和生命周期（R7 M1 部分） | `python3 -B scripts/coport/sim/coport_serial.py dist/mac-arm64/Coport.app --lifecycle` | 用旧 YAML profile 打开私有 PTY。关最后一窗仍有 1 个 fd，向同包 PID 发 `kAEReopenApplication`，重开后同代次、快照回放。取消退出后的 fd 仍为 1，普通关窗、Dock 挂回及就地改速后代次一致。首次挂载前的条件登录提示触发一次写入，重挂未重复。Disconnect 与退出后 fd 为 0，重启无串口标签与 fd。实际字符位置与游标由下一行的几何夹具验证。 |
| 终端尺寸与实际历史回放 | `python3 -B scripts/coport/sim/coport_serial.py dist/mac-arm64/Coport.app --geometry` | 120×28 实时和同宽挂回、80×24 跨宽挂回、挂接后 120×32 实时 resize 均通过。无窗口时 DSR 仍返回 28 行、120 列。无视图打开的新代次 DSR 返回 24 行、80 列，挂到 120×28 后第 2 行第 1 列显示 B，游标位于第 2 行第 2 列。 |
| 非标准波特率确认 | 同一 `--lifecycle` 的 `baud-confirmation` | 实际渲染器显示并提交 961200。macOS PTY 不支持该速率的 IOSSIOSPEED，组件验收使用可接受任意波特率的适配器夹具，以 115200 打开私有 PTY，连接时 fd 为 1。 |
| 十六进制 profile | `python3 -B scripts/coport/sim/coport_serial.py dist/mac-arm64/Coport.app --hex-monitor` | 关窗及挂回同代次时保留原始字节，设备收到 0 字节自发应答。普通终端的 DSR 应答单独通过。 |
| WCH 排序 | `node --experimental-strip-types --test scripts/coport/sim/serial-profiles.test.mjs` | 使用注入的双节点清单，匹配的苹果驱动节点标注，空列表排序与过滤结果中 WCH 先出现。 |
| 上游回归 | `npm run lint` · `npm run test:ssh-term` · `npm run test:unit` | 全仓 lint 通过，14 和 11 个用例通过。 |

`$electron` 对应 M0 的独立 Electron arm64 发行包。M1 测试不安装系统应用，不调用默认 Tabby。

第一轮独立审查发现退出流程、旧格式历史与启动登录脚本、过滤排序、就地改速的问题。追加复现验证普通 headless 回复会让十六进制监视 profile 对载荷中的 `ESC[5n` 写出 `ESC[0n`。本分支用主进程决定应答来源及在十六进制监视时停发应答，保留唯一的权威解析器。详见规格的渲染实现说明。前三轮独立审查于尺寸裁决前完成。第二轮复核后加入 Darwin dial-in/callout 归并、旧 profile 重挂清屏、就地改速后同一 profile 重挂、过滤和最近使用排序、打开时陈旧输出与鼠标焦点夹具。第三轮确认普通非 80 列终端的历史几何偏差。CI 修复 0 轮，无 PR。

R7 的 MCP 连接端到端判据，以及独立启动的 `mcp.sock` 判据在 M2 重跑。FTDI P2 对端收包和硬件人工验收在 M4 G3。


## 实现期设计决定

1. 已获批准由当前串口视图决定 headless 尺寸。人打开新代次时携带首个尺寸，挂接时用当时的实际尺寸生成快照。每个代次只注册一个视图，重复打开聚焦该视图。没有视图时保留最后尺寸，AI 独自打开的新代次为 80×24。
2. `coport-serial:resize` 在当前批次的设备输出之后更新 headless，并发出 `resized` 事件。渲染端将该事件与设备输出串行处理，确保同一批数据在相同尺寸下解析。挂接和回放期间只记录最新的待应用尺寸。
3. xterm 序列化器在最后写满一行时，回放相对光标移动可能少一列。普通快照尾部补绝对列定位，保留行尾待换行状态。连接动画在回放前停止，因为动画清理会擦除游标所在行。两个修复均保留现有的 xterm 尺寸重排规则和已提交逻辑行。

## 完成状态

M1 产品提交基于 `fb57641a` 的当前工作区，完整构建、静态检查、私有 PTY 和签名包复测通过。第 4 轮独立复审无发现。最新证据已汇入证据文件的 R7 最终验证段。挂接期间连续改变布局的竞态由代码顺序保障，本轮人工模拟覆盖的是挂接后实时 resize。

复测打包使用 electron-builder 及同版本本机缓存的 Electron 43.7.0 arm64 ZIP，通过 `electronDist` 指定，避免重新下载。隔离测试用的目录产物通过 ad-hoc 签名验证。分支 CI 与汇总 PR 专属检查留到最终收尾。

下一动作是 M2 接入 MCP host、shim 和 serial exec，并重跑完整的 R1 启动与 R7 生命周期。P2 的真机对端收包留到 M4 G3。
