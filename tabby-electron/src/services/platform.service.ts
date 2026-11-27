import * as path from 'path'
import * as crypto from 'crypto'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as os from 'os'
import promiseIpc, { RendererProcessType } from 'electron-promise-ipc'
import { execFile } from 'mz/child_process'
import { Injectable, NgZone } from '@angular/core'
import { PlatformService, ClipboardContent, Platform, MenuItemOptions, MessageBoxOptions, MessageBoxResult, DirectoryUpload, FileUpload, FileDownload, DirectoryDownload, FileUploadOptions, wrapPromise, TranslateService, FileTransfer, PlatformTheme } from 'tabby-core'
import { ElectronService } from '../services/electron.service'
import { ElectronHostWindow } from './hostWindow.service'
import { ShellIntegrationService } from './shellIntegration.service'
import { ElectronHostAppService } from './hostApp.service'
import { configPath } from '../../../app/lib/config'
const fontManager = require('fontmanager-redux') // eslint-disable-line

/* eslint-disable block-scoped-var */

try {
    // eslint-disable-next-line no-var
    var windowsProcessTreeNative = require('@tabby-gang/windows-process-tree/build/Release/windows_process_tree.node')
    // eslint-disable-next-line no-var
    var wnr = require('windows-native-registry')
} catch { }

/**
 * Resolve `relativePath` against `basePath` and ensure the result stays inside `basePath`.
 */
export function resolveInsideBase (basePath: string, relativePath: string): string {
    const base = path.resolve(basePath)
    const target = path.resolve(base, relativePath)
    const rel = path.relative(base, target)
    if (rel !== '' && (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))) {
        throw new Error(`Refusing access outside the target directory: ${relativePath}`)
    }
    return target
}

@Injectable({ providedIn: 'root' })
export class ElectronPlatformService extends PlatformService {
    supportsWindowControls = true
    private safeExternalSchemes = new Set(['http', 'https', 'ftp', 'mailto'])
    private configPath: string

    constructor (
        private hostApp: ElectronHostAppService,
        private hostWindow: ElectronHostWindow,
        private electron: ElectronService,
        private zone: NgZone,
        private shellIntegration: ShellIntegrationService,
        private translate: TranslateService,
    ) {
        super()
        this.configPath = configPath

        electron.ipcRenderer.on('host:display-metrics-changed', () => {
            this.zone.run(() => this.displayMetricsChanged.next())
        })

        electron.nativeTheme.on('updated', () => {
            this.zone.run(() => this.themeChanged.next(this.getTheme()))
        })
    }

    private async collectAllFiles (dir: string, root: DirectoryUpload, opened: FileUpload[]): Promise<DirectoryUpload> {
        const items = await fs.readdir(dir, { withFileTypes: true })
        for (const item of items) {
            if (item.isDirectory()) {
                const childDir = new DirectoryUpload(item.name)
                root.pushChildren(childDir)
                await this.collectAllFiles(path.join(dir, item.name), childDir, opened)
            } else {
                const file = new ElectronFileUpload(path.join(dir, item.name), this.electron)
                opened.push(file)
                root.pushChildren(file)
                await wrapPromise(this.zone, file.open())
            }
        }
        return root
    }

    async getAllFiles (dir: string, root: DirectoryUpload): Promise<DirectoryUpload> {
        const opened: FileUpload[] = []
        try {
            await this.collectAllFiles(dir, root, opened)
        } catch (error) {
            for (const file of opened) {
                if (!file.isCancelled()) {
                    file.cancel()
                }
            }
            throw error
        }
        for (const file of opened) {
            this.fileTransferStarted.next(file)
        }
        return root
    }

    readClipboard (): string {
        return this.electron.clipboard.readText()
    }

    setClipboard (content: ClipboardContent): void {
        require('@electron/remote').clipboard.write(content)
    }

    async installPlugin (name: string, version: string): Promise<void> {
        await (promiseIpc as RendererProcessType).send('plugin-manager:install', name, version)
    }

    async uninstallPlugin (name: string): Promise<void> {
        await (promiseIpc as RendererProcessType).send('plugin-manager:uninstall', name)
    }

