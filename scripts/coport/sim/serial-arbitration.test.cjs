const assert = require('node:assert/strict')
const { test } = require('node:test')
const { setTimeout: delay } = require('node:timers/promises')
const { McpConnection } = require('../../../dist/coport-m1/compiled/mcpTools.js')
const { SessionManager } = require('../../../dist/coport-m1/compiled/sessionManager.js')
const { SerialHub } = require('../../../dist/coport-m1/compiled/serialHub.js')
const { SerialExec } = require('../../../dist/coport-m1/compiled/serialExec.js')
const { PromptTracker } = require('../../../dist/coport-m1/compiled/promptTracker.js')

const prompt = '\x1b]133;A\x07# \x1b]133;B\x07'
const bytes = data => Buffer.from(data)
const failingWith = (code, reason) => error => {
    assert.equal(error.code, code)
    if (reason) assert.equal(error.details.reason, reason)
    return true
}

function setup (readPrompt = async () => ({ text: '', current_line: '# ' })) {
    const writes = []
    const device = {
        blocked: false,
        pending: 0,
        queuedReadBytes: () => device.pending,
        write (data, offset) {
            if (device.blocked) return -1
            writes.push(data.subarray(offset))
            return data.length - offset
        },
    }
    const hub = new SerialHub(device, () => {})
    const exec = new SerialExec(hub, () => readPrompt(hub))
    hub.onEnqueued = data => exec.enqueued(data)
    return {
        hub, exec, device,
        read: data => exec.receive(bytes(data)),
        drain () {
            hub.drainWrites()
            return Buffer.concat(writes.splice(0))
        },
        enqueue: (data, source) => hub.enqueue(bytes(data), source),
    }
}

test('shared half-line protection, terminal replies, pasted newline, Ctrl-O and Ctrl-C', () => {
    const { hub, drain, enqueue } = setup()
    const first = Symbol()
    const second = Symbol()
    enqueue('\x1b[200~half\r', 'human')
    enqueue('\x1b[201', 'human')
    enqueue('~', 'human')
    assert.throws(() => enqueue('AI\r', first), failingWith('busy'))
    enqueue('\x1b[1;2R', 'terminal')
    enqueue('\x1b\r', 'human')
    assert.equal(hub.humanInputPending, true)
    enqueue('\n', 'human')
    enqueue('AI', first)
    assert.throws(() => enqueue('\r', second), failingWith('busy'))
    enqueue('\x03', 'human')
    assert.throws(() => enqueue('x'.repeat(65536), second), failingWith('queue_full'))
    assert.equal(hub.humanInputPending, false)
    enqueue('OK\r', 'human')
    assert.equal(drain().toString(), '\x1b[200~half\r\x1b[201~\x1b[1;2R\x1b\r\nAI\x03OK\r')

    enqueue('one\x0f', first)
    assert.throws(() => enqueue('two\r', second), failingWith('busy'))
    enqueue('\x03', second)
    enqueue('two\r', second)
    assert.equal(drain().toString(), 'one\x0f\x03two\r')
})

test('exec reserves Ctrl-C capacity and fences it behind earlier device bytes', () => {
    const { hub, device, drain, enqueue } = setup()
    hub.reserveInterrupt()
    enqueue('x'.repeat(65535), Symbol())
    assert.throws(() => enqueue('\r', Symbol()), failingWith('queue_full'))
    let interruptWritten = false
    hub.enqueueUrgent(bytes('\x03'), () => { interruptWritten = true })
    device.pending = 8
    assert.deepEqual(drain(), bytes('x'.repeat(65535)))
    assert.equal(interruptWritten, false)
    assert.equal(hub.wantsWrite, false)
    device.pending = 0
    hub.consumeBytesAheadOfInterrupt(8)
    assert.deepEqual(drain(), bytes('\x03'))
    assert.equal(interruptWritten, true)
    enqueue('next\r', 'human')
    assert.deepEqual(drain(), bytes('next\r'))
})

