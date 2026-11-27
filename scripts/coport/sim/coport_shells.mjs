import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
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

async function prepareNavigationFixtures () {
    const embeddedRoot = join(adbRoot, 'devices', 'embedded')
    await mkdir(join(embeddedRoot, 'data', 'app', 'g_comp', 'nested'), { recursive: true })
    await mkdir(join(embeddedRoot, 'data', 'filter-actions', 'a-dir'), { recursive: true })
    await mkdir(join(embeddedRoot, 'data', 'only-on-embedded', 'deep'), { recursive: true })
    await mkdir(join(embeddedRoot, 'etc'), { recursive: true })
    await mkdir(join(embeddedRoot, 'bulk'), { recursive: true })
    await writeFile(join(embeddedRoot, 'data', 'app', 'g_comp', 'nested', 'leaf.txt'), 'nested leaf\n')
    await writeFile(join(embeddedRoot, 'data', 'app', 'good_config.txt'), 'good config\n')
    await writeFile(join(embeddedRoot, 'data', 'app', 'alpha.txt'), 'alpha\n')
    await writeFile(join(embeddedRoot, 'data', 'filter-actions', 'a-first.txt'), 'first\n')
    await writeFile(join(embeddedRoot, 'data', 'filter-actions', 'm-middle.txt'), 'middle\n')
    await writeFile(join(embeddedRoot, 'data', 'filter-actions', 'z-target.txt'), 'z-target-content\n')
    await symlink('../app', join(embeddedRoot, 'data', 'filter-actions', 'sym-dir'))
    await symlink('../../etc', join(embeddedRoot, 'data', 'filter-actions', 'sym-dir-2'))
    await writeFile(join(embeddedRoot, 'data', 'only-on-embedded', 'deep', 'note.txt'), 'deep\n')
    await writeFile(join(embeddedRoot, 'etc', 'hosts'), '127.0.0.1 localhost\n')
    await Promise.all(Array.from({ length: 1000 }, (_, i) => {
        const name = i % 5 === 0
            ? `g_comp_item_${String(i).padStart(4, '0')}.txt`
            : `entry_item_${String(i).padStart(4, '0')}.log`
        return writeFile(join(embeddedRoot, 'bulk', name), '')
    }))

    const twoRoot = join(adbRoot, 'devices', 'two')
    await mkdir(join(twoRoot, 'data'), { recursive: true })
    await mkdir(join(twoRoot, 'etc'), { recursive: true })
    await writeFile(join(twoRoot, 'data', 'two-marker.txt'), 'two\n')
    await writeFile(join(twoRoot, 'etc', 'hosts'), '127.0.0.1 two\n')

    await mkdir(join(sshRoot, 'sub-a'), { recursive: true })
    await mkdir(join(sshRoot, 'sub-b'), { recursive: true })
    await mkdir(join(sshRoot, 'cwd-dir'), { recursive: true })
    await mkdir(join(sshRoot, 'trail '), { recursive: true })
    await mkdir(join(sshRoot, 'real-parent', 'real-child'), { recursive: true })
    await mkdir(join(sshRoot, 'link-parent'), { recursive: true })
    await mkdir(join(sshRoot, 'retarget-parent-a', 'child'), { recursive: true })
    await mkdir(join(sshRoot, 'retarget-parent-b', 'child'), { recursive: true })
    await mkdir(join(sshRoot, 'readable', 'no-perm'), { recursive: true })
    await writeFile(join(sshRoot, 'sub-a', 'a.txt'), 'sub-a\n')
    await writeFile(join(sshRoot, 'sub-b', 'b.txt'), 'sub-b\n')
    await writeFile(join(sshRoot, 'cwd-dir', 'cwd.txt'), 'cwd\n')
    await writeFile(join(sshRoot, 'trail ', 'space-marker.txt'), 'trail\n')
    await writeFile(join(sshRoot, 'real-parent', 'from-real-parent.txt'), 'real\n')
    await writeFile(join(sshRoot, 'link-parent', 'from-link-parent.txt'), 'link\n')
    await writeFile(join(sshRoot, 'retarget-parent-a', 'only-in-parent-a.txt'), 'parent-a\n')
    await writeFile(join(sshRoot, 'retarget-parent-b', 'only-in-parent-b.txt'), 'parent-b\n')
    await symlink(join(sshRoot, 'real-parent', 'real-child'), join(sshRoot, 'link-parent', 'to-real-child'))
    await symlink(join(sshRoot, 'retarget-parent-a', 'child'), join(sshRoot, 'retarget-link'))
    await symlink('/Users', join(sshRoot, 'to-root-child'))
    await writeFile(join(sshRoot, 'readable', 'readable-marker.txt'), 'readable\n')
    await chmod(join(sshRoot, 'readable', 'no-perm'), 0o000)
}

