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

async function prepareNavigationFixtures () {
    const embeddedRoot = join(adbRoot, 'devices', 'embedded')
    await mkdir(join(embeddedRoot, 'data', 'app', 'g_comp', 'nested'), { recursive: true })
    await mkdir(join(embeddedRoot, 'data', 'only-on-embedded', 'deep'), { recursive: true })
    await mkdir(join(embeddedRoot, 'etc'), { recursive: true })
    await mkdir(join(embeddedRoot, 'bulk'), { recursive: true })
    await writeFile(join(embeddedRoot, 'data', 'app', 'g_comp', 'nested', 'leaf.txt'), 'nested leaf\n')
    await writeFile(join(embeddedRoot, 'data', 'app', 'good_config.txt'), 'good config\n')
    await writeFile(join(embeddedRoot, 'data', 'app', 'alpha.txt'), 'alpha\n')
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
    await writeFile(join(sshRoot, 'sub-a', 'a.txt'), 'sub-a\n')
    await writeFile(join(sshRoot, 'sub-b', 'b.txt'), 'sub-b\n')
    await writeFile(join(sshRoot, 'cwd-dir', 'cwd.txt'), 'cwd\n')
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

    // Type-to-filter without clicking Filter, highlights, keyboard drill-down, zero remote calls, Backspace/Esc, no-match Go up
    const filterAndKeyboard = await evalJs(`(async () => {
        const tabEl = cpAdbTabEl('embedded')
        const panelEl = tabEl.querySelector('sftp-panel')
        const panel = cpPanelForEl(tabEl)
        await panel.navigate('/data/app')
        let readdirCalls = 0
        const origReaddir = panel.sftp.readdir.bind(panel.sftp)
        panel.sftp.readdir = async (...args) => {
            readdirCalls++
            return origReaddir(...args)
        }
        try {
            const filterVisibleBefore = Boolean(panelEl.querySelector('[data-testid="filter-bar"]'))
            panelEl.focus()
            for (const ch of ['g', '_', 'c']) {
                panelEl.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }))
            }
            const callsAfterType = readdirCalls
            const filterVisibleAfter = Boolean(panelEl.querySelector('[data-testid="filter-bar"]'))
            const filterTextAfterType = panel.filterText
            const filteredNames = panel.filteredFileList.map(e => e.name)
            const marks = [...panelEl.querySelectorAll('mark.filter-match')].map(el => el.textContent)
            // Verify filtered-state action targets actual filtered item (row 1 is good_config.txt, not fileList[1])
            const filteredCtx = (await panel.buildContextMenu(panel.filteredFileList[1])).map(i => i.label).filter(Boolean)

            panelEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
            const indexAfterDown = panel.selectedIndex
            const selectedDownClass = panelEl.querySelector('.list-group-item[data-index="1"]')?.classList.contains('selected') ?? false

            panelEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
            const indexAfterUp = panel.selectedIndex

            panelEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
            const deadline1 = Date.now() + 5000
            while (panel.path !== '/data/app/g_comp' && Date.now() < deadline1) {
                await new Promise(r => setTimeout(r, 30))
            }
            const afterEnterPath = panel.path
            const afterEnterFilterCleared = !panel.showFilter && panel.filterText === ''
            const focusedAfterEnter = document.activeElement === panelEl || panelEl.contains(document.activeElement)

            // Continuous keyboard drill-down without clicking
            for (const ch of ['n', 'e', 's']) {
                panelEl.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }))
            }
            panelEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
            const deadline2 = Date.now() + 5000
            while (panel.path !== '/data/app/g_comp/nested' && Date.now() < deadline2) {
                await new Promise(r => setTimeout(r, 30))
            }
            const drillPath = panel.path

            // Repeated Backspace with empty filter must NOT go up
            panelEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', repeat: true, bubbles: true, cancelable: true }))
            await new Promise(r => setTimeout(r, 120))
            const pathAfterRepeatBackspace = panel.path

            // Single non-repeat Backspace goes up
            panelEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', repeat: false, bubbles: true, cancelable: true }))
            const deadline3 = Date.now() + 5000
            while (panel.path !== '/data/app/g_comp' && Date.now() < deadline3) {
                await new Promise(r => setTimeout(r, 30))
            }
            const pathAfterBackspace = panel.path

            // No-match state retains Go up, Escape clears filter without closing panel
            for (const ch of ['z', 'z', 'z']) {
                panelEl.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }))
            }
            panel.cdr.detectChanges()
            const noMatchShown = Boolean(panelEl.querySelector('[data-testid="no-match-alert"]'))
            const goUpKeptOnNoMatch = Boolean(panelEl.querySelector('[data-testid="go-up-item"]'))

            panelEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
            panel.cdr.detectChanges()
            const afterEscFilterHidden = !panel.showFilter && panel.filterText === ''
            const panelStillOpenAfterEsc = Boolean(tabEl.querySelector('sftp-panel'))

            return {
                filterVisibleBefore,
                filterVisibleAfter,
                callsAfterType,
                filterTextAfterType,
                filteredNames,
                marks,
                filteredCtx,
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
    assert.equal(filterAndKeyboard.callsAfterType, 0)
    assert.equal(filterAndKeyboard.filterTextAfterType, 'g_c')
    assert.deepEqual(filterAndKeyboard.filteredNames, ['g_comp', 'good_config.txt'])
    assert.ok(filterAndKeyboard.marks.includes('g_c') && filterAndKeyboard.marks.includes('_c'), filterAndKeyboard.marks)
    assert.ok(filterAndKeyboard.filteredCtx.includes('Download'), filterAndKeyboard.filteredCtx)
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

    // 1,000-entry directory UI filtering benchmark <= 16 ms with 0 remote readdir calls
    const bulkBench = await evalJs(`(async () => {
        const tabEl = cpAdbTabEl('embedded')
        const panel = cpPanelForEl(tabEl)
        await panel.navigate('/bulk')
        const total = panel.fileList.length
        let readdirCalls = 0
        const origReaddir = panel.sftp.readdir.bind(panel.sftp)
        panel.sftp.readdir = async (...args) => {
            readdirCalls++
            return origReaddir(...args)
        }
        try {
            panel.showFilter = true
            panel.onFilterTextChange('g_c') // warm up
            const queries = ['g_c', 'item_05', 'e', 'g_comp_item_0995', 'no_match_xyz']
            const times = []
            for (const q of queries) {
                const start = performance.now()
                panel.onFilterTextChange(q)
                times.push(performance.now() - start)
            }
            const gCompCount = (() => {
                panel.onFilterTextChange('g_c')
                return panel.filteredFileList.length
            })()
            panel.clearFilter(true)
            return { total, readdirCalls, maxMs: Math.max(...times), times, gCompCount }
        } finally {
            panel.sftp.readdir = origReaddir
        }
    })()`, 15000)
    assert.equal(bulkBench.total, 1000)
    assert.equal(bulkBench.readdirCalls, 0)
    assert.equal(bulkBench.gCompCount, 200)
    assert.ok(bulkBench.maxMs <= 16, `Expected 1000-entry UI filter <= 16ms, got ${bulkBench.maxMs.toFixed(2)}ms`)

    // Path bar single-click edit, Esc cancel, Enter jump, and manual invalid-dir error keeping current valid list
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
        pathInput1.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        panel.cdr.detectChanges()
        const pathAfterEsc = panel.path
        const inputClosedAfterEsc = !panelEl.querySelector('[data-testid="path-input"]')

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

        await panel.navigate('/does-not-exist-manual')
        panel.cdr.detectChanges()
        return {
            inputAfterSingleClick,
            pathAfterEsc,
            inputClosedAfterEsc,
            pathAfterEnter,
            pathAfterInvalidManual: panel.path,
            keptHostsFile: panel.fileList.some(e => e.name === 'hosts'),
            errorBannerVisible: Boolean(panelEl.querySelector('[data-testid="error-banner"]')),
            invalidInRecent: panel.recentPaths.includes('/does-not-exist-manual'),
        }
    })()`, 15000)
    assert.deepEqual(pathBarAndManualError, {
        inputAfterSingleClick: true,
        pathAfterEsc: '/data/app',
        inputClosedAfterEsc: true,
        pathAfterEnter: '/etc',
        pathAfterInvalidManual: '/etc',
        keptHostsFile: true,
        errorBannerVisible: true,
        invalidInRecent: false,
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

    // SSH host isolation, independent favorites, CWD priority, non-bubbling clicks
    await open(title.ssh)
    await waitFor(() => evalJs("cpComponentEl(cpSshTabEl('127.0.0.1'))?.session?.open"))
    await open(title.ssh2)
    await waitFor(() => evalJs("cpComponentEl(cpSshTabEl('localhost'))?.session?.open"))

    const sshIsolationPhase1 = await evalJs(`(async () => {
        const openSftpFor = async host => {
            const tabEl = cpSshTabEl(host)
            const tab = cpComponentEl(tabEl)
            await tab.openSFTP()
            const deadline = Date.now() + 5000
            while (!Array.isArray(cpPanelForEl(tabEl)?.fileList) && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 30))
            }
            return { tabEl, tab, panel: cpPanelForEl(tabEl) }
        }
        const s1 = await openSftpFor('127.0.0.1')
        const ssh1InitialPath = s1.panel.path
        const ssh1InitialFavorites = [...s1.panel.favorites]
        await s1.panel.navigate(${JSON.stringify(join(sshRoot, 'sub-a'))})
        s1.panel.cdr.detectChanges()
        s1.tabEl.querySelector('sftp-panel [data-testid="favorite-toggle"]').click()
        s1.tabEl.querySelector('sftp-panel [data-testid="places-toggle"]').click()
        s1.panel.cdr.detectChanges()
        const ssh1StillVisibleAfterClicks = Boolean(s1.tabEl.querySelector('sftp-panel'))
        s1.tabEl.querySelector('sftp-panel [data-testid="places-toggle"]').click()

        const s2 = await openSftpFor('localhost')
        const ssh2InitialPath = s2.panel.path
        const ssh2InitialFavorites = [...s2.panel.favorites]
        await s2.panel.navigate(${JSON.stringify(join(sshRoot, 'sub-b'))})
        s2.panel.cdr.detectChanges()
        s2.tabEl.querySelector('sftp-panel [data-testid="favorite-toggle"]').click()

        // Test CWD priority on ssh1
        s1.tab.sftpPanelVisible = false
        s1.panel.cdr.detectChanges()
        const closeDeadline = Date.now() + 5000
        while (s1.tabEl.querySelector('sftp-panel') && Date.now() < closeDeadline) {
            await new Promise(r => setTimeout(r, 30))
        }
        s1.tab.session.reportedCWD = ${JSON.stringify(join(sshRoot, 'cwd-dir'))}
        const s1Cwd = await openSftpFor('127.0.0.1')
        const ssh1CwdPath = s1Cwd.panel.path
        // Restore sub-a as last visited so restart verifies ssh1 persistence
        s1Cwd.tab.session.reportedCWD = null
        await s1Cwd.panel.navigate(${JSON.stringify(join(sshRoot, 'sub-a'))})

        return {
            ssh1InitialPath,
            ssh1InitialFavorites,
            ssh1StillVisibleAfterClicks,
            ssh2InitialPath,
            ssh2InitialFavorites,
            ssh1CwdPath,
            ssh1FinalPath: s1Cwd.panel.path,
            ssh2FinalPath: s2.panel.path,
        }
    })()`, 15000)
    assert.deepEqual(sshIsolationPhase1, {
        ssh1InitialPath: '/',
        ssh1InitialFavorites: [],
        ssh1StillVisibleAfterClicks: true,
        ssh2InitialPath: '/',
        ssh2InitialFavorites: [],
        ssh1CwdPath: join(sshRoot, 'cwd-dir'),
        ssh1FinalPath: join(sshRoot, 'sub-a'),
        ssh2FinalPath: join(sshRoot, 'sub-b'),
    })

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

    // Verify SSH hosts restore independently across restart
    await open2(title.ssh)
    await waitFor(() => evalJs("cpComponentEl(cpSshTabEl('127.0.0.1'))?.session?.open"))
    await open2(title.ssh2)
    await waitFor(() => evalJs("cpComponentEl(cpSshTabEl('localhost'))?.session?.open"))
    const sshAfterRestart = await evalJs(`(async () => {
        const openAndRead = async host => {
            const tabEl = cpSshTabEl(host)
            const tab = cpComponentEl(tabEl)
            await tab.openSFTP()
            const deadline = Date.now() + 5000
            while (!Array.isArray(cpPanelForEl(tabEl)?.fileList) && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 30))
            }
            const panel = cpPanelForEl(tabEl)
            return { path: panel.path, favorites: [...panel.favorites] }
        }
        return {
            ssh1: await openAndRead('127.0.0.1'),
            ssh2: await openAndRead('localhost'),
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
        window.localStorage.removeItem('coport.filePanelState.v1')
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
            filteredNames: filterAndKeyboard.filteredNames,
            drillPath: filterAndKeyboard.drillPath,
            pathAfterBackspace: filterAndKeyboard.pathAfterBackspace,
            goUpKeptOnNoMatch: filterAndKeyboard.goUpKeptOnNoMatch,
            panelStillOpenAfterEsc: filterAndKeyboard.panelStillOpenAfterEsc,
        },
        bulkBench: {
            total: bulkBench.total,
            readdirCalls: bulkBench.readdirCalls,
            maxMs: Number(bulkBench.maxMs.toFixed(2)),
            gCompCount: bulkBench.gCompCount,
        },
        pathBarAndManualError,
        favoritesFlow,
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
    await rm(run, { recursive: true, force: true })
}
