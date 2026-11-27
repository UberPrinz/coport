import { MenuItemOptions } from './menu'
import { Subject, Observable } from 'rxjs'

/* eslint-disable @typescript-eslint/no-unused-vars */
export interface ClipboardContent {
    text: string
    html?: string
}

export interface MessageBoxOptions {
    type: 'warning'|'error'
    message: string
    detail?: string
    buttons: string[]
    defaultId?: number
    cancelId?: number
}

export interface MessageBoxResult {
    response: number
}

export abstract class FileTransfer {
    abstract getName (): string
    abstract getSize (): number
    abstract close (): void

    getSpeed (): number {
        return this.lastChunkSpeed
    }

    getCompletedBytes (): number {
        return this.completedBytes
    }

    getStatus (): string {
        return this.status
    }

    getTotalSize (): number {
        return this.totalSize
    }

    isComplete (): boolean {
        return !this.cancelled && !this.pendingCommit && (this.completed || this.completedBytes >= this.getSize())
    }

    // coport: Staged transfers remain cancellable until the destination commits them.
    setPendingCommit (pending: boolean): void {
        this.pendingCommit = pending
    }

    protected isPendingCommit (): boolean {
        return this.pendingCommit
    }

    protected isCompleted (): boolean {
        return this.completed
    }

    isCancelled (): boolean {
        return this.cancelled
    }

    // coport: Once an irreversible commit (such as atomic rename) starts,
    // cancel() cannot roll it back; pending cancel intent is replayed only if commit fails.
    protected setCommitting (committing: boolean): void {
        this.committing = committing
        if (committing) {
            this.cancelRequestedDuringCommit = false
        }
    }

    protected consumeCancelRequestedDuringCommit (): boolean {
        const requested = this.cancelRequestedDuringCommit
        this.cancelRequestedDuringCommit = false
        return requested
    }

    protected markCommitted (): void {
        this.committed = true
        this.committing = false
        this.cancelRequestedDuringCommit = false
    }

    cancel (): void {
        if (this.committed) {
            return
        }
        if (this.committing) {
            this.cancelRequestedDuringCommit = true
            return
        }
        this.cancelled = true
        this.close()
    }

    setStatus (status: string): void {
        this.status = status
    }

    setTotalSize (size: number): void {
        this.totalSize = size
    }

    setCompleted (completed: boolean): void {
        this.completed = completed
    }

    protected increaseProgress (bytes: number): void {
        if (!bytes) {
            return
        }
        this.completedBytes += bytes
        this.lastChunkSpeed = bytes * 1000 / (Date.now() - this.lastChunkStartTime)
        this.lastChunkStartTime = Date.now()
    }

    private completedBytes = 0
    private totalSize = 0
    private lastChunkStartTime = Date.now()
    private lastChunkSpeed = 0
    private cancelled = false
    private pendingCommit = false
    private committing = false
    private committed = false
    private cancelRequestedDuringCommit = false
    private completed = false
    private status = ''
}

export abstract class FileDownload extends FileTransfer {
    abstract write (buffer: Uint8Array): Promise<void>

    async completeDownload (): Promise<void> {
        this.markCommitted()
        this.setPendingCommit(false)
        this.setCompleted(true)
        this.close()
    }
}

export abstract class DirectoryDownload extends FileTransfer {
    abstract createDirectory (relativePath: string): Promise<void>
    abstract createFile (relativePath: string, mode: number, size: number, atomic?: boolean): Promise<FileDownload>
}

export abstract class FileUpload extends FileTransfer {
    abstract getMode (): number

    abstract read (): Promise<Uint8Array>

    // coport: Queued 0-byte uploads must not appear complete before upload finishes and commits.
    isComplete (): boolean {
        if (this.isCancelled() || this.isPendingCommit()) {
            return false
        }
        if (this.isCompleted()) {
            return true
        }
        const size = this.getSize()
        return size > 0 && this.getCompletedBytes() >= size
    }

    async readAll (): Promise<Uint8Array> {
        const result = new Uint8Array(this.getSize())
        let pos = 0
        while (true) {
            const buf = await this.read()
            if (!buf.length) {
                break
            }
            result.set(buf, pos)
            pos += buf.length
        }
        this.setCompleted(true)
        this.close()
        return result
    }
}

export interface FileUploadOptions {
    multiple: boolean
}

export class DirectoryUpload {
    private childrens: (FileUpload|DirectoryUpload)[] = []

    constructor (private name = '') {
        // Just set name for now.
    }

    getName (): string {
        return this.name
    }

    getChildrens (): (FileUpload|DirectoryUpload)[] {
        return this.childrens
    }

    pushChildren (item: FileUpload|DirectoryUpload): void {
        this.childrens.push(item)
    }
}

export type PlatformTheme = 'light'|'dark'

export abstract class PlatformService {
    supportsWindowControls = false

    get fileTransferStarted$ (): Observable<FileTransfer> { return this.fileTransferStarted }
    get displayMetricsChanged$ (): Observable<void> { return this.displayMetricsChanged }
    get themeChanged$ (): Observable<PlatformTheme> { return this.themeChanged }

    protected fileTransferStarted = new Subject<FileTransfer>()
    protected displayMetricsChanged = new Subject<void>()
    protected themeChanged = new Subject<PlatformTheme>()

