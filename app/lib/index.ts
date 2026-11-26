// Registers main-process error logging - must be first so it catches import-time errors
import { logMainError } from './errors'

import { app, ipcMain, Menu, dialog } from 'electron'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

// set userData Path on portable version
import './portable'

// set defaults of environment variables
import 'dotenv/config'
process.env.TABBY_PLUGINS ??= ''
// coport: Explicit user-data overrides isolate config, caches, plugins and IPC.
const isolatedDir = app.commandLine.getSwitchValue('user-data-dir')
if (isolatedDir) {
    const directory = resolve(isolatedDir)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    app.setPath('userData', directory)
    process.env.TABBY_CONFIG_DIRECTORY = directory
}
process.env.TABBY_CONFIG_DIRECTORY ??= app.getPath('userData')

process.setSourceMapsEnabled(true)
import './sentry'
import './lru'
import { parseArgs } from './cli'
import { Application } from './app'
import electronDebug from 'electron-debug'
import { loadConfig } from './config'
// coport: Serial state belongs to the main process and survives renderer teardown.
import { SessionManager } from './coport/sessionManager'
import { installSerialIpc } from './coport/serialIpc'

const argv = parseArgs(process.argv, process.cwd())

// eslint-disable-next-line @typescript-eslint/init-declarations
let configStore: any

try {
    configStore = loadConfig()
} catch (err) {
    dialog.showErrorBox('Could not read config', err.message)
    app.exit(1)
}

process.mainModule = module

const application = new Application(configStore)
const serial = new SessionManager()
const background = process.argv.includes('--coport-background')

let quitting = false
let serialStopped = false
// coport: Leave serial intact if the renderer cancels the quit request.
app.on('will-quit', event => {
    if (!serialStopped) {
        event.preventDefault()
        if (!quitting) {
            quitting = true
            void serial.shutdown().finally(() => {
                serialStopped = true
                app.quit()
            })
        }
    }
})

// Register tabby:// URL scheme
// coport: Isolated runs leave the host URL handler untouched.
if (!isolatedDir) {
    if (process.defaultApp) {
        if (process.argv.length >= 2) {
            app.setAsDefaultProtocolClient('tabby', process.execPath, [process.argv[1]])
        }
    } else {
        app.setAsDefaultProtocolClient('tabby')
    }
}

ipcMain.on('app:new-window', () => {
    application.newWindow()
})

process.on('uncaughtException', err => {
    application.broadcast('uncaughtException', err)
})

if (argv.d) {
    electronDebug({
        isEnabled: true,
        showDevTools: true,
        devToolsMode: 'undocked',
    })
}

app.on('activate', async () => {
    if (quitting || !app.isReady()) {
        return
    }
    if (!application.hasWindows()) {
        application.newWindow()
    } else {
        application.focus()
    }
})

// Handle URL scheme on macOS
app.on('open-url', async (event, url) => {
    event.preventDefault()
    console.log('Received open-url event:', url)
    if (!application.hasWindows()) {
        process.argv.push(url)
    } else {
        await app.whenReady()
        application.handleSecondInstance([url], process.cwd())
    }
})

app.on('second-instance', async (_event, newArgv, cwd) => {
    // coport: A shim launch must not reveal any windows.
    if (!quitting && !newArgv.includes('--coport-background')) {
        application.handleSecondInstance(newArgv, cwd)
    }
})

if (!app.requestSingleInstanceLock()) {
    app.quit()
    app.exit(0)
}

app.on('ready', async () => {
    if (process.platform === 'darwin') {
        app.dock?.setMenu(Menu.buildFromTemplate([
            {
                label: 'New window',
                click () {
                    void application.newWindow()
                },
            },
        ]))
    }

    try {
        application.init()
        installSerialIpc(serial)
        console.log('coport: ready')
        if (background) {
            return
        }

        const window = await application.newWindow({ hidden: argv.hidden })
        await window.ready
        window.passCliArguments(process.argv, process.cwd(), false)
        window.focus()
    } catch (err) {
        logMainError('Failed to open window', err)
        dialog.showErrorBox('Coport failed to start', String(err?.stack ?? err))
        app.exit(1)
    }
})
