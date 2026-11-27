export interface DirectoryFallbackSuccess<T> {
    ok: true
    cancelled: false
    path: string
    entries: T[]
    requestedPath: string
    fellBackFrom?: string
    fallbackReason?: string
}

export interface DirectoryFallbackFailure {
    ok: false
    cancelled: false
    path: string
    requestedPath: string
    error: unknown
    errorMessage: string
    isUnavailable: boolean
}

export interface DirectoryFallbackCancelled {
    ok: false
    cancelled: true
    path: string
    requestedPath: string
}

export interface ManagedSFTPChannel {
    closed$: { subscribe: (onClose: () => void) => unknown }
    close: () => Promise<unknown>
}

const TRANSIENT_ERROR_PATTERN = /\b(timeout|timed out|etimedout|channel closed|disconnected|connection reset|connection refused|econnreset|epipe|broken pipe|not connected|session closed|offline|transport closed)\b/i
const UNAVAILABLE_ERROR_PATTERN = /no\s*such\s*file|permission\s*denied|not\s*a\s*directory|enoent|eacces|enotdir|ssh_fx_no_such_file|ssh_fx_permission_denied|status(?:\s+code)?\s*[:=]?\s*[23]\b/i
const CHANNEL_CLOSED_ERROR_PATTERN = /\b(channel\s+(?:is\s+)?closed|session\s+(?:is\s+)?closed|transport\s+(?:is\s+)?closed|stream\s+(?:is\s+)?closed|sftp\s+(?:channel|session)\s+(?:is\s+)?closed|broken\s+pipe|epipe|econnreset|connection\s+reset|disconnected|not\s+connected|unexpected\s*eof|end\s+of\s+file|eof)\b/i
const EXPLICIT_NOT_SYMLINK_ERROR_PATTERN = /\b(einval|invalid\s+argument|not\s+a\s+sym(?:bolic\s+)?link)\b/i
const GENERIC_SFTP_FAILURE_ERROR_PATTERN = /\bstatus_code\s*:\s*(?:failure|badmessage)\b|\bstatus\s*\(\s*(?:failure|bad\s*message)\s*\)|\bssh_fx_(?:failure|bad_message)\b|(?:^|[:(\s])(?:failure|bad\s*message)(?:\)|$)/i

export function hasDotDotSegment (rawPath: string): boolean {
    if (typeof rawPath !== 'string' || !rawPath) {
        return false
    }
    return rawPath.split('/').includes('..')
}

export function hasRelativePathSegment (rawPath: string): boolean {
    if (typeof rawPath !== 'string' || !rawPath) {
        return false
    }
    return rawPath.split('/').some(segment => segment === '..' || segment === '.')
}

export function normalizeFallbackPath (rawPath: string, preserveDotDot = false): string {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
        return '/'
    }
    const segments = rawPath.split('/')
    const resolved: string[] = []
    for (const segment of segments) {
        if (!segment || segment === '.') {
            continue
        }
        if (segment === '..' && !preserveDotDot) {
            resolved.pop()
        } else {
            resolved.push(segment)
        }
    }
    return resolved.length > 0 ? `/${resolved.join('/')}` : '/'
}

export function getParentDirectoryPath (dirPath: string, preserveDotDot = false): string | null {
    const normalized = normalizeFallbackPath(dirPath, preserveDotDot)
    if (normalized === '/') {
        return null
    }
    const lastSlash = normalized.lastIndexOf('/')
    if (lastSlash <= 0) {
        return '/'
    }
    return normalized.slice(0, lastSlash)
}

export function extractErrorMessage (error: unknown): string {
    if (error instanceof Error && error.message) {
        return error.message
    }
    if (typeof error === 'string' && error) {
        return error
    }
    if (typeof error === 'object' && error !== null && 'message' in error) {
        const message = (error as { message?: unknown }).message
        if (typeof message === 'string' && message) {
            return message
        }
    }
    return String(error ?? 'Unknown error')
}

