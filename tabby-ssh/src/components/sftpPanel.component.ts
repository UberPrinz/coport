import * as C from 'constants'
import { posix as path } from 'path'
import {
    ChangeDetectorRef,
    Component,
    ElementRef,
    EventEmitter,
    HostBinding,
    HostListener,
    Inject,
    Input,
    OnDestroy,
    OnInit,
    Optional,
    Output,
    ViewChild,
} from '@angular/core'
import { FileUpload, DirectoryUpload, DirectoryDownload, MenuItemOptions, NotificationsService, PlatformService } from 'tabby-core'
import { SFTPFile } from '../session/sftp'
import { FileBackend } from '../api/fileBackend'
import { SFTPContextMenuItemProvider } from '../api'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { SFTPCreateDirectoryModalComponent } from './sftpCreateDirectoryModal.component'
import {
    FILE_PANEL_STATE_STORAGE_KEY,
    FilePanelStateStore,
    normalizeFilePanelPath,
} from '../utils/filePanelState'
import {
    FilteredFileEntry,
    filterAndSortEntries,
    sortFileEntries,
} from '../utils/filePanelFilter'
import {
    extractErrorMessage,
    resolveReadableDirectory,
} from '../utils/filePanelFallback'

interface PathSegment {
    name: string
    path: string
}

interface FallbackNotice {
    requestedPath: string
    resolvedPath: string
    reason: string
}

interface PanelErrorNotice {
    path: string
    message: string
}

@Component({
    selector: 'sftp-panel',
    templateUrl: './sftpPanel.component.pug',
    styleUrls: ['./sftpPanel.component.scss'],
})
export class SFTPPanelComponent implements OnInit, OnDestroy {
    @HostBinding('attr.tabindex') readonly tabIndex = 0
    @Input() session: { openSFTP: () => Promise<FileBackend> } // coport: Used by SSH and ADB.
    @Output() closed = new EventEmitter<void>()
    @Output() pathChange = new EventEmitter<string>()
    @Input() cwdDetectionAvailable: boolean | null = false
    @Input() rootLabel = 'SFTP' // coport: ADB uses the same panel.
    @Input() defaultPath = '/'
    @Input() stateScope: string | null = null

    @ViewChild('pathInput') pathInput?: ElementRef<HTMLInputElement>
    @ViewChild('filterInput') filterInput?: ElementRef<HTMLInputElement>

    sftp: FileBackend
    fileList: SFTPFile[] | null = null
    filteredFileList: SFTPFile[] = []
    filteredEntries: FilteredFileEntry<SFTPFile>[] = []
    pathSegments: PathSegment[] = []
    editingPath: string | null = null
    showFilter = false
    filterText = ''
    selectedIndex = -1
    favorites: string[] = []
    recentPaths: string[] = []
    isCurrentPathFavorite = false
    showPlacesDropdown = false
    fallbackNotice: FallbackNotice | null = null
    errorNotice: PanelErrorNotice | null = null
    loadError: PanelErrorNotice | null = null

    private backend: FileBackend | null = null
    private initialPathInput: string | null = null
    private currentPath = '/'
    private unfilteredEntries: FilteredFileEntry<SFTPFile>[] = []
    private navigation = 0
    private destroyed = false
    private persistentStore: FilePanelStateStore
    private memoryStore = new FilePanelStateStore(null)

    readonly getDropTarget = (): string => this.path

    private readonly handleStorageEvent = (event: StorageEvent): void => {
        if (event.key === null || event.key === FILE_PANEL_STATE_STORAGE_KEY) {
            this.syncStoredPlaces()
            this.cdr.markForCheck()
        }
    }

    @Input()
    get path (): string {
        return this.currentPath
    }

    set path (value: string | null | undefined) {
        if (value == null || value.trim() === '') {
            this.initialPathInput = null
            return
        }
        this.initialPathInput = value
        this.currentPath = value
    }

    get isFilterActive (): boolean {
        return this.showFilter && this.filterText.trim() !== ''
    }

    constructor (
        private ngbModal: NgbModal,
        private notifications: NotificationsService,
        public platform: PlatformService,
        private elementRef: ElementRef<HTMLElement>,
        private cdr: ChangeDetectorRef,
        @Optional() @Inject(SFTPContextMenuItemProvider) protected contextMenuProviders: SFTPContextMenuItemProvider[],
    ) {
        this.contextMenuProviders.sort((a, b) => a.weight - b.weight)
        this.persistentStore = new FilePanelStateStore(typeof window !== 'undefined' ? window.localStorage : null)
    }

