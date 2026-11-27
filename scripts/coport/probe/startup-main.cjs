const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, ipcMain } = require('electron')

const checkout = process.cwd()
const dataDir = fs.mkdtempSync(path.join(checkout, 'dist/coport-m0/startup-'))
app.setPath('userData', dataDir)
app.setAppPath(path.join(checkout, 'app'))
// The smoke test must leave the existing tabby:// handler intact.
app.setAsDefaultProtocolClient = () => true
process.env.TABBY_DEV = '1'
process.env.TABBY_CONFIG_DIRECTORY = dataDir
process.env.TABBY_PLUGINS = ''
fs.writeFileSync(path.join(dataDir, 'config.yaml'), [
    'enableAnalytics: false',
    'enableAutomaticUpdates: false',
    'recoverTabs: false',
].join('\n'))
process.argv.push('--hidden')
const timer = setTimeout(() => {
    console.error('Fork startup timed out before app:ready')
    app.exit(1)
}, 15000)
ipcMain.once('app:ready', async event => {
    assert.notEqual(await event.sender.executeJavaScript('document.readyState'), 'loading')
    clearTimeout(timer)
    assert.ok(event.sender.getURL().startsWith('file:'))
    console.log(JSON.stringify({ event: 'app:ready', electron: process.versions.electron, dataDir }))
    // Let the stock renderer complete startup IPC before shutting down the smoke run.
    setTimeout(() => app.quit(), 750)
})
require(path.join(app.getAppPath(), 'dist/main.js'))