export function isAdbDirectoryUnavailableError (error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
        return false
    }
    return (error as { reason?: unknown }).reason === 'unreadable_directory'
}

export function isSFTPDirectoryUnavailableError (error: unknown): boolean {
    if (typeof error === 'object' && error !== null) {
        const candidate = error as {
            reason?: unknown
            code?: unknown
            status?: unknown
            statusCode?: unknown
        }
        if (candidate.reason === 'unreadable_directory') {
            return true
        }
        const numericCodes = [candidate.code, candidate.status, candidate.statusCode]
        if (numericCodes.some(value => value === 2 || value === 3)) {
            return true
        }
        if (candidate.code === 'ENOENT' || candidate.code === 'EACCES' || candidate.code === 'ENOTDIR') {
            return true
        }
    }
    const message = extractErrorMessage(error)
    if (TRANSIENT_ERROR_PATTERN.test(message)) {
        return false
    }
    return UNAVAILABLE_ERROR_PATTERN.test(message)
}

export function isSFTPChannelClosedError (error: unknown): boolean {
    if (isSFTPDirectoryUnavailableError(error)) {
        return false
    }
    const message = extractErrorMessage(error).trim()
    if (!message) {
        return false
    }
    if (CHANNEL_CLOSED_ERROR_PATTERN.test(message)) {
        return true
    }
    return /(?:^|[\s:(])closed\b/i.test(message) && !/\bstatus\s*\(\s*failure\s*\)/i.test(message)
}

export function isTransientConnectionError (error: unknown): boolean {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ETIMEDOUT') {
        return true
    }
    if (isSFTPChannelClosedError(error)) {
        return true
    }
    return TRANSIENT_ERROR_PATTERN.test(extractErrorMessage(error))
}

function isExplicitNotSymlinkError (error: unknown): boolean {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EINVAL') {
        return true
    }
    return EXPLICIT_NOT_SYMLINK_ERROR_PATTERN.test(extractErrorMessage(error))
}

function isGenericSFTPFailureError (error: unknown): boolean {
    if (typeof error === 'object' && error !== null) {
        const candidate = error as { code?: unknown, status?: unknown, statusCode?: unknown }
        if ([candidate.code, candidate.status, candidate.statusCode].some(value => value === 4 || value === 5)) {
            return true
        }
    }
    return GENERIC_SFTP_FAILURE_ERROR_PATTERN.test(extractErrorMessage(error).trim())
}

export interface PosixPathStatLike {
    isDirectory: boolean
    isSymlink?: boolean
}

export async function resolvePosixPathWithReadlink (
    rawPath: string,
    readlink: (targetPath: string) => Promise<string>,
    stat?: (targetPath: string) => Promise<PosixPathStatLike>,
    maxSymlinks = 40,
): Promise<string> {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
        return '/'
    }
    const rawSegments = rawPath.split('/')
    const initialParts = rawSegments.filter(part => part !== '' && part !== '.')
    if (!initialParts.includes('..')) {
        if (rawSegments.includes('.')) {
            return initialParts.length > 0 ? `/${initialParts.join('/')}` : '/'
        }
        return rawPath
    }
    const queue: string[] = [...initialParts]
    const resolved: string[] = []
    let symlinksFollowed = 0

    while (queue.length > 0) {
        const segment = queue.shift()
        if (!segment || segment === '.') {
            continue
        }
        if (segment === '..') {
            resolved.pop()
            continue
        }
        const candidate = resolved.length > 0 ? `/${resolved.join('/')}/${segment}` : `/${segment}`
        let linkTarget: string | null = null
        try {
            linkTarget = await readlink(candidate)
        } catch (error) {
            if (
                isSFTPChannelClosedError(error) ||
                isTransientConnectionError(error) ||
                isSFTPDirectoryUnavailableError(error)
            ) {
                throw error
            }
            if (isExplicitNotSymlinkError(error)) {
                if (stat) {
                    const info = await stat(candidate)
                    if (!info.isDirectory || info.isSymlink) {
                        throw error
                    }
                }
                linkTarget = null
            } else if (isGenericSFTPFailureError(error) && stat) {
                const info = await stat(candidate)
                if (!info.isDirectory || info.isSymlink) {
                    throw error
                }
                linkTarget = null
            } else {
                throw error
            }
        }
        if (linkTarget !== null) {
            symlinksFollowed++
            if (symlinksFollowed > maxSymlinks) {
                return rawPath
            }
            const targetParts = linkTarget.split('/').filter(part => part !== '' && part !== '.')
            if (linkTarget.startsWith('/')) {
                resolved.length = 0
            }
            queue.unshift(...targetParts)
        } else {
            resolved.push(segment)
        }
    }
    return resolved.length > 0 ? `/${resolved.join('/')}` : '/'
}