    async isProcessRunning (name: string): Promise<boolean> {
        if (this.hostApp.platform === Platform.Windows) {
            return new Promise<boolean>(resolve => {
                windowsProcessTreeNative.getProcessList(list => { // eslint-disable-line block-scoped-var
                    resolve(list.some(x => x.name === name))
                }, 0)
            })
        } else {
            throw new Error('Not supported')
        }
    }

    getWinSCPPath (): string|null {
        const key = wnr.getRegistryKey(wnr.HK.CR, 'WinSCP.Url\\DefaultIcon')
        if (key?.['']) {
            let detectedPath = key[''].value?.split(',')[0]
            detectedPath = detectedPath?.substring(1, detectedPath.length - 1)
            return detectedPath
        }
        return null
    }

    async exec (app: string, argv: string[]): Promise<void> {
        await execFile(app, argv)
    }

    isShellIntegrationSupported (): boolean {
        return this.hostApp.platform !== Platform.Linux
    }

    async isShellIntegrationInstalled (): Promise<boolean> {
        return this.shellIntegration.isInstalled()
    }

    async installShellIntegration (): Promise<void> {
        await this.shellIntegration.install()
    }

    async uninstallShellIntegration (): Promise<void> {
        await this.shellIntegration.remove()
    }

    async loadConfig (): Promise<string> {
        if (fsSync.existsSync(this.configPath)) {
            return fs.readFile(this.configPath, 'utf8')
        } else {
            return ''
        }
    }

    async saveConfig (content: string): Promise<void> {
        await this.hostApp.saveConfig(content)
    }

    getConfigPath (): string|null {
        return this.configPath
    }

    showItemInFolder (p: string): void {
        this.electron.shell.showItemInFolder(p)
    }

    async openExternal (url: string): Promise<void> {
        const scheme = this.getExternalScheme(url)
        if (scheme && this.safeExternalSchemes.has(scheme)) {
            await this.electron.shell.openExternal(url)
        } else {
            await this.confirmAndOpenExternal(url)
        }
    }

    private getExternalScheme (url: string): string | null {
        try {
            const protocol = new URL(url.trim()).protocol
            return protocol ? protocol.replace(':', '').toLowerCase() : null
        } catch {
            return null
        }
    }

    private async confirmAndOpenExternal (url: string): Promise<void> {
        const scheme = this.getExternalScheme(url)
        const result = await this.electron.dialog.showMessageBox(
            this.hostWindow.getWindow(),
            {
                type: 'warning',
                message: this.translate.instant(`Open this app-specific "${scheme}" URI?`),
                detail: url,
                buttons: [
                    this.translate.instant('Open'),
                    this.translate.instant('Cancel'),
                ],
                defaultId: 0,
                cancelId: 1,
            },
        )

        if (result.response === 0) {
            await this.electron.shell.openExternal(url)
        }
    }

    openPath (p: string): void {
        this.electron.shell.openPath(p)
    }

    getOSRelease (): string {
        return os.release()
    }

    getAppVersion (): string {
        return this.electron.app.getVersion()
    }

    async listFonts (): Promise<string[]> {
        if (this.hostApp.platform === Platform.Windows || this.hostApp.platform === Platform.macOS) {
            let fonts = await new Promise<any[]>(resolve => fontManager.getAvailableFonts(resolve))
            fonts = fonts.map(x => x.family.trim())
            return fonts
        }
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (this.hostApp.platform === Platform.Linux) {
            const stdout = (await execFile('fc-list', [':spacing=mono']))[0]
            const fonts = stdout.toString()
                .split('\n')
                .filter(x => !!x)
                .map(x => x.split(':')[1].trim())
                .map(x => x.split(',')[0].trim())
            fonts.sort()
            return fonts
        }
        return []
    }

    popupContextMenu (menu: MenuItemOptions[], _event?: MouseEvent): void {
        this.electron.Menu.buildFromTemplate(menu.map(item => this.rewrapMenuItemOptions(item))).popup({})
    }

    rewrapMenuItemOptions (menu: MenuItemOptions): MenuItemOptions {
        return {
            ...menu,
            click: () => {
                this.zone.run(() => {
                    menu.click?.()
                })
            },
            submenu: menu.submenu ? menu.submenu.map(x => this.rewrapMenuItemOptions(x)) : undefined,
        }
    }

