import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import {
    FILE_PANEL_STATE_IPC_CHANGED,
    FILE_PANEL_STATE_IPC_OP,
} from '../../../tabby-ssh/src/utils/filePanelState'
import {
    createFilePanelStateCoordinator,
    FILE_PANEL_STATE_FILENAME,
} from './filePanelStateCoordinator'

export { createFilePanelStateCoordinator, FILE_PANEL_STATE_FILENAME }

export function installFilePanelStateIpc (
    filePath = join(app.getPath('userData'), FILE_PANEL_STATE_FILENAME),
): void {
    const coordinator = createFilePanelStateCoordinator({
        filePath,
        broadcast: payload => {
            for (const win of BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
                    win.webContents.send(FILE_PANEL_STATE_IPC_CHANGED, payload)
                }
            }
        },
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
