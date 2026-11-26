import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer, createConnection } from 'node:net'
import { userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { evaluate, renderer, waitFor } from './renderer.mjs'

const bundle = resolve(process.argv[2])
const device = process.argv[3]
assert.match(device, /^\/dev\/ttys\d+$/)
const run = await realpath(await mkdtemp('/tmp/cp-shells-'))
const adbRoot = join(run, 'adb')
const sshRoot = join(run, 'remote')
const endpoint = join(run, 'mcp.sock')
const shim = join(bundle, 'Contents/MacOS/coport-mcp')
const requireApp = createRequire(new URL('../../../app/package.json', import.meta.url))
const { Client } = requireApp('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = requireApp('@modelcontextprotocol/sdk/client/stdio.js')

async function stop (process) {
    if (process && process.exitCode === null && process.signalCode === null) {
        const exit = once(process, 'exit')
        process.kill('SIGTERM')
        if (!await Promise.race([exit, delay(2000, false)])) {
            process.kill('SIGKILL')
            await exit
        }
    }
}

const childrenLogs = []
let sshd, app, mcp, target
try {
    await mkdir(sshRoot)
    await writeFile(join(sshRoot, 'seed.txt'), 'ssh fixture\n')
    await symlink('seed.txt', join(sshRoot, 'linked'))
    const adb = execFileSync('python3', ['-B', 'scripts/coport/sim/prepare_adb.py', '--prepare', adbRoot], { encoding: 'utf8' }).trim()
    for (const label of ['host', 'client']) {
        execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(run, label)])
    }
    const reservation = createServer()
    reservation.listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const port = reservation.address().port
    await new Promise(resolveClose => reservation.close(resolveClose))
    const config = join(run, 'sshd_config')
    await writeFile(config, [
        `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${run}/host`,
        `AuthorizedKeysFile ${run}/client.pub`, 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
        'UsePAM no', 'StrictModes no', 'Subsystem sftp internal-sftp', `PidFile ${run}/sshd.pid`,
        `SetEnv ZDOTDIR=${run} HISTFILE=/dev/null`,
    ].join('\n') + '\n')
    sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', config])
    sshd.stderr.on('data', data => childrenLogs.push(data.toString()))
    await waitFor(async () => {
        const probe = createConnection({ host: '127.0.0.1', port })
        try {
            await once(probe, 'connect')
            return true
        } finally {
            probe.destroy()
        }
    })
    const [type, hostKey] = (await readFile(join(run, 'host.pub'), 'utf8')).split(' ')
    const home = userInfo().username
    const title = { local: 'M3 local', ssh: 'M3 SSH', serial: 'M3 serial', adb: 'M3 ADB' }
    await writeFile(join(run, 'config.yaml'), JSON.stringify({
        enableAnalytics: false,
        enableAutomaticUpdates: false,
        hacks: { disableGPU: true },
        terminal: { environment: { ZDOTDIR: run, HISTFILE: '/dev/null', ADB_SERVER_SOCKET: 'tcp:localhost:5041' } },
        ssh: { knownHosts: [{
            host: '127.0.0.1', port, type,
            digest: createHash('sha256').update(Buffer.from(hostKey, 'base64')).digest('base64'),
        }] },
        profiles: [
            { name: title.local, type: 'local', options: { command: '/bin/sh', args: ['-i'], cwd: run } },
            { name: title.ssh, type: 'ssh', options: {
                host: '127.0.0.1', port, user: home, auth: 'publicKey', privateKeys: [join(run, 'client')], cwd: sshRoot,
            } },
            { name: title.serial, type: 'serial', options: { port: device, baudrate: 115200 } },
            { name: title.adb, type: 'coport-adb', options: { serial: null } },
        ],
    }))
    const env = { ...process.env, ADB_SERVER_SOCKET: 'tcp:localhost:5999',
        COPORT_TEST_ADB: adb, COPORT_TEST_SOCKET: endpoint, TABBY_PLUGINS: '' }
    for (const key of ['ELECTRON_RUN_AS_NODE', 'TABBY_DEV', 'COPORT_TEST_AUTOSTART_APP']) delete env[key]
    app = spawn(join(bundle, 'Contents/MacOS/Coport'), [`--user-data-dir=${run}`, '--remote-debugging-port=0'], { env })
    for (const stream of [app.stdout, app.stderr]) stream.on('data', data => childrenLogs.push(data.toString()))
    const debugPort = await waitFor(async () => Number((await readFile(join(run, 'DevToolsActivePort'), 'utf8')).split('\n')[0]))
    target = await waitFor(async () => {
        const page = await renderer(debugPort)
        return page && await evaluate(page, "require('electron').ipcRenderer.listenerCount('cli') > 0") && page
    })
    const evalJs = (expression, timeout) => evaluate(target, expression, timeout)
    await evalJs(`(() => {
        window.cpErrors = []
        for (const level of ['error', 'warn']) {
            const original = console[level]
            console[level] = (...args) => {
                cpErrors.push(args.map(String).join(' '))
                original.apply(console, args)
            }
        }
        // Angular 15's production renderer does not publish window.ng.
        window.cpComponent = selector => {
            const element = document.querySelector(selector)
            if (!element) return null
            const context = require('@angular/core').ɵgetLContext(element)
            const { lView, nodeIndex } = context
            const node = lView[1].data[nodeIndex]
            return lView[node.directiveStart + node.componentOffset]
        }
        window.cpTerminalProof = async (selector, proof) => {
            const tab = cpComponent(selector)
            if (!tab?.session?.open || !tab.frontend?.xterm) return false
            tab.sendInput('printf "%s\\\\n" "' + proof + '"\\r')
            return true
        }
        window.cpHasLine = (selector, proof) => {
            const buffer = cpComponent(selector)?.frontend?.xterm?.buffer.active
            return buffer && Array.from({length: buffer.length}, (_, i) =>
                buffer.getLine(i)?.translateToString(true).trim()).includes(proof)
        }
        return true
    })()`)
    const open = name => evalJs(`require('electron').ipcRenderer.emit('cli', null,
        { _: ['profile'], profileName: ${JSON.stringify(name)} }, '/', false)`)
    const proof = async (selector, token) => {
        await waitFor(() => evalJs(`cpTerminalProof(${JSON.stringify(selector)}, ${JSON.stringify(token)})`))
        await waitFor(() => evalJs(`cpHasLine(${JSON.stringify(selector)}, ${JSON.stringify(token)})`))
    }
    await open(title.local)
    await proof('terminaltab', 'M3-LOCAL')
    await open(title.serial)
    await waitFor(() => evalJs("!!document.querySelector('serial-tab .text-success')"))
    mcp = new Client({ name: 'm3-shells', version: '1' })
    await mcp.connect(new StdioClientTransport({ command: shim, env: { COPORT_TEST_SOCKET: endpoint } }))
    const tool = async (name, args) => (await mcp.callTool({ name, arguments: args })).structuredContent
    const serial = await tool('open_serial', { path: device })
    assert.equal(serial.reused, true)
    await open(title.ssh)
    await proof('ssh-tab', 'M3-SSH')
    await open(title.adb)
    await proof('coport-adb-tab', 'M3-ADB')

    async function exercisePanel (selector, label, path, seed, expected) {
        assert.equal(await evalJs(`(() => {
            const button = [...document.querySelectorAll(${JSON.stringify(selector + ' terminal-toolbar button')})]
                .find(item => item.textContent.trim() === ${JSON.stringify(label)})
            button?.click()
            return Boolean(button)
        })()`), true)
        await waitFor(() => evalJs(`!!cpComponent(${JSON.stringify(selector + ' sftp-panel')})?.sftp`))
        const result = await evalJs(`(async () => {
            const panel = cpComponent(${JSON.stringify(selector + ' sftp-panel')})
            const directory = ${JSON.stringify(path)}
            await panel.navigate(directory)
            const seen = panel.fileList.map(entry => entry.name)
            const file = directory + '/space and \\'quote.txt'
            const child = directory + '/directory'
            const data = Buffer.from('M3 binary\\x00 file\\n')
            let count = 0
            const transfer = { isCancelled: () => false, close() {}, setStatus() {}, cancel() {}, setPendingCommit() {}, completeDownload: async () => {} }
            const read = async () => count++ ? Buffer.alloc(0) : data
            await panel.sftp.mkdir(child)
            await panel.sftp.upload(file, { ...transfer, read })
            const chunks = []
            const download = async path => {
                chunks.length = 0
                await panel.sftp.download(path, { ...transfer, write: async bytes => chunks.push(Buffer.from(bytes)) })
                return Buffer.concat(chunks)
            }
            const copied = (await download(file)).equals(data)
            const seed = (await download(directory + '/seed.txt')).toString()
            const entry = await panel.sftp.stat(file)
            const { DirectoryUpload } = require('tabby-core')
            const folder = new DirectoryUpload('folder')
            const nested = new DirectoryUpload('nested')
            let folderReads = 0
            nested.pushChildren({ ...transfer, getName: () => 'recursive.txt',
                read: async () => folderReads++ ? Buffer.alloc(0) : data })
            folder.pushChildren(nested)
            const root = new DirectoryUpload()
            root.pushChildren(folder)
            const folderUpload = panel.uploadOneFolder(root)
            await panel.navigate('/')
            await folderUpload
            if (panel.path !== '/') throw new Error('Folder upload moved the current directory')
            await panel.navigate(directory)
            const nestedFile = directory + '/folder/nested/recursive.txt'
            const folderCopied = (await download(nestedFile)).equals(data)
            await panel.sftp.unlink(nestedFile)
            await panel.sftp.rmdir(directory + '/folder/nested')
            await panel.sftp.rmdir(directory + '/folder')
            const linked = await panel.sftp.stat(directory + '/linked')
            if (linked.isSymlink || linked.size !== Buffer.byteLength(seed)) throw new Error('stat did not follow the link')
            let fallback = 0
            let link = null
            let cancelled = false
            if (${selector === 'coport-adb-tab'}) {
                const fallbackBytes = await download(directory + '/fallback.bin')
                fallback = fallbackBytes.every((byte, index) => byte === index % 256) ? fallbackBytes.length : 0
                link = await panel.sftp.readlink(directory + '/linked')
                const chain = await panel.sftp.stat(directory + '/chain')
                if (chain.isSymlink || chain.size !== Buffer.byteLength(seed)) throw new Error('stat did not follow links')
                let cancelDownload = false
                setTimeout(() => { cancelDownload = true }, 100)
                const before = Date.now()
                try {
                    await panel.sftp.download(directory + '/slow-download.bin', {
                        ...transfer,
                        isCancelled: () => cancelDownload,
                        write: async () => { throw new Error('Cancelled transfer yielded data') },
                    })
                } catch {
                    cancelled = cancelDownload && Date.now() - before < 1000
                }
            }
            await panel.sftp.unlink(file)
            await panel.sftp.rmdir(child)
            const after = (await panel.sftp.readdir(directory)).map(entry => entry.name)
            return { seen, seed, copied, folderCopied, size: entry.size, fallback, link, cancelled, after }
        })()`)
        assert.ok(result.seen.includes(seed), result)
        assert.equal(result.seed, expected)
        assert.equal(result.copied, true)
        assert.equal(result.folderCopied, true)
        assert.equal(result.size, Buffer.byteLength('M3 binary\x00 file\n'))
        assert.deepEqual(result.after.slice().sort(), result.seen.slice().sort())
        return result
    }

    const adbPanel = await exercisePanel('coport-adb-tab', 'Files', '/sdcard', 'seed.txt', 'android fixture\n')
    assert.equal(adbPanel.fallback, 256 * 3000)
    assert.equal(adbPanel.link, 'seed.txt')
    assert.equal(adbPanel.cancelled, true)
    const edits = await evalJs(`(async () => {
        const adbPanel = cpComponent('coport-adb-tab sftp-panel')
        const seed = adbPanel.fileList.find(item => item.name === 'seed.txt')
        return (await adbPanel.buildContextMenu(seed)).map(item => item.label).filter(Boolean)
    })()`)
    assert.ok(edits.includes('Copy full path') && !edits.includes('Edit locally'), edits)
    await writeFile(join(adbRoot, 'state.json'), JSON.stringify({
        devices: [['one', 'device']], reject_unlink: ['/sdcard/seed.txt'],
    }))
    await evalJs(`(async () => {
        const panel = cpComponent('coport-adb-tab sftp-panel')
        const seed = panel.fileList.find(item => item.name === 'seed.txt')
        const original = panel.platform.showMessageBox
        panel.platform.showMessageBox = async () => ({ response: 0 })
        try {
            const entry = (await panel.buildContextMenu(seed)).find(item => item.label === 'Delete')
            await entry.click()
        } finally {
            panel.platform.showMessageBox = original
        }
    })()`)
    await waitFor(() => evalJs("document.body.innerText.includes('remote delete denied by legacy shell')"))
    assert.equal(await readFile(join(adbRoot, 'device', 'sdcard', 'seed.txt'), 'utf8'), 'android fixture\n')
    await evalJs(`(async () => {
        const panel = cpComponent('coport-adb-tab sftp-panel')
        const original = panel.platform.startDownload
        panel.platform.startDownload = async () => { throw new Error('fixture destination is unwritable') }
        try {
            await panel.download('/sdcard/seed.txt', 0o600, 12)
        } finally {
            panel.platform.startDownload = original
        }
    })()`)
    await waitFor(() => evalJs("document.body.innerText.includes('fixture destination is unwritable')"))
    const destination = join(run, 'download-target.txt')
    await writeFile(destination, 'existing uses are preserved')
    assert.equal(await evalJs(`(async () => {
        const panel = cpComponent('coport-adb-tab sftp-panel')
        const destination = ${JSON.stringify(destination)}
        const transfer = await panel.platform.startDownload('target', 0o600, 0, destination, true)
        if (transfer.isComplete()) throw new Error('Empty download completed before verification')
        try {
            await panel.sftp.download('/sdcard/missing', transfer)
            return false
        } catch {
            return transfer.isCancelled()
        }
    })()`), true)
    assert.equal(await readFile(destination, 'utf8'), 'existing uses are preserved')
    assert.equal(await evalJs(`(async () => {
        const panel = cpComponent('coport-adb-tab sftp-panel')
        const transfer = await panel.platform.startDownload('target', 0o444, 1000, ${JSON.stringify(destination)}, true)
        await panel.sftp.download('/sdcard/seed.txt', transfer)
        return transfer.isComplete()
    })()`), true)
    assert.equal(await readFile(destination, 'utf8'), 'android fixture\n')
    assert.equal((await stat(destination)).mode & 0o777, 0o444)
    const advanced = await evalJs(`(async () => {
        const panel = cpComponent('coport-adb-tab sftp-panel')
        const { FileUpload } = require('tabby-core')
        class SmallUpload extends FileUpload {
            getName() { return 'test' }
            getSize() { return 1 }
            getMode() { return 0o600 }
            close() {}
            async read() {
                if (this.getCompletedBytes()) return Buffer.alloc(0)
                this.increaseProgress(1)
                if (this.isComplete()) throw new Error('Upload was complete before remote commit')
                return Buffer.from('x')
            }
        }
        const batch = Array.from({ length: 17 }, (_, i) => ({
            path: '/sdcard/queued-' + i, transfer: new SmallUpload(),
        }))
        await Promise.all(batch.map(({ path, transfer }) => panel.sftp.upload(path, transfer)))
        const queued = batch.filter(({ transfer }) => transfer.isComplete()).length
        for (const { path } of batch) await panel.sftp.unlink(path)
        const longPath = '/sdcard/' + 'x'.repeat(235)
        const longUpload = new SmallUpload()
        await panel.sftp.upload(longPath, longUpload)
        const longName = (await panel.sftp.stat(longPath)).name.length
        await panel.sftp.unlink(longPath)
        const denied = async operation => {
            try { await operation; return false } catch (error) { return error.message.includes('did not complete') }
        }
        return {
            queued, longName,
            mkdirDenied: await denied(panel.sftp.mkdir('/sdcard/legacy-denied')),
            moveDenied: await denied(panel.sftp.upload('/sdcard/legacy-move-denied', new SmallUpload())),
        }
    })()`, 15000)
    assert.deepEqual(advanced, { queued: 17, longName: 235, mkdirDenied: true, moveDenied: true })
    const android = join(adbRoot, 'device', 'sdcard')
    assert.deepEqual((await readdir(android)).sort(), ['chain', 'fallback.bin', 'left', 'linked', 'right', 'seed.txt', 'slow-download.bin'])
    await writeFile(join(adbRoot, 'state.json'), JSON.stringify({
        devices: [['one', 'device']], list_delays: { one: { '/sdcard': 0.3 } },
    }))
    assert.deepEqual(await evalJs(`(async () => {
        const panel = cpComponent('coport-adb-tab sftp-panel')
        const slow = panel.navigate('/sdcard')
        await panel.navigate('/')
        await slow
        return { path: panel.path, names: panel.fileList.map(entry => entry.name) }
    })()`), { path: '/', names: ['sdcard'] })
    assert.deepEqual(await evalJs(`(async () => {
        const panel = cpComponent('coport-adb-tab sftp-panel')
        await panel.navigate('/sdcard/left/link/..')
        return { path: panel.path, names: panel.fileList.map(entry => entry.fullPath).sort() }
    })()`), { path: '/sdcard/left', names: ['/sdcard/left/left.txt', '/sdcard/left/link'] })
    await evalJs(`(async () => {
        const panel = cpComponent('coport-adb-tab sftp-panel')
        await panel.navigate('/sdcard')
        const original = panel.platform.startUploadFromDragEvent
        let release
        panel.platform.startUploadFromDragEvent = () => new Promise(resolve => { release = resolve })
        try {
            document.querySelector('coport-adb-tab sftp-panel .body').dispatchEvent(new Event('drop'))
            await panel.navigate('/')
            const { DirectoryUpload } = require('tabby-core')
            const transfer = new DirectoryUpload()
            let sent = false
            transfer.pushChildren({ getName: () => 'dropped.txt', isCancelled: () => false,
                setPendingCommit() {}, close() {}, cancel() {}, setStatus() {},
                read: async () => sent ? Buffer.alloc(0) : (sent = true, Buffer.from('drop-source')) })
            release(transfer)
        } finally {
            panel.platform.startUploadFromDragEvent = original
        }
    })()`)
    await waitFor(async () => (await readFile(join(android, 'dropped.txt'), 'utf8')) === 'drop-source')
    assert.equal(await evalJs("cpComponent('coport-adb-tab sftp-panel').path"), '/')
    await evalJs("cpComponent('coport-adb-tab sftp-panel').sftp.unlink('/sdcard/dropped.txt')")
    const sshPanel = await exercisePanel('ssh-tab', 'SFTP', sshRoot, 'seed.txt', 'ssh fixture\n')
    await writeFile(join(adbRoot, 'state.json'), JSON.stringify({ devices: [['two', 'device'], ['one', 'device']] }))
    assert.equal((await tool('exec', { command: 'printf recent-device' })).output, 'recent-device')
    const calls = (await readFile(join(adbRoot, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.ok(calls.some(call => call.length === 3 && call.join(' ') === '-s one shell'))
    assert.ok(calls.some(call => call[2] === 'exec-out' && call[3].startsWith("cat -- '/sdcard/fallback.bin' && printf '%s' 'COPORT_ADB_")))
    assert.ok(calls.some(call => call[2] === 'pull' && call[3] === '/sdcard/fallback.bin'))
    assert.ok(calls.some(call => call[2] === 'push' && call[4].startsWith('/sdcard/.coport-upload-')))
    for (const command of [
        "mkdir -- '/sdcard/directory'",
        "rmdir -- '/sdcard/directory'",
        "readlink -- '/sdcard/linked'",
    ]) {
        assert.ok(calls.some(call => call[0] === '-s' && call[1] === 'one' && call[2] === 'shell' &&
            call[3]?.startsWith(command + " && printf")), command)
    }
    assert.ok(calls.some(call => call[2] === 'shell' && call[3]?.includes('recent-device') && call[1] === 'one'))
    const servers = (await readFile(join(adbRoot, 'adb-server.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.ok(servers.every(([, , flags]) => JSON.stringify(flags) === JSON.stringify(['-L', 'tcp:localhost:5041'])), servers)
    assert.ok(servers.some(([, action, , variable]) => action === 'devices' && variable === 'tcp:localhost:5999'))
    assert.ok(servers.some(([, action, , variable]) => action === 'shell' && variable === 'tcp:localhost:5041'))
    assert.equal(await evalJs("document.querySelectorAll('terminaltab,ssh-tab,serial-tab,coport-adb-tab').length"), 4)
    assert.deepEqual(await tool('write_serial', { data: 'M3-AI-STILL-BOUND\r' }), { bytes_queued: 18 })
    const again = await tool('open_serial', { path: device })
    assert.equal(again.session_id, serial.session_id)
    assert.equal(await evalJs(`(async () => {
        const panel = cpComponent('coport-adb-tab sftp-panel')
        const transfer = await panel.platform.startDownload('target', 0o600, 100,
            ${JSON.stringify(destination)}, true)
        void panel.sftp.download('/sdcard/slow-download.bin', transfer).catch(() => null)
        return true
    })()`), true)
    await waitFor(async () => (await readdir(run)).some(name => name.startsWith('.coport-download-')))
    await evalJs('setTimeout(() => require("@electron/remote").getCurrentWindow().destroy(), 30); true')
    await waitFor(async () => !(await readdir(run)).some(name => name.startsWith('.coport-download-')))
    assert.equal(await readFile(destination, 'utf8'), 'android fixture\n')
    console.log(JSON.stringify({ adbPTY: true, sshPTY: true, localPTY: true, serialGeneration: serial.session_id,
        sameWindow: true, adbPanel, sshPanel, recentADB: 'one', advanced, atomicDownloadOnWindowClose: true, argv: calls }))
} catch (error) {
    console.error(childrenLogs.slice(-25).join(''))
    if (target) {
        console.error(await evaluate(target, `({
            text: document.body.innerText,
            errors: window.cpErrors,
            plugins: window.pluginModules?.map(plugin => plugin.name),
            safeMode: String(window.safeModeReason ?? ''),
        })`).catch(() => 'Renderer unavailable'))
    }
    throw error
} finally {
    await mcp?.close().catch(() => null)
    await stop(app)
    await stop(sshd)
    await rm(run, { recursive: true, force: true })
}