    async ngOnInit (): Promise<void> {
        if (typeof window !== 'undefined') {
            window.addEventListener('storage', this.handleStorageEvent)
        }
        this.syncStoredPlaces()
        await this.initializeBackendAndNavigate()
    }

    ngOnDestroy (): void {
        this.destroyed = true
        this.navigation++
        if (typeof window !== 'undefined') {
            window.removeEventListener('storage', this.handleStorageEvent)
        }
    }

    private get activeStore (): FilePanelStateStore {
        return this.stateScope ? this.persistentStore : this.memoryStore
    }

    private get activeScope (): string {
        return this.stateScope ?? 'memory'
    }

    private normalizePathValue (rawPath: string): string {
        const backendNormalized = this.backend?.normalizePath?.(rawPath) ?? rawPath
        return normalizeFilePanelPath(backendNormalized)
    }

    private isDirectoryUnavailableError (error: unknown): boolean {
        return this.backend?.isDirectoryUnavailable?.(error) ?? false
    }

    private async initializeBackendAndNavigate (overrideStartPath?: string): Promise<void> {
        const startPath = normalizeFilePanelPath(
            overrideStartPath ?? this.initialPathInput ?? this.activeStore.getLastPath(this.activeScope) ?? this.defaultPath,
        )
        this.loadError = null
        this.errorNotice = null
        this.fallbackNotice = null

        if (!this.backend) {
            try {
                const backend = await this.session.openSFTP()
                if (this.destroyed) {
                    return
                }
                this.backend = backend
                this.sftp = backend
            } catch (error) {
                if (this.destroyed) {
                    return
                }
                const message = extractErrorMessage(error)
                this.setCurrentPath(startPath)
                this.loadError = { path: startPath, message }
                this.notifications.error(message)
                return
            }
        }

        await this.navigateWithFallback(this.normalizePathValue(startPath))
    }

    private setCurrentPath (nextPath: string): void {
        const normalized = normalizeFilePanelPath(nextPath)
        this.currentPath = normalized
        this.pathChange.next(normalized)
        this.rebuildPathSegments(normalized)
        this.isCurrentPathFavorite = this.favorites.includes(normalized)
    }

    private rebuildPathSegments (targetPath: string): void {
        let p = targetPath
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
    }

    private applyLoadedEntries (entries: SFTPFile[]): void {
        const sorted = sortFileEntries(entries)
        this.fileList = sorted
        this.unfilteredEntries = sorted.map(item => ({
            item,
            tier: 0,
            ranges: [],
            segments: [{ text: item.name, highlighted: false }],
        }))
        this.updateFilteredList(true)
    }

    private syncStoredPlaces (): void {
        const record = this.activeStore.getScopeState(this.activeScope)
        this.favorites = record.favorites
        this.recentPaths = record.recent
        this.isCurrentPathFavorite = this.favorites.includes(this.currentPath)
    }

    private recordCurrentDirectory (dirPath: string): void {
        this.activeStore.recordVisit(this.activeScope, dirPath)
        this.syncStoredPlaces()
    }

    private async navigateWithFallback (targetPath: string): Promise<void> {
        const backend = this.backend
        if (!backend) {
            return
        }
        const normalizedTarget = this.normalizePathValue(targetPath)
        const request = ++this.navigation
        this.setCurrentPath(normalizedTarget)
        this.clearFilter()
        this.fileList = null
        this.unfilteredEntries = []
        this.filteredEntries = []
        this.filteredFileList = []
        this.selectedIndex = -1
        this.loadError = null
        this.errorNotice = null
        this.fallbackNotice = null

        const result = await resolveReadableDirectory(
            normalizedTarget,
            dirPath => backend.readdir(dirPath),
            error => this.isDirectoryUnavailableError(error),
            () => this.destroyed || request !== this.navigation,
        )

        if (result.cancelled || this.destroyed || request !== this.navigation) {
            return
        }

        if (result.ok) {
            this.setCurrentPath(result.path)
            this.applyLoadedEntries(result.entries)
            this.loadError = null
            if (result.fellBackFrom) {
                this.fallbackNotice = {
                    requestedPath: result.fellBackFrom,
                    resolvedPath: result.path,
                    reason: result.fallbackReason ?? 'Directory is unavailable',
                }
            }
            this.recordCurrentDirectory(result.path)
            this.focusPanel()
            return
        }

        this.setCurrentPath(result.path)
        this.fileList = null
        this.unfilteredEntries = []
        this.filteredEntries = []
        this.filteredFileList = []
        this.selectedIndex = -1
        this.loadError = {
            path: result.path,
            message: result.errorMessage,
        }
        this.notifications.error(result.errorMessage)
    }