export class SFTPChannelPool<T extends ManagedSFTPChannel> {
    private currentChannel: T | null = null
    private openingChannel: Promise<T> | null = null
    private createChannel: () => Promise<T>

    constructor (factory: () => Promise<T>) {
        this.createChannel = factory
    }

    get current (): T | null {
        return this.currentChannel
    }

    invalidate (channel: T | null | undefined): void {
        if (!channel || this.currentChannel !== channel) {
            return
        }
        this.currentChannel = null
        void channel.close().catch(() => null)
    }

    async acquire (failedChannel?: T | null): Promise<T> {
        if (failedChannel && this.currentChannel !== null && this.currentChannel === failedChannel) {
            this.invalidate(failedChannel)
        }
        if (this.currentChannel) {
            return this.currentChannel
        }
        if (!this.openingChannel) {
            const pending = (async () => {
                const created = await this.createChannel()
                this.currentChannel = created
                created.closed$.subscribe(() => {
                    if (this.currentChannel === created) {
                        this.currentChannel = null
                    }
                })
                return created
            })()
            this.openingChannel = pending
            pending.finally(() => {
                if (this.openingChannel === pending) {
                    this.openingChannel = null
                }
            }).catch(() => null)
        }
        return this.openingChannel
    }
}

export async function resolveReadableDirectory<T> (
    startPath: string,
    readdir: (dirPath: string) => Promise<T[]>,
    isUnavailable: (error: unknown) => boolean,
    isStale?: () => boolean,
    preserveDotDot = false,
): Promise<DirectoryFallbackSuccess<T> | DirectoryFallbackFailure | DirectoryFallbackCancelled> {
    const requestedPath = normalizeFallbackPath(startPath, preserveDotDot)
    let currentPath = requestedPath
    let initialFailureReason: string | undefined = undefined

    while (true) {
        if (isStale?.()) {
            return {
                ok: false,
                cancelled: true,
                path: currentPath,
                requestedPath,
            }
        }

        try {
            const entries = await readdir(currentPath)
            if (isStale?.()) {
                return {
                    ok: false,
                    cancelled: true,
                    path: currentPath,
                    requestedPath,
                }
            }
            if (currentPath !== requestedPath) {
                return {
                    ok: true,
                    cancelled: false,
                    path: currentPath,
                    entries,
                    requestedPath,
                    fellBackFrom: requestedPath,
                    fallbackReason: initialFailureReason,
                }
            }
            return {
                ok: true,
                cancelled: false,
                path: currentPath,
                entries,
                requestedPath,
            }
        } catch (error) {
            if (isStale?.()) {
                return {
                    ok: false,
                    cancelled: true,
                    path: currentPath,
                    requestedPath,
                }
            }
            const unavailable = isUnavailable(error)
            const errorMessage = extractErrorMessage(error)
            if (initialFailureReason === undefined) {
                initialFailureReason = errorMessage
            }
            if (!unavailable) {
                return {
                    ok: false,
                    cancelled: false,
                    path: currentPath,
                    requestedPath,
                    error,
                    errorMessage,
                    isUnavailable: false,
                }
            }
            const parentPath = getParentDirectoryPath(currentPath, preserveDotDot)
            if (parentPath === null) {
                return {
                    ok: false,
                    cancelled: false,
                    path: currentPath,
                    requestedPath,
                    error,
                    errorMessage,
                    isUnavailable: true,
                }
            }
            currentPath = parentPath
        }
    }
}

