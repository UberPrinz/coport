import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
    executeFilePanelStateOp,
    FILE_PANEL_STATE_IPC_CHANGED,
    FILE_PANEL_STATE_IPC_OP,
    FilePanelStateOpResponse,
    FilePanelStateStore,
    parseFilePanelStateSnapshot,
} from '../../../tabby-ssh/src/utils/filePanelState'

export const FILE_PANEL_STATE_FILENAME = 'coport-file-panel-state.json'

export interface FilePanelStateCoordinator {
    readonly store: FilePanelStateStore
    handleOp: (request: unknown) => FilePanelStateOpResponse
}

export function createFilePanelStateCoordinator (
    filePath: string,
    onChanged?: (scope: string) => void,
): FilePanelStateCoordinator {
    const store = new FilePanelStateStore(null)
    let writeCounter = 0

    try {
        const raw = readFileSync(filePath, 'utf8')
        store.loadSnapshot(parseFilePanelStateSnapshot(raw))
    } catch {
        // Missing or unreadable state file starts cleanly with empty state.
    }

    const persistSnapshot = (): void => {
        const serialized = JSON.stringify(store.getSnapshot())
        const tempPath = `${filePath}.${process.pid}.${++writeCounter}.tmp`
        try {
            mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
            writeFileSync(tempPath, serialized, { encoding: 'utf8', mode: 0o600 })
            renameSync(tempPath, filePath)
        } catch {
            // Keep in-memory store intact on write failure without rolling back.
            try {
                unlinkSync(tempPath)
            } catch {
                // Best-effort cleanup of temp file.
            }
        }
    }

    return {
        store,
        handleOp: (request: unknown): FilePanelStateOpResponse => {
            const response = executeFilePanelStateOp(store, request)
            if (response.ok && response.changedScope) {
                persistSnapshot()
                onChanged?.(response.changedScope)
            }
            return response
        },
    }
}

export function installFilePanelStateIpc (
    filePath = join(app.getPath('userData'), FILE_PANEL_STATE_FILENAME),
): void {
    const coordinator = createFilePanelStateCoordinator(filePath, scope => {
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
                win.webContents.send(FILE_PANEL_STATE_IPC_CHANGED, { scope })
            }
        }
    })

    ipcMain.on(FILE_PANEL_STATE_IPC_OP, (event, request) => {
        if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) {
            event.returnValue = {
                ok: false,
                error: 'File panel state IPC requires the main window frame',
            }
            return
        }
        event.returnValue = coordinator.handleOp(request)
    })
}