async function launchApp (env, childrenLogs) {
    await rm(join(run, 'DevToolsActivePort'), { force: true })
    const proc = spawn(join(bundle, 'Contents/MacOS/Coport'), [`--user-data-dir=${run}`, '--remote-debugging-port=0'], { env })
    for (const stream of [proc.stdout, proc.stderr]) stream.on('data', data => childrenLogs.push(data.toString()))
    const debugPort = await waitFor(async () => Number((await readFile(join(run, 'DevToolsActivePort'), 'utf8')).split('\n')[0]))
    const page = await waitFor(async () => {
        const candidate = await renderer(debugPort)
        return candidate && await evaluate(candidate, "require('electron').ipcRenderer.listenerCount('cli') > 0") && candidate
    })
    await evaluate(page, `(() => {
        window.cpErrors = []
        for (const level of ['error', 'warn']) {
            const original = console[level]
            console[level] = (...args) => {
                cpErrors.push(args.map(String).join(' '))
                original.apply(console, args)
            }
        }
        // Angular 15's production renderer does not publish window.ng.
        window.cpComponentEl = element => {
            if (!element) return null
            const context = require('@angular/core').ɵgetLContext(element)
            if (!context?.lView) return null
            const { lView, nodeIndex } = context
            const node = lView[1]?.data?.[nodeIndex]
            return node ? lView[node.directiveStart + node.componentOffset] : null
        }
        window.cpComponent = selector => window.cpComponentEl(document.querySelector(selector))
        window.cpAdbTabEl = serial => [...document.querySelectorAll('coport-adb-tab')]
            .find(el => window.cpComponentEl(el)?.serial === serial) ?? null
        window.cpSshTabEl = host => [...document.querySelectorAll('ssh-tab')]
            .find(el => window.cpComponentEl(el)?.profile?.options?.host === host) ?? null
        window.cpPanelForEl = tabEl => {
            const panelEl = tabEl?.querySelector('sftp-panel')
            return panelEl ? window.cpComponentEl(panelEl) : null
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
    return { proc, page }
}

const childrenLogs = []
let sshd, app, mcp, target
try {
    await mkdir(sshRoot)
    await writeFile(join(sshRoot, 'seed.txt'), 'ssh fixture\n')
    await symlink('seed.txt', join(sshRoot, 'linked'))
    const adb = execFileSync('python3', ['-B', 'scripts/coport/sim/prepare_adb.py', '--prepare', adbRoot], { encoding: 'utf8' }).trim()
    await prepareNavigationFixtures()
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
    const hostDigest = createHash('sha256').update(Buffer.from(hostKey, 'base64')).digest('base64')
    const home = userInfo().username
    const title = {
        local: 'M3 local',
        ssh: 'M3 SSH',
        ssh2: 'Nav SSH 2',
        serial: 'M3 serial',
        adb: 'M3 ADB',
        adbEmbedded: 'Nav ADB Embedded',
        adbTwo: 'Nav ADB Two',
    }
    await writeFile(join(run, 'config.yaml'), JSON.stringify({
        enableAnalytics: false,
        enableAutomaticUpdates: false,
        recoverTabs: false,
        hacks: { disableGPU: true },
        terminal: { environment: { ZDOTDIR: run, HISTFILE: '/dev/null', ADB_SERVER_SOCKET: 'tcp:localhost:5041' } },
        ssh: { knownHosts: [
            { host: '127.0.0.1', port, type, digest: hostDigest },
            { host: 'localhost', port, type, digest: hostDigest },
        ] },
        profiles: [
            { name: title.local, type: 'local', options: { command: '/bin/sh', args: ['-i'], cwd: run } },
            { name: title.ssh, type: 'ssh', options: {
                host: '127.0.0.1', port, user: home, auth: 'publicKey', privateKeys: [join(run, 'client')], cwd: sshRoot,
            } },
            { name: title.ssh2, type: 'ssh', options: {
                host: 'localhost', port, user: home, auth: 'publicKey', privateKeys: [join(run, 'client')], cwd: sshRoot,
            } },
            { name: title.serial, type: 'serial', options: { port: device, baudrate: 115200 } },
            { name: title.adb, type: 'coport-adb', options: { serial: null } },
            { name: title.adbEmbedded, type: 'coport-adb', options: { serial: 'embedded' } },
            { name: title.adbTwo, type: 'coport-adb', options: { serial: 'two' } },
        ],
    }))
    const env = { ...process.env, ADB_SERVER_SOCKET: 'tcp:localhost:5999',
        COPORT_TEST_ADB: adb, COPORT_TEST_SOCKET: endpoint, TABBY_PLUGINS: '' }
    for (const key of ['ELECTRON_RUN_AS_NODE', 'TABBY_DEV', 'COPORT_TEST_AUTOSTART_APP']) delete env[key]

    // Phase 1: Navigation, no-/sdcard boot, filter, keyboard drill-down, favorites, SSH host isolation & CWD priority
    await writeFile(join(adbRoot, 'state.json'), JSON.stringify({
        devices: [['embedded', 'device'], ['two', 'device'], ['one', 'device']],
    }))
    ;({ proc: app, page: target } = await launchApp(env, childrenLogs))
    let evalJs = (expression, timeout) => evaluate(target, expression, timeout)
    const open = name => evalJs(`require('electron').ipcRenderer.emit('cli', null,
        { _: ['profile'], profileName: ${JSON.stringify(name)} }, '/', false)`)

    await open(title.adbEmbedded)
    await waitFor(() => evalJs("!!cpAdbTabEl('embedded')"))
    assert.equal(await evalJs(`(() => {
        const btn = [...cpAdbTabEl('embedded').querySelectorAll('terminal-toolbar button')]
            .find(item => item.textContent.trim() === 'Files')
        btn?.click()
        return Boolean(btn)
    })()`), true)
    await waitFor(() => evalJs("Array.isArray(cpPanelForEl(cpAdbTabEl('embedded'))?.fileList)"))

    const noSdcardBoot = await evalJs(`(() => {
        const panel = cpPanelForEl(cpAdbTabEl('embedded'))
        return {
            path: panel.path,
            names: panel.fileList.map(e => e.name),
            loadError: panel.loadError,
        }
    })()`)
    assert.equal(noSdcardBoot.path, '/')
    assert.equal(noSdcardBoot.loadError, null)
    assert.ok(noSdcardBoot.names.includes('data') && !noSdcardBoot.names.includes('sdcard'), noSdcardBoot)

    const initialCalls = (await readFile(join(adbRoot, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(
        initialCalls.some(call => call[0] === '-s' && call[1] === 'embedded' && call[2] === 'ls' && call[3] === '/sdcard'),
        false,
        'embedded device must never attempt /sdcard on initial open',
    )

    // Type-to-filter via real panel focus -> real focused <input>, highlights, keyboard drill-down, zero remote calls, Backspace/Esc, no-match Go up
    const filterAndKeyboard = await evalJs(`(async () => {
        const tabEl = cpAdbTabEl('embedded')
        const panelEl = tabEl.querySelector('sftp-panel')
        const panel = cpPanelForEl(tabEl)
        await panel.navigate('/data/app')
        panel.cdr.detectChanges()
        let readdirCalls = 0
        const origReaddir = panel.sftp.readdir.bind(panel.sftp)
        panel.sftp.readdir = async (...args) => {
            readdirCalls++
            return origReaddir(...args)
        }
        const typeSequence = text => {
            for (let idx = 0; idx < text.length; idx++) {
                const ch = text[idx]
                const active = document.activeElement || panelEl
                const ev = new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true })
                active.dispatchEvent(ev)
                if (active.tagName === 'INPUT' && !ev.defaultPrevented) {
                    active.value += ch
                    active.dispatchEvent(new Event('input', { bubbles: true }))
                }
                panel.cdr.detectChanges()
            }
        }
        try {
            const filterVisibleBefore = Boolean(panelEl.querySelector('[data-testid="filter-bar"]'))
            panelEl.focus()
            // First key on panel must open filter and focus <input data-testid="filter-input">
            panelEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true, cancelable: true }))
            panel.cdr.detectChanges()
            const filterInput = panelEl.querySelector('[data-testid="filter-input"]')
            const activeIsFilterInputAfterFirstKey = Boolean(filterInput && document.activeElement === filterInput)
            // Subsequent chars go through the actually focused <input>
            typeSequence('_c')
            const callsAfterType = readdirCalls
            const filterVisibleAfter = Boolean(panelEl.querySelector('[data-testid="filter-bar"]'))
            const filterTextAfterType = panel.filterText
            const domFilteredNames = [...panelEl.querySelectorAll('.list-group-item.file-row')].map(el => el.getAttribute('data-name'))
            const marks = [...panelEl.querySelectorAll('mark.filter-match')].map(el => el.textContent)

            document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
            const indexAfterDown = panel.selectedIndex
            const selectedDownClass = panelEl.querySelector('.list-group-item[data-index="1"]')?.classList.contains('selected') ?? false

            document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
            const indexAfterUp = panel.selectedIndex

            document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
            const deadline1 = Date.now() + 5000
            while (panel.path !== '/data/app/g_comp' && Date.now() < deadline1) {
                await new Promise(r => setTimeout(r, 30))
            }
            const afterEnterPath = panel.path
            const afterEnterFilterCleared = !panel.showFilter && panel.filterText === ''
            const focusedAfterEnter = document.activeElement === panelEl || panelEl.contains(document.activeElement)

            // Continuous keyboard drill-down without clicking
            typeSequence('nes')
            const activeDuringSecondFilter = document.activeElement === panelEl.querySelector('[data-testid="filter-input"]')
            document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
            const deadline2 = Date.now() + 5000
            while (panel.path !== '/data/app/g_comp/nested' && Date.now() < deadline2) {
                await new Promise(r => setTimeout(r, 30))
            }
            const drillPath = panel.path

            // Repeated Backspace with empty filter must NOT go up
            document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', repeat: true, bubbles: true, cancelable: true }))
            await new Promise(r => setTimeout(r, 120))
            const pathAfterRepeatBackspace = panel.path

            // Single non-repeat Backspace goes up
            document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', repeat: false, bubbles: true, cancelable: true }))
            const deadline3 = Date.now() + 5000
            while (panel.path !== '/data/app/g_comp' && Date.now() < deadline3) {
                await new Promise(r => setTimeout(r, 30))
            }
            const pathAfterBackspace = panel.path

            // No-match state retains Go up, Escape clears filter without closing panel
            typeSequence('zzz')
            const noMatchShown = Boolean(panelEl.querySelector('[data-testid="no-match-alert"]'))
            const goUpKeptOnNoMatch = Boolean(panelEl.querySelector('[data-testid="go-up-item"]'))

            document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
            panel.cdr.detectChanges()
            const afterEscFilterHidden = !panel.showFilter && panel.filterText === ''
            const panelStillOpenAfterEsc = Boolean(tabEl.querySelector('sftp-panel'))

            return {
                filterVisibleBefore,
                filterVisibleAfter,
                activeIsFilterInputAfterFirstKey,
                activeDuringSecondFilter,
                callsAfterType,
                filterTextAfterType,
                domFilteredNames,
                marks,
                indexAfterDown,
                selectedDownClass,
                indexAfterUp,
                afterEnterPath,
                afterEnterFilterCleared,
                focusedAfterEnter,
                drillPath,
                pathAfterRepeatBackspace,
                pathAfterBackspace,
                noMatchShown,
                goUpKeptOnNoMatch,
                afterEscFilterHidden,
                panelStillOpenAfterEsc,
            }
        } finally {
            panel.sftp.readdir = origReaddir
        }
    })()`, 15000)

    assert.equal(filterAndKeyboard.filterVisibleBefore, false)
    assert.equal(filterAndKeyboard.filterVisibleAfter, true)
    assert.equal(filterAndKeyboard.activeIsFilterInputAfterFirstKey, true)
    assert.equal(filterAndKeyboard.activeDuringSecondFilter, true)
    assert.equal(filterAndKeyboard.callsAfterType, 0)
    assert.equal(filterAndKeyboard.filterTextAfterType, 'g_c')
    assert.deepEqual(filterAndKeyboard.domFilteredNames, ['g_comp', 'good_config.txt'])
    assert.ok(filterAndKeyboard.marks.includes('g_c') && filterAndKeyboard.marks.includes('_c'), filterAndKeyboard.marks)
    assert.equal(filterAndKeyboard.indexAfterDown, 1)
    assert.equal(filterAndKeyboard.selectedDownClass, true)
    assert.equal(filterAndKeyboard.indexAfterUp, 0)
    assert.equal(filterAndKeyboard.afterEnterPath, '/data/app/g_comp')
    assert.equal(filterAndKeyboard.afterEnterFilterCleared, true)
    assert.equal(filterAndKeyboard.focusedAfterEnter, true)
    assert.equal(filterAndKeyboard.drillPath, '/data/app/g_comp/nested')
    assert.equal(filterAndKeyboard.pathAfterRepeatBackspace, '/data/app/g_comp/nested')
    assert.equal(filterAndKeyboard.pathAfterBackspace, '/data/app/g_comp')
    assert.equal(filterAndKeyboard.noMatchShown, true)
    assert.equal(filterAndKeyboard.goUpKeptOnNoMatch, true)
    assert.equal(filterAndKeyboard.afterEscFilterHidden, true)
    assert.equal(filterAndKeyboard.panelStillOpenAfterEsc, true)

    // Filtered-state real DOM click, real contextmenu, and keyboard Enter download targeting actual filtered item
    const filteredActions = await evalJs(`(async () => {
        const tabEl = cpAdbTabEl('embedded')
        const panelEl = tabEl.querySelector('sftp-panel')
        const panel = cpPanelForEl(tabEl)
        await panel.navigate('/data/filter-actions')
        panel.cdr.detectChanges()
        const rawIndex = panel.fileList.findIndex(e => e.name === 'z-target.txt')

        const downloads = []
        const origStartDownload = panel.platform.startDownload
        const origPopup = panel.platform.popupContextMenu
        const origBackendDownload = panel.sftp.download.bind(panel.sftp)
        let capturedMenu = null
        panel.platform.startDownload = async (name) => {
            const chunks = []
            return {
                name,
                chunks,
                isCancelled: () => false,
                setStatus () {},
                cancel () {},
                close () {},
                write: async bytes => { chunks.push(Buffer.from(bytes)) },
                completeDownload: async () => {},
            }
        }
        panel.sftp.download = async (remotePath, transfer) => {
            await origBackendDownload(remotePath, transfer)
            downloads.push({
                remotePath,
                content: Buffer.concat(transfer.chunks).toString('utf8'),
            })
        }
        panel.platform.popupContextMenu = (items) => {
            capturedMenu = items
        }

        try {
            panelEl.focus()
            panelEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true, cancelable: true }))
            panel.cdr.detectChanges()
            const filterInput = panelEl.querySelector('[data-testid="filter-input"]')
            filterInput.value = 'z-tar'
            filterInput.dispatchEvent(new Event('input', { bubbles: true }))
            panel.cdr.detectChanges()

            const row0 = panelEl.querySelector('.list-group-item.file-row[data-index="0"]')
            const row0Name = row0?.getAttribute('data-name')

            // 1. Click row 0
            row0.click()
            const d1 = Date.now() + 5000
            while (downloads.length < 1 && Date.now() < d1) await new Promise(r => setTimeout(r, 30))

            // 2. Real contextmenu event on row 0 -> invoke Download item
            row0.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
            const d2 = Date.now() + 5000
            while (!capturedMenu && Date.now() < d2) await new Promise(r => setTimeout(r, 30))
            const downloadItem = capturedMenu.find(item => item.label === 'Download')
            await downloadItem.click()
            const d3 = Date.now() + 5000
            while (downloads.length < 2 && Date.now() < d3) await new Promise(r => setTimeout(r, 30))

            // 3. Keyboard Enter on focused filter input -> downloads file, clears filter, keeps panel focus
            filterInput.focus()
            document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
            const d4 = Date.now() + 5000
            while (downloads.length < 3 && Date.now() < d4) await new Promise(r => setTimeout(r, 30))
            panel.cdr.detectChanges()
            const filterTextAfterEnterDownload = panel.filterText
            const showFilterAfterEnterDownload = panel.showFilter
            const focusedAfterEnterDownload = document.activeElement === panelEl || panelEl.contains(document.activeElement)

            // 4. Re-filter and trigger real contextmenu event on filtered row 0 -> invoke Delete item and verify actual target deleted
            panelEl.focus()
            panelEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true, cancelable: true }))
            panel.cdr.detectChanges()
            const refilterInput = panelEl.querySelector('[data-testid="filter-input"]')
            refilterInput.value = 'z-tar'
            refilterInput.dispatchEvent(new Event('input', { bubbles: true }))
            panel.cdr.detectChanges()
            const refilteredRow0 = panelEl.querySelector('.list-group-item.file-row[data-index="0"]')
            const origShowMessageBox = panel.platform.showMessageBox
            panel.platform.showMessageBox = async () => ({ response: 0 })
            let remainingAfterDelete = []
            try {
                capturedMenu = null
                refilteredRow0.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
                const d5 = Date.now() + 5000
                while (!capturedMenu && Date.now() < d5) await new Promise(r => setTimeout(r, 30))
                const deleteItem = capturedMenu.find(item => item.label === 'Delete')
                await deleteItem.click()
                const d6 = Date.now() + 5000
                while (panel.fileList.some(e => e.name === 'z-target.txt') && Date.now() < d6) {
                    await new Promise(r => setTimeout(r, 30))
                }
                remainingAfterDelete = panel.fileList.map(e => e.name)
            } finally {
                panel.platform.showMessageBox = origShowMessageBox
            }

            panel.clearFilter(true)
            return {
                rawIndex,
                row0Name,
                downloads,
                filterTextAfterEnterDownload,
                showFilterAfterEnterDownload,
                focusedAfterEnterDownload,
                remainingAfterDelete,
            }
        } finally {
            panel.platform.startDownload = origStartDownload
            panel.platform.popupContextMenu = origPopup
            panel.sftp.download = origBackendDownload
        }
    })()`, 15000)
    assert.equal(filteredActions.rawIndex, 5)
    assert.equal(filteredActions.row0Name, 'z-target.txt')
    assert.deepEqual(filteredActions.downloads, [
        { remotePath: '/data/filter-actions/z-target.txt', content: 'z-target-content\n' },
        { remotePath: '/data/filter-actions/z-target.txt', content: 'z-target-content\n' },
        { remotePath: '/data/filter-actions/z-target.txt', content: 'z-target-content\n' },
    ])
    assert.equal(filteredActions.filterTextAfterEnterDownload, '')
    assert.equal(filteredActions.showFilterAfterEnterDownload, false)
    assert.equal(filteredActions.focusedAfterEnterDownload, true)
    assert.equal(filteredActions.remainingAfterDelete.includes('z-target.txt'), false)
    assert.equal(filteredActions.remainingAfterDelete.includes('a-first.txt'), true)
    assert.equal(filteredActions.remainingAfterDelete.includes('m-middle.txt'), true)

    // Stale async operations: slow symlink stat(), back-to-back two symlinks (both orderings), slow openSFTP(), slow mkdir(), slow uploadOne(), and terminal focus preservation during slow ADB load
    const staleOps = await evalJs(`(async () => {
        const tabEl = cpAdbTabEl('embedded')
        const panel = cpPanelForEl(tabEl)
        await panel.navigate('/data/filter-actions')
        const symItem = panel.fileList.find(e => e.name === 'sym-dir')
        const symItem2 = panel.fileList.find(e => e.name === 'sym-dir-2')
        const origStat = panel.sftp.stat.bind(panel.sftp)
        const origMkdir = panel.sftp.mkdir.bind(panel.sftp)
        const origUpload = panel.sftp.upload.bind(panel.sftp)
        const origReaddir = panel.sftp.readdir.bind(panel.sftp)
        const origModalOpen = panel.ngbModal.open.bind(panel.ngbModal)
        const origOpenSFTP = panel.session.openSFTP.bind(panel.session)
        let releaseStat
        let releaseMkdir
        let releaseUpload
        panel.sftp.stat = async (p) => {
            await new Promise(resolve => { releaseStat = resolve })
            return origStat(p)
        }
        try {
            const slowOpen = panel.open(symItem)
            while (!releaseStat) await new Promise(r => setTimeout(r, 10))
            await panel.navigate('/etc')
            const recentAfterNav = [...panel.recentPaths]
            releaseStat()
            await slowOpen
            const pathAfterSlowStat = panel.path
            const recentAfterSlowStat = [...panel.recentPaths]

            // Back-to-back two symlinks: (a) first resolves BEFORE second -> second still wins; (b) second resolves BEFORE first -> second still wins
            const runTwoSymlinks = async (releaseFirstThenSecond) => {
                await panel.navigate('/data/filter-actions')
                const resolvers = new Map()
                panel.sftp.stat = async (p) => {
                    await new Promise(resolve => { resolvers.set(p, resolve) })
                    return origStat(p)
                }
                const p1 = panel.open(symItem)
                const p2 = panel.open(symItem2)
                while (!resolvers.has(symItem.fullPath) || !resolvers.has(symItem2.fullPath)) {
                    await new Promise(r => setTimeout(r, 10))
                }
                if (releaseFirstThenSecond) {
                    resolvers.get(symItem.fullPath)()
                    await p1
                    resolvers.get(symItem2.fullPath)()
                    await p2
                } else {
                    resolvers.get(symItem2.fullPath)()
                    await p2
                    resolvers.get(symItem.fullPath)()
                    await p1
                }
                return panel.path
            }
            const twoSymFirstResolvesFirst = await runTwoSymlinks(true)
            const twoSymSecondResolvesFirst = await runTwoSymlinks(false)
            panel.sftp.stat = origStat

            // Slow openSFTP('/data/app') superseded by fast navigate('/etc') -> final path is '/etc' and '/data/app' is NOT written as latest
            let releaseSlowOpenSFTP
            let openCalls = 0
            panel.session.openSFTP = async (...args) => {
                const callNum = ++openCalls
                if (callNum === 1) {
                    await new Promise(resolve => { releaseSlowOpenSFTP = resolve })
                }
                return origOpenSFTP(...args)
            }
            panel.detachBackend()
            const slowOpenNav = panel.navigate('/data/app')
            while (!releaseSlowOpenSFTP) await new Promise(r => setTimeout(r, 10))
            await panel.navigate('/etc')
            const recentAfterFastOpen = [...panel.recentPaths]
            releaseSlowOpenSFTP()
            await slowOpenNav
            const pathAfterSlowOpenSFTP = panel.path
            const recentUnchangedAfterSlowOpenSFTP = JSON.stringify(recentAfterFastOpen) === JSON.stringify(panel.recentPaths)
            panel.session.openSFTP = origOpenSFTP

            // Slow openCreateDirectoryModal() -> mkdir completes AFTER user navigated elsewhere -> must NOT jump to created dir
            await panel.navigate('/data/filter-actions')
            panel.ngbModal.open = () => ({ result: Promise.resolve('stale-created-dir') })
            panel.sftp.mkdir = async (p) => {
                await new Promise(resolve => { releaseMkdir = resolve })
                return origMkdir(p)
            }
            await panel.openCreateDirectoryModal()
            while (!releaseMkdir) await new Promise(r => setTimeout(r, 10))
            await panel.navigate('/etc')
            releaseMkdir()
            await new Promise(r => setTimeout(r, 80))
            const pathAfterSlowMkdir = panel.path

            // Slow uploadOne(): navigate away and back so this.path === target while request !== navigation
            await panel.navigate('/data/app')
            panel.sftp.upload = async () => {
                await new Promise(resolve => { releaseUpload = resolve })
            }
            let readdirCallsAfterUploadResolve = 0
            panel.sftp.readdir = async (...args) => {
                readdirCallsAfterUploadResolve++
                return origReaddir(...args)
            }
            const dummyUpload = { getName: () => 'late.txt' }
            const slowUpload = panel.uploadOne(dummyUpload, '/data/app')
            while (!releaseUpload) await new Promise(r => setTimeout(r, 10))
            await panel.navigate('/etc')
            await panel.navigate('/data/app')
            readdirCallsAfterUploadResolve = 0
            releaseUpload()
            await slowUpload

            // Slow ADB directory load must NOT steal focus after user focuses ADB terminal
            let releaseFocusLoad
            panel.sftp.readdir = async (...args) => {
                await new Promise(resolve => { releaseFocusLoad = resolve })
                return origReaddir(...args)
            }
            const termTextarea = tabEl.querySelector('.xterm-helper-textarea')
            const slowFocusNav = panel.navigate('/etc')
            while (!releaseFocusLoad) await new Promise(r => setTimeout(r, 10))
            termTextarea.focus()
            const focusedTermBeforeLoad = document.activeElement === termTextarea
            releaseFocusLoad()
            await slowFocusNav
            const focusedTermAfterLoad = document.activeElement === termTextarea

            return {
                pathAfterSlowStat,
                recentUnchangedAfterStat: JSON.stringify(recentAfterNav) === JSON.stringify(recentAfterSlowStat),
                twoSymFirstResolvesFirst,
                twoSymSecondResolvesFirst,
                pathAfterSlowOpenSFTP,
                recentUnchangedAfterSlowOpenSFTP,
                pathAfterSlowMkdir,
                readdirCallsAfterUploadResolve,
                focusedTermBeforeLoad,
                focusedTermAfterLoad,
                finalPath: panel.path,
            }
        } finally {
            panel.sftp.stat = origStat
            panel.sftp.mkdir = origMkdir
            panel.sftp.upload = origUpload
            panel.sftp.readdir = origReaddir
            panel.ngbModal.open = origModalOpen
            panel.session.openSFTP = origOpenSFTP
        }
    })()`, 20000)
    assert.deepEqual(staleOps, {
        pathAfterSlowStat: '/etc',
        recentUnchangedAfterStat: true,
        twoSymFirstResolvesFirst: '/data/filter-actions/sym-dir-2',
        twoSymSecondResolvesFirst: '/data/filter-actions/sym-dir-2',
        pathAfterSlowOpenSFTP: '/etc',
        recentUnchangedAfterSlowOpenSFTP: true,
        pathAfterSlowMkdir: '/etc',
        readdirCallsAfterUploadResolve: 0,
        focusedTermBeforeLoad: true,
        focusedTermAfterLoad: true,
        finalPath: '/etc',
    })

    // 1,000-entry directory real DOM filtering benchmark (including first keystroke from closed filter bar) <= 16 ms + ResizeObserver viewport growth
    const bulkBench = await evalJs(`(async () => {
        const tabEl = cpAdbTabEl('embedded')
        const panelEl = tabEl.querySelector('sftp-panel')
        const panel = cpPanelForEl(tabEl)
        await panel.navigate('/bulk')
        panel.cdr.detectChanges()
        const total = panel.fileList.length
        let readdirCalls = 0
        const origReaddir = panel.sftp.readdir.bind(panel.sftp)
        panel.sftp.readdir = async (...args) => {
            readdirCalls++
            return origReaddir(...args)
        }
        try {
            const filterClosedBeforeFirstKey = !panel.showFilter && panel.filterText === ''
            panelEl.focus()
            // Measure FIRST keystroke from closed filter bar (no warm-up!)
            const firstStart = performance.now()
            panelEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true, cancelable: true }))
            panel.cdr.detectChanges()
            const firstKeyMs = performance.now() - firstStart
            const filterInput = panelEl.querySelector('[data-testid="filter-input"]')
            const firstKeyFocusedInput = Boolean(filterInput && document.activeElement === filterInput)
            const firstKeyShown = panel.showFilter && panel.filterText === 'i'
            const firstKeyCount = panelEl.querySelector('[data-testid="filter-count"]')?.textContent?.trim()

            // Continue typing subsequent characters into the focused filter input
            const times = [firstKeyMs]
            for (const ch of ['t', 'e', 'm', '_', '0', '5', '0']) {
                const start = performance.now()
                filterInput.value += ch
                filterInput.dispatchEvent(new Event('input', { bubbles: true }))
                panel.cdr.detectChanges()
                times.push(performance.now() - start)
            }
            const incrementalSnapshot = {
                countText: panelEl.querySelector('[data-testid="filter-count"]')?.textContent?.trim(),
                domRowCount: panelEl.querySelectorAll('.list-group-item.file-row').length,
                firstRowName: panelEl.querySelector('.list-group-item.file-row')?.getAttribute('data-name') ?? null,
            }

            const queries = ['g_c', 'item_050', 'e', 'g_comp_item_0995', 'no_match_xyz']
            const domSnapshots = {}
            for (const q of queries) {
                const start = performance.now()
                filterInput.value = q
                filterInput.dispatchEvent(new Event('input', { bubbles: true }))
                panel.cdr.detectChanges()
                const elapsed = performance.now() - start
                times.push(elapsed)
                const rows = [...panelEl.querySelectorAll('.list-group-item.file-row')]
                domSnapshots[q] = {
                    countText: panelEl.querySelector('[data-testid="filter-count"]')?.textContent?.trim(),
                    domRowCount: rows.length,
                    firstRowName: rows[0]?.getAttribute('data-name') ?? null,
                }
            }
            panel.clearFilter(true)
            panel.cdr.detectChanges()

            // Verify ResizeObserver recomputes virtual visible range when viewport grows taller
            const bodyEl = panel.bodyContainer.nativeElement
            const prevPanelHeight = panelEl.style.height
            const prevBodyHeight = bodyEl.style.height
            const prevBodyMaxHeight = bodyEl.style.maxHeight
            let mountedBeforeResize = 0
            let mountedAfterResize = 0
            try {
                bodyEl.style.height = '320px'
                bodyEl.style.maxHeight = '320px'
                await new Promise(r => setTimeout(r, 80))
                panel.cdr.detectChanges()
                mountedBeforeResize = panelEl.querySelectorAll('.list-group-item.file-row').length

                panelEl.style.height = '2000px'
                bodyEl.style.height = '1800px'
                bodyEl.style.maxHeight = '1800px'
                const resizeDeadline = Date.now() + 2000
                while (panelEl.querySelectorAll('.list-group-item.file-row').length <= mountedBeforeResize && Date.now() < resizeDeadline) {
                    await new Promise(r => setTimeout(r, 30))
                }
                mountedAfterResize = panelEl.querySelectorAll('.list-group-item.file-row').length
            } finally {
                panelEl.style.height = prevPanelHeight
                bodyEl.style.height = prevBodyHeight
                bodyEl.style.maxHeight = prevBodyMaxHeight
            }

            return {
                total,
                readdirCalls,
                filterClosedBeforeFirstKey,
                firstKeyMs,
                firstKeyFocusedInput,
                firstKeyShown,
                firstKeyCount,
                incrementalSnapshot,
                maxMs: Math.max(...times),
                times,
                domSnapshots,
                mountedBeforeResize,
                mountedAfterResize,
            }
        } finally {
            panel.sftp.readdir = origReaddir
        }
    })()`, 15000)
    assert.equal(bulkBench.total, 1000)
    assert.equal(bulkBench.readdirCalls, 0)
    assert.equal(bulkBench.filterClosedBeforeFirstKey, true)
    assert.equal(bulkBench.firstKeyFocusedInput, true)
    assert.equal(bulkBench.firstKeyShown, true)
    assert.equal(bulkBench.firstKeyCount, '1000 / 1000')
    assert.ok(bulkBench.firstKeyMs <= 16, `Expected first key from closed filter <= 16ms, got ${bulkBench.firstKeyMs.toFixed(2)}ms`)
    assert.equal(bulkBench.incrementalSnapshot.countText, '28 / 1000')
    assert.equal(bulkBench.incrementalSnapshot.domRowCount, 28)
    assert.equal(bulkBench.incrementalSnapshot.firstRowName, 'entry_item_0501.log')
    assert.equal(bulkBench.domSnapshots['g_c'].countText, '200 / 1000')
    assert.equal(bulkBench.domSnapshots['g_c'].firstRowName, 'g_comp_item_0000.txt')
    assert.ok(bulkBench.domSnapshots['g_c'].domRowCount > 0 && bulkBench.domSnapshots['g_c'].domRowCount <= 200)
    assert.equal(bulkBench.domSnapshots['item_050'].countText, '28 / 1000')
    assert.equal(bulkBench.domSnapshots['item_050'].domRowCount, 28)
    assert.equal(bulkBench.domSnapshots['item_050'].firstRowName, 'entry_item_0501.log')
    assert.equal(bulkBench.domSnapshots['e'].countText, '1000 / 1000')
    assert.ok(bulkBench.domSnapshots['e'].domRowCount > 0)
    assert.equal(bulkBench.domSnapshots['g_comp_item_0995'].countText, '1 / 1000')
    assert.equal(bulkBench.domSnapshots['g_comp_item_0995'].domRowCount, 1)
    assert.equal(bulkBench.domSnapshots['g_comp_item_0995'].firstRowName, 'g_comp_item_0995.txt')
    assert.equal(bulkBench.domSnapshots['no_match_xyz'].countText, '0 / 1000')
    assert.equal(bulkBench.domSnapshots['no_match_xyz'].domRowCount, 0)
    assert.ok(bulkBench.maxMs <= 16, `Expected 1000-entry real DOM filter <= 16ms, got ${bulkBench.maxMs.toFixed(2)}ms`)
    assert.ok(
        bulkBench.mountedAfterResize > bulkBench.mountedBeforeResize,
        `Expected virtual list to grow mounted rows on viewport height increase (${bulkBench.mountedBeforeResize} -> ${bulkBench.mountedAfterResize})`,
    )

    // Path bar single-click edit, IME composing pass-through, Esc cancel, Enter jump, and manual invalid-dir error preserving list + returning panel focus
    const pathBarAndManualError = await evalJs(`(async () => {
        const tabEl = cpAdbTabEl('embedded')
        const panelEl = tabEl.querySelector('sftp-panel')
        const panel = cpPanelForEl(tabEl)
        await panel.navigate('/data/app')
        panel.cdr.detectChanges()

        panelEl.querySelector('[data-testid="path-edit-spacer"]').click()
        panel.cdr.detectChanges()
        const inputAfterSingleClick = Boolean(panelEl.querySelector('[data-testid="path-input"]'))
        const pathInput1 = panelEl.querySelector('[data-testid="path-input"]')
        pathInput1.value = '/etc'
        pathInput1.dispatchEvent(new Event('input', { bubbles: true }))
        // IME composing Enter & Escape must NOT submit or cancel
        pathInput1.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))
        pathInput1.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }))
        panel.cdr.detectChanges()
        const stayedOpenDuringIme = Boolean(panelEl.querySelector('[data-testid="path-input"]')) && panel.path === '/data/app'

        pathInput1.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        panel.cdr.detectChanges()
        const pathAfterEsc = panel.path
        const inputClosedAfterEsc = !panelEl.querySelector('[data-testid="path-input"]')
        const focusedPanelAfterEsc = document.activeElement === panelEl

        panelEl.querySelector('[data-testid="edit-path-btn"]').click()
        panel.cdr.detectChanges()
        const pathInput2 = panelEl.querySelector('[data-testid="path-input"]')
        pathInput2.value = '/etc'
        pathInput2.dispatchEvent(new Event('input', { bubbles: true }))
        pathInput2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        const deadline = Date.now() + 5000
        while (panel.path !== '/etc' && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 30))
        }
        const pathAfterEnter = panel.path

        // Submit non-existent path through real <input>, verify list preserved, panel regains focus, and direct typing filters immediately
        panelEl.querySelector('[data-testid="edit-path-btn"]').click()
        panel.cdr.detectChanges()
        const pathInput3 = panelEl.querySelector('[data-testid="path-input"]')
        pathInput3.value = '/does-not-exist-manual'
        pathInput3.dispatchEvent(new Event('input', { bubbles: true }))
        pathInput3.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        const errDeadline = Date.now() + 5000
        while (!panelEl.querySelector('[data-testid="error-banner"]') && Date.now() < errDeadline) {
            await new Promise(r => setTimeout(r, 30))
        }
        panel.cdr.detectChanges()
        const focusedAfterInvalidManual = document.activeElement === panelEl
        // Type directly to activeElement without calling focus()
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true }))
        panel.cdr.detectChanges()
        const typedFilterAfterError = panel.showFilter && panel.filterText === 'h' &&
            [...panelEl.querySelectorAll('.list-group-item.file-row')].some(el => el.getAttribute('data-name') === 'hosts')
        panel.clearFilter(true)

        return {
            inputAfterSingleClick,
            stayedOpenDuringIme,
            pathAfterEsc,
            inputClosedAfterEsc,
            focusedPanelAfterEsc,
            pathAfterEnter,
            pathAfterInvalidManual: panel.path,
            keptHostsFile: panel.fileList.some(e => e.name === 'hosts'),
            errorBannerVisible: Boolean(panelEl.querySelector('[data-testid="error-banner"]')),
            invalidInRecent: panel.recentPaths.includes('/does-not-exist-manual'),
            focusedAfterInvalidManual,
            typedFilterAfterError,
        }
    })()`, 15000)
    assert.deepEqual(pathBarAndManualError, {
        inputAfterSingleClick: true,
        stayedOpenDuringIme: true,
        pathAfterEsc: '/data/app',
        inputClosedAfterEsc: true,
        focusedPanelAfterEsc: true,
        pathAfterEnter: '/etc',
        pathAfterInvalidManual: '/etc',
        keptHostsFile: true,
        errorBannerVisible: true,
        invalidInRecent: false,
        focusedAfterInvalidManual: true,
        typedFilterAfterError: true,
    })

    // Favorites star, compact bar, Places dropdown (Favorites above Recent), jump & remove
    const favoritesFlow = await evalJs(`(async () => {
        const tabEl = cpAdbTabEl('embedded')
        const panelEl = tabEl.querySelector('sftp-panel')
        const panel = cpPanelForEl(tabEl)
        await panel.navigate('/etc')
        panel.cdr.detectChanges()

        panelEl.querySelector('[data-testid="favorite-toggle"]').click()
        panel.cdr.detectChanges()
        const etcStarred = panel.isCurrentPathFavorite
        const chipHasEtc = Boolean(panelEl.querySelector('[data-testid="favorite-chip"][data-path="/etc"]'))

        await panel.navigate('/data/app')
        panel.cdr.detectChanges()
        const appStarredBefore = panel.isCurrentPathFavorite
        panelEl.querySelector('[data-testid="favorite-toggle"]').click()
        panel.cdr.detectChanges()
        const appStarredAfter = panel.isCurrentPathFavorite

        panelEl.querySelector('[data-testid="places-toggle"]').click()
        panel.cdr.detectChanges()
        const favSection = panelEl.querySelector('[data-testid="places-favorites"]')
        const recentSection = panelEl.querySelector('[data-testid="places-recent"]')
        const favoritesAboveRecent = Boolean(favSection && recentSection &&
            favSection.getBoundingClientRect().top < recentSection.getBoundingClientRect().top &&
            Boolean(favSection.compareDocumentPosition(recentSection) & Node.DOCUMENT_POSITION_FOLLOWING))

        panelEl.querySelector('[data-testid="places-favorite-item"][data-path="/etc"]').click()
        const deadline1 = Date.now() + 5000
        while (panel.path !== '/etc' && Date.now() < deadline1) {
            await new Promise(r => setTimeout(r, 30))
        }
        const jumpedFromDropdown = panel.path

        panelEl.querySelector('[data-testid="favorite-chip"][data-path="/data/app"]').click()
        const deadline2 = Date.now() + 5000
        while (panel.path !== '/data/app' && Date.now() < deadline2) {
            await new Promise(r => setTimeout(r, 30))
        }
        const jumpedFromChip = panel.path

        panelEl.querySelector('[data-testid="favorite-chip"][data-path="/data/app"] [data-testid="favorite-chip-remove"]').click()
        panel.cdr.detectChanges()
        const appStarredAfterRemove = panel.isCurrentPathFavorite
        const appStillInRecent = panel.recentPaths.includes('/data/app')

        // Navigate to path that only exists on 'embedded' so restart + device 'two' tests both restore and fallback
        await panel.navigate('/data/only-on-embedded/deep')
        return {
            etcStarred,
            chipHasEtc,
            appStarredBefore,
            appStarredAfter,
            favoritesAboveRecent,
            jumpedFromDropdown,
            jumpedFromChip,
            appStarredAfterRemove,
            appStillInRecent,
            finalPath: panel.path,
            finalFavorites: [...panel.favorites],
        }
    })()`, 15000)
    assert.deepEqual(favoritesFlow, {
        etcStarred: true,
        chipHasEtc: true,
        appStarredBefore: false,
        appStarredAfter: true,
        favoritesAboveRecent: true,
        jumpedFromDropdown: '/etc',
        jumpedFromChip: '/data/app',
        appStarredAfterRemove: false,
        appStillInRecent: true,
        finalPath: '/data/only-on-embedded/deep',
        finalFavorites: ['/etc'],
    })

    // SSH host/user isolation, first-open CWD vs savedLastPath priority, trailing spaces, symlink/.., SFTP channel close Retry, real sshd fallback
    const keepDownloadFile = join(run, 'keep-existing-download.txt')
    await writeFile(keepDownloadFile, 'MUST-NOT-BE-TRUNCATED\n')
    await open(title.ssh)
    await waitFor(() => evalJs("cpComponentEl(cpSshTabEl('127.0.0.1'))?.session?.open"))
    await open(title.ssh2)
    await waitFor(() => evalJs("cpComponentEl(cpSshTabEl('localhost'))?.session?.open"))

    const sshIsolationPhase1 = await evalJs(`(async () => {
        const closeSftpFor = async host => {
            const tabEl = cpSshTabEl(host)
            const closeBtn = tabEl.querySelector('sftp-panel .header > button:last-child')
            if (closeBtn) {
                closeBtn.click()
            } else {
                const tab = cpComponentEl(tabEl)
                tab.sftpPanelVisible = false
            }
            const deadline = Date.now() + 5000
            while (tabEl.querySelector('sftp-panel') && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 30))
            }
        }
        const openSftpFor = async host => {
            const tabEl = cpSshTabEl(host)
            const tab = cpComponentEl(tabEl)
            const sftpBtn = [...tabEl.querySelectorAll('terminal-toolbar button')]
                .find(item => item.textContent.trim() === 'SFTP')
            if (!sftpBtn) {
                throw new Error('Missing SFTP toolbar button for ' + host)
            }
            sftpBtn.click()
            const deadline = Date.now() + 5000
            while (!Array.isArray(cpPanelForEl(tabEl)?.fileList) && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 30))
            }
            return { tabEl, tab, panel: cpPanelForEl(tabEl) }
        }

        // 1. First open with NO history and detected CWD -> opens CWD
        const tab1 = cpComponentEl(cpSshTabEl('127.0.0.1'))
        tab1.session.reportedCWD = ${JSON.stringify(join(sshRoot, 'cwd-dir'))}
        const s1 = await openSftpFor('127.0.0.1')
        const ssh1InitialCwdPath = s1.panel.path
        const ssh1InitialFavorites = [...s1.panel.favorites]

        // Switch to sub-a and favorite it, verify clicks don't close panel
        await s1.panel.navigate(${JSON.stringify(join(sshRoot, 'sub-a'))})
        s1.panel.cdr.detectChanges()
        s1.tabEl.querySelector('sftp-panel [data-testid="favorite-toggle"]').click()
        s1.tabEl.querySelector('sftp-panel [data-testid="places-toggle"]').click()
        s1.panel.cdr.detectChanges()
        const ssh1StillVisibleAfterClicks = Boolean(s1.tabEl.querySelector('sftp-panel'))
        s1.tabEl.querySelector('sftp-panel [data-testid="places-toggle"]').click()

        // Close and reopen even while reportedCWD is still cwd-dir -> MUST restore savedLastPath (sub-a)
        await closeSftpFor('127.0.0.1')
        tab1.session.reportedCWD = ${JSON.stringify(join(sshRoot, 'cwd-dir'))}
        const s1Reopened = await openSftpFor('127.0.0.1')
        const ssh1ReopenedPathOverCwd = s1Reopened.panel.path
        tab1.session.reportedCWD = null

        // 2. SSH path edit: trailing space directory ('trail ') and cross-parent symlink/..
        const editAndSubmit = async (panelEl, panel, targetPath, expectedFile) => {
            panelEl.querySelector('[data-testid="edit-path-btn"]').click()
            panel.cdr.detectChanges()
            const input = panelEl.querySelector('[data-testid="path-input"]')
            input.value = targetPath
            input.dispatchEvent(new Event('input', { bubbles: true }))
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
            const deadline = Date.now() + 5000
            while ((!Array.isArray(panel.fileList) || !panel.fileList.some(e => e.name === expectedFile)) && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 30))
            }
            panel.cdr.detectChanges()
            return {
                path: panel.path,
                names: (panel.fileList || []).map(e => e.name),
            }
        }
        const s1PanelEl = s1Reopened.tabEl.querySelector('sftp-panel')
        const trailingSpaceResult = await editAndSubmit(
            s1PanelEl, s1Reopened.panel, ${JSON.stringify(join(sshRoot, 'trail '))}, 'space-marker.txt',
        )
        const symlinkDotDotResult = await editAndSubmit(
            s1PanelEl, s1Reopened.panel, ${JSON.stringify(join(sshRoot, 'link-parent', 'to-real-child') + '/..')}, 'from-real-parent.txt',
        )
        // Walk up via Backspace from resolved symlink/.. path all the way to '/' and verify convergence without '/..' loops
        let upSteps = 0
        s1PanelEl.focus()
        while (s1Reopened.panel.path !== '/' && upSteps < 20) {
            const prev = s1Reopened.panel.path
            s1PanelEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', repeat: false, bubbles: true, cancelable: true }))
            const upDeadline = Date.now() + 5000
            while (s1Reopened.panel.path === prev && Date.now() < upDeadline) {
                await new Promise(r => setTimeout(r, 25))
            }
            upSteps++
        }
        s1Reopened.panel.cdr.detectChanges()
        const convergedToRoot = s1Reopened.panel.path === '/'
        const goUpHiddenAtRoot = !s1PanelEl.querySelector('[data-testid="go-up-item"]')
        const dotDotLeakedInRecent = s1Reopened.panel.recentPaths.some(p => p.split('/').includes('..'))
        await s1Reopened.panel.navigate(${JSON.stringify(join(sshRoot, 'sub-a'))})
        s1Reopened.panel.cdr.detectChanges()

        // 2b. Manual jump to /<regular-file>/.. MUST hit server readdir first, report error, keep previous list, and NOT list '/' or record history
        const recentBeforeFileDotDot = [...s1Reopened.panel.recentPaths]
        s1PanelEl.querySelector('[data-testid="edit-path-btn"]').click()
        s1Reopened.panel.cdr.detectChanges()
        const fileDotDotInput = s1PanelEl.querySelector('[data-testid="path-input"]')
        const invalidFileDotDotPath = ${JSON.stringify(join(sshRoot, 'sub-a', 'a.txt') + '/..')}
        fileDotDotInput.value = invalidFileDotDotPath
        fileDotDotInput.dispatchEvent(new Event('input', { bubbles: true }))
        fileDotDotInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        const fileDotDotDeadline = Date.now() + 5000
        while (!s1PanelEl.querySelector('[data-testid="error-banner"]') && Date.now() < fileDotDotDeadline) {
            await new Promise(r => setTimeout(r, 30))
        }
        s1Reopened.panel.cdr.detectChanges()
        const manualFileDotDot = {
            path: s1Reopened.panel.path,
            keptATxt: (s1Reopened.panel.fileList || []).some(e => e.name === 'a.txt'),
            errorBannerVisible: Boolean(s1PanelEl.querySelector('[data-testid="error-banner"]')),
            recentUnchanged: JSON.stringify(s1Reopened.panel.recentPaths) === JSON.stringify(recentBeforeFileDotDot),
        }

        // 3a. Normal SFTP operational Status(Failure) + Retry MUST NOT close healthy shared channel or break sibling panel
        const healthyRawSftp = s1Reopened.tab.sshSession.sftp
        const healthyBackend = s1Reopened.panel.sftp
        const siblingHealthyBackend = await s1Reopened.tab.sshSession.openSFTP()
        let healthyCloseCalls = 0
        const origHealthyClose = healthyRawSftp.close.bind(healthyRawSftp)
        healthyRawSftp.close = async (...args) => {
            healthyCloseCalls++
            return origHealthyClose(...args)
        }
        const origHealthyReaddir = healthyBackend.readdir.bind(healthyBackend)
        let failOnceOperational = true
        healthyBackend.readdir = async (...args) => {
            if (failOnceOperational) {
                failOnceOperational = false
                throw new Error('Status(Failure)')
            }
            return origHealthyReaddir(...args)
        }
        let operationalFailureRetry = null
        try {
            s1Reopened.panel.fileList = null
            await s1Reopened.panel.navigate(${JSON.stringify(join(sshRoot, 'sub-a'))})
            s1Reopened.panel.cdr.detectChanges()
            const retryShownOnOperational = Boolean(s1Reopened.tabEl.querySelector('[data-testid="retry-button"]'))
            s1Reopened.tabEl.querySelector('[data-testid="retry-button"]').click()
            const opRetryDeadline = Date.now() + 5000
            while ((!Array.isArray(s1Reopened.panel.fileList) || s1Reopened.panel.loadError) && Date.now() < opRetryDeadline) {
                await new Promise(r => setTimeout(r, 30))
            }
            const siblingOkAfterOpRetry = (await siblingHealthyBackend.readdir(${JSON.stringify(join(sshRoot, 'sub-a'))})).some(e => e.name === 'a.txt')
            operationalFailureRetry = {
                retryShownOnOperational,
                healthyCloseCalls,
                sameChannelKept: s1Reopened.tab.sshSession.sftp === healthyRawSftp && s1Reopened.panel.sftp === healthyBackend,
                recoveredATxt: s1Reopened.panel.fileList.some(e => e.name === 'a.txt'),
                siblingOkAfterOpRetry,
            }
        } finally {
            healthyRawSftp.close = origHealthyClose
            healthyBackend.readdir = origHealthyReaddir
        }

        // 3b. Real SFTP channel close -> error + Retry rebuilds channel; second panel reusing same SSHSession does NOT close recovered channel
        const oldSftp = s1Reopened.tab.sshSession.sftp
        const oldBackend = s1Reopened.panel.sftp
        const siblingFailedBackend = await s1Reopened.tab.sshSession.openSFTP()
        await oldSftp.close()
        // Wait briefly for closed$ if server notifies proactively; otherwise trigger Refresh on closed channel
        await new Promise(r => setTimeout(r, 150))
        if (!s1Reopened.tabEl.querySelector('[data-testid="retry-button"]')) {
            const refreshBtn = [...s1Reopened.tabEl.querySelectorAll('sftp-panel .header button')]
                .find(btn => btn.textContent.trim() === 'Refresh')
            refreshBtn.click()
        }
        const retryWaitDeadline = Date.now() + 5000
        while (!s1Reopened.tabEl.querySelector('[data-testid="retry-button"]') && Date.now() < retryWaitDeadline) {
            await new Promise(r => setTimeout(r, 30))
        }
        s1Reopened.panel.cdr.detectChanges()
        const channelClearedOnClose = s1Reopened.tab.sshSession.sftp === null
        const retryShownAfterClose = Boolean(s1Reopened.tabEl.querySelector('[data-testid="retry-button"]'))
        s1Reopened.tabEl.querySelector('[data-testid="retry-button"]').click()
        const recoverDeadline = Date.now() + 5000
        while ((!Array.isArray(s1Reopened.panel.fileList) || s1Reopened.panel.loadError) && Date.now() < recoverDeadline) {
            await new Promise(r => setTimeout(r, 30))
        }
        const recoveredSftp = s1Reopened.tab.sshSession.sftp
        const retryRecovered = Boolean(
            recoveredSftp &&
            recoveredSftp !== oldSftp &&
            s1Reopened.panel.sftp !== oldBackend &&
            s1Reopened.panel.fileList.some(e => e.name === 'a.txt'),
        )
        // Second panel retries with its stale failed backend -> must reuse recoveredSftp without closing it
        const siblingRecovered = await s1Reopened.tab.sshSession.openSFTP(siblingFailedBackend)
        const siblingReusedRecoveredChannel = Boolean(
            s1Reopened.tab.sshSession.sftp === recoveredSftp &&
            siblingRecovered.rawSftp === recoveredSftp &&
            (await siblingRecovered.readdir(${JSON.stringify(join(sshRoot, 'sub-a'))})).some(e => e.name === 'a.txt'),
        )

        // 4. Real sshd fallback: saved missing deep path & saved chmod 000 no-perm dir (seeded via main-process IPC)
        const { ipcRenderer } = require('electron')
        await closeSftpFor('127.0.0.1')
        ipcRenderer.sendSync('coport-file-panel-state:op', {
            op: 'recordVisit',
            scope: tab1.sftpStateScope,
            path: ${JSON.stringify(join(sshRoot, 'readable', 'missing-a', 'missing-b'))},
        })
        const s1MissingFallback = await openSftpFor('127.0.0.1')
        s1MissingFallback.panel.cdr.detectChanges()
        const sshMissingFallback = {
            path: s1MissingFallback.panel.path,
            hasMarker: s1MissingFallback.panel.fileList.some(e => e.name === 'readable-marker.txt'),
            bannerText: s1MissingFallback.tabEl.querySelector('[data-testid="fallback-banner"]')?.textContent ?? '',
        }

        await closeSftpFor('127.0.0.1')
        ipcRenderer.sendSync('coport-file-panel-state:op', {
            op: 'recordVisit',
            scope: tab1.sftpStateScope,
            path: ${JSON.stringify(join(sshRoot, 'readable', 'no-perm'))},
        })
        const s1NoPermFallback = await openSftpFor('127.0.0.1')
        s1NoPermFallback.panel.cdr.detectChanges()
        const sshNoPermFallback = {
            path: s1NoPermFallback.panel.path,
            hasMarker: s1NoPermFallback.panel.fileList.some(e => e.name === 'readable-marker.txt'),
            bannerText: s1NoPermFallback.tabEl.querySelector('[data-testid="fallback-banner"]')?.textContent ?? '',
        }

        // 4b. Symlink whose target has parent '/' (to-root-child -> /Users): fallback from .../to-root-child/../missing resolves to '/' post-readdir
        await closeSftpFor('127.0.0.1')
        ipcRenderer.sendSync('coport-file-panel-state:op', {
            op: 'recordVisit',
            scope: tab1.sftpStateScope,
            path: ${JSON.stringify(join(sshRoot, 'to-root-child') + '/../missing-for-root-fallback')},
        })
        const s1SymlinkRootFallback = await openSftpFor('127.0.0.1')
        s1SymlinkRootFallback.panel.cdr.detectChanges()
        const sshSymlinkRootFallback = {
            path: s1SymlinkRootFallback.panel.path,
            goUpHidden: !s1SymlinkRootFallback.tabEl.querySelector('[data-testid="go-up-item"]'),
            recentFirst: s1SymlinkRootFallback.panel.recentPaths[0] ?? null,
            resolvedDotDotRecorded: s1SymlinkRootFallback.panel.recentPaths.includes(${JSON.stringify(join(sshRoot, 'to-root-child') + '/..')}),
            bannerText: s1SymlinkRootFallback.tabEl.querySelector('[data-testid="fallback-banner"]')?.textContent ?? '',
        }

        // 4c. Symlink retargeting AFTER initial readdir succeeds and BEFORE post-readdir readlink runs (both manual nav and startup fallback)
        const fsMod = require('fs')
        const retargetLinkPath = ${JSON.stringify(join(sshRoot, 'retarget-link'))}
        const retargetParentAChild = ${JSON.stringify(join(sshRoot, 'retarget-parent-a', 'child'))}
        const retargetParentBChild = ${JSON.stringify(join(sshRoot, 'retarget-parent-b', 'child'))}
        const setRetargetLink = targetPath => {
            try { fsMod.unlinkSync(retargetLinkPath) } catch {}
            fsMod.symlinkSync(targetPath, retargetLinkPath)
        }

        // Manual navigation with symlink retargeted mid-flight
        setRetargetLink(retargetParentAChild)
        const manualRetargetBackend = s1SymlinkRootFallback.panel.sftp
        const origManualResolvePath = manualRetargetBackend.resolvePath.bind(manualRetargetBackend)
        let manualRetargetSwapped = false
        manualRetargetBackend.resolvePath = async p => {
            if (!manualRetargetSwapped && p === retargetLinkPath + '/..') {
                manualRetargetSwapped = true
                setRetargetLink(retargetParentBChild)
            }
            return origManualResolvePath(p)
        }
        try {
            await s1SymlinkRootFallback.panel.navigate(retargetLinkPath + '/..')
        } finally {
            manualRetargetBackend.resolvePath = origManualResolvePath
        }
        s1SymlinkRootFallback.panel.cdr.detectChanges()
        const symlinkRetargetManual = {
            path: s1SymlinkRootFallback.panel.path,
            names: (s1SymlinkRootFallback.panel.fileList || []).map(e => e.name),
            entryBFullPath: (s1SymlinkRootFallback.panel.fileList || []).find(e => e.name === 'only-in-parent-b.txt')?.fullPath ?? null,
        }

        // Startup fallback with symlink retargeted after fallback readdir succeeds and before post-readdir readlink runs
        setRetargetLink(retargetParentAChild)
        await closeSftpFor('127.0.0.1')
        ipcRenderer.sendSync('coport-file-panel-state:op', {
            op: 'recordVisit',
            scope: tab1.sftpStateScope,
            path: retargetLinkPath + '/../missing-retarget-child',
        })
        const origOpenForRetarget = tab1.sshSession.openSFTP.bind(tab1.sshSession)
        let fallbackRetargetSwapped = false
        tab1.sshSession.openSFTP = async (...args) => {
            const backend = await origOpenForRetarget(...args)
            const origRes = backend.resolvePath.bind(backend)
            backend.resolvePath = async p => {
                if (!fallbackRetargetSwapped && p === retargetLinkPath + '/..') {
                    fallbackRetargetSwapped = true
                    setRetargetLink(retargetParentBChild)
                }
                return origRes(p)
            }
            return backend
        }
        let s1RetargetFallback
        try {
            s1RetargetFallback = await openSftpFor('127.0.0.1')
        } finally {
            tab1.sshSession.openSFTP = origOpenForRetarget
        }
        s1RetargetFallback.panel.cdr.detectChanges()
        const symlinkRetargetFallback = {
            path: s1RetargetFallback.panel.path,
            names: (s1RetargetFallback.panel.fileList || []).map(e => e.name),
            entryBFullPath: (s1RetargetFallback.panel.fileList || []).find(e => e.name === 'only-in-parent-b.txt')?.fullPath ?? null,
        }

        // 4d. Channel closed$ firing during post-readdir resolvePath MUST keep loadError & Retry visible (both manual nav and startup fallback)
        const triggerBackendClose = async (tab, panel, backend) => {
            const raw = tab.sshSession.sftp
            if (raw) {
                await raw.close().catch(() => null)
            }
            const waitClose = Date.now() + 250
            while (!panel.loadError && Date.now() < waitClose) {
                await new Promise(r => setTimeout(r, 20))
            }
            if (!panel.loadError && backend?.closed?.next) {
                backend.closed.next()
            }
            const waitErr = Date.now() + 3000
            while (!panel.loadError && Date.now() < waitErr) {
                await new Promise(r => setTimeout(r, 20))
            }
        }

        // 4d-manual: manual navigate('/link-parent/to-real-child/..') -> readdir succeeds -> closed$ fires while resolvePath pending -> Retry stays visible
        const manualCloseBackend = s1RetargetFallback.panel.sftp
        const origCloseManualResolve = manualCloseBackend.resolvePath.bind(manualCloseBackend)
        let releaseCloseManualResolve = null
        manualCloseBackend.resolvePath = () => new Promise(resolve => { releaseCloseManualResolve = resolve })
        const pendingManualCloseNav = s1RetargetFallback.panel.navigate(${JSON.stringify(join(sshRoot, 'link-parent', 'to-real-child') + '/..')})
        const waitManualResolveDeadline = Date.now() + 5000
        while (!releaseCloseManualResolve && Date.now() < waitManualResolveDeadline) {
            await new Promise(r => setTimeout(r, 20))
        }
        await triggerBackendClose(tab1, s1RetargetFallback.panel, manualCloseBackend)
        s1RetargetFallback.panel.cdr.detectChanges()
        releaseCloseManualResolve(${JSON.stringify(join(sshRoot, 'real-parent'))})
        await pendingManualCloseNav
        await new Promise(r => setTimeout(r, 80))
        s1RetargetFallback.panel.cdr.detectChanges()
        const disconnectDuringResolveManual = {
            hasLoadError: Boolean(s1RetargetFallback.panel.loadError),
            retryVisible: Boolean(s1RetargetFallback.tabEl.querySelector('[data-testid="retry-button"]')),
            fileListIsNull: s1RetargetFallback.panel.fileList === null,
        }
        manualCloseBackend.resolvePath = origCloseManualResolve
        s1RetargetFallback.tabEl.querySelector('[data-testid="retry-button"]').click()
        const manualCloseRecoverDeadline = Date.now() + 5000
        while ((!Array.isArray(s1RetargetFallback.panel.fileList) || s1RetargetFallback.panel.loadError) && Date.now() < manualCloseRecoverDeadline) {
            await new Promise(r => setTimeout(r, 30))
        }
        disconnectDuringResolveManual.recoveredAfterRetry = Array.isArray(s1RetargetFallback.panel.fileList) && !s1RetargetFallback.panel.loadError

        // 4d-fallback: startup fallback from '/to-root-child/../missing' -> readdir('/to-root-child/..') succeeds -> closed$ fires while resolvePath pending -> Retry stays visible
        await closeSftpFor('127.0.0.1')
        ipcRenderer.sendSync('coport-file-panel-state:op', {
            op: 'recordVisit',
            scope: tab1.sftpStateScope,
            path: ${JSON.stringify(join(sshRoot, 'to-root-child') + '/../missing-for-close-during-resolve')},
        })
        const origOpenForCloseFallback = tab1.sshSession.openSFTP.bind(tab1.sshSession)
        let releaseCloseFallbackResolve = null
        let closeFallbackBackend = null
        let wrappedOnceForCloseFallback = false
        tab1.sshSession.openSFTP = async (...args) => {
            const backend = await origOpenForCloseFallback(...args)
            if (!wrappedOnceForCloseFallback) {
                wrappedOnceForCloseFallback = true
                closeFallbackBackend = backend
                backend.resolvePath = () => new Promise(resolve => { releaseCloseFallbackResolve = resolve })
            }
            return backend
        }
        let disconnectDuringResolveFallback = null
        try {
            const tabEl1 = cpSshTabEl('127.0.0.1')
            const sftpBtn1 = [...tabEl1.querySelectorAll('terminal-toolbar button')].find(item => item.textContent.trim() === 'SFTP')
            sftpBtn1.click()
            const waitFallbackResolveDeadline = Date.now() + 5000
            while (!releaseCloseFallbackResolve && Date.now() < waitFallbackResolveDeadline) {
                await new Promise(r => setTimeout(r, 20))
            }
            const fallbackPanel = cpPanelForEl(tabEl1)
            await triggerBackendClose(tab1, fallbackPanel, closeFallbackBackend)
            fallbackPanel.cdr.detectChanges()
            releaseCloseFallbackResolve('/')
            await new Promise(r => setTimeout(r, 100))
            fallbackPanel.cdr.detectChanges()
            disconnectDuringResolveFallback = {
                hasLoadError: Boolean(fallbackPanel.loadError),
                retryVisible: Boolean(tabEl1.querySelector('[data-testid="retry-button"]')),
                fileListIsNull: fallbackPanel.fileList === null,
            }
            tabEl1.querySelector('[data-testid="retry-button"]').click()
            const fallbackRecoverDeadline = Date.now() + 5000
            while ((!Array.isArray(fallbackPanel.fileList) || fallbackPanel.loadError) && Date.now() < fallbackRecoverDeadline) {
                await new Promise(r => setTimeout(r, 30))
            }
            disconnectDuringResolveFallback.recoveredAfterRetry = Array.isArray(fallbackPanel.fileList) && !fallbackPanel.loadError
            disconnectDuringResolveFallback.recoveredPath = fallbackPanel.path
            await fallbackPanel.navigate(${JSON.stringify(join(sshRoot, 'sub-a'))})
        } finally {
            tab1.sshSession.openSFTP = origOpenForCloseFallback
        }

        // 4e. Round-5 P2 #2: readlink timeout must NOT fold to '/' or write history; symlink removed between readdir and readlink must NOT adopt stale entries (manual & fallback)
        const readlinkErrorPanel = cpPanelForEl(cpSshTabEl('127.0.0.1'))
        await readlinkErrorPanel.navigate(${JSON.stringify(join(sshRoot, 'sub-a'))})
        setRetargetLink(retargetParentAChild)
        const recentBeforeTimeout = [...readlinkErrorPanel.recentPaths]
        const timeoutBackend = readlinkErrorPanel.sftp
        const origTimeoutReadlink = timeoutBackend.rawSftp.readlink.bind(timeoutBackend.rawSftp)
        timeoutBackend.rawSftp.readlink = async target => {
            if (target === retargetLinkPath) {
                throw Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' })
            }
            return origTimeoutReadlink(target)
        }
        try {
            await readlinkErrorPanel.navigate(retargetLinkPath + '/..')
        } finally {
            timeoutBackend.rawSftp.readlink = origTimeoutReadlink
        }
        readlinkErrorPanel.cdr.detectChanges()
        const readlinkTimeoutManual = {
            foldedToRoot: readlinkErrorPanel.path === '/',
            hasLoadError: Boolean(readlinkErrorPanel.loadError),
            retryVisible: Boolean(cpSshTabEl('127.0.0.1').querySelector('[data-testid="retry-button"]')),
            recentUnchanged: JSON.stringify(readlinkErrorPanel.recentPaths) === JSON.stringify(recentBeforeTimeout),
        }
        // Recover from timeout error cleanly back to sub-a
        await readlinkErrorPanel.navigate(${JSON.stringify(join(sshRoot, 'sub-a'))})

        // 4e-removed-manual: symlink removed after initial readdir('/retarget-link/..') and before readlink('/retarget-link') -> keep sub-a with errorNotice, never adopt stale only-in-parent-a.txt
        setRetargetLink(retargetParentAChild)
        const recentBeforeRemovedManual = [...readlinkErrorPanel.recentPaths]
        const removedManualBackend = readlinkErrorPanel.sftp
        const origRemovedManualResolve = removedManualBackend.resolvePath.bind(removedManualBackend)
        removedManualBackend.resolvePath = async p => {
            if (p === retargetLinkPath + '/..') {
                try { fsMod.unlinkSync(retargetLinkPath) } catch {}
            }
            return origRemovedManualResolve(p)
        }
        try {
            await readlinkErrorPanel.navigate(retargetLinkPath + '/..')
        } finally {
            removedManualBackend.resolvePath = origRemovedManualResolve
        }
        readlinkErrorPanel.cdr.detectChanges()
        const symlinkRemovedManual = {
            path: readlinkErrorPanel.path,
            keptATxt: Boolean(readlinkErrorPanel.fileList?.some(e => e.name === 'a.txt')),
            adoptedStaleA: Boolean(readlinkErrorPanel.fileList?.some(e => e.name === 'only-in-parent-a.txt')),
            errorBannerVisible: Boolean(cpSshTabEl('127.0.0.1').querySelector('[data-testid="error-banner"]')),
            recentUnchanged: JSON.stringify(readlinkErrorPanel.recentPaths) === JSON.stringify(recentBeforeRemovedManual),
        }

        // 4e-removed-fallback: startup fallback from retargetLink/../missing-after-unlink where symlink is removed after fallback readdir succeeds and before readlink -> falls back to live ancestor sshRoot, never adopts stale only-in-parent-a.txt
        setRetargetLink(retargetParentAChild)
        await closeSftpFor('127.0.0.1')
        ipcRenderer.sendSync('coport-file-panel-state:op', {
            op: 'recordVisit',
            scope: tab1.sftpStateScope,
            path: retargetLinkPath + '/../missing-after-unlink',
        })
        const origOpenForRemovedFallback = tab1.sshSession.openSFTP.bind(tab1.sshSession)
        let unlinkedInFallback = false
        tab1.sshSession.openSFTP = async (...args) => {
            const backend = await origOpenForRemovedFallback(...args)
            const origRes = backend.resolvePath.bind(backend)
            backend.resolvePath = async p => {
                if (!unlinkedInFallback && p === retargetLinkPath + '/..') {
                    unlinkedInFallback = true
                    try { fsMod.unlinkSync(retargetLinkPath) } catch {}
                }
                return origRes(p)
            }
            return backend
        }
        let s1RemovedFallback
        try {
            s1RemovedFallback = await openSftpFor('127.0.0.1')
        } finally {
            tab1.sshSession.openSFTP = origOpenForRemovedFallback
        }
        s1RemovedFallback.panel.cdr.detectChanges()
        const symlinkRemovedFallback = {
            path: s1RemovedFallback.panel.path,
            adoptedStaleA: Boolean(s1RemovedFallback.panel.fileList?.some(e => e.name === 'only-in-parent-a.txt')),
            hasLiveSubA: Boolean(s1RemovedFallback.panel.fileList?.some(e => e.name === 'sub-a')),
            bannerVisible: Boolean(s1RemovedFallback.tabEl.querySelector('[data-testid="fallback-banner"]')),
        }
        setRetargetLink(retargetParentAChild)

        // 4e-readlink-failure-symlink (Round-6 P2 #3): readlink('/retarget-link') returns Failure while on-disk /retarget-link is a symlink to another dir.
        // stat() follows symlink and would report isDirectory: true, whereas parent readdir reports isSymlink: true.
        // Persistent Failure MUST NOT fold '..' to sshRoot; one-shot Failure retries readlink and resolves to retarget-parent-a.
        await s1RemovedFallback.panel.navigate(${JSON.stringify(join(sshRoot, 'sub-a'))})
        const recentBeforeFailureSymlink = [...s1RemovedFallback.panel.recentPaths]
        const failSymBackend = s1RemovedFallback.panel.sftp
        const origFailSymReadlink = failSymBackend.rawSftp.readlink.bind(failSymBackend.rawSftp)
        failSymBackend.rawSftp.readlink = async target => {
            if (target === retargetLinkPath) {
                throw new Error('Status(Failure)')
            }
            return origFailSymReadlink(target)
        }
        try {
            await s1RemovedFallback.panel.navigate(retargetLinkPath + '/..')
        } finally {
            failSymBackend.rawSftp.readlink = origFailSymReadlink
        }
        s1RemovedFallback.panel.cdr.detectChanges()
        const persistentFailureSymlink = {
            path: s1RemovedFallback.panel.path,
            foldedToSshRoot: s1RemovedFallback.panel.path === ${JSON.stringify(sshRoot)},
            keptATxt: Boolean(s1RemovedFallback.panel.fileList?.some(e => e.name === 'a.txt')),
            errorBannerVisible: Boolean(s1RemovedFallback.tabEl.querySelector('[data-testid="error-banner"]')),
            recentUnchanged: JSON.stringify(s1RemovedFallback.panel.recentPaths) === JSON.stringify(recentBeforeFailureSymlink),
        }
        let oneShotReadlinkCalls = 0
        failSymBackend.rawSftp.readlink = async target => {
            if (target === retargetLinkPath) {
                oneShotReadlinkCalls++
                if (oneShotReadlinkCalls === 1) {
                    throw new Error('Status(Failure)')
                }
            }
            return origFailSymReadlink(target)
        }
        try {
            await s1RemovedFallback.panel.navigate(retargetLinkPath + '/..')
        } finally {
            failSymBackend.rawSftp.readlink = origFailSymReadlink
        }
        s1RemovedFallback.panel.cdr.detectChanges()
        const oneShotFailureSymlink = {
            readlinkCalls: oneShotReadlinkCalls,
            path: s1RemovedFallback.panel.path,
            foldedToSshRoot: s1RemovedFallback.panel.path === ${JSON.stringify(sshRoot)},
            hasOnlyInA: Boolean(s1RemovedFallback.panel.fileList?.some(e => e.name === 'only-in-parent-a.txt')),
        }

        // 4e-deep-fallback (Round-6 P2 #4): > 16 levels deep with canonicalization EACCES at every level never stalls at Loading.
        const deepSuffixParts = []
        for (let i = 1; i <= 18; i++) {
            deepSuffixParts.push('deep-' + i, '..')
        }
        const deepFallbackPath = ${JSON.stringify(sshRoot)} + '/' + deepSuffixParts.join('/')
        await closeSftpFor('127.0.0.1')
        ipcRenderer.sendSync('coport-file-panel-state:op', {
            op: 'recordVisit',
            scope: tab1.sftpStateScope,
            path: deepFallbackPath,
        })
        const origOpenForDeepFallback = tab1.sshSession.openSFTP.bind(tab1.sshSession)
        let deepResolveCalls = 0
        tab1.sshSession.openSFTP = async (...args) => {
            const backend = await origOpenForDeepFallback(...args)
            const origReaddir = backend.readdir.bind(backend)
            const origResolve = backend.resolvePath.bind(backend)
            backend.readdir = async dirPath => {
                if (dirPath.includes('/deep-') && dirPath.includes('..')) {
                    return [{ name: 'stub.txt', fullPath: dirPath + '/stub.txt', isDirectory: false, isSymlink: false, mode: 0o644, size: 1, modified: new Date() }]
                }
                return origReaddir(dirPath)
            }
            backend.resolvePath = async dirPath => {
                if (dirPath.includes('/deep-') && dirPath.includes('..')) {
                    deepResolveCalls++
                    throw Object.assign(new Error('Permission denied'), { code: 'EACCES' })
                }
                return origResolve(dirPath)
            }
            return backend
        }
        let s1DeepRecovered
        try {
            s1DeepRecovered = await openSftpFor('127.0.0.1')
        } finally {
            tab1.sshSession.openSFTP = origOpenForDeepFallback
        }
        s1DeepRecovered.panel.cdr.detectChanges()
        const deepFallbackRecovered = {
            resolveCallsOver16: deepResolveCalls > 16,
            path: s1DeepRecovered.panel.path,
            hasSubA: Boolean(s1DeepRecovered.panel.fileList?.some(e => e.name === 'sub-a')),
            loadErrorIsNull: s1DeepRecovered.panel.loadError === null,
            bannerVisible: Boolean(s1DeepRecovered.tabEl.querySelector('[data-testid="fallback-banner"]')),
        }

        // 4e-deep-fallback-all-denied (Round-6 P2 #4): when even ancestors & '/' throw EACCES, panel ends in loadError + Retry, never stuck Loading.
        await closeSftpFor('127.0.0.1')
        ipcRenderer.sendSync('coport-file-panel-state:op', {
            op: 'recordVisit',
            scope: tab1.sftpStateScope,
            path: deepFallbackPath,
        })
        let deepAllDeniedResolveCalls = 0
        tab1.sshSession.openSFTP = async (...args) => {
            const backend = await origOpenForDeepFallback(...args)
            backend.readdir = async dirPath => {
                if (dirPath.includes('/deep-') && dirPath.includes('..')) {
                    return [{ name: 'stub.txt', fullPath: dirPath + '/stub.txt', isDirectory: false, isSymlink: false, mode: 0o644, size: 1, modified: new Date() }]
                }
                throw Object.assign(new Error('Permission denied on ancestor'), { code: 'EACCES' })
            }
            backend.resolvePath = async () => {
                deepAllDeniedResolveCalls++
                throw Object.assign(new Error('Permission denied during resolve'), { code: 'EACCES' })
            }
            return backend
        }
        let deepFallbackAllDenied
        try {
            tab1.openSFTP()
            tab1.injector.get(require('@angular/core').ApplicationRef).tick()
            const tabEl = cpSshTabEl('127.0.0.1')
            const deepErrDeadline = Date.now() + 8000
            let panel = null
            while (Date.now() < deepErrDeadline) {
                panel = cpPanelForEl(tabEl)
                if (panel && (panel.loadError || Array.isArray(panel.fileList))) {
                    break
                }
                await new Promise(r => setTimeout(r, 25))
            }
            panel?.cdr.detectChanges()
            deepFallbackAllDenied = {
                resolveCallsOver16: deepAllDeniedResolveCalls > 16,
                fileListIsNull: panel?.fileList === null,
                hasLoadError: Boolean(panel?.loadError),
                loadErrorPath: panel?.loadError?.path ?? null,
                retryVisible: Boolean(tabEl.querySelector('[data-testid="retry-button"]')),
            }
        } finally {
            tab1.sshSession.openSFTP = origOpenForDeepFallback
        }

        // 5. Same host+port with empty profile.options.user: interactive authUsername isolation + LIVE account switch with independent Bob backend (delete/upload isolation) + LRU eviction live refresh
        await closeSftpFor('127.0.0.1')
        const origProfileUser = tab1.profile.options.user
        const origAuthUsername = tab1.sshSession.authUsername
        const origSshSession = tab1.sshSession
        let authUserIsolation = null
        let liveReconnectAccountSwitch = null
        let lruEvictionLiveRefresh = null
        let bobRawSftp = null
        try {
            tab1.profile.options.user = ''
            tab1.sshSession.authUsername = 'alice'
            const aliceScope = tab1.sftpStateScope
            const aliceOpen = await openSftpFor('127.0.0.1')
            await aliceOpen.panel.navigate(${JSON.stringify(join(sshRoot, 'sub-a'))})
            aliceOpen.panel.cdr.detectChanges()
            aliceOpen.tabEl.querySelector('sftp-panel [data-testid="favorite-toggle"]').click()
            await closeSftpFor('127.0.0.1')

            tab1.sshSession.authUsername = 'bob'
            const bobScope = tab1.sftpStateScope
            const bobOpen = await openSftpFor('127.0.0.1')
            const bobInitialPath = bobOpen.panel.path
            const bobInitialFavorites = [...bobOpen.panel.favorites]
            await bobOpen.panel.navigate(${JSON.stringify(join(sshRoot, 'sub-b'))})
            bobOpen.panel.cdr.detectChanges()
            bobOpen.tabEl.querySelector('sftp-panel [data-testid="favorite-toggle"]').click()
            await closeSftpFor('127.0.0.1')

            // Open as alice, keep panel OPEN, and build a genuinely INDEPENDENT SFTP backend for bob
            tab1.sshSession.authUsername = 'alice'
            const aliceReopen = await openSftpFor('127.0.0.1')
            authUserIsolation = {
                aliceScope,
                bobScope,
                bobInitialPath,
                bobInitialFavorites,
                aliceRestoredPath: aliceReopen.panel.path,
                aliceRestoredFavorites: [...aliceReopen.panel.favorites],
            }

            const samePanelBefore = aliceReopen.panel
            const aliceBackend = samePanelBefore.sftp
            const SFTPSessionCtor = aliceBackend.constructor
            bobRawSftp = await origSshSession.ssh.activateSFTP(await origSshSession.ssh.openSessionChannel())
            const bobBackend = new SFTPSessionCtor(bobRawSftp, tab1.injector)
            const bobOps = { unlink: 0, rmdir: 0, upload: 0, mkdir: 0, download: 0 }
            const origBobUnlink = bobBackend.unlink.bind(bobBackend)
            const origBobRmdir = bobBackend.rmdir.bind(bobBackend)
            const origBobUpload = bobBackend.upload.bind(bobBackend)
            const origBobMkdir = bobBackend.mkdir.bind(bobBackend)
            const origBobDownload = bobBackend.download.bind(bobBackend)
            bobBackend.unlink = async (...args) => { bobOps.unlink++; return origBobUnlink(...args) }
            bobBackend.rmdir = async (...args) => { bobOps.rmdir++; return origBobRmdir(...args) }
            bobBackend.upload = async (...args) => { bobOps.upload++; return origBobUpload(...args) }
            bobBackend.mkdir = async (...args) => { bobOps.mkdir++; return origBobMkdir(...args) }
            bobBackend.download = async (...args) => { bobOps.download++; return origBobDownload(...args) }

            let bobSessionOpenCalls = 0
            let failFirstBobOpen = true
            const bobSessionProxy = Object.assign(Object.create(origSshSession), {
                authUsername: 'bob',
                openSFTP: async () => {
                    bobSessionOpenCalls++
                    if (failFirstBobOpen) {
                        failFirstBobOpen = false
                        throw new Error('simulated bob reconnect transient error')
                    }
                    return bobBackend
                },
            })

            // 5a. Open Delete confirmation dialog on Alice's open panel, switch live to Bob, then confirm Delete -> Bob receives 0 unlink/rmdir
            const origShowMessageBox = samePanelBefore.platform.showMessageBox
            const origPopupMenu = samePanelBefore.platform.popupContextMenu
            const origStartUpload = samePanelBefore.platform.startUpload
            const origStartUploadFromDrag = samePanelBefore.platform.startUploadFromDragEvent
            const origElectronDialog = samePanelBefore.platform.electron.dialog
            let releaseDeleteConfirm = null
            let aliceMenu = null
            let deleteClickPromise = null
            let bobRetryTargetPath = null
            let bobFavoritesDuringError = []
            let bobRecoveredPath = null
            let bobRecoveredFavorites = []
            let bobLeakedAlicePath = false
            let uploadTransferCancelled = false
            let dragCancelCounts = null
            let midDirCancelCounts = null
            let delayedOpenDownloadResult = null
            let cancelledSshAtomicDownloadResult = null
            let atomicDownloadPermResult = null
            let atomicDownloadCancelRenameResult = null
            let scanFailureCleanupResult = null
            let cancelQueuedUploadResult = null
            let zeroByteQueuedUploadResult = null
            let closedPanelDropResult = null
            let samePanelForLru = samePanelBefore
            try {
                const switchLiveToAlice = async () => {
                    tab1.sshSession = origSshSession
                    tab1.sshSession.authUsername = 'alice'
                    tab1.injector.get(require('@angular/core').ApplicationRef).tick()
                    const dl = Date.now() + 5000
                    while ((samePanelBefore.path !== ${JSON.stringify(join(sshRoot, 'sub-a'))} || !Array.isArray(samePanelBefore.fileList)) && Date.now() < dl) {
                        await new Promise(r => setTimeout(r, 25))
                    }
                }
                const switchLiveToBob = async () => {
                    tab1.sshSession = bobSessionProxy
                    tab1.injector.get(require('@angular/core').ApplicationRef).tick()
                    const dl = Date.now() + 5000
                    while ((samePanelBefore.path !== ${JSON.stringify(join(sshRoot, 'sub-b'))} || !Array.isArray(samePanelBefore.fileList)) && Date.now() < dl) {
                        await new Promise(r => setTimeout(r, 25))
                    }
                }
                const makeTrackedUpload = (name, size = 10) => {
                    let cancelled = false
                    let cancelCalls = 0
                    return {
                        getName: () => name,
                        getSize: () => size,
                        getMode: () => 0o644,
                        read: async () => Buffer.alloc(0),
                        cancel () { cancelCalls++; cancelled = true },
                        close () {},
                        setStatus () {},
                        isCancelled: () => cancelled,
                        isComplete: () => false,
                        getCancelCalls: () => cancelCalls,
                    }
                }

                samePanelBefore.platform.popupContextMenu = items => { aliceMenu = items }
                samePanelBefore.platform.showMessageBox = () => new Promise(resolve => { releaseDeleteConfirm = resolve })
                const aliceRowA = aliceReopen.tabEl.querySelector('.list-group-item.file-row[data-name="a.txt"]')
                aliceRowA.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
                const menuDeadline = Date.now() + 5000
                while (!aliceMenu && Date.now() < menuDeadline) await new Promise(r => setTimeout(r, 20))
                deleteClickPromise = aliceMenu.find(item => item.label === 'Delete').click()
                const confirmDeadline = Date.now() + 5000
                while (!releaseDeleteConfirm && Date.now() < confirmDeadline) await new Promise(r => setTimeout(r, 20))

                // Keep the SAME panel instance open and switch account to bob while Alice's Delete dialog is pending
                tab1.sshSession = bobSessionProxy
                tab1.injector.get(require('@angular/core').ApplicationRef).tick()
                const bobErrDeadline = Date.now() + 5000
                while (!samePanelBefore.loadError && Date.now() < bobErrDeadline) {
                    await new Promise(r => setTimeout(r, 25))
                }
                samePanelBefore.cdr.detectChanges()
                bobRetryTargetPath = samePanelBefore.loadError?.path ?? null
                bobFavoritesDuringError = [...samePanelBefore.favorites]

                // Click Retry -> must recover bob's directory (sub-b) on bobBackend, never alice's (sub-a)
                aliceReopen.tabEl.querySelector('[data-testid="retry-button"]').click()
                const bobRecoverDeadline = Date.now() + 5000
                while ((!Array.isArray(samePanelBefore.fileList) || samePanelBefore.loadError) && Date.now() < bobRecoverDeadline) {
                    await new Promise(r => setTimeout(r, 25))
                }
                samePanelBefore.cdr.detectChanges()
                bobRecoveredPath = samePanelBefore.path
                bobRecoveredFavorites = [...samePanelBefore.favorites]
                bobLeakedAlicePath = samePanelBefore.recentPaths.includes(${JSON.stringify(join(sshRoot, 'sub-a'))})

                // Now confirm the stale Alice Delete dialog -> MUST NOT delete on Bob (0 unlink/rmdir)
                releaseDeleteConfirm({ response: 0 })
                await deleteClickPromise
                await new Promise(r => setTimeout(r, 80))

                // 5b. Switch back to Alice on the SAME open panel, start pending upload(), switch to Bob before picker resolves -> 0 upload/mkdir on Bob
                await switchLiveToAlice()
                let releaseUploadPicker = null
                samePanelBefore.platform.startUpload = () => new Promise(resolve => { releaseUploadPicker = resolve })
                const pendingAliceUpload = samePanelBefore.upload()
                const uploadPickerDeadline = Date.now() + 5000
                while (!releaseUploadPicker && Date.now() < uploadPickerDeadline) await new Promise(r => setTimeout(r, 20))

                await switchLiveToBob()
                const staleUploadTransfer = {
                    getName: () => 'should-never-hit-bob.txt',
                    read: async () => Buffer.alloc(0),
                    cancel () { uploadTransferCancelled = true },
                    close () {},
                    setStatus () {},
                    isCancelled: () => uploadTransferCancelled,
                }
                releaseUploadPicker([staleUploadTransfer])
                await pendingAliceUpload
                await new Promise(r => setTimeout(r, 80))

                // 5b-drag (P1): Trigger real drop on Alice's open panel with delayed directory scan, switch live to Bob before scan completes -> Bob receives 0 upload/mkdir and all dragged files are cancelled once
                await switchLiveToAlice()
                let releaseDragScan = null
                samePanelBefore.platform.startUploadFromDragEvent = () => new Promise(resolve => { releaseDragScan = resolve })
                aliceReopen.tabEl.querySelector('sftp-panel .body').dispatchEvent(new Event('drop'))
                const dragDeadline = Date.now() + 5000
                while (!releaseDragScan && Date.now() < dragDeadline) await new Promise(r => setTimeout(r, 20))
                await switchLiveToBob()
                const { DirectoryUpload } = require('tabby-core')
                const dragTree = new DirectoryUpload()
                const dragRootFile = makeTrackedUpload('drag-root.txt')
                const dragSubDir = new DirectoryUpload('drag-sub')
                const dragNestedFile = makeTrackedUpload('drag-nested.txt')
                dragSubDir.pushChildren(dragNestedFile)
                dragTree.pushChildren(dragRootFile)
                dragTree.pushChildren(dragSubDir)
                releaseDragScan(dragTree)
                await new Promise(r => setTimeout(r, 100))
                dragCancelCounts = {
                    root: dragRootFile.getCancelCalls(),
                    nested: dragNestedFile.getCancelCalls(),
                }

                // 5b-download (P2): Existing non-empty local file chosen in Save dialog after switching Alice -> Bob MUST NOT be truncated & Bob receives 0 downloads
                await switchLiveToAlice()
                let releaseSaveDialog = null
                samePanelBefore.platform.electron.dialog = {
                    showSaveDialog: () => new Promise(resolve => { releaseSaveDialog = resolve }),
                }
                const pendingAliceDownload = samePanelBefore.download(${JSON.stringify(join(sshRoot, 'sub-a', 'a.txt'))}, 0o644, 6)
                const saveDeadline = Date.now() + 5000
                while (!releaseSaveDialog && Date.now() < saveDeadline) await new Promise(r => setTimeout(r, 20))
                await switchLiveToBob()
                releaseSaveDialog({ canceled: false, filePath: ${JSON.stringify(keepDownloadFile)} })
                await pendingAliceDownload
                await new Promise(r => setTimeout(r, 80))
                samePanelBefore.platform.electron.dialog = origElectronDialog

                // 5b-download-delayed-open (Round-5 P2 #1): Delayed fs.open AFTER canOpen() passes -> switch Alice -> Bob before fs.open resolves -> existing local file untouched & 0 temp files left
                await switchLiveToAlice()
                const fsPromisesMod = require('fs/promises')
                const origFsPromisesOpen = fsPromisesMod.open
                let releaseDelayedOpen = null
                let delayedOpenIntercepted = false
                fsPromisesMod.open = function (targetPath, ...rest) {
                    if (!delayedOpenIntercepted && typeof targetPath === 'string' && targetPath.includes('.coport-download-')) {
                        delayedOpenIntercepted = true
                        const openPromise = origFsPromisesOpen.call(fsPromisesMod, targetPath, ...rest)
                        return new Promise((resolve, reject) => {
                            releaseDelayedOpen = () => openPromise.then(resolve, reject)
                        })
                    }
                    return origFsPromisesOpen.call(fsPromisesMod, targetPath, ...rest)
                }
                samePanelBefore.platform.electron.dialog = {
                    showSaveDialog: async () => ({ canceled: false, filePath: ${JSON.stringify(keepDownloadFile)} }),
                }
                const appRootComp = cpComponent('app-root')
                const transfersBeforeDelayedOpen = appRootComp.activeTransfers.length
                try {
                    const pendingDelayedOpenDownload = samePanelBefore.download(${JSON.stringify(join(sshRoot, 'sub-a', 'a.txt'))}, 0o644, 6)
                    const openDeadline = Date.now() + 5000
                    while (!releaseDelayedOpen && Date.now() < openDeadline) await new Promise(r => setTimeout(r, 20))
                    await switchLiveToBob()
                    releaseDelayedOpen()
                    await pendingDelayedOpenDownload
                    await new Promise(r => setTimeout(r, 120))
                } finally {
                    fsPromisesMod.open = origFsPromisesOpen
                    samePanelBefore.platform.electron.dialog = origElectronDialog
                }
                const tempFilesAfterDelayedOpen = fsMod.readdirSync(${JSON.stringify(run)}).filter(n => n.startsWith('.coport-download-'))
                delayedOpenDownloadResult = {
                    intercepted: delayedOpenIntercepted,
                    contentIntact: fsMod.readFileSync(${JSON.stringify(keepDownloadFile)}, 'utf8') === 'MUST-NOT-BE-TRUNCATED\\n',
                    tempFilesLeft: tempFilesAfterDelayedOpen.length,
                    transfersAdded: appRootComp.activeTransfers.length - transfersBeforeDelayedOpen,
                }

                // 5b-download-mid-cancel (Round-5 P2 #1): Real SSH atomic download cancelled mid-transfer preserves existing local file & leaves 0 temp files; normal SSH atomic download commits cleanly
                await switchLiveToAlice()
                const activeAliceForDl = samePanelBefore.sftp
                const origAliceDlOpen = activeAliceForDl.open.bind(activeAliceForDl)
                let releaseSshDlRead = null
                activeAliceForDl.open = async (...args) => {
                    const handle = await origAliceDlOpen(...args)
                    const origRead = handle.read.bind(handle)
                    let pausedOnce = false
                    handle.read = async () => {
                        if (!pausedOnce) {
                            pausedOnce = true
                            await new Promise(resolve => { releaseSshDlRead = resolve })
                        }
                        return origRead()
                    }
                    return handle
                }
                samePanelBefore.platform.electron.dialog = {
                    showSaveDialog: async () => ({ canceled: false, filePath: ${JSON.stringify(keepDownloadFile)} }),
                }
                try {
                    const pendingMidCancelDl = samePanelBefore.download(${JSON.stringify(join(sshRoot, 'sub-a', 'a.txt'))}, 0o644, 6)
                    const dlPauseDeadline = Date.now() + 5000
                    while (!releaseSshDlRead && Date.now() < dlPauseDeadline) await new Promise(r => setTimeout(r, 20))
                    await switchLiveToBob()
                    releaseSshDlRead()
                    await pendingMidCancelDl
                    await new Promise(r => setTimeout(r, 120))
                } finally {
                    activeAliceForDl.open = origAliceDlOpen
                    samePanelBefore.platform.electron.dialog = origElectronDialog
                }
                const tempFilesAfterMidCancel = fsMod.readdirSync(${JSON.stringify(run)}).filter(n => n.startsWith('.coport-download-'))
                const sshCommitDest = ${JSON.stringify(join(run, 'ssh-atomic-commit.txt'))}
                fsMod.writeFileSync(sshCommitDest, 'OLD-SSH-CONTENT')
                await switchLiveToAlice()
                samePanelBefore.platform.electron.dialog = {
                    showSaveDialog: async () => ({ canceled: false, filePath: sshCommitDest }),
                }
                try {
                    await samePanelBefore.download(${JSON.stringify(join(sshRoot, 'sub-a', 'a.txt'))}, 0o644, 2)
                } finally {
                    samePanelBefore.platform.electron.dialog = origElectronDialog
                }
                const tempFilesAfterCommit = fsMod.readdirSync(${JSON.stringify(run)}).filter(n => n.startsWith('.coport-download-'))
                cancelledSshAtomicDownloadResult = {
                    atomicEnabled: samePanelBefore.sftp.atomicDownloads === true,
                    existingIntactAfterMidCancel: fsMod.readFileSync(${JSON.stringify(keepDownloadFile)}, 'utf8') === 'MUST-NOT-BE-TRUNCATED\\n',
                    tempFilesAfterMidCancel: tempFilesAfterMidCancel.length,
                    committedContent: fsMod.readFileSync(sshCommitDest, 'utf8'),
                    tempFilesAfterCommit: tempFilesAfterCommit.length,
                }

                // 5b-download-perms (Round-6 P2 #1): Overwriting existing 0600 file with remote 0644 preserves 0600; new files apply mode & ~umask.
                const existing0600Dest = ${JSON.stringify(join(run, 'ssh-perm-existing-0600.txt'))}
                const new0644Dest = ${JSON.stringify(join(run, 'ssh-perm-new-0644.txt'))}
                const new0755Dest = ${JSON.stringify(join(run, 'ssh-perm-new-0755.txt'))}
                fsMod.writeFileSync(existing0600Dest, 'SECRET-OLD')
                fsMod.chmodSync(existing0600Dest, 0o600)
                try { fsMod.unlinkSync(new0644Dest) } catch {}
                try { fsMod.unlinkSync(new0755Dest) } catch {}
                const currentUmask = process.umask()
                try {
                    samePanelBefore.platform.electron.dialog = {
                        showSaveDialog: async () => ({ canceled: false, filePath: existing0600Dest }),
                    }
                    await samePanelBefore.download(${JSON.stringify(join(sshRoot, 'sub-a', 'a.txt'))}, 0o644, 6)
                    samePanelBefore.platform.electron.dialog = {
                        showSaveDialog: async () => ({ canceled: false, filePath: new0644Dest }),
                    }
                    await samePanelBefore.download(${JSON.stringify(join(sshRoot, 'sub-a', 'a.txt'))}, 0o644, 6)
                    samePanelBefore.platform.electron.dialog = {
                        showSaveDialog: async () => ({ canceled: false, filePath: new0755Dest }),
                    }
                    await samePanelBefore.download(${JSON.stringify(join(sshRoot, 'sub-a', 'a.txt'))}, 0o755, 6)
                } finally {
                    samePanelBefore.platform.electron.dialog = origElectronDialog
                }
                atomicDownloadPermResult = {
                    existingContentUpdated: fsMod.readFileSync(existing0600Dest, 'utf8') === 'sub-a\\n',
                    existingModePreserved0600: (fsMod.statSync(existing0600Dest).mode & 0o7777) === 0o600,
                    new0644ModeMatchesUmask: (fsMod.statSync(new0644Dest).mode & 0o7777) === (0o644 & ~currentUmask),
                    new0755ModeMatchesUmask: (fsMod.statSync(new0755Dest).mode & 0o7777) === (0o755 & ~currentUmask),
                }

                // 5b-download-cancel-rename (Round-6 P2 #2): Cancel before fs.rename preserves target + isCancelled=true; cancel during fs.rename leaves isCancelled=false & isComplete=true when rename succeeds, and cleans up + reflects failure when rename rejects.
                const origFsPromisesChmod = fsPromisesMod.chmod
                const origFsPromisesRename = fsPromisesMod.rename
                const preRenameDest = ${JSON.stringify(join(run, 'ssh-cancel-pre-rename.txt'))}
                const duringRenameOkDest = ${JSON.stringify(join(run, 'ssh-cancel-during-rename-ok.txt'))}
                const duringRenameFailDest = ${JSON.stringify(join(run, 'ssh-cancel-during-rename-fail.txt'))}
                fsMod.writeFileSync(preRenameDest, 'KEEP-BEFORE-RENAME')
                fsMod.writeFileSync(duringRenameOkDest, 'OLD-BEFORE-RENAME-OK')
                fsMod.writeFileSync(duringRenameFailDest, 'KEEP-ON-RENAME-FAIL')

                // Case A: Cancel during fs.chmod (before fs.rename starts)
                let releaseChmodPause = null
                let preRenameTransfer = null
                fsPromisesMod.chmod = function (targetPath, ...rest) {
                    if (!releaseChmodPause && typeof targetPath === 'string' && targetPath.includes('.coport-download-')) {
                        const chmodPromise = origFsPromisesChmod.call(fsPromisesMod, targetPath, ...rest)
                        return new Promise((resolve, reject) => {
                            releaseChmodPause = () => chmodPromise.then(resolve, reject)
                        })
                    }
                    return origFsPromisesChmod.call(fsPromisesMod, targetPath, ...rest)
                }
                samePanelBefore.platform.electron.dialog = {
                    showSaveDialog: async () => ({ canceled: false, filePath: preRenameDest }),
                }
                try {
                    const beforeCount = appRootComp.activeTransfers.length
                    const dlPromise = samePanelBefore.download(${JSON.stringify(join(sshRoot, 'sub-a', 'a.txt'))}, 0o644, 6)
                    const dlDeadline = Date.now() + 5000
                    while (!releaseChmodPause && Date.now() < dlDeadline) await new Promise(r => setTimeout(r, 20))
                    preRenameTransfer = appRootComp.activeTransfers[beforeCount]
                    preRenameTransfer.cancel()
                    releaseChmodPause()
                    await dlPromise
                } finally {
                    fsPromisesMod.chmod = origFsPromisesChmod
                    samePanelBefore.platform.electron.dialog = origElectronDialog
                }
                const tempLeftAfterPreRename = fsMod.readdirSync(${JSON.stringify(run)}).filter(n => n.startsWith('.coport-download-')).length

                // Case B: Cancel DURING async fs.rename that succeeds -> transfer finishes complete & NOT cancelled
                let releaseRenameOk = null
                let duringRenameOkTransfer = null
                fsPromisesMod.rename = function (src, dst) {
                    if (!releaseRenameOk && dst === duringRenameOkDest) {
                        return new Promise((resolve, reject) => {
                            releaseRenameOk = () => origFsPromisesRename.call(fsPromisesMod, src, dst).then(resolve, reject)
                        })
                    }
                    return origFsPromisesRename.call(fsPromisesMod, src, dst)
                }
                samePanelBefore.platform.electron.dialog = {
                    showSaveDialog: async () => ({ canceled: false, filePath: duringRenameOkDest }),
                }
                try {
                    const beforeCount = appRootComp.activeTransfers.length
                    const dlPromise = samePanelBefore.download(${JSON.stringify(join(sshRoot, 'sub-a', 'a.txt'))}, 0o644, 6)
                    const dlDeadline = Date.now() + 5000
                    while (!releaseRenameOk && Date.now() < dlDeadline) await new Promise(r => setTimeout(r, 20))
                    duringRenameOkTransfer = appRootComp.activeTransfers[beforeCount]
                    duringRenameOkTransfer.cancel()
                    releaseRenameOk()
                    await dlPromise
                } finally {
                    fsPromisesMod.rename = origFsPromisesRename
                    samePanelBefore.platform.electron.dialog = origElectronDialog
                }
                const tempLeftAfterRenameOk = fsMod.readdirSync(${JSON.stringify(run)}).filter(n => n.startsWith('.coport-download-')).length

                // Case C: Cancel DURING async fs.rename that fails -> temp cleaned up, target intact, isCancelled=true, isComplete=false
                let releaseRenameFail = null
                let duringRenameFailTransfer = null
                fsPromisesMod.rename = function (src, dst) {
                    if (!releaseRenameFail && dst === duringRenameFailDest) {
                        return new Promise((_resolve, reject) => {
                            releaseRenameFail = () => reject(Object.assign(new Error('EACCES: simulated rename failure'), { code: 'EACCES' }))
                        })
                    }
                    return origFsPromisesRename.call(fsPromisesMod, src, dst)
                }
                samePanelBefore.platform.electron.dialog = {
                    showSaveDialog: async () => ({ canceled: false, filePath: duringRenameFailDest }),
                }
                try {
                    const beforeCount = appRootComp.activeTransfers.length
                    const dlPromise = samePanelBefore.download(${JSON.stringify(join(sshRoot, 'sub-a', 'a.txt'))}, 0o644, 6)
                    const dlDeadline = Date.now() + 5000
                    while (!releaseRenameFail && Date.now() < dlDeadline) await new Promise(r => setTimeout(r, 20))
                    duringRenameFailTransfer = appRootComp.activeTransfers[beforeCount]
                    duringRenameFailTransfer.cancel()
                    releaseRenameFail()
                    await dlPromise
                } finally {
                    fsPromisesMod.rename = origFsPromisesRename
                    samePanelBefore.platform.electron.dialog = origElectronDialog
                }
                const tempLeftAfterRenameFail = fsMod.readdirSync(${JSON.stringify(run)}).filter(n => n.startsWith('.coport-download-')).length

                atomicDownloadCancelRenameResult = {
                    preRenameTargetIntact: fsMod.readFileSync(preRenameDest, 'utf8') === 'KEEP-BEFORE-RENAME',
                    preRenameCancelled: Boolean(preRenameTransfer?.isCancelled()),
                    preRenameComplete: Boolean(preRenameTransfer?.isComplete()),
                    preRenameTempFilesLeft: tempLeftAfterPreRename,
                    duringRenameOkTargetUpdated: fsMod.readFileSync(duringRenameOkDest, 'utf8') === 'sub-a\\n',
                    duringRenameOkCancelled: Boolean(duringRenameOkTransfer?.isCancelled()),
                    duringRenameOkComplete: Boolean(duringRenameOkTransfer?.isComplete()),
                    duringRenameOkTempFilesLeft: tempLeftAfterRenameOk,
                    duringRenameFailTargetIntact: fsMod.readFileSync(duringRenameFailDest, 'utf8') === 'KEEP-ON-RENAME-FAIL',
                    duringRenameFailCancelled: Boolean(duringRenameFailTransfer?.isCancelled()),
                    duringRenameFailComplete: Boolean(duringRenameFailTransfer?.isComplete()),
                    duringRenameFailTempFilesLeft: tempLeftAfterRenameFail,
                }

                // 5b-mid-dir-upload (P2): Multi-file + nested DirectoryUpload paused during first file while switching Alice -> Bob cancels every remaining unsubmitted FileUpload exactly once & 0 writes to Bob
                await switchLiveToAlice()
                const activeAliceBackend = samePanelBefore.sftp
                const origAliceUpload = activeAliceBackend.upload.bind(activeAliceBackend)
                let releaseFirstUpload = null
                activeAliceBackend.upload = async (_targetPath, transfer) => {
                    await new Promise(resolve => { releaseFirstUpload = resolve })
                    transfer.close()
                }
                try {
                    const midTree = new DirectoryUpload()
                    const midFirst = makeTrackedUpload('first.txt', 12)
                    const midSecond = makeTrackedUpload('second.txt', 14)
                    const midSub = new DirectoryUpload('nested')
                    const midThird = makeTrackedUpload('third.txt', 16)
                    const midDeep = new DirectoryUpload('deep')
                    const midFourth = makeTrackedUpload('fourth.txt', 0)
                    midDeep.pushChildren(midFourth)
                    midSub.pushChildren(midThird)
                    midSub.pushChildren(midDeep)
                    midTree.pushChildren(midFirst)
                    midTree.pushChildren(midSecond)
                    midTree.pushChildren(midSub)

                    const midUploadPromise = samePanelBefore.uploadOneFolder(midTree)
                    const midDeadline = Date.now() + 5000
                    while (!releaseFirstUpload && Date.now() < midDeadline) await new Promise(r => setTimeout(r, 20))
                    await switchLiveToBob()
                    releaseFirstUpload()
                    await midUploadPromise
                    await new Promise(r => setTimeout(r, 80))
                    midDirCancelCounts = {
                        first: midFirst.getCancelCalls(),
                        second: midSecond.getCancelCalls(),
                        third: midThird.getCancelCalls(),
                        fourth: midFourth.getCancelCalls(),
                    }
                } finally {
                    activeAliceBackend.upload = origAliceUpload
                }

                // 5b-cancel-queued-file (Round-5 P2 #5): Cancelling queued 2nd file during 1st file upload skips 2nd cleanly and still uploads 1st, 3rd, and 0-byte 4th without aborting batch
                await switchLiveToAlice()
                const batchAliceBackend = samePanelBefore.sftp
                const origBatchUpload = batchAliceBackend.upload.bind(batchAliceBackend)
                const batchUploadedNames = []
                let releaseBatchFirst = null
                batchAliceBackend.upload = async (targetPath, transfer) => {
                    batchUploadedNames.push(targetPath.split('/').pop())
                    if (transfer.getName() === 'batch-1.txt') {
                        await new Promise(resolve => { releaseBatchFirst = resolve })
                    }
                    transfer.close()
                }
                try {
                    const batchTree = new DirectoryUpload()
                    const b1 = makeTrackedUpload('batch-1.txt', 10)
                    const b2 = makeTrackedUpload('batch-2.txt', 10)
                    const b3 = makeTrackedUpload('batch-3.txt', 10)
                    const b4 = makeTrackedUpload('batch-4-empty.txt', 0)
                    batchTree.pushChildren(b1)
                    batchTree.pushChildren(b2)
                    batchTree.pushChildren(b3)
                    batchTree.pushChildren(b4)
                    const batchPromise = samePanelBefore.uploadOneFolder(batchTree)
                    const bDeadline = Date.now() + 5000
                    while (!releaseBatchFirst && Date.now() < bDeadline) await new Promise(r => setTimeout(r, 20))
                    // User cancels queued 2nd file from transfer menu while 1st file is uploading
                    b2.cancel()
                    releaseBatchFirst()
                    await batchPromise
                    cancelQueuedUploadResult = {
                        uploadedNames: batchUploadedNames,
                        b2CancelCalls: b2.getCancelCalls(),
                        b3Cancelled: b3.isCancelled(),
                        b4Cancelled: b4.isCancelled(),
                    }
                } finally {
                    batchAliceBackend.upload = origBatchUpload
                }

                // 5b-zero-byte-queued-upload (Round-6 P2 #5): Real ElectronFileUpload & HTMLFileUpload 0-byte queued files show isComplete() === false until close(); removing via TransfersMenuComponent actually triggers cancel() and skips backend upload, while uncancelled 0-byte file completes with isComplete() === true.
                const { HTMLFileUpload } = require('tabby-core')
                const htmlEmptyKeep = new HTMLFileUpload(new File([], 'html-empty-keep.txt'))
                const htmlEmptyCancel = new HTMLFileUpload(new File([], 'html-empty-cancel.txt'))
                const htmlEmptyBeforeCloseComplete = htmlEmptyKeep.isComplete()
                htmlEmptyKeep.close()
                const htmlEmptyAfterCloseComplete = htmlEmptyKeep.isComplete()
                htmlEmptyCancel.cancel()
                const htmlEmptyCancelState = {
                    cancelled: htmlEmptyCancel.isCancelled(),
                    complete: htmlEmptyCancel.isComplete(),
                }

                const zeroByteDir = ${JSON.stringify(join(run, 'zero-byte-queue-dir'))}
                fsMod.mkdirSync(zeroByteDir, { recursive: true })
                fsMod.writeFileSync(zeroByteDir + '/01-first.txt', 'first-payload')
                fsMod.writeFileSync(zeroByteDir + '/02-cancel-empty.txt', '')
                fsMod.writeFileSync(zeroByteDir + '/03-keep-empty.txt', '')
                const realZeroTree = await samePanelBefore.platform.startUploadDirectory([zeroByteDir])
                const realZeroRootDir = realZeroTree.getChildrens()[0]
                const realZeroFiles = realZeroRootDir.getChildrens()
                const realCancelEmpty = realZeroFiles.find(f => f.getName() === '02-cancel-empty.txt')
                const realKeepEmpty = realZeroFiles.find(f => f.getName() === '03-keep-empty.txt')
                const zeroCancelCompleteBeforeUpload = realCancelEmpty.isComplete()
                const zeroKeepCompleteBeforeUpload = realKeepEmpty.isComplete()

                const realZeroUploadedNames = []
                let releaseRealZeroFirst = null
                const origRealZeroUpload = batchAliceBackend.upload.bind(batchAliceBackend)
                batchAliceBackend.upload = async (targetPath, transfer) => {
                    realZeroUploadedNames.push(targetPath.split('/').pop())
                    if (transfer.getName() === '01-first.txt') {
                        await new Promise(resolve => { releaseRealZeroFirst = resolve })
                    }
                    return origRealZeroUpload(targetPath, transfer)
                }
                try {
                    const realZeroPromise = samePanelBefore.uploadOneFolder(realZeroTree)
                    const zDeadline = Date.now() + 5000
                    while (!releaseRealZeroFirst && Date.now() < zDeadline) await new Promise(r => setTimeout(r, 20))
                    // Remove the queued 0-byte file via the real TransfersMenuComponent -> MUST trigger cancel() because isComplete() is false
                    tab1.injector.get(require('@angular/core').ApplicationRef).tick()
                    const transfersMenuComp = cpComponent('transfers-menu')
                    transfersMenuComp.removeTransfer(realCancelEmpty)
                    const cancelledViaMenu = realCancelEmpty.isCancelled()
                    releaseRealZeroFirst()
                    await realZeroPromise
                    const remoteZeroDir = ${JSON.stringify(join(sshRoot, 'sub-a', 'zero-byte-queue-dir'))}
                    const remoteCancelEmptyExists = fsMod.existsSync(remoteZeroDir + '/02-cancel-empty.txt')
                    const remoteKeepEmptyExists = fsMod.existsSync(remoteZeroDir + '/03-keep-empty.txt')
                    try { fsMod.rmSync(remoteZeroDir, { recursive: true, force: true }) } catch {}
                    zeroByteQueuedUploadResult = {
                        htmlEmptyBeforeCloseComplete,
                        htmlEmptyAfterCloseComplete,
                        htmlEmptyCancelState,
                        zeroCancelCompleteBeforeUpload,
                        zeroKeepCompleteBeforeUpload,
                        cancelledViaMenu,
                        uploadedNames: realZeroUploadedNames,
                        cancelEmptyCancelled: realCancelEmpty.isCancelled(),
                        cancelEmptyComplete: realCancelEmpty.isComplete(),
                        keepEmptyCancelled: realKeepEmpty.isCancelled(),
                        keepEmptyComplete: realKeepEmpty.isComplete(),
                        remoteCancelEmptyExists,
                        remoteKeepEmptyExists,
                    }
                } finally {
                    batchAliceBackend.upload = origRealZeroUpload
                }

                // 5b-scan-failure-cleanup (Round-5 P2 #4): Directory scan where 1st file opens and 2nd file fails automatically cancels/closes 1st file handle & stops all powerSaveBlockers with 0 residual transfers
                const scanFailDir = ${JSON.stringify(join(run, 'scan-fail-dir'))}
                fsMod.mkdirSync(scanFailDir, { recursive: true })
                const scanFile1 = scanFailDir + '/01-ok.txt'
                const scanFile2 = scanFailDir + '/02-fail.txt'
                fsMod.writeFileSync(scanFile1, 'first-file-content')
                fsMod.writeFileSync(scanFile2, 'second-file-content')
                const activeBlockerIds = new Set()
                const origBlockerStart = samePanelBefore.platform.electron.powerSaveBlocker.start.bind(samePanelBefore.platform.electron.powerSaveBlocker)
                const origBlockerStop = samePanelBefore.platform.electron.powerSaveBlocker.stop.bind(samePanelBefore.platform.electron.powerSaveBlocker)
                let firstHandleCloseCalls = 0
                let scanErrorMessage = null
                const transfersBeforeScanFail = appRootComp.activeTransfers.length
                samePanelBefore.platform.electron.powerSaveBlocker.start = type => {
                    const id = origBlockerStart(type)
                    activeBlockerIds.add(id)
                    return id
                }
                samePanelBefore.platform.electron.powerSaveBlocker.stop = id => {
                    activeBlockerIds.delete(id)
                    return origBlockerStop(id)
                }
                fsPromisesMod.open = async function (targetPath, ...rest) {
                    if (targetPath === scanFile2) {
                        throw Object.assign(new Error('EACCES: simulated read failure'), { code: 'EACCES' })
                    }
                    const handle = await origFsPromisesOpen.call(fsPromisesMod, targetPath, ...rest)
                    if (targetPath === scanFile1) {
                        const origClose = handle.close.bind(handle)
                        handle.close = async () => {
                            firstHandleCloseCalls++
                            return origClose()
                        }
                    }
                    return handle
                }
                try {
                    await samePanelBefore.platform.startUploadDirectory([scanFailDir])
                } catch (error) {
                    scanErrorMessage = error.message
                } finally {
                    fsPromisesMod.open = origFsPromisesOpen
                    samePanelBefore.platform.electron.powerSaveBlocker.start = origBlockerStart
                    samePanelBefore.platform.electron.powerSaveBlocker.stop = origBlockerStop
                }
                await new Promise(r => setTimeout(r, 80))
                scanFailureCleanupResult = {
                    threwExpected: Boolean(scanErrorMessage && scanErrorMessage.includes('simulated read failure')),
                    firstHandleCloseCalls,
                    leakedBlockers: activeBlockerIds.size,
                    transfersAdded: appRootComp.activeTransfers.length - transfersBeforeScanFail,
                }

                // 5b-drop-close-panel (Round-5 P2 #3): Closing panel while drag directory scan is in-flight cancels all scanned FileUploads & leaves 0 residual items in global activeTransfers
                await switchLiveToBob()
                const samePanelReusedBeforeClose = cpPanelForEl(aliceReopen.tabEl) === samePanelBefore
                const distinctBobBackendBeforeClose = samePanelBefore.sftp === bobBackend && bobBackend !== aliceBackend
                samePanelBefore.platform.startUploadFromDragEvent = origStartUploadFromDrag
                let capturedDropUpload = null
                const origRealDrag = samePanelBefore.platform.startUploadFromDragEvent.bind(samePanelBefore.platform)
                samePanelBefore.platform.startUploadFromDragEvent = async (...args) => {
                    const res = await origRealDrag(...args)
                    capturedDropUpload = res
                    return res
                }
                let releaseDropReadEntries = null
                const makeFakeFileEntry = (name, text) => ({
                    isFile: true,
                    isDirectory: false,
                    name,
                    file: cb => cb(new File([text], name)),
                })
                const fakeDirEntry = {
                    isFile: false,
                    isDirectory: true,
                    name: 'dropped-folder',
                    createReader: () => ({
                        readEntries: cb => {
                            releaseDropReadEntries = () => cb([
                                makeFakeFileEntry('drop-a.txt', 'aaa'),
                                {
                                    isFile: false,
                                    isDirectory: true,
                                    name: 'nested',
                                    createReader: () => ({
                                        readEntries: subCb => subCb([makeFakeFileEntry('drop-b.txt', 'bbb')]),
                                    }),
                                },
                            ])
                        },
                    }),
                }
                const transfersBeforeClosedDrop = appRootComp.activeTransfers.length
                const dropEvent = new Event('drop')
                Object.defineProperty(dropEvent, 'dataTransfer', {
                    value: { items: [{ webkitGetAsEntry: () => fakeDirEntry }] },
                })
                aliceReopen.tabEl.querySelector('sftp-panel .body').dispatchEvent(dropEvent)
                const dropWaitDeadline = Date.now() + 5000
                while (!releaseDropReadEntries && Date.now() < dropWaitDeadline) await new Promise(r => setTimeout(r, 20))
                // Close/destroy the panel BEFORE the drag scan resolves!
                await closeSftpFor('127.0.0.1')
                releaseDropReadEntries()
                const dropDoneDeadline = Date.now() + 5000
                while (!capturedDropUpload && Date.now() < dropDoneDeadline) await new Promise(r => setTimeout(r, 20))
                await new Promise(r => setTimeout(r, 100))
                const collectUploads = tree => {
                    const out = []
                    for (const child of tree.getChildrens()) {
                        if (typeof child.getChildrens === 'function') {
                            out.push(...collectUploads(child))
                        } else {
                            out.push(child)
                        }
                    }
                    return out
                }
                const scannedFiles = capturedDropUpload ? collectUploads(capturedDropUpload) : []
                closedPanelDropResult = {
                    scannedCount: scannedFiles.length,
                    allCancelled: scannedFiles.length === 2 && scannedFiles.every(f => f.isCancelled()),
                    transfersAdded: appRootComp.activeTransfers.length - transfersBeforeClosedDrop,
                }
                liveReconnectAccountSwitch = {
                    samePanelReused: samePanelReusedBeforeClose,
                    distinctBobBackend: distinctBobBackendBeforeClose,
                    bobSessionOpenCalls,
                    bobRetryTargetPath,
                    bobFavoritesDuringError,
                    bobRecoveredPath,
                    bobRecoveredFavorites,
                    bobLeakedAlicePath,
                    bobOps,
                    uploadTransferCancelled,
                    dragCancelCounts,
                    midDirCancelCounts,
                    delayedOpenDownloadResult,
                    cancelledSshAtomicDownloadResult,
                    atomicDownloadPermResult,
                    atomicDownloadCancelRenameResult,
                    scanFailureCleanupResult,
                    cancelQueuedUploadResult,
                    zeroByteQueuedUploadResult,
                    closedPanelDropResult,
                }
                // Re-open panel for Bob so 5c LRU eviction live refresh test runs on the open Bob panel as before
                const bobReopenForLru = await openSftpFor('127.0.0.1')
                samePanelForLru = bobReopenForLru.panel
            } finally {
                samePanelBefore.platform.showMessageBox = origShowMessageBox
                samePanelBefore.platform.popupContextMenu = origPopupMenu
                samePanelBefore.platform.startUpload = origStartUpload
                samePanelBefore.platform.startUploadFromDragEvent = origStartUploadFromDrag
                samePanelBefore.platform.electron.dialog = origElectronDialog
            }

            // 5c. LRU eviction live refresh: Bob's panel is currently OPEN with favorite [sub-b]; write 50 new SSH scopes -> Bob's open panel immediately clears favorites, recent & star
            samePanelForLru.cdr.detectChanges()
            const favoritesBeforeEvict = [...samePanelForLru.favorites]
            const starredBeforeEvict = samePanelForLru.isCurrentPathFavorite
            const favoritesBarBeforeEvict = Boolean(aliceReopen.tabEl.querySelector('[data-testid="favorites-bar"]'))
            for (let i = 1; i <= 50; i++) {
                ipcRenderer.sendSync('coport-file-panel-state:op', {
                    op: 'recordVisit',
                    scope: 'ssh:evict-user@evict-host-' + String(i).padStart(2, '0') + ':22',
                    path: '/tmp',
                })
            }
            const evictDeadline = Date.now() + 5000
            while ((samePanelForLru.favorites.length > 0 || samePanelForLru.isCurrentPathFavorite) && Date.now() < evictDeadline) {
                await new Promise(r => setTimeout(r, 25))
            }
            samePanelForLru.cdr.detectChanges()
            lruEvictionLiveRefresh = {
                favoritesBeforeEvict,
                starredBeforeEvict,
                favoritesBarBeforeEvict,
                favoritesAfterEvict: [...samePanelForLru.favorites],
                recentAfterEvict: [...samePanelForLru.recentPaths],
                starredAfterEvict: samePanelForLru.isCurrentPathFavorite,
                favoritesBarAfterEvict: Boolean(aliceReopen.tabEl.querySelector('[data-testid="favorites-bar"]')),
            }
            await closeSftpFor('127.0.0.1')
        } finally {
            tab1.sshSession = origSshSession
            tab1.profile.options.user = origProfileUser
            tab1.sshSession.authUsername = origAuthUsername
            if (bobRawSftp) {
                await bobRawSftp.close().catch(() => null)
            }
        }

        // Re-seed ssh1 (sub-a + favorite) after the 50-scope LRU eviction test so Phase 2 restart check verifies both ssh1 & ssh2 persistence
        ipcRenderer.sendSync('coport-file-panel-state:op', {
            op: 'recordVisit',
            scope: tab1.sftpStateScope,
            path: ${JSON.stringify(join(sshRoot, 'sub-a'))},
        })
        ipcRenderer.sendSync('coport-file-panel-state:op', {
            op: 'addFavorite',
            scope: tab1.sftpStateScope,
            path: ${JSON.stringify(join(sshRoot, 'sub-a'))},
        })

        // 6. Second SSH host ('localhost') independent scope
        const s2 = await openSftpFor('localhost')
        const ssh2InitialPath = s2.panel.path
        const ssh2InitialFavorites = [...s2.panel.favorites]
        await s2.panel.navigate(${JSON.stringify(join(sshRoot, 'sub-b'))})
        s2.panel.cdr.detectChanges()
        s2.tabEl.querySelector('sftp-panel [data-testid="favorite-toggle"]').click()

        return {
            ssh1InitialCwdPath,
            ssh1InitialFavorites,
            ssh1StillVisibleAfterClicks,
            ssh1ReopenedPathOverCwd,
            trailingSpaceResult,
            symlinkDotDotPath: symlinkDotDotResult.path,
            symlinkDotDotHasReal: symlinkDotDotResult.names.includes('from-real-parent.txt'),
            symlinkDotDotHasLinkParent: symlinkDotDotResult.names.includes('from-link-parent.txt'),
            convergedToRoot,
            goUpHiddenAtRoot,
            dotDotLeakedInRecent,
            manualFileDotDot,
            operationalFailureRetry,
            channelClearedOnClose,
            retryShownAfterClose,
            retryRecovered,
            siblingReusedRecoveredChannel,
            sshMissingFallback,
            sshNoPermFallback,
            sshSymlinkRootFallback,
            symlinkRetargetManual,
            symlinkRetargetFallback,
            disconnectDuringResolveManual,
            disconnectDuringResolveFallback,
            readlinkTimeoutManual,
            symlinkRemovedManual,
            symlinkRemovedFallback,
            persistentFailureSymlink,
            oneShotFailureSymlink,
            deepFallbackRecovered,
            deepFallbackAllDenied,
            authUserIsolation,
            liveReconnectAccountSwitch,
            lruEvictionLiveRefresh,
            ssh2InitialPath,
            ssh2InitialFavorites,
            ssh2FinalPath: s2.panel.path,
        }
    })()`, 30000)
    assert.equal(sshIsolationPhase1.ssh1InitialCwdPath, join(sshRoot, 'cwd-dir'))
    assert.deepEqual(sshIsolationPhase1.ssh1InitialFavorites, [])
    assert.equal(sshIsolationPhase1.ssh1StillVisibleAfterClicks, true)
    assert.equal(sshIsolationPhase1.ssh1ReopenedPathOverCwd, join(sshRoot, 'sub-a'))
    assert.equal(sshIsolationPhase1.trailingSpaceResult.path, join(sshRoot, 'trail '))
    assert.ok(sshIsolationPhase1.trailingSpaceResult.names.includes('space-marker.txt'))
    assert.equal(sshIsolationPhase1.symlinkDotDotPath, join(sshRoot, 'real-parent'))
    assert.equal(sshIsolationPhase1.symlinkDotDotHasReal, true)
    assert.equal(sshIsolationPhase1.symlinkDotDotHasLinkParent, false)
    assert.equal(sshIsolationPhase1.convergedToRoot, true)
    assert.equal(sshIsolationPhase1.goUpHiddenAtRoot, true)
    assert.equal(sshIsolationPhase1.dotDotLeakedInRecent, false)
    assert.deepEqual(sshIsolationPhase1.manualFileDotDot, {
        path: join(sshRoot, 'sub-a'),
        keptATxt: true,
        errorBannerVisible: true,
        recentUnchanged: true,
    })
    assert.deepEqual(sshIsolationPhase1.operationalFailureRetry, {
        retryShownOnOperational: true,
        healthyCloseCalls: 0,
        sameChannelKept: true,
        recoveredATxt: true,
        siblingOkAfterOpRetry: true,
    })
    assert.equal(sshIsolationPhase1.channelClearedOnClose, true)
    assert.equal(sshIsolationPhase1.retryShownAfterClose, true)
    assert.equal(sshIsolationPhase1.retryRecovered, true)
    assert.equal(sshIsolationPhase1.siblingReusedRecoveredChannel, true)
    assert.equal(sshIsolationPhase1.sshMissingFallback.path, join(sshRoot, 'readable'))
    assert.equal(sshIsolationPhase1.sshMissingFallback.hasMarker, true)
    assert.ok(
        sshIsolationPhase1.sshMissingFallback.bannerText.includes('missing-a/missing-b') &&
        sshIsolationPhase1.sshMissingFallback.bannerText.includes(join(sshRoot, 'readable')),
        sshIsolationPhase1.sshMissingFallback.bannerText,
    )
    assert.equal(sshIsolationPhase1.sshNoPermFallback.path, join(sshRoot, 'readable'))
    assert.equal(sshIsolationPhase1.sshNoPermFallback.hasMarker, true)
    assert.ok(
        sshIsolationPhase1.sshNoPermFallback.bannerText.includes('no-perm') &&
        sshIsolationPhase1.sshNoPermFallback.bannerText.includes(join(sshRoot, 'readable')),
        sshIsolationPhase1.sshNoPermFallback.bannerText,
    )
    assert.equal(sshIsolationPhase1.sshSymlinkRootFallback.path, '/')
    assert.equal(sshIsolationPhase1.sshSymlinkRootFallback.goUpHidden, true)
    assert.equal(sshIsolationPhase1.sshSymlinkRootFallback.recentFirst, '/')
    assert.equal(sshIsolationPhase1.sshSymlinkRootFallback.resolvedDotDotRecorded, false)
    assert.ok(
        sshIsolationPhase1.sshSymlinkRootFallback.bannerText.includes('missing-for-root-fallback'),
        sshIsolationPhase1.sshSymlinkRootFallback.bannerText,
    )
    assert.deepEqual(sshIsolationPhase1.symlinkRetargetManual, {
        path: join(sshRoot, 'retarget-parent-b'),
        names: ['child', 'only-in-parent-b.txt'],
        entryBFullPath: join(sshRoot, 'retarget-parent-b', 'only-in-parent-b.txt'),
    })
    assert.deepEqual(sshIsolationPhase1.symlinkRetargetFallback, {
        path: join(sshRoot, 'retarget-parent-b'),
        names: ['child', 'only-in-parent-b.txt'],
        entryBFullPath: join(sshRoot, 'retarget-parent-b', 'only-in-parent-b.txt'),
    })
    assert.deepEqual(sshIsolationPhase1.disconnectDuringResolveManual, {
        hasLoadError: true,
        retryVisible: true,
        fileListIsNull: true,
        recoveredAfterRetry: true,
    })
    assert.deepEqual(sshIsolationPhase1.disconnectDuringResolveFallback, {
        hasLoadError: true,
        retryVisible: true,
        fileListIsNull: true,
        recoveredAfterRetry: true,
        recoveredPath: '/',
    })
    assert.deepEqual(sshIsolationPhase1.readlinkTimeoutManual, {
        foldedToRoot: false,
        hasLoadError: true,
        retryVisible: true,
        recentUnchanged: true,
    })
    assert.deepEqual(sshIsolationPhase1.symlinkRemovedManual, {
        path: join(sshRoot, 'sub-a'),
        keptATxt: true,
        adoptedStaleA: false,
        errorBannerVisible: true,
        recentUnchanged: true,
    })
    assert.deepEqual(sshIsolationPhase1.symlinkRemovedFallback, {
        path: sshRoot,
        adoptedStaleA: false,
        hasLiveSubA: true,
        bannerVisible: true,
    })
    assert.deepEqual(sshIsolationPhase1.persistentFailureSymlink, {
        path: join(sshRoot, 'sub-a'),
        foldedToSshRoot: false,
        keptATxt: true,
        errorBannerVisible: true,
        recentUnchanged: true,
    })
    assert.deepEqual(sshIsolationPhase1.oneShotFailureSymlink, {
        readlinkCalls: 2,
        path: join(sshRoot, 'retarget-parent-a'),
        foldedToSshRoot: false,
        hasOnlyInA: true,
    })
    assert.deepEqual(sshIsolationPhase1.deepFallbackRecovered, {
        resolveCallsOver16: true,
        path: sshRoot,
        hasSubA: true,
        loadErrorIsNull: true,
        bannerVisible: true,
    })
    assert.deepEqual(sshIsolationPhase1.deepFallbackAllDenied, {
        resolveCallsOver16: true,
        fileListIsNull: true,
        hasLoadError: true,
        loadErrorPath: '/',
        retryVisible: true,
    })
    assert.equal(await readFile(keepDownloadFile, 'utf8'), 'MUST-NOT-BE-TRUNCATED\n')
    assert.deepEqual(sshIsolationPhase1.authUserIsolation, {
        aliceScope: `ssh:alice@127.0.0.1:${port}`,
        bobScope: `ssh:bob@127.0.0.1:${port}`,
        bobInitialPath: '/',
        bobInitialFavorites: [],
        aliceRestoredPath: join(sshRoot, 'sub-a'),
        aliceRestoredFavorites: [join(sshRoot, 'sub-a')],
    })
    assert.deepEqual(sshIsolationPhase1.liveReconnectAccountSwitch, {
        samePanelReused: true,
        distinctBobBackend: true,
        bobSessionOpenCalls: 9,
        bobRetryTargetPath: join(sshRoot, 'sub-b'),
        bobFavoritesDuringError: [join(sshRoot, 'sub-b')],
        bobRecoveredPath: join(sshRoot, 'sub-b'),
        bobRecoveredFavorites: [join(sshRoot, 'sub-b')],
        bobLeakedAlicePath: false,
        bobOps: { unlink: 0, rmdir: 0, upload: 0, mkdir: 0, download: 0 },
        uploadTransferCancelled: true,
        dragCancelCounts: { root: 1, nested: 1 },
        midDirCancelCounts: { first: 0, second: 1, third: 1, fourth: 1 },
        delayedOpenDownloadResult: {
            intercepted: true,
            contentIntact: true,
            tempFilesLeft: 0,
            transfersAdded: 0,
        },
        cancelledSshAtomicDownloadResult: {
            atomicEnabled: true,
            existingIntactAfterMidCancel: true,
            tempFilesAfterMidCancel: 0,
            committedContent: 'sub-a\n',
            tempFilesAfterCommit: 0,
        },
        atomicDownloadPermResult: {
            existingContentUpdated: true,
            existingModePreserved0600: true,
            new0644ModeMatchesUmask: true,
            new0755ModeMatchesUmask: true,
        },
        atomicDownloadCancelRenameResult: {
            preRenameTargetIntact: true,
            preRenameCancelled: true,
            preRenameComplete: false,
            preRenameTempFilesLeft: 0,
            duringRenameOkTargetUpdated: true,
            duringRenameOkCancelled: false,
            duringRenameOkComplete: true,
            duringRenameOkTempFilesLeft: 0,
            duringRenameFailTargetIntact: true,
            duringRenameFailCancelled: true,
            duringRenameFailComplete: false,
            duringRenameFailTempFilesLeft: 0,
        },
        scanFailureCleanupResult: {
            threwExpected: true,
            firstHandleCloseCalls: 1,
            leakedBlockers: 0,
            transfersAdded: 0,
        },
        cancelQueuedUploadResult: {
            uploadedNames: ['batch-1.txt', 'batch-3.txt', 'batch-4-empty.txt'],
            b2CancelCalls: 1,
            b3Cancelled: false,
            b4Cancelled: false,
        },
        zeroByteQueuedUploadResult: {
            htmlEmptyBeforeCloseComplete: false,
            htmlEmptyAfterCloseComplete: true,
            htmlEmptyCancelState: {
                cancelled: true,
                complete: false,
            },
            zeroCancelCompleteBeforeUpload: false,
            zeroKeepCompleteBeforeUpload: false,
            cancelledViaMenu: true,
            uploadedNames: ['01-first.txt', '03-keep-empty.txt'],
            cancelEmptyCancelled: true,
            cancelEmptyComplete: false,
            keepEmptyCancelled: false,
            keepEmptyComplete: true,
            remoteCancelEmptyExists: false,
            remoteKeepEmptyExists: true,
        },
        closedPanelDropResult: {
            scannedCount: 2,
            allCancelled: true,
            transfersAdded: 0,
        },
    })
    assert.deepEqual(sshIsolationPhase1.lruEvictionLiveRefresh, {
        favoritesBeforeEvict: [join(sshRoot, 'sub-b')],
        starredBeforeEvict: true,
        favoritesBarBeforeEvict: true,
        favoritesAfterEvict: [],
        recentAfterEvict: [],
        starredAfterEvict: false,
        favoritesBarAfterEvict: false,
    })
    assert.equal(sshIsolationPhase1.ssh2InitialPath, '/')
    assert.deepEqual(sshIsolationPhase1.ssh2InitialFavorites, [])
    assert.equal(sshIsolationPhase1.ssh2FinalPath, join(sshRoot, 'sub-b'))

    // Verify main-process atomic state file was persisted inside isolated userData
    const persistedStateFile = JSON.parse(await readFile(join(run, 'coport-file-panel-state.json'), 'utf8'))
    assert.equal(persistedStateFile.version, 1)
    assert.equal(persistedStateFile.scopes['adb:shared'].recent[0], '/data/only-on-embedded/deep')
    assert.deepEqual(persistedStateFile.scopes['adb:shared'].favorites, ['/etc'])

    // Phase 2: Restart isolated Electron app with the SAME --user-data-dir to verify persistence, cross-device ADB sharing, fallback banner, root failure Retry, plus all M3 regressions
    await stop(app)
    app = null
    target = null
    ;({ proc: app, page: target } = await launchApp(env, childrenLogs))
    evalJs = (expression, timeout) => evaluate(target, expression, timeout)
    const open2 = name => evalJs(`require('electron').ipcRenderer.emit('cli', null,
        { _: ['profile'], profileName: ${JSON.stringify(name)} }, '/', false)`)

    // Verify ADB embedded restores last path + favorite across restart
    await open2(title.adbEmbedded)
    await waitFor(() => evalJs("!!cpAdbTabEl('embedded')"))
    await evalJs(`(() => {
        const btn = [...cpAdbTabEl('embedded').querySelectorAll('terminal-toolbar button')]
            .find(item => item.textContent.trim() === 'Files')
        btn.click()
        return true
    })()`)
    await waitFor(() => evalJs("Array.isArray(cpPanelForEl(cpAdbTabEl('embedded'))?.fileList)"))
    const adbAfterRestart = await evalJs(`(() => {
        const panel = cpPanelForEl(cpAdbTabEl('embedded'))
        return { path: panel.path, favorites: [...panel.favorites] }
    })()`)
    assert.deepEqual(adbAfterRestart, { path: '/data/only-on-embedded/deep', favorites: ['/etc'] })

    // Verify second ADB device 'two' shares ADB state and automatically falls back from missing directory with banner
    await open2(title.adbTwo)
    await waitFor(() => evalJs("!!cpAdbTabEl('two')"))
    await evalJs(`(() => {
        const btn = [...cpAdbTabEl('two').querySelectorAll('terminal-toolbar button')]
            .find(item => item.textContent.trim() === 'Files')
        btn.click()
        return true
    })()`)
    await waitFor(() => evalJs("Array.isArray(cpPanelForEl(cpAdbTabEl('two'))?.fileList)"))
    const adbFallback = await evalJs(`(() => {
        const tabEl = cpAdbTabEl('two')
        const panel = cpPanelForEl(tabEl)
        panel.cdr.detectChanges()
        const bannerText = tabEl.querySelector('[data-testid="fallback-banner"]')?.textContent ?? ''
        return {
            path: panel.path,
            names: panel.fileList.map(e => e.name),
            favorites: [...panel.favorites],
            bannerText,
        }
    })()`)
    assert.equal(adbFallback.path, '/data')
    assert.ok(adbFallback.names.includes('two-marker.txt'), adbFallback.names)
    assert.deepEqual(adbFallback.favorites, ['/etc'])
    assert.ok(adbFallback.bannerText.includes('/data/only-on-embedded/deep') && adbFallback.bannerText.includes('/data'), adbFallback.bannerText)

    // Verify cross-device shared update in reverse ('two' -> 'embedded')
    await evalJs(`(async () => {
        await cpPanelForEl(cpAdbTabEl('two')).navigate('/etc')
        const btn = [...cpAdbTabEl('embedded').querySelectorAll('terminal-toolbar button')]
            .find(item => item.textContent.trim() === 'Files')
        btn.click()
        return true
    })()`)
    await waitFor(() => evalJs("!cpAdbTabEl('embedded')?.querySelector('sftp-panel')"))
    await evalJs(`(() => {
        const btn = [...cpAdbTabEl('embedded').querySelectorAll('terminal-toolbar button')]
            .find(item => item.textContent.trim() === 'Files')
        btn.click()
        return true
    })()`)
    await waitFor(() => evalJs("cpPanelForEl(cpAdbTabEl('embedded'))?.path === '/etc' && Array.isArray(cpPanelForEl(cpAdbTabEl('embedded'))?.fileList)"))

    // Verify same-window two open ADB panels immediately sync favorites & chips
    const sameWindowSync = await evalJs(`(() => {
        const tab1El = cpAdbTabEl('embedded')
        const tab2El = cpAdbTabEl('two')
        const p1 = cpPanelForEl(tab1El)
        const p2 = cpPanelForEl(tab2El)
        // Both are at /etc and /etc is currently starred; unstar on tab1 first
        tab1El.querySelector('sftp-panel [data-testid="favorite-toggle"]').click()
        const p2FavAfterUnstar = p2.isCurrentPathFavorite
        const p2ChipAfterUnstar = Boolean(tab2El.querySelector('sftp-panel [data-testid="favorite-chip"][data-path="/etc"]'))
        // Star on tab1 -> tab2 must immediately sync
        tab1El.querySelector('sftp-panel [data-testid="favorite-toggle"]').click()
        const p2FavAfterStar = p2.isCurrentPathFavorite
        const p2ChipAfterStar = Boolean(tab2El.querySelector('sftp-panel [data-testid="favorite-chip"][data-path="/etc"]'))
        // Click star on tab2 -> must toggle cleanly in sync with displayed state
        tab2El.querySelector('sftp-panel [data-testid="favorite-toggle"]').click()
        const p2FavAfterOwnToggle = p2.isCurrentPathFavorite
        const p1FavAfterTab2Toggle = p1.isCurrentPathFavorite
        // Restore /etc favorite
        tab1El.querySelector('sftp-panel [data-testid="favorite-toggle"]').click()
        return {
            p2FavAfterUnstar,
            p2ChipAfterUnstar,
            p2FavAfterStar,
            p2ChipAfterStar,
            p2FavAfterOwnToggle,
            p1FavAfterTab2Toggle,
        }
    })()`)
    assert.deepEqual(sameWindowSync, {
        p2FavAfterUnstar: false,
        p2ChipAfterUnstar: false,
        p2FavAfterStar: true,
        p2ChipAfterStar: true,
        p2FavAfterOwnToggle: false,
        p1FavAfterTab2Toggle: false,
    })

    // Verify root '/' disconnect failure shows error + Retry button and recovers after reconnect
    await evalJs(`(async () => {
        await cpPanelForEl(cpAdbTabEl('embedded')).navigate('/')
        const btn = [...cpAdbTabEl('two').querySelectorAll('terminal-toolbar button')]
            .find(item => item.textContent.trim() === 'Files')
        btn.click()
        return true
    })()`)
    await waitFor(() => evalJs("!cpAdbTabEl('two')?.querySelector('sftp-panel')"))
    await writeFile(join(adbRoot, 'state.json'), JSON.stringify({
        devices: [['embedded', 'device'], ['two', 'device'], ['one', 'device']],
        offline_serials: ['two'],
    }))
    await evalJs(`(() => {
        const btn = [...cpAdbTabEl('two').querySelectorAll('terminal-toolbar button')]
            .find(item => item.textContent.trim() === 'Files')
        btn.click()
        return true
    })()`)
    await waitFor(() => evalJs("Boolean(cpAdbTabEl('two')?.querySelector('[data-testid=\"retry-button\"]'))"))
    const rootErrorState = await evalJs(`(() => {
        const tabEl = cpAdbTabEl('two')
        const panel = cpPanelForEl(tabEl)
        return {
            hasLoadError: Boolean(panel.loadError),
            errorPath: panel.loadError?.path,
            hasRetryBtn: Boolean(tabEl.querySelector('[data-testid="retry-button"]')),
            stuckOnLoading: tabEl.querySelector('sftp-panel .body')?.textContent?.trim() === 'Loading',
        }
    })()`)
    assert.deepEqual(rootErrorState, { hasLoadError: true, errorPath: '/', hasRetryBtn: true, stuckOnLoading: false })

    await writeFile(join(adbRoot, 'state.json'), JSON.stringify({
        devices: [['embedded', 'device'], ['two', 'device'], ['one', 'device']],
    }))
    await evalJs(`(() => {
        cpAdbTabEl('two').querySelector('[data-testid="retry-button"]').click()
        return true
    })()`)
    await waitFor(() => evalJs("Array.isArray(cpPanelForEl(cpAdbTabEl('two'))?.fileList) && !cpPanelForEl(cpAdbTabEl('two'))?.loadError"))
    const afterRetryNames = await evalJs("cpPanelForEl(cpAdbTabEl('two')).fileList.map(e => e.name)")
    assert.ok(afterRetryNames.includes('data') && afterRetryNames.includes('etc'), afterRetryNames)

    // Verify SSH hosts restore independently across restart AND prioritize savedLastPath over a different reported CWD
    await open2(title.ssh)
    await waitFor(() => evalJs("cpComponentEl(cpSshTabEl('127.0.0.1'))?.session?.open"))
    await open2(title.ssh2)
    await waitFor(() => evalJs("cpComponentEl(cpSshTabEl('localhost'))?.session?.open"))
    const sshAfterRestart = await evalJs(`(async () => {
        const openAndRead = async (host, differentCwd) => {
            const tabEl = cpSshTabEl(host)
            const tab = cpComponentEl(tabEl)
            tab.session.reportedCWD = differentCwd
            const sftpBtn = [...tabEl.querySelectorAll('terminal-toolbar button')]
                .find(item => item.textContent.trim() === 'SFTP')
            if (!sftpBtn) {
                throw new Error('Missing SFTP toolbar button for ' + host)
            }
            sftpBtn.click()
            const deadline = Date.now() + 5000
            while (!Array.isArray(cpPanelForEl(tabEl)?.fileList) && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 30))
            }
            const panel = cpPanelForEl(tabEl)
            tab.session.reportedCWD = null
            return { path: panel.path, favorites: [...panel.favorites] }
        }
        return {
            ssh1: await openAndRead('127.0.0.1', ${JSON.stringify(join(sshRoot, 'cwd-dir'))}),
            ssh2: await openAndRead('localhost', ${JSON.stringify(join(sshRoot, 'cwd-dir'))}),
        }
    })()`, 15000)
    assert.deepEqual(sshAfterRestart, {
        ssh1: { path: join(sshRoot, 'sub-a'), favorites: [join(sshRoot, 'sub-a')] },
        ssh2: { path: join(sshRoot, 'sub-b'), favorites: [join(sshRoot, 'sub-b')] },
    })

    // Close extra nav tabs and reset state.json to single device 'one' for full M3 regression suite
    await evalJs(`(() => {
        for (const el of [cpAdbTabEl('embedded'), cpAdbTabEl('two'), cpSshTabEl('localhost')]) {
            cpComponentEl(el)?.destroy()
        }
        const ssh1 = cpComponentEl(cpSshTabEl('127.0.0.1'))
        if (ssh1) ssh1.sftpPanelVisible = false
        for (const key of Object.keys(window.localStorage)) {
            if (key === 'coport.filePanelState.v1' || key.startsWith('coport.filePanelState.v1:')) {
                window.localStorage.removeItem(key)
            }
        }
        return true
    })()`)
    await waitFor(() => evalJs("document.querySelectorAll('coport-adb-tab').length === 0 && document.querySelectorAll('ssh-tab').length === 1"))
    await writeFile(join(adbRoot, 'state.json'), JSON.stringify({ devices: [['one', 'device']] }))

    const proof = async (selector, token) => {
        await waitFor(() => evalJs(`cpTerminalProof(${JSON.stringify(selector)}, ${JSON.stringify(token)})`))
        await waitFor(() => evalJs(`cpHasLine(${JSON.stringify(selector)}, ${JSON.stringify(token)})`))
    }
    await open2(title.local)
    await proof('terminaltab', 'M3-LOCAL')
    await open2(title.serial)
    await waitFor(() => evalJs("!!document.querySelector('serial-tab .text-success')"))
    mcp = new Client({ name: 'm3-shells', version: '1' })
    await mcp.connect(new StdioClientTransport({ command: shim, env: { COPORT_TEST_SOCKET: endpoint } }))
    const tool = async (name, args) => (await mcp.callTool({ name, arguments: args })).structuredContent
    const serial = await tool('open_serial', { path: device })
    assert.equal(serial.reused, true)
    await proof('ssh-tab', 'M3-SSH')
    await open2(title.adb)
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
    assert.equal(await evalJs(`['terminaltab', 'ssh-tab', 'serial-tab', 'coport-adb-tab']
        .every(selector => Boolean(document.querySelector(selector)))`), true)
    assert.equal(await evalJs(`${JSON.stringify([title.local, title.ssh, title.serial, title.adb])}
        .every(name => document.body.innerText.split('\\n').includes(name))`), true)
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
    console.log(JSON.stringify({
        noSdcardBoot,
        filterAndKeyboard: {
            callsAfterType: filterAndKeyboard.callsAfterType,
            domFilteredNames: filterAndKeyboard.domFilteredNames,
            activeIsFilterInputAfterFirstKey: filterAndKeyboard.activeIsFilterInputAfterFirstKey,
            drillPath: filterAndKeyboard.drillPath,
            pathAfterBackspace: filterAndKeyboard.pathAfterBackspace,
            goUpKeptOnNoMatch: filterAndKeyboard.goUpKeptOnNoMatch,
            panelStillOpenAfterEsc: filterAndKeyboard.panelStillOpenAfterEsc,
        },
        filteredActions,
        staleOps,
        bulkBench: {
            total: bulkBench.total,
            readdirCalls: bulkBench.readdirCalls,
            firstKeyMs: Number(bulkBench.firstKeyMs.toFixed(2)),
            maxMs: Number(bulkBench.maxMs.toFixed(2)),
            mountedBeforeResize: bulkBench.mountedBeforeResize,
            mountedAfterResize: bulkBench.mountedAfterResize,
            domSnapshots: bulkBench.domSnapshots,
        },
        pathBarAndManualError,
        favoritesFlow,
        sameWindowSync,
        sshIsolationPhase1,
        adbAfterRestart,
        adbFallback: { path: adbFallback.path, favorites: adbFallback.favorites, bannerText: adbFallback.bannerText },
        rootErrorState,
        sshAfterRestart,
        adbPTY: true,
        sshPTY: true,
        localPTY: true,
        serialGeneration: serial.session_id,
        sameWindow: true,
        adbPanel,
        sshPanel,
        recentADB: 'one',
        advanced,
        atomicDownloadOnWindowClose: true,
    }))
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
    await chmod(join(sshRoot, 'readable', 'no-perm'), 0o700).catch(() => null)
    await rm(run, { recursive: true, force: true })
}
