const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const requireProbe = createRequire(path.resolve('dist/coport-m0/probe-deps/package.json'))
const { app, BrowserWindow } = require('electron')
const { collect, replay } = require('./history.cjs')

async function main(workDir) {
    const source = path.resolve(process.env.COPORT_SOURCE ?? '../coport')
    const historyPath = path.join(workDir, 'upstream-history.cjs')
    const historySource = 'Sources/CoportApp/Resources/tabby-coport/history.js'
    fs.writeFileSync(historyPath, execFileSync('git', ['-C', source, 'show', `2c1ea46:${historySource}`]))
    const { History } = require(historyPath)
    const addon = requireProbe.resolve('@xterm/addon-serialize')
    const renderer = requireProbe.resolve('@xterm/xterm')
    const rendererWindow = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
    })
    await rendererWindow.loadURL('about:blank')
    const original = await rendererWindow.webContents.executeJavaScript(`
        require(${JSON.stringify(require.resolve('./history.cjs'))}).collect(
            require(${JSON.stringify(renderer)}).Terminal,
            require(${JSON.stringify(historyPath)}).History,
            require(${JSON.stringify(addon)}).SerializeAddon,
        )
    `)
    assert.deepEqual(original.prompts.map(x => x.empty), original.expected)
    assert.equal(original.lines.filter(x => /^ROW\d{5} /.test(x.text)).length, 20000)

    const headless = await collect(requireProbe('@xterm/headless').Terminal, History, require(addon).SerializeAddon)
    assert.deepEqual(headless.prompts, original.prompts)
    assert.deepEqual(headless.lines, original.lines)
    assert.deepEqual(headless.screen, original.screen)
    const restored = await rendererWindow.webContents.executeJavaScript(`
        require(${JSON.stringify(require.resolve('./history.cjs'))}).replay(
            require(${JSON.stringify(renderer)}).Terminal,
            ${JSON.stringify(headless.snapshot)},
        )
    `)
    assert.deepEqual(restored, original.screen)
    console.log(JSON.stringify({
        probe: 'P1', electron: process.versions.electron, samples: headless.prompts,
        lines: headless.lines.length, restoredRows: restored.length, bytes: headless.bytes,
        headlessMs: Math.round(headless.elapsed), rendererMs: Math.round(original.elapsed),
    }))
    assert.ok(headless.elapsed < 500, `headless parse took ${headless.elapsed} ms`)
}

const workDir = fs.mkdtempSync(path.resolve('dist/coport-m0/p1-'))
app.setPath('userData', workDir)
app.whenReady().then(() => main(workDir)).then(() => app.exit(0), error => {
    console.error(error)
    app.exit(1)
})
