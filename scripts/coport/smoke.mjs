import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'

import { evaluate, renderer, waitFor } from './sim/renderer.mjs'

const bundle = resolve(process.argv[2] ?? 'dist/mac-arm64/Coport.app')
const executable = join(bundle, 'Contents/MacOS/Coport')
const plist = join(bundle, 'Contents/Info.plist')
assert.equal(execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleIdentifier', plist], { encoding: 'utf8' }).trim(), 'local.coport.app')
const run = await realpath(await mkdtemp(join(tmpdir(), 'coport-smoke-')))
const endpoint = join(run, 'mcp.sock')
const requireApp = createRequire(new URL('../../app/package.json', import.meta.url))
const { Client } = requireApp('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = requireApp('@modelcontextprotocol/sdk/client/stdio.js')
let mcp

async function connectMcp () {
    const client = new Client({ name: 'coport-lifecycle', version: '1' })
    await client.connect(new StdioClientTransport({
        command: join(bundle, 'Contents/MacOS/coport-mcp'),
        env: { COPORT_TEST_SOCKET: endpoint },
    }))
    return client
}

async function tool (name, args) {
    const result = await mcp.callTool({ name, arguments: args })
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent)
    assert.equal(result.isError, 'error' in result.structuredContent)
    return result.structuredContent
}
const geometry = process.argv[3] === '--geometry'
const splitAttach = process.argv[3] === '--split-attach'
const lifecycle = geometry || splitAttach || process.argv[3] === '--lifecycle'
const hexMonitor = process.argv.includes('--hex-monitor')
const device = process.argv[4]
if (lifecycle) {
    assert.match(device ?? '', /^\/dev\/ttys\d+$/)
    assert.equal(await realpath(device), device)
}
const profileName = 'Isolated serial profile'
const nonStandardProfile = 'Isolated non-standard baud'
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
delete environment.TABBY_DEV
environment.TABBY_PLUGINS = ''
environment.COPORT_TEST_ADB = join(run, 'no-adb')
const preferences = {
    enableWelcomeTab: false,
    // Split attach opens every view explicitly. Recovering a serial-only split
    // restores its empty wrapper even though the serial pane opts out.
    recoverTabs: !splitAttach,
    appearance: { frame: 'native' },
    terminal: { frontend: 'xterm', autoOpen: false },
    ...(lifecycle ? {
        profiles: [{
            type: 'serial', id: 'serial:isolated', name: profileName, behaviorOnSessionEnd: splitAttach ? 'close' : 'keep',
            clearServiceMessagesOnConnect: true,
            options: {
                port: device, baudrate: 115200, databits: 8, stopbits: 1, parity: 'none',
                ...(geometry || splitAttach ? {} : hexMonitor ? { outputMode: 'hex' } : {
                    scripts: [{ expect: 'COPORT-LOGIN', send: 'login-once' }],
                }),
            },
        }, {
            type: 'serial', id: 'serial:isolated-nonstandard', name: nonStandardProfile, behaviorOnSessionEnd: 'keep',
            options: { port: device, baudrate: 961200 },
        }],
    } : {}),
}
// JSON is valid YAML and preserves the old Tabby profile schema unchanged.
await writeFile(join(run, 'config.yaml'), JSON.stringify(preferences))
let app, exit, log = ''
async function start () {
    await rm(join(run, 'DevToolsActivePort'), { force: true })
    app = spawn(executable, [`--user-data-dir=${run}`, '--remote-debugging-port=0'], {
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    exit = once(app, 'exit')
    app.stdout.on('data', data => { log += data })
    app.stderr.on('data', data => { log += data })
    const port = await waitFor(async () => {
        assert.equal(app.exitCode, null)
        assert.equal(app.signalCode, null)
        return Number((await readFile(join(run, 'DevToolsActivePort'), 'utf8')).split('\n')[0])
    })
    const target = await readyWindow(port)
    const info = await evaluate(target, `(() => {
        const { app, getCurrentWindow } = require('@electron/remote')
        return { pid: process.ppid, name: app.getName(), data: app.getPath('userData'), window: getCurrentWindow().id }
    })()`)
    assert.equal(info.name, 'Coport')
    assert.equal(info.data, run)
    assert.match(log, /coport: ready/)
    const socket = await lstat(endpoint)
    assert.equal(socket.isSocket(), true)
    assert.equal(socket.mode & 0o777, 0o600)
    assert.equal(info.pid, app.pid)
    const processes = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
        .trim().split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    const descendants = new Set([app.pid])
    let size
    do {
        size = descendants.size
        for (const [, pid, parent] of processes) {
            if (descendants.has(Number(parent))) descendants.add(Number(pid))
        }
    } while (size !== descendants.size)
    assert.ok(processes.some(([, pid, , command]) => Number(pid) === app.pid && command === executable))
    for (const [, pid, , command] of processes) {
        if (descendants.has(Number(pid)) && /Coport(?:\.app|$)/.test(command)) {
            assert.ok(command.startsWith(bundle + '/'), command)
        }
    }
    console.log(JSON.stringify({ case: 'startup', bundleId: 'local.coport.app', renderer: 'ready',
        originalSwiftDescendants: 0, socketMode: '0600', ...info }))
    return { port, target }
}

async function readyWindow (port) {
    return waitFor(async () => {
        const target = await renderer(port)
        return target && await evaluate(target, `!!document.querySelector('app-root .window .content.main') &&
            require('electron').ipcRenderer.listenerCount('cli') > 0`) && target
    })
}

function countFds (pid) {
    const options = pid === undefined ? [] : ['-a', '-p', String(pid)]
    try {
        return execFileSync('/usr/sbin/lsof', [...options, '-Fn', device], { encoding: 'utf8' })
            .split('\n').filter(line => /^f\d+$/.test(line)).length
    } catch (error) {
        if (error.status === 1 && !error.stdout) return 0
        throw error
    }
}

async function openProfile (target, name = profileName, baudrate = 115200, gateAttach = false, waitForOpen = true) {
    await evaluate(target, `(() => {
        if (!window.coportSmokeErrors) {
            window.coportSmokeErrors = []
            for (const level of ['error', 'warn', 'info']) {
                const original = console[level]
                console[level] = (...args) => {
                    window.coportSmokeErrors.push([level, ...args.map(String)])
                    original.apply(console, args)
                }
            }
        }
        const ipc = require('electron').ipcRenderer
        if (!window.coportCapture) {
            const capture = window.coportCapture = { frames: [], acks: {}, attaches: [], attachErrors: [], attachRequests: [], input: [], serialEvents: [] }
            if (${splitAttach}) {
                for (const channel of ['coport-serial:ended', 'coport-serial:view-detached']) {
                    ipc.on(channel, (_, event) => capture.serialEvents.push({ channel, event }))
                }
            }
            ipc.on('coport-serial:output', (_, frame) => capture.frames.push({
                ...frame, bytes: Buffer.from(frame.bytes).toString(),
            }))
            const send = ipc.send.bind(ipc)
            ipc.send = (channel, ...args) => {
                if (channel === 'coport-serial:ack') capture.acks[args[0].generation] = args[0].seq
                if (channel === 'window-close-cancelled') capture.closeCancelled = true
                return send(channel, ...args)
            }
            const invoke = ipc.invoke.bind(ipc)
            ipc.invoke = async (channel, ...args) => {
                if (channel === 'coport-serial:input') capture.input.push(Buffer.from(args[0].bytes).toString('hex'))
                if (channel === 'coport-serial:attach-display' && ${gateAttach}) {
                    await new Promise(resolve => { window.coportReleaseAttach = resolve })
                }
                const attaching = ['coport-serial:attach', 'coport-serial:attach-display'].includes(channel)
                if (attaching) capture.attachRequests.push(args[0])
                const result = await invoke(channel, ...args)
                if (${splitAttach} && (attaching || channel === 'coport-serial:ensure' || channel === 'coport-serial:resize')) {
                    capture.serialEvents.push({ channel, ms: Math.round(performance.now()), ok: result.ok,
                        result: attaching && result.ok ? { seq: result.result.seq } : result.result,
                        error: result.error })
                }
                if (attaching && result.ok) {
                    capture.attaches.push({
                        ...result.result,
                        displayFrames: result.result.displayFrames?.map(frame => Buffer.from(frame).toString('hex')),
                    })
                } else if (attaching) {
                    capture.attachErrors.push(result.error.code)
                }
                return result
            }
        }
        ipc.emit('cli', null, { _: ['profile'], profileName: ${JSON.stringify(name)} }, '/', false)
        return true
    })()`)
    if (!waitForOpen) {
        return
    }
    try {
        const view = await waitFor(() => evaluate(target, `(() => {
            const capture = window.coportCapture
            const failure = capture.serialEvents.find(event => event.error ||
                event.channel === 'coport-serial:ended' || event.channel === 'coport-serial:view-detached')
            return failure ? { failure } : document.querySelector('serial-tab .text-success') ? { open: true } : null
        })()`))
        assert.equal(view.open, true, JSON.stringify(view))
    } catch (error) {
        console.error('Profile view:', JSON.stringify(await evaluate(target, `({
            text: document.body.innerText, safeMode: String(window.safeModeReason ?? ''),
            cliListeners: require('electron').ipcRenderer.listenerCount('cli'),
            serialTabs: document.querySelectorAll('serial-tab').length,
            window: require('@electron/remote').getCurrentWindow().id,
            serialEvents: window.coportCapture?.serialEvents,
            plugins: window.pluginModules?.map(module => module.name || String(module)),
            errors: window.coportSmokeErrors?.slice(-12),
        })`)))
        throw error
    }
    return evaluate(target, `require('electron').ipcRenderer.invoke('coport-serial:ensure', {
        config: { port: ${JSON.stringify(device)}, baudrate: ${baudrate} }, reveal: false
    })`)
}

async function quit (target) {
    await evaluate(target, 'setTimeout(() => require("@electron/remote").app.quit(), 100); true')
    assert.deepEqual(await Promise.race([exit, delay(5000, ['timeout'])]), [0, null])
    await assert.rejects(lstat(endpoint), { code: 'ENOENT' })
}

async function exerciseCancelledQuit (target) {
    await evaluate(target, `(() => {
        const { app, dialog } = require('@electron/remote')
        const original = dialog.showMessageBox
        dialog.showMessageBox = async (_, options) => ({
            response: options.message.includes('still running') ? 1 : 0, checkboxChecked: false,
        })
        window.coportPermitClose = () => {
            dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
        }
        require('electron').ipcRenderer.emit('cli', null, {
            _: ['run'], command: ['/bin/sh', '-c', '/bin/sleep 15 & /bin/sleep 15 & wait'],
        }, '/', false)
        window.coportRequestQuit = () => setTimeout(() => app.quit(), 100)
        return typeof original === 'function'
    })()`)
    await waitFor(() => evaluate(target, '!!document.querySelector("terminaltab .xterm")'))
    await delay(300)
    await evaluate(target, 'window.coportRequestQuit(); true')
    await waitFor(() => evaluate(target, 'coportCapture.closeCancelled'))
    assert.equal(countFds(app.pid), 1)
    await evaluate(target, 'window.coportPermitClose(); true')
}

async function setFixtureSize (target, cols, rows, waitForPendingResize = false) {
    await evaluate(target, `(() => {
        window.coportFixtureSize = { cols: ${cols}, rows: ${rows} }
        if (window.coportFrontend) {
            if (${waitForPendingResize}) {
                const frontend = window.coportFrontend
                const resize = frontend.requestResize
                frontend.requestResize = (cols, rows) => {
                    resize(cols, rows)
                    if (cols === ${cols} && rows === ${rows}) {
                        frontend.requestResize = resize
                        window.coportPendingResize = coportCapture.attaches.length === 0 &&
                            coportCapture.attachErrors.length === 0
                    }
                }
            }
            window.dispatchEvent(new Event('resize'))
            return true
        }
        const { XTermFrontend } = require('tabby-terminal')
        const attach = XTermFrontend.prototype.attach
        XTermFrontend.prototype.attach = function (host, profile) {
            if (host.closest('serial-tab')) {
                window.coportFrontend = this
                this.fitAddon.proposeDimensions = () => window.coportFixtureSize
            }
            return attach.call(this, host, profile)
        }
        return true
    })()`)
    if (waitForPendingResize) {
        const pending = await waitFor(() => evaluate(target, `window.coportPendingResize === undefined
            ? null : { pending: window.coportPendingResize }`))
        assert.equal(pending.pending, true)
    }
}

async function assertGeometry (target, wanted) {
    const actual = await waitFor(async () => {
        const grid = await evaluate(target, `(() => {
            const { xterm } = window.coportFrontend
            const buffer = xterm.buffer.active
            return {
                cols: xterm.cols, rows: xterm.rows, x: buffer.cursorX, y: buffer.cursorY,
                lines: [0, 1].map(offset => buffer.getLine(buffer.baseY + offset).translateToString(true)),
            }
        })()`)
        assert.deepEqual(grid, wanted)
        return grid
    })
    console.log(JSON.stringify({ case: 'geometry-grid', ...actual }))
}

async function exerciseGeometry (port, target) {
    async function reopen (oldTarget, cols, rows, detachedReply) {
        await evaluate(oldTarget, 'setTimeout(() => require("@electron/remote").getCurrentWindow().close(), 100); true')
        await waitFor(async () => !await renderer(port))
        assert.equal(countFds(app.pid), 1)
        if (detachedReply) {
            console.log(JSON.stringify({ case: 'geometry-write-detached', reply: detachedReply }))
            await waitFor(() => readFile(join(run, 'geometry-write-detached'), 'utf8').then(() => true))
        }
        execFileSync(resolve('dist/coport-m1/reopen'), [String(app.pid)], { timeout: 4000 })
        const next = await readyWindow(port)
        assert.notEqual(next.id, oldTarget.id)
        await setFixtureSize(next, cols, rows)
        return next
    }
    const wide = { cols: 120, rows: 28, x: 1, y: 0, lines: ['B' + 'A'.repeat(99), ''] }
    const narrow = { cols: 80, rows: 24, x: 1, y: 0, lines: ['B' + 'A'.repeat(79), ''] }
    await setFixtureSize(target, wide.cols, wide.rows)
    const opened = await openProfile(target)
    assert.equal(opened.ok, true)
    console.log(JSON.stringify({ case: 'geometry-write-wide', reply: '\x1b[28;120R\x1b[1;2R' }))
    await assertGeometry(target, wide)
    for (const expected of [wide, narrow]) {
        target = await reopen(target, expected.cols, expected.rows, expected === wide ? '\x1b[28;120R\x1b[1;2R' : undefined)
        const reused = await openProfile(target)
        assert.deepEqual(reused, { ok: true, result: { generation: opened.result.generation, reused: true } })
        await assertGeometry(target, expected)
    }

    await setFixtureSize(target, 120, 32)
    await assertGeometry(target, { ...narrow, cols: 120, rows: 32 })
    console.log(JSON.stringify({ case: 'geometry-write-resized', reply: '\x1b[32;120R\x1b[1;2R' }))
    await assertGeometry(target, { ...wide, rows: 32 })

    assert.equal(await evaluate(target, `require('electron').ipcRenderer.invoke('coport-serial:disconnect',
        { generation: ${JSON.stringify(opened.result.generation)} }).then(x => x.ok)`), true)
    mcp = await connectMcp()
    const ai = await tool('open_serial', { path: device })
    assert.equal(ai.reused, false)
    assert.notEqual(ai.session_id.toLowerCase(), opened.result.generation.toLowerCase())
    console.log(JSON.stringify({ case: 'geometry-write-ai', reply: '\x1b[24;80R\x1b[2;2R' }))
    // Wait for the PTY's DSR round trip before revealing the AI-opened session.
    target = await reopen(target, 120, 28)
    await waitFor(() => readFile(join(run, 'geometry-write-ai'), 'utf8').then(() => true))
    const attached = await openProfile(target)
    assert.deepEqual(attached, { ok: true, result: { generation: ai.session_id.toLowerCase(), reused: true } })
    await assertGeometry(target, {
        ...wide, y: 1, lines: ['A'.repeat(80), 'B' + 'A'.repeat(19)],
    })
    await quit(target)
    assert.equal(countFds(), 0)
}

async function exerciseSplitAttach (port, target) {
    function ipc (action, args, timeout) {
        return evaluate(target, `require('electron').ipcRenderer.invoke('coport-serial:${action}', ${JSON.stringify(args)})`, timeout)
    }

    async function writeFrame (bytes, currentLine, committedLine) {
        console.log(JSON.stringify({ case: 'split-attach-write', hex: bytes.toString('hex') }))
        if (currentLine !== undefined) {
            await waitFor(async () => {
                const history = await tool('read_terminal', {})
                return history.current_line === currentLine &&
                    (committedLine === undefined || history.lines.at(-1)?.text === committedLine)
            })
        }
    }

    async function checkCleanWindow () {
        const state = await evaluate(target, `(() => {
            const { app, getCurrentWindow } = require('@electron/remote')
            return { pid: process.ppid, data: app.getPath('userData'), window: getCurrentWindow().id,
                tabs: document.querySelectorAll('tab-header').length }
        })()`)
        assert.equal(state.pid, app.pid)
        assert.equal(state.data, run)
        assert.equal(state.tabs, 0)
        console.log(JSON.stringify({ case: 'split-attach-window', ...state }))
    }

    async function closeAndReopen () {
        await evaluate(target, 'setTimeout(() => require("@electron/remote").getCurrentWindow().close(), 100); true')
        await waitFor(async () => !await renderer(port))
        assert.equal(countFds(app.pid), 1)
        execFileSync(resolve('dist/coport-m1/reopen'), [String(app.pid)], { timeout: 4000 })
        const next = await readyWindow(port)
        assert.notEqual(next.id, target.id)
        target = next
        await checkCleanWindow()
    }

    async function checkView (expectedLines) {
        const grid = await waitFor(async () => {
            const info = await evaluate(target, `(() => {
                const { xterm } = window.coportFrontend
                const buffer = xterm.buffer.active
                const cells = Array.from({ length: buffer.length }, (_, index) => {
                    const line = buffer.getLine(index)
                    let last = line.length - 1
                    while (last > 0 && !line.getCell(last).getChars().trim()) last--
                    return { text: line.translateToString(true), color: line.getCell(last).getFgColor() }
                }).filter(line => line.text)
                return { lines: cells.map(line => line.text), colors: cells.map(line => line.color), cols: xterm.cols, rows: xterm.rows }
            })()`)
            assert.deepEqual(info.lines, expectedLines)
            return info
        })
        const history = await tool('read_terminal', {})
        assert.deepEqual(history.lines.map(line => line.text), expectedLines)
        const attach = await evaluate(target, `coportCapture.attaches[0]`)
        const frames = await evaluate(target, 'coportCapture.frames.map(frame => frame.seq)')
        assert.deepEqual(frames, frames.map((_, index) => attach.seq + index + 1))
        console.log(JSON.stringify({ case: 'split-attach-parity', ...grid, snapshotSeq: attach.seq, liveFrames: frames.length }))
        return grid
    }

    async function waitForAttachRequest () {
        await waitFor(() => evaluate(target, 'window.coportCapture?.attachRequests.length === 1'))
        await checkStillWaiting()
    }

    async function checkStillWaiting () {
        await delay(150)
        assert.deepEqual(await evaluate(target, '[coportCapture.attaches.length, coportCapture.frames.length]'), [0, 0])
    }

    mcp = await connectMcp()
    await checkCleanWindow()
    const opened = await tool('open_serial', { path: device })
    const generation = opened.session_id.toLowerCase()
    const reused = { ok: true, result: { generation, reused: true } }
    assert.equal(opened.reused, false)
    assert.equal(countFds(app.pid), 1)

    await writeFrame(Buffer.concat([Buffer.from('UTF8 '), Buffer.from([0xe4])]), 'UTF8')
    await setFixtureSize(target, 80, 24)
    const opening = openProfile(target)
    // Keep the assertion failure for a prematurely attached view as the first error.
    void opening.catch(() => undefined)
    await waitForAttachRequest()
    await writeFrame(Buffer.from([0xb8]))
    await checkStillWaiting()
    await writeFrame(Buffer.from([0xad, 0x21, 0x0d, 0x0a]), '', 'UTF8 中!')
    assert.deepEqual(await opening, reused)
    await checkView(['UTF8 中!'])

    // Force actual, separately acknowledged renderer deliveries for live UTF-8 and CSI.
    const live = Buffer.from('实时 😀')
    const liveParts = [live.subarray(0, 1), live.subarray(1, 8), live.subarray(8, 10),
        Buffer.concat([live.subarray(10), Buffer.from(' \x1b[')]), Buffer.from('31mred\x1b[0m\r\n')]
    let seq = await evaluate(target, 'coportCapture.attaches[0].seq')
    for (const bytes of liveParts) {
        await writeFrame(bytes)
        seq++
        await waitFor(() => evaluate(target, `coportCapture.acks[${JSON.stringify(generation)}] === ${seq}`))
    }
    assert.deepEqual((await checkView(['UTF8 中!', '实时 😀 red'])).colors, [-1, 1])
    await closeAndReopen()

    await writeFrame(Buffer.from('ANSI\x1b['), 'ANSI')
    await setFixtureSize(target, 120, 28)
    const reopening = openProfile(target)
    void reopening.catch(() => undefined)
    await waitForAttachRequest()
    await setFixtureSize(target, 100, 25, true)
    await writeFrame(Buffer.from('31\r\n'), '', 'ANSI')
    await checkStillWaiting()
    // Each new read can finish a colored line and still leave the parser
    // waiting for the next CSI final. Attach before the next ESC within it.
    await writeFrame(Buffer.from('mred\x1b[0m\x1b[32\r\n'), '', 'red')
    assert.deepEqual(await reopening, reused)
    await waitFor(() => evaluate(target, 'window.coportFrontend.xterm.cols === 100 && window.coportFrontend.xterm.rows === 25'))
    const grid = await checkView(['UTF8 中!', '实时 😀 red', 'ANSI', 'red'])
    assert.deepEqual(grid.colors, [-1, 1, -1, 1])
    await writeFrame(Buffer.from('mgreen\x1b[0m\x1b[31\r\n'), '', 'green')
    assert.deepEqual((await checkView(['UTF8 中!', '实时 😀 red', 'ANSI', 'red', 'green'])).colors, [-1, 1, -1, 1, 2])
    await closeAndReopen()

    await writeFrame(Buffer.from('m\x1b[0mBASE\x1b['), 'BASE')
    await setFixtureSize(target, 80, 24)
    const savedCursor = openProfile(target)
    void savedCursor.catch(() => undefined)
    await waitForAttachRequest()
    await writeFrame(Buffer.from('s\x1b[1;8H\x1b[uZ\r\n'), '', 'BASEZ')
    assert.deepEqual(await savedCursor, reused)
    await checkView(['UTF8 中!', '实时 😀 red', 'ANSI', 'red', 'green', 'BASEZ'])
    await closeAndReopen()

    const reserve = () => evaluate(target, `require('electron').ipcRenderer.invoke('coport-serial:ensure', {
        config: { port: ${JSON.stringify(device)}, baudrate: 115200 }, reveal: true,
        windowId: require('@electron/remote').getCurrentWindow().id, cols: 80, rows: 24,
    })`)
    const attachArgs = { generation, cols: 80, rows: 24 }
    assert.equal((await reserve()).result.generation, generation)
    await writeFrame(Buffer.from('TIMEOUT \x1b['), 'TIMEOUT')
    const then = performance.now()
    const timeout = await ipc('attach', attachArgs, 4000)
    assert.equal(timeout.ok, false)
    assert.equal(timeout.error.code, 'timeout')
    assert.equal(timeout.error.retryable, true)
    assert.ok(performance.now() - then < 3500)
    assert.equal(countFds(app.pid), 1)
    await writeFrame(Buffer.from('32mgreen\x1b[0m'), 'TIMEOUT green')
    const retried = await ipc('attach', attachArgs)
    assert.equal(retried.ok, true)
    assert.match(retried.result.snapshot, /TIMEOUT \x1b\[32mgreen/)
    assert.equal((await ipc('detach', { generation })).ok, true)

    await writeFrame(Buffer.from('\r\nCANCEL \x1b['), 'CANCEL')
    assert.equal((await reserve()).result.generation, generation)
    const detached = await evaluate(target, `(async () => {
        const { ipcRenderer } = require('electron')
        const pending = ipcRenderer.invoke('coport-serial:attach', ${JSON.stringify(attachArgs)})
        await new Promise(resolve => setTimeout(resolve, 150))
        const before = performance.now()
        const stopped = await ipcRenderer.invoke('coport-serial:detach', { generation: ${JSON.stringify(generation)} })
        return { stopped, attach: await pending, elapsed: performance.now() - before }
    })()`)
    assert.equal(detached.stopped.ok, true)
    assert.equal(detached.attach.ok, false)
    assert.equal(detached.attach.error.code, 'channel_lost')
    assert.ok(detached.elapsed < 1000, detached)
    assert.equal(countFds(app.pid), 1)

    await openProfile(target, profileName, 115200, false, false)
    await waitForAttachRequest()
    const clicked = await evaluate(target, `(() => {
        const disconnect = [...document.querySelectorAll('serial-tab button')]
            .find(button => button.textContent.trim() === 'Disconnect')
        disconnect?.click()
        return Boolean(disconnect)
    })()`)
    assert.equal(clicked, true)
    await waitFor(() => evaluate(target, `coportCapture.attachErrors[0] === 'channel_lost'`), 1200)
    await waitFor(() => countFds(app.pid) === 0, 1200)
    assert.equal((await tool('open_serial', { path: device })).reused, false)
    await writeFrame(Buffer.from('LOSS\x1b['), 'LOSS')
    const tabs = await evaluate(target, `(() => {
        const { attaches, attachRequests, attachErrors, frames } = coportCapture
        attaches.length = attachRequests.length = attachErrors.length = frames.length = 0
        return document.querySelectorAll('serial-tab').length
    })()`)
    await openProfile(target, profileName, 115200, false, false)
    await waitForAttachRequest()
    assert.equal(await evaluate(target, "document.querySelectorAll('serial-tab').length"), tabs + 1)
    console.log(JSON.stringify({ case: 'split-attach-device-lost' }))
    await waitFor(() => evaluate(target, `coportCapture.attachErrors[0] === 'channel_lost' &&
        document.querySelectorAll('serial-tab').length === ${tabs}`))
    assert.equal(countFds(app.pid), 0)
    console.log(JSON.stringify({ case: 'split-attach-lifecycle', timeout: 'retryable', retry: true, detached: true,
        disconnected: true, deviceLossClosedTab: true }))
    await quit(target)
}

try {
    const { port, target } = await start()
    if (!lifecycle) {
        await quit(target)
    } else if (geometry) {
        await exerciseGeometry(port, target)
    } else if (splitAttach) {
        await exerciseSplitAttach(port, target)
    } else {
        const opening = openProfile(target, profileName, 115200, !hexMonitor)
        if (!hexMonitor) {
            await waitFor(() => evaluate(target, 'typeof window.coportReleaseAttach === "function"'))
            console.log(JSON.stringify({ case: 'profile-before-attach' }))
            await delay(220)
            await evaluate(target, 'window.coportReleaseAttach(); true')
        }
        const initial = await opening
        assert.equal(initial.ok, true)
        assert.equal(countFds(app.pid), 1)
        console.log(JSON.stringify({ case: 'profile-open', pid: app.pid, ...initial.result }))
        mcp = await connectMcp()
        const joined = await tool('open_serial', { path: device })
        assert.deepEqual(joined, { session_id: initial.result.generation.toUpperCase(), path: device, reused: true })
        const conflict = await evaluate(target, `require('electron').ipcRenderer.invoke('coport-serial:ensure', {
            config: { port: ${JSON.stringify(device)}, baudrate: 9600 }, reveal: false
        })`)
        assert.equal(conflict.ok, false)
        assert.equal(conflict.error.code, 'config_conflict')
        assert.deepEqual(conflict.error.active, {
            port: device, baudrate: 115200, databits: 8, stopbits: 1, parity: 'none',
            flowControl: { rtscts: false, xon: false, xoff: false, xany: false },
        })
        console.log(JSON.stringify({ case: 'ipc-config-conflict', active: conflict.error.active }))

        await waitFor(() => evaluate(target, `coportCapture.frames.some(frame =>
            frame.bytes.includes('COPORT-SNAPSHOT') && coportCapture.acks[frame.generation] >= frame.seq)`))
        if (!hexMonitor) {
            await evaluate(target, `(() => {
                const terminal = document.querySelector('serial-tab .xterm')
                const textarea = terminal.querySelector('textarea')
                textarea.blur()
                textarea.focus()
                const screen = terminal.querySelector('.xterm-screen')
                const rect = screen.getBoundingClientRect()
                for (const type of ['mousedown', 'mouseup']) {
                    screen.dispatchEvent(new MouseEvent(type, {
                        bubbles: true, button: 0, buttons: type === 'mousedown' ? 1 : 0,
                        clientX: rect.left + 4, clientY: rect.top + 4,
                    }))
                }
                return true
            })()`)
            assert.deepEqual(await evaluate(target, 'coportCapture.input'), [
                Buffer.from('login-once\n').toString('hex'),
            ])
        }
        console.log(JSON.stringify({ case: 'profile-output-acked' }))
        await delay(300)
        const configured = await evaluate(target, `require('electron').ipcRenderer.invoke('coport-serial:update-baudrate', {
            generation: ${JSON.stringify(initial.result.generation)}, baudrate: 57600
        })`)
        assert.equal(configured.ok, true)
        if (!hexMonitor) {
            await exerciseCancelledQuit(target)
        }
        await evaluate(target, 'setTimeout(() => require("@electron/remote").getCurrentWindow().close(), 100); true')
        await waitFor(async () => !await renderer(port))
        assert.equal(countFds(app.pid), 1)

        if (!hexMonitor) {
            assert.deepEqual(await tool('write_serial', { data: 'MCP-DETACHED\r' }), { bytes_queued: 13 })
            console.log(JSON.stringify({ case: 'mcp-detached-write' }))
            const reading = await tool('read_terminal', { after_line: -1, wait_ms: 1000 })
            const detachedLine = line => line.text === 'MCP-DETACHED-OUTPUT'
            if (!reading.lines.some(detachedLine)) {
                const observed = await tool('read_terminal', { after_line: reading.last_line, wait_ms: 2000 })
                assert.ok(observed.lines.some(detachedLine))
            }
            console.log(JSON.stringify({ case: 'mcp-detached-read', session_id: joined.session_id }))
        }

        execFileSync(resolve('dist/coport-m1/reopen'), [String(app.pid)], { stdio: 'inherit', timeout: 4000 })
        const reopened = await readyWindow(port)
        assert.notEqual(reopened.id, target.id)
        const reused = await openProfile(reopened, profileName, 57600)
        assert.equal(reused.ok, true)
        assert.equal(reused.result.generation, initial.result.generation)
        assert.equal(reused.result.reused, true)
        assert.match(await evaluate(reopened, 'document.querySelector("serial-tab terminal-toolbar strong")?.textContent'), /57600/)
        const replayed = hexMonitor
            ? `coportCapture.attaches.some(attach =>
                attach.displayFrames?.join('').includes('434f504f52542d534e415053484f541b5b356e'))`
            : `coportCapture.attaches.some(attach => attach.snapshot.includes('COPORT-SNAPSHOT'))`
        assert.equal(await evaluate(reopened, replayed), true)
        if (!hexMonitor) {
            console.log(JSON.stringify({ case: 'profile-reopened' }))
            await delay(280)
        }

        await evaluate(reopened, `[...document.querySelectorAll('serial-tab button')]
            .find(button => button.textContent.trim() === 'Disconnect').click()`)
        await waitFor(() => countFds(app.pid) === 0)
        assert.deepEqual(await tool('write_serial', { data: 'stale\r' }), {
            error: { code: 'channel_lost', message: 'Tabby terminal is unavailable', retryable: true },
        })
        assert.equal((await tool('prepare_shell')).error.code, 'channel_lost')
        assert.equal((await tool('exec', { command: 'true' })).error.code, 'channel_lost')
        assert.ok((await tool('read_terminal')).lines.some(line => line.text.includes('COPORT-SNAPSHOT')))
        console.log(JSON.stringify({ case: 'mcp-disconnected', channelLost: true, historyReadable: true }))
        const [humanRace, aiRace] = await Promise.all([
            evaluate(reopened, `require('electron').ipcRenderer.invoke('coport-serial:ensure', {
                config: { port: ${JSON.stringify(device)}, baudrate: 115200 }, reveal: true,
                windowId: require('@electron/remote').getCurrentWindow().id, cols: 80, rows: 24,
            })`),
            tool('open_serial', { path: device }),
        ])
        assert.equal(humanRace.ok, true)
        assert.equal(humanRace.result.generation, aiRace.session_id.toLowerCase())
        assert.notEqual(humanRace.result.reused, aiRace.reused)
        assert.equal(countFds(app.pid), 1)
        assert.equal(await evaluate(reopened, `require('electron').ipcRenderer.invoke('coport-serial:disconnect', {
            generation: ${JSON.stringify(humanRace.result.generation)}
        }).then(result => result.ok)`), true)
        assert.equal(countFds(app.pid), 0)
        console.log(JSON.stringify({ case: 'mcp-ipc-concurrent-open', openedFds: 1, aiReused: aiRace.reused }))
        await evaluate(reopened, `(() => {
            const dialog = require('@electron/remote').dialog
            const original = dialog.showMessageBox
            dialog.showMessageBox = async (_, options) => {
                window.coportBaudPrompt = options
                return { response: 0, checkboxChecked: false }
            }
            const ipc = require('electron').ipcRenderer
            const invoke = ipc.invoke
            ipc.invoke = function (channel, request, ...args) {
                if (channel === 'coport-serial:ensure' && request?.config?.baudrate === 961200) {
                    window.coportRequestedBaud = request.config.baudrate
                    request = { ...request, config: { ...request.config, baudrate: 115200 } }
                }
                return invoke.call(this, channel, request, ...args)
            }
            window.coportRestoreBaudFixture = () => {
                dialog.showMessageBox = original
                ipc.invoke = invoke
            }
            return true
        })()`)
        const nonStandard = await openProfile(reopened, nonStandardProfile, 961200)
        assert.equal(nonStandard.ok, true)
        assert.match(await evaluate(reopened, 'window.coportBaudPrompt?.message'), /961200/)
        assert.equal(await evaluate(reopened, 'window.coportRequestedBaud'), 961200)
        await evaluate(reopened, 'window.coportRestoreBaudFixture(); true')
        assert.equal(countFds(app.pid), 1)
        console.log(JSON.stringify({ case: 'baud-confirmation', baudrate: 961200,
            ptySpeed: 115200, fixture: 'arbitrary-rate adapter', openedFds: 1 }))
        await quit(reopened)
        assert.equal(countFds(), 0)

        const restarted = await start()
        await delay(300)
        assert.equal(countFds(app.pid), 0)
        assert.equal(await evaluate(restarted.target, 'document.querySelectorAll("serial-tab").length'), 0)
        await quit(restarted.target)
        console.log(JSON.stringify({ case: 'lifecycle', closeRetainsFd: true, dockReopen: true,
            replayedHistory: true, hexMonitor, generation: reused.result.generation, disconnectFds: 0, quitFds: 0, restartFds: 0 }))
    }
} finally {
    await mcp?.close()
    if (app && app.exitCode === null && app.signalCode === null) {
        app.kill('SIGKILL')
        await exit
    }
    process.stderr.write(log)
    await rm(run, { recursive: true, force: true })
}