    abstract readClipboard (): string
    abstract setClipboard (content: ClipboardContent): void
    abstract loadConfig (): Promise<string>
    abstract saveConfig (content: string): Promise<void>

    abstract startDownload (name: string, mode: number, size: number, filePath?: string, atomic?: boolean, canOpen?: () => boolean): Promise<FileDownload|null>
    abstract startDownloadDirectory (name: string, estimatedSize?: number, canOpen?: () => boolean): Promise<DirectoryDownload|null>
    abstract startUpload (options?: FileUploadOptions): Promise<FileUpload[]>
    abstract startUploadDirectory (paths?: string[]): Promise<DirectoryUpload>

    async startUploadFromDragEvent (event: DragEvent, multiple = false, canAccept?: () => boolean): Promise<DirectoryUpload> {
        const result = new DirectoryUpload()

        if (!event.dataTransfer) {
            return Promise.resolve(result)
        }

        const created: FileUpload[] = []
        let aborted = false
        const cancelCreated = () => {
            aborted = true
            for (const transfer of created) {
                if (!transfer.isCancelled()) {
                    transfer.cancel()
                }
            }
        }

        const traverseFileTree = (item: any, root: DirectoryUpload = result): Promise<void> => {
            return new Promise((resolve, reject) => {
                if (item.isFile) {
                    item.file((file: File) => {
                        const transfer = new HTMLFileUpload(file)
                        if (aborted) {
                            transfer.cancel()
                            resolve()
                            return
                        }
                        created.push(transfer)
                        root.pushChildren(transfer)
                        resolve()
                    }, reject)
                } else if (item.isDirectory) {
                    const dirReader = item.createReader()
                    const childrenFolder = new DirectoryUpload(item.name)
                    root.pushChildren(childrenFolder)
                    dirReader.readEntries(async (entries: any[]) => {
                        try {
                            for (const entry of entries) {
                                await traverseFileTree(entry, childrenFolder)
                            }
                            resolve()
                        } catch (error) {
                            reject(error)
                        }
                    }, reject)
                } else {
                    resolve()
                }
            })
        }

        const promises: Promise<void>[] = []

        const items = event.dataTransfer.items
        // eslint-disable-next-line @typescript-eslint/prefer-for-of
        for (let i = 0; i < items.length; i++) {
            const item = items[i].webkitGetAsEntry()
            if (item) {
                promises.push(traverseFileTree(item))
                if (!multiple) {
                    break
                }
            }
        }
        try {
            await Promise.all(promises)
        } catch (error) {
            aborted = true
            await Promise.allSettled(promises)
            cancelCreated()
            throw error
        }
        if (canAccept && !canAccept()) {
            cancelCreated()
            return result
        }
        for (const transfer of created) {
            this.fileTransferStarted.next(transfer)
        }
        return result
    }

    getConfigPath (): string|null {
        return null
    }

    showItemInFolder (path: string): void {
        throw new Error('Not implemented')
    }

    async isProcessRunning (name: string): Promise<boolean> {
        return false
    }

    async installPlugin (name: string, version: string): Promise<void> {
        throw new Error('Not implemented')
    }

    async uninstallPlugin (name: string): Promise<void> {
        throw new Error('Not implemented')
    }

    getWinSCPPath (): string|null {
        throw new Error('Not implemented')
    }

    async exec (app: string, argv: string[]): Promise<void> {
        throw new Error('Not implemented')
    }

    isShellIntegrationSupported (): boolean {
        return false
    }

    async isShellIntegrationInstalled (): Promise<boolean> {
        return false
    }

    async installShellIntegration (): Promise<void> {
        throw new Error('Not implemented')
    }

    async uninstallShellIntegration (): Promise<void> {
        throw new Error('Not implemented')
    }

    openPath (path: string): void {
        throw new Error('Not implemented')
    }

    getTheme (): PlatformTheme {
        return 'dark'
    }

    abstract getOSRelease (): string
    abstract getAppVersion (): string
    abstract openExternal (url: string): Promise<void>
    abstract listFonts (): Promise<string[]>
    abstract setErrorHandler (handler: (_: any) => void): void
    abstract popupContextMenu (menu: MenuItemOptions[], event?: MouseEvent): void
    abstract showMessageBox (options: MessageBoxOptions): Promise<MessageBoxResult>
    abstract pickDirectory (): Promise<string | null>
    abstract quit (): void
}

export class HTMLFileUpload extends FileUpload {
    private stream: ReadableStream
    private reader: ReadableStreamDefaultReader

    constructor (private file: File) {
        super()
        this.stream = this.file.stream()
        this.reader = this.stream.getReader()
    }

    getName (): string {
        return this.file.name
    }

    getMode (): number {
        return 0o644
    }

    getSize (): number {
        return this.file.size
    }

    async read (): Promise<Uint8Array> {
        const result: any = await this.reader.read()
        if (result.done || !result.value) {
            return new Uint8Array(0)
        }
        const chunk = new Uint8Array(result.value)
        this.increaseProgress(chunk.length)
        return chunk
    }

    private closed = false

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    bringToFront (): void { }

    close (): void {
        if (this.closed) {
            return
        }
        this.closed = true
        if (!this.isCancelled() && this.getCompletedBytes() >= this.getSize()) {
            this.setCompleted(true)
        }
        void this.reader.cancel().catch(() => null)
    }
}