    async showMessageBox (options: MessageBoxOptions): Promise<MessageBoxResult> {
        return this.electron.dialog.showMessageBox(this.hostWindow.getWindow(), options)
    }

    quit (): void {
        this.electron.app.exit(0)
    }

    async startUpload (options?: FileUploadOptions, paths?: string[]): Promise<FileUpload[]> {
        options ??= { multiple: false }

        const properties: any[] = ['openFile', 'treatPackageAsDirectory']
        if (options.multiple) {
            properties.push('multiSelections')
        }

        if (!paths) {
            const result = await this.electron.dialog.showOpenDialog(
                this.hostWindow.getWindow(),
                {
                    buttonLabel: this.translate.instant('Select'),
                    properties,
                },
            )
            if (result.canceled) {
                return []
            }
            paths = result.filePaths
        }

        const opened: ElectronFileUpload[] = []
        try {
            for (const p of paths) {
                const transfer = new ElectronFileUpload(p, this.electron)
                opened.push(transfer)
                await wrapPromise(this.zone, transfer.open())
            }
        } catch (error) {
            for (const transfer of opened) {
                if (!transfer.isCancelled()) {
                    transfer.cancel()
                }
            }
            throw error
        }
        for (const transfer of opened) {
            this.fileTransferStarted.next(transfer)
        }
        return opened
    }

    async startUploadDirectory (paths?: string[]): Promise<DirectoryUpload> {
        const properties: any[] = ['openFile', 'treatPackageAsDirectory', 'openDirectory']

        if (!paths) {
            const result = await this.electron.dialog.showOpenDialog(
                this.hostWindow.getWindow(),
                {
                    buttonLabel: this.translate.instant('Select'),
                    properties,
                },
            )
            if (result.canceled) {
                return new DirectoryUpload()
            }
            paths = result.filePaths
        }

        const root = new DirectoryUpload()
        root.pushChildren(await this.getAllFiles(paths[0].split(path.sep).join(path.posix.sep), new DirectoryUpload(path.basename(paths[0]))))
        return root
    }

    async startDownload (
        name: string,
        mode: number,
        size: number,
        filePath?: string,
        atomic = false,
        canOpen?: () => boolean,
    ): Promise<FileDownload|null> {
        if (!filePath) {
            const result = await this.electron.dialog.showSaveDialog(
                this.hostWindow.getWindow(),
                {
                    defaultPath: name,
                },
            )
            if (!result.filePath) {
                return null
            }
            filePath = result.filePath
        }
        if (canOpen && !canOpen()) {
            return null
        }
        const transfer = new ElectronFileDownload(filePath, mode, size, this.electron, atomic, canOpen)
        try {
            await wrapPromise(this.zone, transfer.open())
        } catch (error) {
            if (canOpen && !canOpen()) {
                await transfer.waitForClose()
                return null
            }
            throw error
        }
        if (canOpen && !canOpen()) {
            transfer.cancel()
            await transfer.waitForClose()
            return null
        }
        this.fileTransferStarted.next(transfer)
        return transfer
    }

    async startDownloadDirectory (
        name: string,
        estimatedSize?: number,
        canOpen?: () => boolean,
    ): Promise<DirectoryDownload|null> {
        const selectedFolder = await this.pickDirectory(this.translate.instant('Select destination folder for {name}', { name }), this.translate.instant('Download here'))
        if (!selectedFolder) {
            return null
        }
        if (canOpen && !canOpen()) {
            return null
        }

        let downloadPath = resolveInsideBase(selectedFolder, name)
        let counter = 1
        while (fsSync.existsSync(downloadPath)) {
            downloadPath = resolveInsideBase(selectedFolder, `${name} (${counter})`)
            counter++
        }

        const transfer = new ElectronDirectoryDownload(downloadPath, name, estimatedSize ?? 0, this.electron, this.zone, canOpen)
        await wrapPromise(this.zone, transfer.open())
        if (canOpen && !canOpen()) {
            transfer.cancel()
            return null
        }
        this.fileTransferStarted.next(transfer)
        return transfer
    }

    _registerFileTransfer (transfer: FileTransfer): void {
        this.fileTransferStarted.next(transfer)
    }

