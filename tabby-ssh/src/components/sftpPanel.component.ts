import * as C from 'constants'
import { posix as path } from 'path'
import { Component, Input, Output, EventEmitter, Inject, Optional } from '@angular/core'
import { FileUpload, DirectoryUpload, DirectoryDownload, MenuItemOptions, NotificationsService, PlatformService } from 'tabby-core'
import { SFTPFile } from '../session/sftp'
import { FileBackend } from '../api/fileBackend'
import { SFTPContextMenuItemProvider } from '../api'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { SFTPCreateDirectoryModalComponent } from './sftpCreateDirectoryModal.component'

interface PathSegment {
    name: string
    path: string
}

@Component({
    selector: 'sftp-panel',
    templateUrl: './sftpPanel.component.pug',
    styleUrls: ['./sftpPanel.component.scss'],
})
export class SFTPPanelComponent {
    @Input() session: { openSFTP: () => Promise<FileBackend> } // coport: Used by SSH and ADB.
    @Output() closed = new EventEmitter<void>()
    sftp: FileBackend
    fileList: SFTPFile[]|null = null
    filteredFileList: SFTPFile[] = []
    @Input() path = '/'
    @Output() pathChange = new EventEmitter<string>()
    pathSegments: PathSegment[] = []
    @Input() cwdDetectionAvailable: boolean | null = false
    @Input() rootLabel = 'SFTP' // coport: ADB uses the same panel.
    editingPath: string|null = null
    showFilter = false
    filterText = ''
    private navigation = 0
    readonly getDropTarget = (): string => this.path

    constructor (
        private ngbModal: NgbModal,
        private notifications: NotificationsService,
        public platform: PlatformService,
        @Optional() @Inject(SFTPContextMenuItemProvider) protected contextMenuProviders: SFTPContextMenuItemProvider[],
    ) {
        this.contextMenuProviders.sort((a, b) => a.weight - b.weight)
    }

    async ngOnInit (): Promise<void> {
        this.sftp = await this.session.openSFTP()
        try {
            await this.navigate(this.path)
        } catch (error) {
            console.warn('Could not navigate to', this.path, ':', error)
            this.notifications.error(error.message)
            await this.navigate('/')
        }
    }

    async navigate (newPath: string, fallbackOnError = true): Promise<void> {
        newPath = this.sftp.normalizePath?.(newPath) ?? newPath
        const request = ++this.navigation
        const previousPath = this.path
        this.path = newPath
        this.pathChange.next(this.path)

        this.clearFilter()

        let p = newPath
        this.pathSegments = []
        while (p !== '/' && p !== '.') {
            this.pathSegments.unshift({
                name: path.basename(p),
                path: p,
            })
            const parent = path.dirname(p)
            if (parent === p) {
                break
            }
            p = parent
        }

        this.fileList = null
        this.filteredFileList = []
        try {
            const entries = await this.sftp.readdir(newPath)
            if (request !== this.navigation) {
                return
            }
            this.fileList = entries
        } catch (error) {
            if (request === this.navigation) {
                this.notifications.error(error.message)
                if (previousPath && fallbackOnError) {
                    void this.navigate(previousPath, false)
                }
            }
            return
        }

        const dirKey = a => a.isDirectory ? 1 : 0
        this.fileList.sort((a, b) =>
            dirKey(b) - dirKey(a) ||
            a.name.localeCompare(b.name))

        this.updateFilteredList()
    }

    getFileType (fileExtension: string): string {
        const codeExtensions = ['js', 'ts', 'py', 'java', 'cpp', 'h', 'cs', 'html', 'css', 'rb', 'php', 'swift', 'go', 'kt', 'sh', 'json', 'cc', 'c', 'xml']
        const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp']
        const pdfExtensions = ['pdf']
        const archiveExtensions = ['zip', 'rar', 'tar', 'gz']
        const wordExtensions = ['doc', 'docx']
        const videoExtensions = ['mp4', 'avi', 'mkv', 'mov']
        const powerpointExtensions = ['ppt', 'pptx']
        const textExtensions = ['txt', 'log']
        const audioExtensions = ['mp3', 'wav', 'flac']
        const excelExtensions = ['xls', 'xlsx']

        const lowerCaseExtension = fileExtension.toLowerCase()

        if (codeExtensions.includes(lowerCaseExtension)) {
            return 'code'
        } else if (imageExtensions.includes(lowerCaseExtension)) {
            return 'image'
        } else if (pdfExtensions.includes(lowerCaseExtension)) {
            return 'pdf'
        } else if (archiveExtensions.includes(lowerCaseExtension)) {
            return 'archive'
        } else if (wordExtensions.includes(lowerCaseExtension)) {
            return 'word'
        } else if (videoExtensions.includes(lowerCaseExtension)) {
            return 'video'
        } else if (powerpointExtensions.includes(lowerCaseExtension)) {
            return 'powerpoint'
        } else if (textExtensions.includes(lowerCaseExtension)) {
            return 'text'
        } else if (audioExtensions.includes(lowerCaseExtension)) {
            return 'audio'
        } else if (excelExtensions.includes(lowerCaseExtension)) {
            return 'excel'
        } else {
            return 'unknown'
        }
    }

