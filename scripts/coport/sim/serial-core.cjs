const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const { realpathSync } = require('node:fs')
const { performance } = require('node:perf_hooks')
const { setTimeout: sleep } = require('node:timers/promises')
const { darwinCalloutPath, SessionManager } = require('../../../dist/coport-m1/compiled/sessionManager.js')
const { openDevice } = require('../../../dist/coport-m1/compiled/serialDevice.js')

const [, , dir, first, alias, second, scenario] = process.argv
assert.match(realpathSync(first), /^\/dev\/ttys\d+$/)
assert.equal(realpathSync(alias), first)
assert.match(realpathSync(second), /^\/dev\/ttys\d+$/)
app.setPath('userData', dir)
const prefs = port => ({ port, baudrate: 115200 })
const ai = Symbol('fixture-ai')
const failedWith = code => error => error.code === code
const output = event => process.stdout.write(JSON.stringify(event) + '\n')

async function wait (condition) {
    const until = performance.now() + 3000
    while (!await condition()) {
        assert.ok(performance.now() < until, 'Timed out waiting for serial state')
        await sleep(10)
    }
}

async function basic (manager, mode) {
    let a, b
    if (mode === 'concurrent') {
        [a, b] = await Promise.all([manager.ensure(prefs(first)), manager.ensure(prefs(alias))])
    } else {
        a = await manager.ensure(prefs(mode === 'ai-first' ? alias : first))
        b = await manager.ensure(prefs(mode === 'ai-first' ? first : alias))
    }
    assert.equal(a.session, b.session)
    assert.equal(a.reused, false)
    assert.equal(b.reused, true)
    for (const port of [first, alias]) {
        await assert.rejects(manager.ensure({ port, baudrate: 9600 }), error =>
            error.code === 'config_conflict' && error.active.baudrate === 115200)
    }
    await a.session.changeBaudRate(57600, 'serial:old-profile')
    const updated = await manager.ensure({ port: alias, baudrate: 57600 })
    assert.equal(updated.session, a.session)
    assert.equal(updated.reused, true)
    await assert.rejects(manager.ensure(prefs(first)), error =>
        error.code === 'config_conflict' && error.active.baudrate === 57600)
    assert.equal((await manager.ensure(prefs(alias), true, 'serial:old-profile')).session, a.session)
    await assert.rejects(manager.ensure(prefs(alias), true, 'serial:another-profile'), failedWith('config_conflict'))
    output({ case: mode, pid: process.pid, generation: a.session.generation, fd: 'open', updatedBaud: 57600 })
    await sleep(300)
    await manager.disconnect(a.session.generation)
    assert.throws(() => manager.get(a.session.generation), failedWith('channel_lost'))
    output({ case: mode, pid: process.pid, fd: 'closed' })
    await sleep(300)
}

async function noise (manager) {
    const { session } = await manager.ensure(prefs(second))
    output({ case: 'open-noise', state: 'ready' })
    await wait(async () => (await session.snapshot()).snapshot.includes('NOISE'))
    assert.equal(session.hub.humanInputPending, false)
    assert.equal(session.hub.enqueue(Buffer.from('ai\r'), ai), 3)
    await sleep(200)
    assert.equal(session.hub.enqueue(Buffer.from('human'), 'human'), 5)
    assert.throws(() => session.hub.enqueue(Buffer.from('blocked\r'), ai), failedWith('busy'))
    output({ case: 'open-noise', automaticReports: true, halfLineExclusion: true })
    await sleep(250)
    await manager.disconnect(session.generation)
}

async function timeout () {
    let release
    const gate = new Promise(resolve => { release = resolve })
    let closed
    const didClose = new Promise(resolve => { closed = resolve })
    const manager = new SessionManager(async (...args) => {
        await gate
        const device = await openDevice(...args)
        return { ...device, close: async () => { await device.close(); closed() } }
    })
    const start = performance.now()
    await assert.rejects(manager.ensure(prefs(first)), failedWith('timeout'))
    const elapsed = performance.now() - start
    assert.ok(elapsed >= 14500 && elapsed <= 15500, elapsed)
    assert.equal(manager.sessions.size, 0)
    await Promise.race([manager.shutdown(), sleep(500).then(() => { throw new Error('shutdown waited for an open') })])
    release()
    await didClose
    assert.equal(manager.sessions.size, 0)
    output({ case: 'timeout', elapsed, pid: process.pid, fd: 'closed' })
    await sleep(300)
    await manager.shutdown()
}

