# Coport fork M3 交付记录

- 功能分支 `feat/coport-fork`，目标 `main`。M3 工作区起点 `d02855d4`，产品基线为 M2 提交 `69984e92`。原 Swift / Tabby 插件参考 `2c1ea46`。
- 范围为 R5 的 ADB Shell、MCP 对 ADB 的优先路由、ADB 文件面板、SSH/SFTP 回归及同窗共存。自动验收使用 macOS arm64、隔离 Electron 43.7.0、假 adb、私有 PTY 和本机回环 OpenSSH。真实设备由 G3 集中验收。
- 待提交。M3 隔离构建为 `dist/coport-m3/mac-arm64/Coport.app`，证据位于 `dist/coport-m3/evidence/`。

## 实现期设计决定

1. 内置 ADB profile 沿用 Tabby 本地 PTY。只有一台授权设备时直接打开，其他情况复用设备选择器并显示状态。优先使用本次运行中最近选中或执行过的授权设备，初次有多台时使用 adb 列表首台。ADB shell 标签重启后由用户选择设备再打开。
2. ADB exec 使用 Swift 响应字段、结束标记和保留首尾的输出限制。只有在发现不可用或没有设备时回退到串口，执行已选 ADB 命令失败后报告这次失败，避免重复执行。若有具体故障或离线状态，通过 `adb_fallback` 附加说明，同时保留串口的原有错误原因。
3. SSH 与 ADB 共用 FileBackend 和面板。ADB 下载先流式填充私有临时文件，失败时 `adb pull` 覆盖临时文件，再分 256 KiB 交付给 FileDownload。该次暂存可丢弃失败 cat 的部分字节。上传暂存本地输入后 push 到独立远端临时文件，再移动到目标路径。
4. 同一 WebContents 通过随机传输标识访问其 staging 文件。传输取消、渲染进程退出和应用退出会关闭句柄、停止当前文件传输并清理临时文件。下载先写入主进程登记的同目录私有文件，通过验证后按最终权限原子改名，失败保留本地旧文件。SFTP 实现继续使用既有 russh 连接和传输。
5. 通过类型放宽支持选择取消时无标签，继续使用现有渲染侧终端和文件交互。根面包屑在 ADB 中标为 Files，SSH 保持原标签及工作目录提示。

6. 进程启动时生成显式 ADB server 参数，统一供发现、PTY、文件操作和 exec 使用。配置或环境冲突不会让同名 serial 的终端与文件面板指向不同服务器。重启后读取变更过的 server 设置。
7. 文件传输成功依据远端完成标记校验。ADB 客户端自身的退出码无法证明旧版 raw shell 或 exec-out 中的远端命令成功。下载剥除标记后才交付，旧 shell 的 mkdir、删除或移动失败会显示错误并清理远端暂存。多选上传在各面板中排队，远端提交前仍可取消。
8. 传输清理统一纳入退出等待，渲染器代次变化拒绝后来完成的旧暂存请求。目录面板只应用最近一次导航的结果，ADB 面包屑与设备请求使用同一规范路径。递归上传使用开始时的绝对路径，切换目录也继续写入原位置。只有原 SFTP 后端保留依赖 chmod 和断开事件的本地编辑菜单。

## 独立审查

首轮确认 4 项 P1 与 5 项 P2。已修复远端成功校验、ADB server 对齐、本地编辑边界、干净构建顺序、传输清理、批量上传排队、远端提交前的完成状态及目录竞态。第二轮复审补齐无显式 host 的服务器端口固定、长文件名、删除与下载错误提示、路径及符号链接、递归上传目的地、下载原子替换和窗口关闭清理。第三轮定向复审无剩余 P0–P2。该轮补齐保存目的地错误提示、设备端链接解析及在 Finder 文件扫描前固定拖放目标。

## 验收

| 验收项 | 执行入口 | 当前证据 |
|---|---|---|
| ADB exec 优先与回退 | `python3 -B scripts/coport/sim/prepare_adb.py "$bundle"` | 隔离实际 MCP 已验证 ADB 优先、无设备串口回退、具体离线和未授权原因、server 启动错误、输出截断、ADB 超时及结束标记。补测发现期限 5 秒，以及 adb 不存在场景、固定默认 server。见 `adb-exec.log` |
| ADB 文件协议、SFTP 回环与同窗终端 | `python3 -B scripts/coport/sim/coport_shells.py "$bundle"` | 独立测试用 ADB 合成文件树、OpenSSH 内置 SFTP 与四类实际 renderer 标签。包内实测四类 terminal 同窗与原 MCP 代次不变。ADB 与 SFTP 都完成浏览、新建目录、单文件和递归上传、下载、删除。合成设备另外验证 768,000 字节逐字节回退、17 文件排队、235 字节文件名、取消、只读下载、失败保护既有本地文件及关窗清理。见 `coport-shells.log` |
| 受影响的 M2 与既有测试 | `wire_test.py`、`coport_serial.py --lifecycle`、`npm run lint`、`npm run test:ssh-term`、`npm run test:unit` | M2 wire、生命周期、无窗口冷启动、完整 typings 和 lint 通过，SSH 14 项、终端与 Electron 11 项单测通过。 |

隔离全链路及独立审查完成。提交后进入 M4。