    async navigate (newPath: string, _fallbackOnError = false): Promise<void> {
        if (!this.backend) {
            return
        }
        const normalizedPath = this.normalizePathValue(newPath)
        const request = ++this.navigation
        const hadValidList = this.fileList !== null
        this.showPlacesDropdown = false

        if (!hadValidList) {
            this.loadError = null
        }

        try {
            const entries = await this.backend.readdir(normalizedPath)
            if (this.destroyed || request !== this.navigation) {
                return
            }
            this.setCurrentPath(normalizedPath)
            this.clearFilter()
            this.fallbackNotice = null
            this.errorNotice = null
            this.loadError = null
            this.applyLoadedEntries(entries)
            this.recordCurrentDirectory(normalizedPath)
            this.focusPanel()
        } catch (error) {
            if (this.destroyed || request !== this.navigation) {
                return
            }
            const message = extractErrorMessage(error)
            this.notifications.error(message)
            if (hadValidList) {
                this.errorNotice = {
                    path: normalizedPath,
                    message,
                }
            } else {
                this.setCurrentPath(normalizedPath)
                this.loadError = {
                    path: normalizedPath,
                    message,
                }
            }
        }
    }

    async retryLoad (): Promise<void> {
        const retryPath = this.loadError?.path ?? this.currentPath
        await this.initializeBackendAndNavigate(retryPath)
    }

    refresh (): void {
        if (this.loadError) {
            void this.retryLoad()
            return
        }
        void this.navigate(this.path)
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
        if (this.path === '/') {
            return
        }
        void this.navigate(path.dirname(this.path))
    }