    getIcon (item: SFTPFile): string {
        if (item.isDirectory) {
            return 'fas fa-folder text-info'
        }
        if (item.isSymlink) {
            return 'fas fa-link text-warning'
        }
        const fileMatch = /\.([^.]+)$/.exec(item.name)
        const extension = fileMatch ? fileMatch[1] : null
        if (extension !== null) {
            const fileType = this.getFileType(extension)

            switch (fileType) {
                case 'unknown':
                    return 'fas fa-file'
                default:
                    return `fa-solid fa-file-${fileType} `
            }
        }
        return 'fas fa-file'
    }

    goUp (): void {
        this.navigate(path.dirname(this.path))
    }

    private async resolveLink (item: SFTPFile): Promise<SFTPFile | undefined> {
        if (!item.isSymlink) {
            return item
        }
        try {
            return await this.sftp.stat(item.fullPath)
        } catch (error) {
            this.notifications.error(error.message)
            return undefined
        }
    }

    async open (item: SFTPFile): Promise<void> {
        const target = await this.resolveLink(item)
        if (!target) {
            return
        }
        if (target.isDirectory) {
            await this.navigate(item.fullPath)
        } else {
            await this.download(item.fullPath, target.mode, target.size)
        }
    }

    async downloadItem (item: SFTPFile): Promise<void> {
        const target = await this.resolveLink(item)
        if (!target) {
            return
        }
        if (target.isDirectory) {
            await this.downloadFolder(item)
        } else {
            await this.download(item.fullPath, target.mode, target.size)
        }
    }

    async openCreateDirectoryModal (): Promise<void> {
        const modal = this.ngbModal.open(SFTPCreateDirectoryModalComponent)
        const directoryName = await modal.result.catch(() => null)
        if (directoryName?.trim()) {
            this.sftp.mkdir(path.join(this.path, directoryName)).then(() => {
                this.notifications.notice('The directory was created successfully')
                this.navigate(path.join(this.path, directoryName))
            }).catch(() => {
                this.notifications.error('The directory could not be created')
            })
        }
    }

    async upload (): Promise<void> {
        const target = this.path
        try {
            const transfers = await this.platform.startUpload({ multiple: true })
            await Promise.all(transfers.map(t => this.uploadOne(t, target)))
        } catch (error) {
            this.notifications.error(error.message)
        }
    }

    async uploadFolder (): Promise<void> {
        const target = this.path
        try {
            const transfer = await this.platform.startUploadDirectory()
            await this.uploadOneFolder(transfer, target)
        } catch (error) {
            this.notifications.error(error.message)
        }
    }

    async uploadOneFolder (transfer: DirectoryUpload, base = this.path): Promise<void> {
        const request = this.navigation
        try {
            await this.uploadDirectoryEntries(transfer, base)
            if (request === this.navigation && base === this.path) {
                await this.navigate(base)
            }
        } catch (error) {
            this.notifications.error(error.message)
        }
    }

    private async uploadDirectoryEntries (transfer: DirectoryUpload, directory: string): Promise<void> {
        for (const child of transfer.getChildrens()) {
            const target = path.join(directory, child.getName())
            if (child instanceof DirectoryUpload) {
                try {
                    await this.sftp.mkdir(target)
                } catch {
                    // Intentionally ignoring errors from making duplicate dirs.
                }
                await this.uploadDirectoryEntries(child, target)
            } else {
                await this.sftp.upload(target, child)
            }
        }
    }

    async uploadOne (transfer: FileUpload, target = this.path): Promise<void> {
        await this.sftp.upload(path.join(target, transfer.getName()), transfer)
        if (this.path === target) {
            await this.navigate(target)
        }
    }

