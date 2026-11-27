const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const requireProbe = createRequire(path.resolve('dist/coport-m0/probe-deps/package.json'))
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const readline = require('node:readline')
const { app } = require('electron')
const { SerialPort } = createRequire(path.resolve('app/package.json'))('serialport')
const { Terminal } = requireProbe('@xterm/headless')

const dataDir = fs.mkdtempSync(path.resolve('dist/coport-m0/p2-'))
app.setPath('userData', dataDir)
const [mode, device, alias] = process.argv.slice(2)
const loopback = mode === 'ch340-loopback'
const shell = mode === 'ftdi-shell'
const hardware = mode === 'ch340' || loopback || shell
const wchDevice = '/dev/cu.wchusbserial1130'
const ftdiDevice = '/dev/cu.usbserial-A45P861Z'

function fdCount(pid, devicePath) {
    const options = pid === undefined ? [] : ['-a', '-p', String(pid)]
    const result = spawnSync('/usr/sbin/lsof', [...options, '-Fn', devicePath], {
        encoding: 'utf8',
        timeout: 2000,
    })
    if (result.error) throw result.error
    assert.ok([0, 1].includes(result.status), result.stderr)
    assert.equal(result.stderr, '')
    return result.stdout.split('\n').filter(line => line === 'n' + devicePath).length
}

function call(port, method, ...args) {
    return new Promise((resolve, reject) => {
        port[method](...args, error => error ? reject(error) : resolve())
    })
}

async function shellExchange(port, chunks, command, received, description) {
    chunks.length = 0
    await call(port, 'write', Buffer.from(command + '\r', 'ascii'))
    await call(port, 'drain')
    for (let remaining = 30; remaining > 0; remaining--) {
        if (received(Buffer.concat(chunks))) return
        await delay(50)
    }
    assert.fail(`FTDI did not return ${description}`)
}

async function main() {
    assert.ok(hardware ? device === (shell ? ftdiDevice : wchDevice) : /^\/dev\/ttys\d+$/.test(device))
    if (hardware) {
        assert.ok(fs.statSync(device).isCharacterDevice())
        assert.equal(fdCount(undefined, device), 0, `${device} is already in use`)
    } else {
        assert.equal(fs.statSync(device).rdev, fs.statSync(alias).rdev)
    }
    const port = new SerialPort({
        path: device, baudRate: hardware ? 921600 : 115200, dataBits: 8,
        stopBits: 1, parity: 'none', rtscts: false, autoOpen: false,
    })
    const chunks = []
    port.on('data', chunk => {
        chunks.push(chunk)
        console.error(JSON.stringify({
            receivedHex: chunk.toString('hex'),
            receivedText: chunk.toString('latin1').replace(/[^ -~]/g, '.'),
        }))
    })
    const input = hardware ? null : readline.createInterface({ input: process.stdin })
    try {
        if (hardware) {
            await call(port, 'open')
        } else {
            const opening = call(port, 'open')
            console.log('opening')
            await opening
        }
        assert.equal(fdCount(process.pid, device), 1)
        console.log('open')
        if (!hardware) await once(input, 'line')
        await delay(hardware && !loopback && !shell ? 2000 : 150)
        const received = Buffer.concat(chunks)
        if (shell) {
            await shellExchange(port, chunks, '', data => /[#$][ \t]*$/.test(data.toString('utf8')), 'a shell prompt')
            console.log('shell prompt received')
            const hasLine = expected => data => data.toString('latin1').split(/[\r\n]+/).includes(expected)
            await shellExchange(port, chunks, 'echo COPORT_P2_$((6*7))', hasLine('COPORT_P2_42'), 'COPORT_P2_42')
            console.log('COPORT_P2_42')
            const pattern = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.repeat(5).slice(0, 256)
            // Parameter splitting keeps the complete pattern out of the echoed command.
            const command = `printf '%s%s\\n' '${pattern.slice(0, 128)}' '${pattern.slice(128)}'`
            await shellExchange(port, chunks, command, hasLine(pattern), 'the exact 256-byte pattern')
            console.log(JSON.stringify({ baud: 921600, bits: '8N1', rtscts: false, matchedBytes: pattern.length }))
        } else if (loopback) {
            const pattern = Buffer.from(Array.from({ length: 256 }, (_, byte) => byte))
            chunks.length = 0
            await call(port, 'write', pattern)
            await call(port, 'drain')
            for (let remaining = 20; remaining > 0 && Buffer.concat(chunks).length < pattern.length; remaining--) {
                await new Promise(resolve => setTimeout(resolve, 50))
            }
            assert.deepEqual(Buffer.concat(chunks), pattern)
            console.log(JSON.stringify({ baud: 921600, bits: '8N1', loopbackBytes: pattern.length }))
        } else if (hardware) {
            // The attached device is a log source without an echo command.
            await call(port, 'write', Buffer.from('\r'))
            await call(port, 'drain')
            console.log(JSON.stringify({
                bytesRead: received.length,
                textLines: received.toString('utf8').split('\n').filter(x => /[a-z]{3}/i.test(x)).length,
                replacementCharacters: (received.toString('utf8').match(/\uFFFD/g) ?? []).length,
                txDrained: 1,
                peerReceipt: 'unobserved',
            }))
        } else {
            const openingNoiseReceived = received.includes(Buffer.from('open-noise'))
            assert.ok(received.includes(Buffer.from('after-open')))
            if (mode === 'preload') assert.equal(openingNoiseReceived, false)
            const terminal = new Terminal()
            const replies = []
            terminal.onData(data => replies.push(data))
            await new Promise(resolve => terminal.write(received, resolve))
            terminal.dispose()
            assert.ok(replies.some(reply => /^\x1b\[\d+;\d+R$/.test(reply)), 'missing terminal DSR reply')
            // A DSR would claim human input via SerialHub.arbitrate if routed as
            // human. Here there is no user event and the terminal reply is distinct.
            await call(port, 'write', Buffer.from('ai\r'))
            await call(port, 'drain')
            console.log(JSON.stringify({ bytesRead: received.length, openingNoiseReceived, replies, txDrained: 3 }))
        }
        assert.equal(fdCount(process.pid, device), 1)
    } finally {
        input?.close()
        if (port.isOpen) await call(port, 'close')
        assert.equal(fdCount(process.pid, device), 0)
        console.log('closed fd=0')
    }
}

const deadline = setTimeout(() => {
    console.error('P2 timeout')
    app.exit(1)
}, 7000)
app.whenReady().then(main).then(() => {
    clearTimeout(deadline)
    app.exit(0)
}, error => {
    console.error(error)
    app.exit(1)
})