test('canceling an unsent interrupt preserves an owned half-line', () => {
    const { hub, drain, enqueue } = setup()
    hub.reserveInterrupt()
    enqueue('human draft', 'human')
    const pending = hub.enqueueUrgent(bytes('\x03'))
    assert.equal(hub.cancelPendingInterrupt(pending), true)
    assert.throws(() => enqueue('ai\r', Symbol()), failingWith('busy'))
    enqueue('\r', 'human')
    assert.equal(drain().toString(), 'human draft\r')
})

test('orphan recovery requires fresh evidence across interrupt cancellation', () => {
    const { hub, device, drain, enqueue } = setup()
    const owner = Symbol()
    hub.confirmEmptyPrompt(hub.observePromptOutput(1).token)
    enqueue('half', owner)
    assert.equal(drain().toString(), 'half')
    device.pending = 10
    const pending = hub.enqueueUrgent(bytes('\x03'))
    hub.clientDisconnected(owner)
    assert.equal(hub.cancelPendingInterrupt(pending), true)
    assert.equal(hub.observePromptOutput(10), undefined)
    device.pending = 0
    const fresh = hub.observePromptOutput(1)
    const fence = hub.enqueueUrgent(bytes('\x03'))
    hub.confirmEmptyPrompt(fresh.token)
    assert.throws(() => enqueue('next\r', 'human'), failingWith('busy'))
    assert.equal(hub.cancelPendingInterrupt(fence), true)
    enqueue('next\r', 'human')
    assert.deepEqual(drain(), bytes('next\r'))
})

test('old completion cannot rearm prompt after Ctrl-C', () => {
    const { hub, drain, enqueue } = setup()
    const ai = Symbol()
    hub.confirmEmptyPrompt(hub.observePromptOutput(1).token)
    enqueue('run\r', ai)
    assert.equal(drain().toString(), 'run\r')
    const pending = hub.observePromptOutput(1)
    enqueue('\x03', 'human')
    hub.confirmEmptyPrompt(pending.token)
    assert.equal(drain().toString(), '\x03')
    assert.equal(hub.observePromptOutput(1), undefined)
    enqueue('half', ai)
    assert.equal(drain().toString(), 'half')
    hub.clientDisconnected(ai)
    assert.equal(hub.observePromptOutput(1), undefined)
    assert.throws(() => enqueue('next\r', 'human'), failingWith('busy'))
    enqueue('\x03', 'human')
    enqueue('next\r', 'human')
    assert.equal(drain().toString(), '\x03next\r')
})

const alive = () => false
const tick = () => new Promise(resolve => setImmediate(resolve))
async function begin (fixture, command = 'true') {
    const response = fixture.exec.run(command, 250, 1024, alive)
    await tick()
    const frame = fixture.drain().toString()
    const id = /^__cp (\w{8}) /.exec(frame)?.[1]
    assert.ok(id, frame)
    return { response, id, frame }
}