    private async resolveLink (item: SFTPFile): Promise<SFTPFile | undefined> {
        if (!item.isSymlink) {
            return item
        }
        if (!this.backend) {
            return undefined
        }
        try {
            return await this.backend.stat(item.fullPath)
        } catch (error) {
            this.notifications.error(extractErrorMessage(error))
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

    onItemClick (item: SFTPFile, index: number): void {
        this.selectedIndex = index
        void this.open(item)
    }

    onItemContextMenu (item: SFTPFile, index: number, event: MouseEvent): void {
        this.selectedIndex = index
        void this.showContextMenu(item, event)
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
        if (!this.backend) {
            return
        }
        const modal = this.ngbModal.open(SFTPCreateDirectoryModalComponent)
        const directoryName = await modal.result.catch(() => null)
        if (directoryName?.trim()) {
            const targetPath = path.join(this.path, directoryName)
            this.backend.mkdir(targetPath).then(() => {
                this.notifications.notice('The directory was created successfully')
                void this.navigate(targetPath)
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
            this.notifications.error(extractErrorMessage(error))
        }
    }

    async uploadFolder (): Promise<void> {
        const target = this.path
        try {
            const transfer = await this.platform.startUploadDirectory()
            await this.uploadOneFolder(transfer, target)
        } catch (error) {
            this.notifications.error(extractErrorMessage(error))
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
            this.notifications.error(extractErrorMessage(error))
        }
    }

    private async uploadDirectoryEntries (transfer: DirectoryUpload, directory: string): Promise<void> {
        if (!this.backend) {
            return
        }
        for (const child of transfer.getChildrens()) {
            const target = path.join(directory, child.getName())
            if (child instanceof DirectoryUpload) {
                try {
                    await this.backend.mkdir(target)
                } catch {
                    // Intentionally ignoring errors from making duplicate dirs.
                }
                await this.uploadDirectoryEntries(child, target)
            } else {
                await this.backend.upload(target, child)
            }
        }
    }

    async uploadOne (transfer: FileUpload, target = this.path): Promise<void> {
        if (!this.backend) {
            return
        }
        await this.backend.upload(path.join(target, transfer.getName()), transfer)
        if (this.path === target) {
            await this.navigate(target)
        }
    }

    async download (itemPath: string, mode: number, size: number): Promise<void> {
        if (!this.backend) {
            return
        }
        try {
            const transfer = await this.platform.startDownload(path.basename(itemPath), mode, size, undefined, this.backend.atomicDownloads)
            if (transfer) {
                await this.backend.download(itemPath, transfer)
            }
        } catch (error) {
            this.notifications.error(extractErrorMessage(error))
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
            this.notifications.error(`Failed to download folder: ${extractErrorMessage(error)}`)
            throw error
        }
    }

    private async calculateFolderSizeAndUpdate (folder: SFTPFile, transfer: DirectoryDownload): Promise<number> {
        if (!this.backend) {
            return 0
        }
        let totalSize = 0
        const items = await this.backend.readdir(folder.fullPath)
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
        if (!this.backend) {
            return
        }
        const items = await this.backend.readdir(folder.fullPath)

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
                const fileDownload = await transfer.createFile(itemRelativePath, item.mode, item.size, this.backend.atomicDownloads)
                await this.backend.download(item.fullPath, fileDownload)
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
        event.stopPropagation()
        this.platform.popupContextMenu(await this.buildContextMenu(item), event)
    }

    get shouldShowCWDTip (): boolean {
        return !window.localStorage.sshCWDTipDismissed
    }

    dismissCWDTip (): void {
        window.localStorage.sshCWDTipDismissed = 'true'
    }

    editPath (event?: Event): void {
        event?.stopPropagation()
        this.showPlacesDropdown = false
        this.editingPath = this.path
        this.cdr.detectChanges()
        const input = this.pathInput?.nativeElement
        if (input) {
            input.focus()
            input.select()
        }
    }

    confirmPath (event?: Event): void {
        event?.preventDefault()
        event?.stopPropagation()
        if (this.editingPath === null) {
            return
        }
        const target = this.editingPath.trim() || '/'
        this.editingPath = null
        void this.navigate(target)
    }

    cancelPathEdit (event?: Event): void {
        event?.preventDefault()
        event?.stopPropagation()
        if (this.editingPath === null) {
            return
        }
        this.editingPath = null
        this.focusPanel()
    }

    toggleCurrentFavorite (event?: Event): void {
        event?.stopPropagation()
        this.activeStore.toggleFavorite(this.activeScope, this.path)
        this.syncStoredPlaces()
    }

    removeFavoritePath (targetPath: string, event?: Event): void {
        event?.stopPropagation()
        this.activeStore.removeFavorite(this.activeScope, targetPath)
        this.syncStoredPlaces()
    }

    togglePlacesDropdown (event?: Event): void {
        event?.stopPropagation()
        this.syncStoredPlaces()
        this.showPlacesDropdown = !this.showPlacesDropdown
    }

    openPlace (targetPath: string, event?: Event): void {
        event?.stopPropagation()
        this.showPlacesDropdown = false
        void this.navigate(targetPath)
    }

    getPathLabel (targetPath: string): string {
        if (targetPath === '/') {
            return '/'
        }
        const base = path.basename(targetPath)
        const duplicates = this.favorites.filter(item => item !== '/' && path.basename(item) === base)
        if (duplicates.length > 1) {
            const parent = path.basename(path.dirname(targetPath))
            return parent ? `${parent}/${base}` : targetPath
        }
        return base || targetPath
    }

    close (): void {
        this.closed.emit()
    }

    openFilter (event?: Event): void {
        event?.stopPropagation()
        this.showPlacesDropdown = false
        this.showFilter = true
        this.cdr.detectChanges()
        const input = this.filterInput?.nativeElement
        if (input) {
            input.focus()
            input.setSelectionRange(this.filterText.length, this.filterText.length)
        }
    }

    clearFilter (refocusPanel = false): void {
        this.showFilter = false
        this.filterText = ''
        this.updateFilteredList(false)
        if (refocusPanel) {
            this.focusPanel()
        }
    }

    onFilterTextChange (value: string): void {
        this.filterText = value
        this.onFilterChange()
    }

    onFilterChange (): void {
        this.updateFilteredList(true)
    }

    trackByEntry (_index: number, entry: FilteredFileEntry<SFTPFile>): string {
        return entry.item.fullPath
    }

    focusPanel (): void {
        if (this.destroyed || this.editingPath !== null || this.ngbModal.hasOpenModals()) {
            return
        }
        this.elementRef.nativeElement.focus({ preventScroll: true })
    }

    private updateFilteredList (resetSelection: boolean): void {
        if (!this.fileList) {
            this.filteredEntries = []
            this.filteredFileList = []
            this.selectedIndex = -1
            return
        }

        if (!this.isFilterActive) {
            this.filteredEntries = this.unfilteredEntries
            this.filteredFileList = this.fileList
        } else {
            this.filteredEntries = filterAndSortEntries(this.fileList, this.filterText)
            this.filteredFileList = this.filteredEntries.map(entry => entry.item)
        }

        if (this.filteredEntries.length === 0) {
            this.selectedIndex = -1
        } else if (resetSelection || this.selectedIndex < 0 || this.selectedIndex >= this.filteredEntries.length) {
            this.selectedIndex = 0
        }
    }

    private moveSelection (delta: number): void {
        const count = this.filteredEntries.length
        if (count === 0) {
            this.selectedIndex = -1
            return
        }
        if (this.selectedIndex < 0) {
            this.selectedIndex = delta > 0 ? 0 : count - 1
        } else {
            this.selectedIndex = Math.max(0, Math.min(count - 1, this.selectedIndex + delta))
        }
        this.cdr.detectChanges()
        this.scrollSelectedIntoView()
    }

    private scrollSelectedIntoView (): void {
        if (this.selectedIndex < 0) {
            return
        }
        const selectedEl = this.elementRef.nativeElement.querySelector<HTMLElement>(
            `.list-group-item[data-index="${this.selectedIndex}"]`,
        )
        selectedEl?.scrollIntoView({ block: 'nearest' })
    }

    private async activateSelectedItem (): Promise<void> {
        if (this.selectedIndex < 0 || this.selectedIndex >= this.filteredEntries.length) {
            return
        }
        const item = this.filteredEntries[this.selectedIndex].item
        await this.open(item)
    }

    handleEscape (event?: Event): void {
        event?.preventDefault()
        event?.stopPropagation()
        if (this.editingPath !== null) {
            this.cancelPathEdit()
            return
        }
        if (this.showPlacesDropdown) {
            this.showPlacesDropdown = false
            this.focusPanel()
            return
        }
        if (this.showFilter || this.filterText !== '') {
            this.clearFilter(true)
        }
    }

    @HostListener('click', ['$event'])
    onHostClick (event: MouseEvent): void {
        event.stopPropagation()
        if (this.showPlacesDropdown) {
            const target = event.target as HTMLElement | null
            if (!target?.closest('.places-dropdown')) {
                this.showPlacesDropdown = false
            }
        }
    }

    @HostListener('keydown', ['$event'])
    onKeyDown (event: KeyboardEvent): void {
        if (this.ngbModal.hasOpenModals()) {
            return
        }
        if (event.isComposing || event.keyCode === 229) {
            return
        }

        const target = event.target as HTMLElement | null
        const isFilterInput = Boolean(this.filterInput?.nativeElement && target === this.filterInput.nativeElement)

        if (this.editingPath !== null) {
            if (event.key === 'Escape') {
                this.cancelPathEdit(event)
            }
            return
        }

        if (event.key === 'Escape') {
            this.handleEscape(event)
            return
        }

        const isOtherEditable = !isFilterInput && Boolean(
            target && (
                target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.tagName === 'SELECT' ||
                target.isContentEditable
            ),
        )
        if (isOtherEditable) {
            return
        }

        if (!event.ctrlKey && !event.metaKey && !event.altKey) {
            if (event.key === 'ArrowDown') {
                event.preventDefault()
                event.stopPropagation()
                this.moveSelection(1)
                return
            }
            if (event.key === 'ArrowUp') {
                event.preventDefault()
                event.stopPropagation()
                this.moveSelection(-1)
                return
            }
            if (event.key === 'Enter') {
                if (!isFilterInput && target?.closest('button, a')) {
                    return
                }
                event.preventDefault()
                event.stopPropagation()
                void this.activateSelectedItem()
                return
            }
            if (event.key === 'Backspace') {
                if (this.filterText.length === 0) {
                    if (!event.repeat) {
                        event.preventDefault()
                        event.stopPropagation()
                        this.goUp()
                    }
                    return
                }
                if (!isFilterInput) {
                    event.preventDefault()
                    event.stopPropagation()
                    this.filterText = this.filterText.slice(0, -1)
                    this.onFilterChange()
                }
                return
            }

            if (!isFilterInput && event.key.length === 1) {
                if (event.key === ' ' && (!this.showFilter || this.filterText === '')) {
                    return
                }
                if (this.fileList === null) {
                    return
                }
                event.preventDefault()
                event.stopPropagation()
                this.showPlacesDropdown = false
                this.showFilter = true
                this.filterText += event.key
                this.onFilterChange()
                this.cdr.detectChanges()
                const input = this.filterInput?.nativeElement
                if (input) {
                    input.focus()
                    input.setSelectionRange(this.filterText.length, this.filterText.length)
                }
            }
        }
    }
}