    async download (itemPath: string, mode: number, size: number): Promise<void> {
        try {
            const transfer = await this.platform.startDownload(path.basename(itemPath), mode, size, undefined, this.sftp.atomicDownloads)
            if (transfer) {
                await this.sftp.download(itemPath, transfer)
            }
        } catch (error) {
            this.notifications.error(error.message)
        }
    }

    async downloadFolder (folder: SFTPFile): Promise<void> {
        try {
            const transfer = await this.platform.startDownloadDirectory(folder.name, 0)
            if (!transfer) {
                return
            }

            // Start background size calculation and download simultaneously
            const sizeCalculationPromise = this.calculateFolderSizeAndUpdate(folder, transfer)
            const downloadPromise = this.downloadFolderRecursive(folder, transfer, '')

            try {
                await Promise.all([sizeCalculationPromise, downloadPromise])
                transfer.setStatus('')
                transfer.setCompleted(true)
            } catch (error) {
                transfer.cancel()
                throw error
            } finally {
                transfer.close()
            }
        } catch (error) {
            this.notifications.error(`Failed to download folder: ${error.message}`)
            throw error
        }
    }

    private async calculateFolderSizeAndUpdate (folder: SFTPFile, transfer: DirectoryDownload) {
        let totalSize = 0
        const items = await this.sftp.readdir(folder.fullPath)
        for (const item of items) {
            if (item.isDirectory) {
                totalSize += await this.calculateFolderSizeAndUpdate(item, transfer)
            } else {
                totalSize += item.size
            }
            transfer.setTotalSize(totalSize)
        }
        return totalSize
    }

    private async downloadFolderRecursive (folder: SFTPFile, transfer: DirectoryDownload, relativePath: string): Promise<void> {
        const items = await this.sftp.readdir(folder.fullPath)

        for (const item of items) {
            if (transfer.isCancelled()) {
                throw new Error('Download cancelled')
            }

            const itemRelativePath = relativePath ? `${relativePath}/${item.name}` : item.name

            transfer.setStatus(itemRelativePath)
            if (item.isDirectory) {
                await transfer.createDirectory(itemRelativePath)
                await this.downloadFolderRecursive(item, transfer, itemRelativePath)
            } else {
                const fileDownload = await transfer.createFile(itemRelativePath, item.mode, item.size, this.sftp.atomicDownloads)
                await this.sftp.download(item.fullPath, fileDownload)
            }
        }
    }

    getModeString (item: SFTPFile): string {
        const s = 'SGdrwxrwxrwx'
        const e = '   ---------'
        const c = [
            0o4000, 0o2000, C.S_IFDIR,
            C.S_IRUSR, C.S_IWUSR, C.S_IXUSR,
            C.S_IRGRP, C.S_IWGRP, C.S_IXGRP,
            C.S_IROTH, C.S_IWOTH, C.S_IXOTH,
        ]
        let result = ''
        for (let i = 0; i < c.length; i++) {
            result += item.mode & c[i] ? s[i] : e[i]
        }
        return result
    }

    async buildContextMenu (item: SFTPFile): Promise<MenuItemOptions[]> {
        let items: MenuItemOptions[] = []
        for (const section of await Promise.all(this.contextMenuProviders.map(x => x.getItems(item, this)))) {
            items.push({ type: 'separator' })
            items = items.concat(section)
        }
        return items.slice(1)
    }

    async showContextMenu (item: SFTPFile, event: MouseEvent): Promise<void> {
        event.preventDefault()
        this.platform.popupContextMenu(await this.buildContextMenu(item), event)
    }

    get shouldShowCWDTip (): boolean {
        return !window.localStorage.sshCWDTipDismissed
    }

    dismissCWDTip (): void {
        window.localStorage.sshCWDTipDismissed = 'true'
    }

    editPath (): void {
        this.editingPath = this.path
    }

    confirmPath (): void {
        if (this.editingPath === null) {
            return
        }
        this.navigate(this.editingPath)
        this.editingPath = null
    }

    close (): void {
        this.closed.emit()
    }

    clearFilter (): void {
        this.showFilter = false
        this.filterText = ''
        this.updateFilteredList()
    }

    onFilterChange (): void {
        this.updateFilteredList()
    }

    private updateFilteredList (): void {
        if (!this.fileList) {
            this.filteredFileList = []
            return
        }

        if (!this.showFilter || this.filterText.trim() === '') {
            this.filteredFileList = this.fileList
            return
        }

        this.filteredFileList = this.fileList.filter(item =>
            item.name.toLowerCase().includes(this.filterText.toLowerCase()),
        )
    }
}