test('prepare rules, retries, fullscreen, atomic human sequence, and quote byte limit', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let current = '> '
    const fixture = setup(async () => ({ text: '', current_line: current }))
    const { hub, exec, read, drain } = fixture
    await assert.rejects(exec.run('true', 30000, 1024, alive), failingWith('terminal_busy', 'not_prepared'))
    await assert.rejects(exec.prepare(alive), failingWith('terminal_busy', 'not_at_prompt'))
    assert.equal(drain().length, 0)
    current = '# '
    const preparation = exec.prepare(alive)
    const failed = assert.rejects(preparation, failingWith('prepare_failed'))
    await tick()
    assert.match(drain().toString(), /^__cp\(\).*export -n PS1 2>\/dev\/null\r$/)
    t.mock.timers.tick(3000)
    await failed
    const retry = exec.prepare(alive)
    await tick()
    assert.ok(drain().length)
    read(prompt)
    assert.equal(await retry, false)
    assert.equal(await exec.prepare(alive), true)
    for (const mode of [47, 1047, 1049]) {
        read(`\x1b[?${mode}h`)
        await assert.rejects(exec.prepare(alive), failingWith('terminal_busy', 'fullscreen'))
        await assert.rejects(exec.run('true', 30000, 1024, alive), failingWith('terminal_busy', 'fullscreen'))
        read(`\x1b[?${mode}l`)
        await assert.rejects(exec.run('true', 30000, 1024, alive), failingWith('terminal_busy', 'running'))
        read(prompt)
    }
    for (const command of ['x'.repeat(899), "'".repeat(300), '中'.repeat(300)]) {
        await assert.rejects(exec.run(command, 30000, 1024, alive), failingWith('command_too_long'))
    }
    assert.equal(drain().length, 0)

    const racing = setup(async racingHub => {
        racingHub.enqueue(bytes('x'), 'human')
        return { text: '', current_line: '# ' }
    })
    racing.read(prompt)
    await assert.rejects(racing.exec.run('true', 30000, 1024, alive), failingWith('terminal_busy', 'user_input_pending'))
    assert.equal(racing.drain().toString(), 'x')
    hub.close()
})

test('exec isolates marker output, prevents concurrent commands and returns partial output on disconnect', async () => {
    const fixture = setup()
    const { hub, exec, read, drain } = fixture
    read(prompt)
    const { response, id, frame } = await begin(fixture, "printf '中文'; exit 7")
    assert.ok(frame.endsWith(" 'printf '\\''中文'\\''; exit 7'\r"), frame)
    await assert.rejects(exec.run('true', 30000, 1024, alive), failingWith('terminal_busy', 'executing'))
    assert.equal(drain().length, 0)
    read(`echoed wrapper\r\n\x1b]6973;S;${id}\x07中文\r\n\x1b[31mred\x1b[0m\r\n[ 1.23] coport-kmsg\r\n\x1b]6973;E;${id};7\x07`)
    const result = await response
    assert.equal(result.exit_code, 7)
    assert.equal(result.output, '中文\nred\n[ 1.23] coport-kmsg\n')

    read(prompt)
    const lost = await begin(fixture)
    read(`\x1b]6973;S;${lost.id}\x07partial`)
    exec.close()
    hub.close()
    await assert.rejects(lost.response, error => {
        assert.equal(error.code, 'channel_lost')
        assert.deepEqual(error.details, { channel: 'serial', partial_output: 'partial' })
        return true
    })
    await assert.rejects(setup().exec.run('true', 1000, 1024, alive), failingWith('terminal_busy', 'not_prepared'))
})

test('unsent Ctrl-C cancels its byte and preserves the unrelated half-line', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const fixture = setup()
    const { device, drain, enqueue, read } = fixture
    read(prompt)
    const { response } = await begin(fixture)
    device.blocked = true
    enqueue('x'.repeat(65535), 'human')
    const rejected = assert.rejects(response, error => {
        assert.equal(error.code, 'timeout')
        assert.deepEqual(error.details, {
            channel: 'serial', interrupt: 'ctrl_c_not_sent', partial_output: '', shell_recovered: false,
        })
        return true
    })
    t.mock.timers.tick(250)
    t.mock.timers.tick(2000)
    await rejected
    device.blocked = false
    assert.deepEqual(drain(), bytes('x'.repeat(65535)))
    assert.throws(() => enqueue('ai\r', Symbol()), failingWith('busy'))
})