async function historyParity () {
    const { HeadlessTerminal } = require('../../../dist/coport-m1/compiled/headlessTerminal.js')
    const { collect, replay, samples, numbered } = require('../probe/history.cjs')
    const { History } = require('../../../dist/coport-m1/compiled/history.js')
    const { join } = require('node:path')
    const { execFileSync } = require('node:child_process')
    const historySource = execFileSync('git', [
        '-C', process.env.COPORT_SOURCE ?? '../coport', 'show',
        '2c1ea46:Sources/CoportApp/Resources/tabby-coport/history.js',
    ], { encoding: 'utf8' })
    const reference = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } })
    await reference.loadURL('about:blank')
    const renderer = join(process.cwd(), 'tabby-terminal/node_modules/@xterm/xterm')
    const serialize = require.resolve('../../../app/node_modules/@xterm/addon-serialize')
    const original = await reference.webContents.executeJavaScript(`(() => {
        const reference = { exports: {} }
        Function('module', ${JSON.stringify(historySource)})(reference)
        return require(${JSON.stringify(require.resolve('../probe/history.cjs'))}).collect(
            require(${JSON.stringify(renderer)}).Terminal,
            reference.exports.History, require(${JSON.stringify(serialize)}).SerializeAddon,
        )
    })()`)
    const current = new HeadlessTerminal(() => {})
    assert.ok(current.history instanceof History)
    current.history.count = numbered.length + 100
    current.terminal.options.scrollback = 128
    const prompts = []
    const take = current.history.takeEmptyPrompt.bind(current.history)
    current.history.takeEmptyPrompt = token => {
        const end = current.history.promptEndToken ?? null
        const empty = take(token)
        prompts.push({ line: current.history.next, osc: current.history.oscToken ?? null, end, empty })
        return empty
    }
    for (const [input, token] of samples) {
        await current.ingest(Buffer.from(input), token ? { token, skip: 0 } : undefined)
    }
    assert.deepEqual(prompts, original.prompts)
    const bytes = Buffer.from(numbered.join(''))
    const start = performance.now()
    await current.ingest(bytes, undefined)
    const elapsed = performance.now() - start
    assert.ok(elapsed < 500, elapsed)
    await current.ingest(Buffer.from('\x1b[31mRED\x1b[0m normal\r\n'), undefined)
    assert.deepEqual(current.history.lines.slice(current.history.head).map(({ line }) => line), original.lines)
    const restored = await reference.webContents.executeJavaScript(`
        require(${JSON.stringify(require.resolve('../probe/history.cjs'))}).replay(
            require(${JSON.stringify(renderer)}).Terminal,
            ${JSON.stringify(current.snapshot())},
        )
    `)
    assert.deepEqual(restored, original.screen)
    output({ case: 'history-parity', samples: prompts.length, lines: original.lines.length,
        bytes: bytes.length, elapsed, restoredRows: restored.length })
    current.close()
    reference.destroy()
}

app.whenReady().then(async () => {
    if (scenario === 'timeout') {
        await timeout()
    } else if (scenario === 'history') {
        await historyParity()
    } else {
        let opens = 0
        const manager = new SessionManager(async (...args) => {
            opens++
            const device = await openDevice(...args)
            if (args[0] === second) {
                output({ case: 'open-noise', state: 'driver-open' })
                await wait(() => device.queuedReadBytes() > 0)
            }
            return device
        })
        try {
            if (scenario === 'extended') {
                const dialIn = '/dev/tty.cop-pty-fixture'
                const callout = '/dev/cu.cop-pty-fixture'
                assert.equal(darwinCalloutPath(dialIn, path => path === callout), callout)
                assert.equal(darwinCalloutPath(dialIn, () => false), dialIn)
                assert.equal(darwinCalloutPath(callout), callout)
                for (const mode of ['human-first', 'ai-first', 'concurrent']) {
                    const before = opens
                    await basic(manager, mode)
                    assert.equal(opens, before + 1)
                }
            }
            await noise(manager)
        } finally {
            await manager.shutdown()
        }
    }
    app.exit(0)
}).catch(error => {
    console.error(error)
    app.exit(1)
})