    setErrorHandler (handler: (_: any) => void): void {
        this.electron.ipcRenderer.on('uncaughtException', (_$event, err) => {
            handler(err)
        })
    }

    async pickDirectory (title?: string, buttonLabel?: string): Promise<string | null> {
        const result = await this.electron.dialog.showOpenDialog(
            this.hostWindow.getWindow(),
            {
                title,
                buttonLabel,
                properties: ['openDirectory', 'showHiddenFiles'],
            },
        )
        if (result.canceled || !result.filePaths.length) {
            return null
        }
        return result.filePaths[0]
    }

    getTheme (): PlatformTheme {
        if (this.electron.nativeTheme.shouldUseDarkColors) {
            return 'dark'
        } else {
            return 'light'
        }
    }
}

class ElectronFileUpload extends FileUpload {
    private size = 0
    private mode = 0
    private file?: fs.FileHandle
    private buffer: Uint8Array
    private powerSaveBlocker = 0
    private closed = false

    constructor (private filePath: string, private electron: ElectronService) {
        super()
        this.buffer = new Uint8Array(256 * 1024)
        this.powerSaveBlocker = electron.powerSaveBlocker.start('prevent-app-suspension')
    }

    async open (): Promise<void> {
        try {
            const stat = await fs.stat(this.filePath)
            this.size = stat.size
            this.mode = stat.mode
            this.setTotalSize(this.size)
            const handle = await fs.open(this.filePath, 'r')
            if (this.closed || this.isCancelled()) {
                await handle.close().catch(() => null)
                return
            }
            this.file = handle
        } catch (error) {
            this.close()
            throw error
        }
    }

    getName (): string {
        return path.basename(this.filePath)
    }

    getMode (): number {
        return this.mode
    }

    getSize (): number {
        return this.size
    }

    async read (): Promise<Uint8Array> {
        if (!this.file) {
            throw new Error('File handle is closed')
        }
        const result = await this.file.read(this.buffer, 0, this.buffer.length, null)
        this.increaseProgress(result.bytesRead)
        if (this.getCompletedBytes() >= this.getSize()) {
            this.setCompleted(true)
        }
        return this.buffer.slice(0, result.bytesRead)
    }

    close (): void {
        if (this.closed) {
            return
        }
        this.closed = true
        this.electron.powerSaveBlocker.stop(this.powerSaveBlocker)
        const handle = this.file
        this.file = undefined
        void handle?.close().catch(() => null)
    }
}

class ElectronFileDownload extends FileDownload {
    private file?: fs.FileHandle
    private powerSaveBlocker = 0
    private temporary?: { id?: string, path: string }
    private closing?: Promise<void>
    private cleanupPromise?: Promise<void>
    private closed = false

    constructor (
        private filePath: string,
        private mode: number,
        private size: number,
        private electron: ElectronService,
        private atomic = false,
        private canCommit?: () => boolean,
    ) {
        super()
        this.powerSaveBlocker = electron.powerSaveBlocker.start('prevent-app-suspension')
        this.setTotalSize(size)
        this.setPendingCommit(atomic)
    }