test('a prompt before Ctrl-C does not count as recovery and a late command result is ignored', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    for (const recovered of [false, true]) {
        const fixture = setup()
        const { device, drain, enqueue, read } = fixture
        read(prompt)
        const { response, id } = await begin(fixture)
        const rejected = assert.rejects(response, error => {
            assert.equal(error.code, 'timeout')
            assert.deepEqual(error.details, {
                channel: 'serial', interrupt: 'ctrl_c_sent', partial_output: 'partial', shell_recovered: recovered,
            })
            return true
        })
        read(`\x1b]6973;S;${id}\x07partial`)
        device.blocked = true
        enqueue('x'.repeat(65535), 'human')
        t.mock.timers.tick(400)
        read(prompt)
        device.blocked = false
        assert.deepEqual(drain(), bytes('x'.repeat(65535) + '\x03'))
        if (recovered) read(prompt)
        t.mock.timers.tick(2000)
        await rejected
        read(`\x1b]6973;E;${id};0\x07`)
    }
})

test('fragmented markers tolerate interleaved kernel records and unterminated escapes', () => {
    const noise = '[ 123.456] coport-kmsg\r\n'
    const markers = { '133;A': 'promptA', '133;B': 'promptB', '6973;S;1234abcd': 'start', '6973;E;1234abcd;127': 'end' }
    for (const [marker, type] of Object.entries(markers)) {
        const sequence = '\x1b]' + marker
        for (let split = 0; split <= sequence.length; split++) {
            const tracker = new PromptTracker()
            const events = []
            for (const byte of bytes(sequence.slice(0, split) + noise + sequence.slice(split) + '\x07')) {
                tracker.feed(bytes([byte]), event => events.push(event))
            }
            assert.deepEqual(events.map(event => event.type), ['bytes', type])
            assert.equal(events[0].data.toString(), noise)
        }
    }
    for (const unfinished of ['\x1b]', '\x1b[', '\x1b[31', '\x1b]title']) {
        const tracker = new PromptTracker()
        const events = []
        for (const byte of bytes(`\x1b]6973;S;1234abcd\x07hello${unfinished}\x1b]6973;E;1234abcd;7\x07\x1b]133;B\x07`)) {
            tracker.feed(bytes([byte]), event => events.push(event))
        }
        assert.deepEqual(events.filter(event => event.type === 'end'), [{ type: 'end', id: '1234abcd', status: 7 }])
    }
})

test('MCP preserves the native serial open error contract when errno is omitted', async () => {
    for (const [message, code] of [
        ['Error: Permission denied, cannot open /dev/null', 'port_busy'],
        ['Error: Resource busy, cannot open /dev/null', 'port_busy'],
        ['Error: Resource temporarily unavailable, cannot open /dev/null', 'port_busy'],
        ['Error Resource temporarily unavailable Cannot lock port', 'port_busy'],
        ['Error: No such file or directory, cannot open /dev/null', 'invalid_argument'],
    ]) {
        const manager = new SessionManager(async () => { throw new Error(message) })
        const result = await new McpConnection(manager).call('open_serial', { path: '/dev/null' })
        assert.equal(result.error.code, code)
        assert.equal(result.error.retryable, code === 'port_busy')
    }
})

test('path lookup consumes the open deadline and cannot trigger a late open', async () => {
    const lookupFailure = new Error('lookup failed')
    let started = 0
    const manager = new SessionManager(
        async () => { started++ },
        20,
        async path => {
            await delay(70)
            if (path === '/missing') throw lookupFailure
            return { path, identity: 1n }
        },
    )
    await Promise.all(['/alias', '/missing'].map(port => assert.rejects(
        manager.ensure({ port, baudrate: 115200 }), failingWith('timeout'),
    )))
    await delay(80)
    assert.equal(started, 0)
})

test('later lookup completion cannot take precedence over an earlier request for the same device', async () => {
    const opens = []
    const failure = new Error('first open failed')
    const manager = new SessionManager(
        async path => {
            opens.push(path)
            await delay(20)
            throw failure
        },
        3000,
        async path => {
            if (path === '/first') await delay(15)
            return { path, identity: 1n }
        },
    )
    const requests = ['/first', '/alias'].map(port => manager.ensure({ port, baudrate: 115200 }))
    for (const outcome of await Promise.allSettled(requests)) {
        assert.equal(outcome.reason, failure)
    }
    assert.deepEqual(opens, ['/first'])
})