export interface CanonicalDirectoryListingResult<T> {
    cancelled: boolean
    path: string
    entries: T[]
}

export async function finalizeCanonicalDirectoryListing<T> (
    listedPath: string,
    initialEntries: T[],
    resolvePath: ((dirPath: string) => Promise<string>) | undefined,
    readdir: (dirPath: string) => Promise<T[]>,
    normalizePath: (rawPath: string) => string,
    isStale: () => boolean,
    shouldResolveRelative: boolean,
    onCanonicalPath?: (canonicalPath: string) => void,
): Promise<CanonicalDirectoryListingResult<T>> {
    if (isStale()) {
        return { cancelled: true, path: listedPath, entries: [] }
    }
    if (!shouldResolveRelative || !resolvePath || !hasRelativePathSegment(listedPath)) {
        return { cancelled: false, path: listedPath, entries: initialEntries }
    }
    let canonicalPath = listedPath
    try {
        const resolved = await resolvePath(listedPath)
        if (isStale()) {
            return { cancelled: true, path: listedPath, entries: [] }
        }
        canonicalPath = normalizePath(resolved)
    } catch (error) {
        if (isStale()) {
            return { cancelled: true, path: listedPath, entries: [] }
        }
        throw error
    }
    if (canonicalPath === listedPath) {
        return { cancelled: false, path: canonicalPath, entries: initialEntries }
    }
    onCanonicalPath?.(canonicalPath)
    const freshEntries = await readdir(canonicalPath)
    if (isStale()) {
        return { cancelled: true, path: canonicalPath, entries: [] }
    }
    return { cancelled: false, path: canonicalPath, entries: freshEntries }
}

export interface CancellableFileUploadLike {
    isCancelled?: () => boolean
    isComplete?: () => boolean
    getSize?: () => number
    cancel: () => void
}

export interface DirectoryUploadTreeLike<T extends CancellableFileUploadLike = CancellableFileUploadLike> {
    getChildrens: () => (T | DirectoryUploadTreeLike<T>)[]
}

function isDirectoryUploadTree<T extends CancellableFileUploadLike> (
    item: T | DirectoryUploadTreeLike<T>,
): item is DirectoryUploadTreeLike<T> {
    return typeof (item as DirectoryUploadTreeLike<T>).getChildrens === 'function'
}

export function isFileUploadAlreadyComplete<T extends CancellableFileUploadLike> (transfer: T): boolean {
    if (typeof transfer.isComplete !== 'function') {
        return false
    }
    if (typeof transfer.getSize === 'function' && transfer.getSize() === 0) {
        return false
    }
    return transfer.isComplete()
}

export function shouldSkipQueuedFileUpload<T extends CancellableFileUploadLike> (transfer: T): boolean {
    if (typeof transfer.isCancelled === 'function' && transfer.isCancelled()) {
        return true
    }
    return isFileUploadAlreadyComplete(transfer)
}

export function cancelPendingFileUpload<T extends CancellableFileUploadLike> (
    transfer: T,
    handled?: Set<T>,
): boolean {
    if (handled?.has(transfer)) {
        return false
    }
    handled?.add(transfer)
    if (typeof transfer.isCancelled === 'function' && transfer.isCancelled()) {
        return false
    }
    if (isFileUploadAlreadyComplete(transfer)) {
        return false
    }
    transfer.cancel()
    return true
}

export function cancelPendingDirectoryUpload<T extends CancellableFileUploadLike> (
    transfer: DirectoryUploadTreeLike<T>,
    handled?: Set<T>,
): number {
    let cancelledCount = 0
    for (const child of transfer.getChildrens()) {
        if (isDirectoryUploadTree(child)) {
            cancelledCount += cancelPendingDirectoryUpload(child, handled)
        } else if (cancelPendingFileUpload(child, handled)) {
            cancelledCount++
        }
    }
    return cancelledCount
}
