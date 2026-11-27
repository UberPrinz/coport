import * as C from 'constants'
import { posix as path } from 'path'
import { Subscription } from 'rxjs'
import {
    AfterViewInit,
    ChangeDetectorRef,
    Component,
    ElementRef,
    EventEmitter,
    HostBinding,
    HostListener,
    Inject,
    Input,
    OnChanges,
    OnDestroy,
    OnInit,
    Optional,
    Output,
    SimpleChanges,
    ViewChild,
} from '@angular/core'
import { FileUpload, DirectoryUpload, DirectoryDownload, MenuItemOptions, NotificationsService, PlatformService } from 'tabby-core'
import { SFTPFile } from '../session/sftp'
import { FileBackend } from '../api/fileBackend'
import { SFTPContextMenuItemProvider } from '../api'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { SFTPCreateDirectoryModalComponent } from './sftpCreateDirectoryModal.component'
import {
    createDefaultFilePanelStateClient,
    FilePanelStateClient,
    FilePanelStateStore,
    getFilePanelScopeStorageKey,
    normalizeFilePanelPath,
    subscribeFilePanelStateChanges,
} from '../utils/filePanelState'
import {
    FilteredFileEntry,
    filterAndSortEntries,
    sortFileEntries,
} from '../utils/filePanelFilter'
import {
    extractErrorMessage,
    hasDotDotSegment,
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

interface VisibleFileRow {
    index: number
    entry: FilteredFileEntry<SFTPFile>
    icon: string
    mode: string
}

const VIRTUAL_ROW_HEIGHT = 36
const VIRTUAL_THRESHOLD = 80
const VIRTUAL_OVERSCAN = 10
const VIRTUAL_MIN_WINDOW = 36

@Component({
    selector: 'sftp-panel',
    templateUrl: './sftpPanel.component.pug',
    styleUrls: ['./sftpPanel.component.scss'],
})
export class SFTPPanelComponent implements OnInit, AfterViewInit, OnChanges, OnDestroy {
    @HostBinding('attr.tabindex') readonly tabIndex = 0
    @Input() session: { openSFTP: (failedBackend?: FileBackend) => Promise<FileBackend> } // coport: Used by SSH and ADB.
    @Output() closed = new EventEmitter<void>()
    @Output() pathChange = new EventEmitter<string>()
    @Input() cwdDetectionAvailable: boolean | null = false
    @Input() rootLabel = 'SFTP' // coport: ADB uses the same panel.
    @Input() defaultPath = '/'
    @Input() stateScope: string | null = null

    @ViewChild('pathInput') pathInput?: ElementRef<HTMLInputElement>
    @ViewChild('filterInput') filterInput?: ElementRef<HTMLInputElement>
    @ViewChild('bodyContainer') bodyContainer?: ElementRef<HTMLElement>

    sftp: FileBackend
    fileList: SFTPFile[] | null = null
    filteredFileList: SFTPFile[] = []
    filteredEntries: FilteredFileEntry<SFTPFile>[] = []
    visibleEntries: VisibleFileRow[] = []
    topSpacerHeight = 0
    bottomSpacerHeight = 0
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
    private failedBackend: FileBackend | null = null
    private backendClosedSub: Subscription | null = null
    private bodyResizeObserver: ResizeObserver | null = null
    private unsubscribeStateChanges: (() => void) | null = null
    private initialPathInput: string | null = null
    private currentPath = '/'
    private unfilteredEntries: FilteredFileEntry<SFTPFile>[] = []
    private rowMetaCache = new Map<string, { icon: string, mode: string }>()
    private visibleStartIndex = 0
    private visibleEndIndex = 0
    private navigation = 0
    private initialized = false
    private destroyed = false
    private persistentStore: FilePanelStateClient
    private memoryStore = new FilePanelStateStore(null)

    readonly getDropTarget = (): string => this.path

    private readonly handleStorageEvent = (event: StorageEvent): void => {
        if (this.destroyed) {
            return
        }
        if (event.key === null || (this.stateScope && event.key === getFilePanelScopeStorageKey(this.stateScope))) {
            this.syncStoredPlaces()
            this.cdr.detectChanges()
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
        this.persistentStore = createDefaultFilePanelStateClient()
    }

    async ngOnInit (): Promise<void> {
        this.initialized = true
        if (typeof window !== 'undefined') {
            window.addEventListener('storage', this.handleStorageEvent)
        }
        this.unsubscribeStateChanges = subscribeFilePanelStateChanges(event => {
            if (this.destroyed || !this.stateScope || event.scope !== this.stateScope) {
                return
            }
            this.syncStoredPlaces()
            if (event.source !== this.persistentStore) {
                this.cdr.detectChanges()
            } else {
                this.cdr.markForCheck()
            }
        })
        this.syncStoredPlaces()
        await this.initializeBackendAndNavigate()
    }

    ngAfterViewInit (): void {
        this.focusPanel()
        const body = this.bodyContainer?.nativeElement
        if (body && typeof ResizeObserver !== 'undefined') {
            this.bodyResizeObserver = new ResizeObserver(() => {
                this.handleBodyResize()
            })
            this.bodyResizeObserver.observe(body)
        }
    }

    ngOnChanges (changes: SimpleChanges): void {
        if (!this.initialized || this.destroyed) {
            return
        }
        const sessionChanged = 'session' in changes && !changes.session.firstChange
        const scopeChanged = 'stateScope' in changes && !changes.stateScope.firstChange
        if (!sessionChanged && !scopeChanged) {
            return
        }
        this.navigation++
        this.backendClosedSub?.unsubscribe()
        this.backendClosedSub = null
        if (sessionChanged) {
            this.backend = null
            this.sftp = null as unknown as FileBackend
        }
        this.failedBackend = null
        if (!('path' in changes)) {
            this.initialPathInput = null
        }
        this.loadError = null
        this.errorNotice = null
        this.fallbackNotice = null
        this.editingPath = null
        this.showPlacesDropdown = false
        this.clearFilter()
        this.resetFileLists()
        this.currentPath = this.normalizePathValue(this.defaultPath)
        this.rebuildPathSegments(this.currentPath)
        this.syncStoredPlaces()
        this.cdr.markForCheck()
        void this.initializeBackendAndNavigate()
    }

    ngOnDestroy (): void {
        this.destroyed = true
        this.navigation++
        this.detachBackend()
        this.failedBackend = null
        this.bodyResizeObserver?.disconnect()
        this.bodyResizeObserver = null
        this.unsubscribeStateChanges?.()
        this.unsubscribeStateChanges = null
        if (typeof window !== 'undefined') {
            window.removeEventListener('storage', this.handleStorageEvent)
        }
    }

    private detachBackend (rememberAsFailed = false): void {
        if (rememberAsFailed && this.backend) {
            this.failedBackend = this.backend
        }
        this.backendClosedSub?.unsubscribe()
        this.backendClosedSub = null
        this.backend = null
    }

    private attachBackend (backend: FileBackend): void {
        this.backend = backend
        this.sftp = backend
        this.failedBackend = null
        this.backendClosedSub?.unsubscribe()
        this.backendClosedSub = backend.closed$?.subscribe(() => {
            if (this.backend === backend) {
                this.detachBackend(true)
                if (!this.destroyed && !this.loadError) {
                    this.resetFileLists()
                    this.loadError = {
                        path: this.currentPath,
                        message: 'SFTP channel closed',
                    }
                    this.cdr.detectChanges()
                }
            }
        }) ?? null
    }

    private getActiveBackend (): FileBackend | null {
        return this.backend
    }

    private get activeStore (): FilePanelStateClient {
        return this.stateScope ? this.persistentStore : this.memoryStore
    }

    private get activeScope (): string {
        return this.stateScope ?? 'memory'
    }

    private get shouldPreserveDotDot (): boolean {
        if (this.backend) {
            return !this.backend.normalizePath
        }
        return this.activeScope.startsWith('ssh:')
    }

    private normalizePathValue (rawPath: string): string {
        if (this.backend?.normalizePath) {
            return normalizeFilePanelPath(this.backend.normalizePath(rawPath), false)
        }
        return normalizeFilePanelPath(rawPath, this.shouldPreserveDotDot)
    }

    private joinChildPath (basePath: string, childName: string): string {
        if (this.backend?.normalizePath) {
            return path.join(basePath, childName)
        }
        if (!basePath || basePath === '/') {
            return `/${childName}`
        }
        return basePath.endsWith('/') ? `${basePath}${childName}` : `${basePath}/${childName}`
    }

    private isDirectoryUnavailableError (error: unknown): boolean {
        return this.backend?.isDirectoryUnavailable?.(error) ?? false
    }

    private resetFileLists (): void {
        this.fileList = null
        this.unfilteredEntries = []
        this.filteredEntries = []
        this.filteredFileList = []
        this.visibleEntries = []
        this.topSpacerHeight = 0
        this.bottomSpacerHeight = 0
        this.visibleStartIndex = 0
        this.visibleEndIndex = 0
        this.selectedIndex = -1
    }

    private async resolveTargetPath (backend: FileBackend, normalizedPath: string): Promise<string> {
        if (!this.shouldPreserveDotDot || !backend.resolvePath || !hasDotDotSegment(normalizedPath)) {
            return normalizedPath
        }
        try {
            const resolved = await backend.resolvePath(normalizedPath)
            return this.normalizePathValue(resolved)
        } catch {
            return normalizedPath
        }
    }

    private async initializeBackendAndNavigate (
        overrideStartPath?: string,
        failedBackend: FileBackend | null = null,
        request = ++this.navigation,
    ): Promise<void> {
        const savedLastPath = this.activeStore.getLastPath(this.activeScope)
        const rawStartPath = overrideStartPath ?? savedLastPath ?? this.initialPathInput ?? this.defaultPath
        this.loadError = null
        this.errorNotice = null
        this.fallbackNotice = null

        if (!this.backend) {
            try {
                const backend = await this.session.openSFTP(failedBackend ?? undefined)
                if (this.destroyed || request !== this.navigation) {
                    return
                }
                this.attachBackend(backend)
            } catch (error) {
                if (this.destroyed || request !== this.navigation) {
                    return
                }
                const startPath = this.normalizePathValue(rawStartPath)
                const message = extractErrorMessage(error)
                this.setCurrentPath(startPath, false)
                this.loadError = { path: startPath, message }
                this.notifications.error(message)
                return
            }
        } else if (!this.backendClosedSub && this.backend.closed$) {
            this.attachBackend(this.backend)
        }

        await this.navigateWithFallback(this.normalizePathValue(rawStartPath), request)
    }

    private setCurrentPath (nextPath: string, emitChange = true): void {
        const normalized = this.normalizePathValue(nextPath)
        this.currentPath = normalized
        if (emitChange) {
            this.pathChange.next(normalized)
        }
        this.rebuildPathSegments(normalized)
        this.isCurrentPathFavorite = this.favorites.includes(normalized)
    }

    private rebuildPathSegments (targetPath: string): void {
        this.pathSegments = []
        if (targetPath === '/') {
            return
        }
        const parts = targetPath.split('/').filter(Boolean)
        let acc = ''
        for (const part of parts) {
            acc += `/${part}`
            this.pathSegments.push({
                name: part,
                path: acc,
            })
        }
    }

    private applyLoadedEntries (entries: SFTPFile[]): void {
        const sorted = sortFileEntries(entries)
        this.fileList = sorted
        this.rowMetaCache.clear()
        this.unfilteredEntries = sorted.map(item => {
            this.rowMetaCache.set(item.fullPath, {
                icon: this.getIcon(item),
                mode: this.getModeString(item),
            })
            return {
                item,
                tier: 0,
                ranges: [],
                segments: [{ text: item.name, highlighted: false }],
            }
        })
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

    private isRequestStale (request: number): boolean {
        return this.destroyed || request !== this.navigation
    }

    private async navigateWithFallback (targetPath: string, request = ++this.navigation): Promise<void> {
        const backend = this.backend
        if (!backend) {
            return
        }
        const normalizedTarget = this.normalizePathValue(targetPath)
        this.setCurrentPath(normalizedTarget, false)
        this.clearFilter()
        this.resetFileLists()
        this.loadError = null
        this.errorNotice = null
        this.fallbackNotice = null

        const resolvedTarget = await this.resolveTargetPath(backend, normalizedTarget)
        if (this.isRequestStale(request)) {
            return
        }
        if (resolvedTarget !== normalizedTarget) {
            this.setCurrentPath(resolvedTarget, false)
        }

        const result = await resolveReadableDirectory(
            resolvedTarget,
            dirPath => backend.readdir(dirPath),
            error => this.isDirectoryUnavailableError(error),
            () => this.isRequestStale(request),
            this.shouldPreserveDotDot,
        )

        if (result.cancelled || this.isRequestStale(request)) {
            return
        }

        if (result.ok) {
            this.setCurrentPath(result.path, true)
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
            this.focusPanelIfOwned()
            return
        }

        if (!result.isUnavailable) {
            this.detachBackend(true)
        }
        this.setCurrentPath(result.path, false)
        this.resetFileLists()
        this.loadError = {
            path: result.path,
            message: result.errorMessage,
        }
        this.notifications.error(result.errorMessage)
    }

    async navigate (newPath: string, _fallbackOnError = false): Promise<void> {
        await this.navigateWithRequest(newPath, ++this.navigation)
    }

    private async navigateWithRequest (newPath: string, request: number): Promise<void> {
        if (!this.backend) {
            await this.initializeBackendAndNavigate(newPath, null, request)
            return
        }
        const backend = this.backend
        const normalizedPath = this.normalizePathValue(newPath)
        const hadValidList = this.fileList !== null
        this.showPlacesDropdown = false

        if (!hadValidList) {
            this.loadError = null
        }

        const resolvedPath = await this.resolveTargetPath(backend, normalizedPath)
        if (this.isRequestStale(request)) {
            return
        }

        try {
            const entries = await backend.readdir(resolvedPath)
            if (this.isRequestStale(request)) {
                return
            }
            this.setCurrentPath(resolvedPath, true)
            this.clearFilter()
            this.fallbackNotice = null
            this.errorNotice = null
            this.loadError = null
            this.applyLoadedEntries(entries)
            this.recordCurrentDirectory(resolvedPath)
            this.focusPanelIfOwned()
        } catch (error) {
            if (this.isRequestStale(request)) {
                return
            }
            const message = extractErrorMessage(error)
            const unavailable = this.isDirectoryUnavailableError(error)
            this.notifications.error(message)
            if (hadValidList && unavailable) {
                this.errorNotice = {
                    path: resolvedPath,
                    message,
                }
                this.cdr.detectChanges()
                this.focusPanelIfOwned()
            } else {
                if (!unavailable) {
                    this.detachBackend(true)
                }
                this.setCurrentPath(resolvedPath, false)
                this.resetFileLists()
                this.loadError = {
                    path: resolvedPath,
                    message,
                }
            }
        }
    }

    async retryLoad (): Promise<void> {
        const retryPath = this.loadError?.path ?? this.currentPath
        const failed = this.backend ?? this.failedBackend
        this.detachBackend()
        this.failedBackend = null
        await this.initializeBackendAndNavigate(retryPath, failed)
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
        if (this.backend?.normalizePath) {
            void this.navigate(path.dirname(this.path))
            return
        }
        const parts = this.path.split('/').filter(Boolean)
        if (parts.includes('..')) {
            void this.navigate(this.joinChildPath(this.path, '..'))
            return
        }
        parts.pop()
        void this.navigate(parts.length > 0 ? `/${parts.join('/')}` : '/')
    }

    private async resolveLink (item: SFTPFile, request?: number): Promise<SFTPFile | undefined> {
        if (!item.isSymlink) {
            return item
        }
        if (!this.backend) {
            return undefined
        }
        try {
            return await this.backend.stat(item.fullPath)
        } catch (error) {
            if (!this.destroyed && (request === undefined || request === this.navigation)) {
                this.notifications.error(extractErrorMessage(error))
            }
            return undefined
        }
    }

    async open (item: SFTPFile): Promise<void> {
        const request = ++this.navigation
        const target = await this.resolveLink(item, request)
        if (!target || this.destroyed || request !== this.navigation) {
            return
        }
        if (target.isDirectory) {
            await this.navigateWithRequest(item.fullPath, request)
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
        const request = this.navigation
        const target = await this.resolveLink(item, request)
        if (!target || this.destroyed || request !== this.navigation) {
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
        const request = this.navigation
        const basePath = this.path
        const modal = this.ngbModal.open(SFTPCreateDirectoryModalComponent)
        const directoryName = await modal.result.catch(() => null)
        const activeBackend = this.getActiveBackend()
        if (this.destroyed || request !== this.navigation || !activeBackend) {
            return
        }
        if (directoryName?.trim()) {
            const targetPath = this.joinChildPath(basePath, directoryName)
            activeBackend.mkdir(targetPath).then(() => {
                this.notifications.notice('The directory was created successfully')
                if (!this.destroyed && request === this.navigation) {
                    void this.navigate(targetPath)
                }
            }).catch(() => {
                if (!this.destroyed) {
                    this.notifications.error('The directory could not be created')
                }
            })
        }
    }

    async upload (): Promise<void> {
        const request = this.navigation
        const target = this.path
        try {
            const transfers = await this.platform.startUpload({ multiple: true })
            await Promise.all(transfers.map(t => this.uploadOne(t, target, request)))
        } catch (error) {
            this.notifications.error(extractErrorMessage(error))
        }
    }

    async uploadFolder (): Promise<void> {
        const request = this.navigation
        const target = this.path
        try {
            const transfer = await this.platform.startUploadDirectory()
            await this.uploadOneFolder(transfer, target, request)
        } catch (error) {
            this.notifications.error(extractErrorMessage(error))
        }
    }

    async uploadOneFolder (transfer: DirectoryUpload, base = this.path, request = this.navigation): Promise<void> {
        try {
            await this.uploadDirectoryEntries(transfer, base)
            if (!this.destroyed && request === this.navigation && base === this.path) {
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
            const target = this.joinChildPath(directory, child.getName())
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

    async uploadOne (transfer: FileUpload, target = this.path, request = this.navigation): Promise<void> {
        if (!this.backend) {
            return
        }
        await this.backend.upload(this.joinChildPath(target, transfer.getName()), transfer)
        if (!this.destroyed && request === this.navigation && this.path === target) {
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

    onPathInputKeyDown (event: KeyboardEvent): void {
        if (event.isComposing || event.keyCode === 229) {
            event.stopPropagation()
            return
        }
        if (event.key === 'Enter') {
            this.confirmPath(event)
            return
        }
        if (event.key === 'Escape') {
            this.cancelPathEdit(event)
        }
    }

    confirmPath (event?: Event): void {
        event?.preventDefault()
        event?.stopPropagation()
        if (this.editingPath === null) {
            return
        }
        const raw = this.editingPath
        this.editingPath = null
        const target = raw.trim() === '' ? '/' : raw
        void this.navigate(target)
    }

    cancelPathEdit (event?: Event): void {
        event?.preventDefault()
        event?.stopPropagation()
        if (this.editingPath === null) {
            return
        }
        this.editingPath = null
        if (event?.type !== 'blur') {
            this.cdr.detectChanges()
            this.focusPanel()
        }
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

    trackByVisibleRow (_index: number, row: VisibleFileRow): string {
        return row.entry.item.fullPath
    }

    trackBySegment (index: number): number {
        return index
    }

    onBodyScroll (): void {
        if (this.filteredEntries.length <= VIRTUAL_THRESHOLD) {
            return
        }
        const { start, end } = this.computeVisibleRange(this.filteredEntries.length)
        if (start !== this.visibleStartIndex || end !== this.visibleEndIndex) {
            this.updateVisibleEntries(start, end)
        }
    }

    private handleBodyResize (): void {
        if (this.destroyed || this.filteredEntries.length <= VIRTUAL_THRESHOLD) {
            return
        }
        const { start, end } = this.computeVisibleRange(this.filteredEntries.length)
        if (start !== this.visibleStartIndex || end !== this.visibleEndIndex) {
            this.updateVisibleEntries(start, end)
            this.cdr.detectChanges()
        }
    }

    private computeVisibleRange (total: number): { start: number, end: number } {
        if (total <= VIRTUAL_THRESHOLD) {
            return { start: 0, end: total }
        }
        const body = this.bodyContainer?.nativeElement
        const scrollTop = body?.scrollTop ?? 0
        const viewportHeight = body && body.clientHeight > 0 ? body.clientHeight : 480
        const windowCount = Math.max(
            VIRTUAL_MIN_WINDOW,
            Math.ceil(viewportHeight / VIRTUAL_ROW_HEIGHT) + VIRTUAL_OVERSCAN * 2,
        )
        const start = Math.max(0, Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN)
        const end = Math.min(total, start + windowCount)
        return { start, end }
    }

    private updateVisibleEntries (explicitStart?: number, explicitEnd?: number): void {
        const total = this.filteredEntries.length
        if (total === 0) {
            this.visibleEntries = []
            this.topSpacerHeight = 0
            this.bottomSpacerHeight = 0
            this.visibleStartIndex = 0
            this.visibleEndIndex = 0
            return
        }
        const range = explicitStart !== undefined && explicitEnd !== undefined
            ? { start: explicitStart, end: explicitEnd }
            : this.computeVisibleRange(total)
        this.visibleStartIndex = range.start
        this.visibleEndIndex = range.end
        this.topSpacerHeight = range.start * VIRTUAL_ROW_HEIGHT
        this.bottomSpacerHeight = (total - range.end) * VIRTUAL_ROW_HEIGHT
        const rows: VisibleFileRow[] = new Array(range.end - range.start)
        for (let i = range.start; i < range.end; i++) {
            const entry = this.filteredEntries[i]
            let meta = this.rowMetaCache.get(entry.item.fullPath)
            if (!meta) {
                meta = {
                    icon: this.getIcon(entry.item),
                    mode: this.getModeString(entry.item),
                }
                this.rowMetaCache.set(entry.item.fullPath, meta)
            }
            rows[i - range.start] = {
                index: i,
                entry,
                icon: meta.icon,
                mode: meta.mode,
            }
        }
        this.visibleEntries = rows
    }

    focusPanel (): void {
        if (this.destroyed || this.editingPath !== null || this.ngbModal.hasOpenModals()) {
            return
        }
        this.elementRef.nativeElement.focus({ preventScroll: true })
    }

    private focusPanelIfOwned (): void {
        if (this.destroyed || this.editingPath !== null || this.ngbModal.hasOpenModals()) {
            return
        }
        const active = typeof document !== 'undefined' ? document.activeElement : null
        if (
            !active ||
            active === document.body ||
            active === document.documentElement ||
            this.elementRef.nativeElement.contains(active)
        ) {
            this.focusPanel()
        }
    }

    private updateFilteredList (resetSelection: boolean): void {
        if (!this.fileList) {
            this.filteredEntries = []
            this.filteredFileList = []
            this.visibleEntries = []
            this.topSpacerHeight = 0
            this.bottomSpacerHeight = 0
            this.visibleStartIndex = 0
            this.visibleEndIndex = 0
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
            if (resetSelection && this.bodyContainer?.nativeElement) {
                this.bodyContainer.nativeElement.scrollTop = 0
            }
        }
        this.updateVisibleEntries()
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
        if (this.filteredEntries.length > VIRTUAL_THRESHOLD && this.bodyContainer?.nativeElement) {
            const body = this.bodyContainer.nativeElement
            const viewportHeight = body.clientHeight > 0 ? body.clientHeight : 480
            const rowTop = this.selectedIndex * VIRTUAL_ROW_HEIGHT
            const rowBottom = rowTop + VIRTUAL_ROW_HEIGHT
            if (rowTop < body.scrollTop) {
                body.scrollTop = rowTop
            } else if (rowBottom > body.scrollTop + viewportHeight) {
                body.scrollTop = Math.max(0, rowBottom - viewportHeight)
            }
            this.updateVisibleEntries()
            this.cdr.detectChanges()
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