    private async reserveTemporary (): Promise<{ id?: string, path: string }> {
        const ipcRenderer = this.electron.ipcRenderer as { invoke?: (channel: string, ...args: any[]) => Promise<any> } | undefined
        if (ipcRenderer?.invoke) {
            try {
                const reply = await ipcRenderer.invoke('coport-adb:fs:reserve-local', { target: this.filePath })
                if (reply && typeof reply === 'object' && 'ok' in reply) {
                    if (!reply.ok) {
                        throw new Error(reply.error?.message ?? 'Failed to reserve download destination')
                    }
                    return reply.result
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                if (!/no handler registered/i.test(message)) {
                    throw error
                }
            }
        }
        const tempPath = path.join(path.dirname(this.filePath), `.coport-download-${crypto.randomUUID()}`)
        const handle = await fs.open(tempPath, 'wx', 0o600)
        await handle.close()
        return { path: tempPath }
    }

    private releaseTemporary (): Promise<void> {
        const temp = this.temporary
        if (!temp) {
            return Promise.resolve()
        }
        this.temporary = undefined
        if (temp.id) {
            return this.electron.ipcRenderer.invoke('coport-adb:fs:release-local', { id: temp.id }).then(() => undefined)
        }
        return fs.rm(temp.path, { force: true })
    }

    async open (): Promise<void> {
        try {
            if (this.atomic) {
                this.temporary = await this.reserveTemporary()
                if (this.closed || this.isCancelled() || (this.canCommit && !this.canCommit())) {
                    throw new Error('Download cancelled')
                }
                this.file = await fs.open(this.temporary.path, 'r+', this.mode)
            } else {
                this.file = await fs.open(this.filePath, 'w', this.mode)
            }
            if (this.closed || this.isCancelled() || (this.canCommit && !this.canCommit())) {
                throw new Error('Download cancelled')
            }
        } catch (error) {
            this.close()
            await this.waitForClose()
            throw error
        }
    }

    getName (): string {
        return path.basename(this.filePath)
    }

    getSize (): number {
        return this.size
    }

    async write (buffer: Uint8Array): Promise<void> {
        let pos = 0
        while (pos < buffer.length) {
            const result = await this.file!.write(buffer, pos, buffer.length - pos, null)
            this.increaseProgress(result.bytesWritten)
            pos += result.bytesWritten
        }
        if (this.getCompletedBytes() >= this.getSize()) {
            this.setCompleted(true)
        }
    }

    private closeHandle (): Promise<void> {
        return this.closing ??= this.file?.close() ?? Promise.resolve()
    }

    async completeDownload (): Promise<void> {
        if (this.temporary) {
            await this.closeHandle()
            if (this.isCancelled() || (this.canCommit && !this.canCommit())) {
                this.cancel()
                await this.waitForClose()
                throw new Error('Download cancelled')
            }
            const targetMode = (this.mode & 0o777) ? (this.mode & 0o777 & ~process.umask()) : (0o666 & ~process.umask())
            await fs.chmod(this.temporary.path, targetMode)
            if (this.isCancelled() || (this.canCommit && !this.canCommit())) {
                this.cancel()
                await this.waitForClose()
                throw new Error('Download cancelled')
            }
            await fs.rename(this.temporary.path, this.filePath)
        } else if (this.isCancelled() || (this.canCommit && !this.canCommit())) {
            this.cancel()
            await this.waitForClose()
            throw new Error('Download cancelled')
        }
        await super.completeDownload()
    }

    async waitForClose (): Promise<void> {
        await this.cleanupPromise
    }

    close (): void {
        if (this.closed) {
            return
        }
        this.closed = true
        this.electron.powerSaveBlocker.stop(this.powerSaveBlocker)
        this.cleanupPromise = this.closeHandle()
            .finally(() => this.releaseTemporary())
            .catch(console.error)
    }
}

class ElectronDirectoryDownload extends DirectoryDownload {
    private powerSaveBlocker = 0
    private closed = false

    constructor (
        private basePath: string,
        private name: string,
        estimatedSize: number,
        private electron: ElectronService,
        private zone: NgZone,
        private canCommit?: () => boolean,
    ) {
        super()
        this.powerSaveBlocker = electron.powerSaveBlocker.start('prevent-app-suspension')
        this.setTotalSize(estimatedSize)
    }

    async open (): Promise<void> {
        await fs.mkdir(this.basePath, { recursive: true })
    }

    getName (): string {
        return this.name
    }

    getSize (): number {
        return this.getTotalSize()
    }

    async createDirectory (relativePath: string): Promise<void> {
        const fullPath = resolveInsideBase(this.basePath, relativePath)
        await fs.mkdir(fullPath, { recursive: true })
    }

    async createFile (relativePath: string, mode: number, size: number, atomic = false): Promise<FileDownload> {
        const fullPath = resolveInsideBase(this.basePath, relativePath)
        await fs.mkdir(path.dirname(fullPath), { recursive: true })

        const fileDownload = new ElectronFileDownload(fullPath, mode, size, this.electron, atomic, this.canCommit)
        await wrapPromise(this.zone, fileDownload.open())
        return fileDownload
    }

    close (): void {
        if (this.closed) {
            return
        }
        this.closed = true
        this.electron.powerSaveBlocker.stop(this.powerSaveBlocker)
    }
}
