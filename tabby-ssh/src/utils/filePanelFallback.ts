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

const TRANSIENT_ERROR_PATTERN = /\b(timeout|timed out|channel closed|disconnected|connection reset|connection refused|econnreset|epipe|broken pipe|not connected|session closed|offline|transport closed)\b/i
const UNAVAILABLE_ERROR_PATTERN = /no\s*such\s*file|permission\s*denied|not\s*a\s*directory|enoent|eacces|enotdir|ssh_fx_no_such_file|ssh_fx_permission_denied|status(?:\s+code)?\s*[:=]?\s*[23]\b/i
const CHANNEL_CLOSED_ERROR_PATTERN = /\b(channel\s+(?:is\s+)?closed|session\s+(?:is\s+)?closed|transport\s+(?:is\s+)?closed|stream\s+(?:is\s+)?closed|sftp\s+(?:channel|session)\s+(?:is\s+)?closed|broken\s+pipe|epipe|econnreset|connection\s+reset|disconnected|not\s+connected|unexpected\s*eof|end\s+of\s+file|eof)\b/i

export function hasDotDotSegment (rawPath: string): boolean {
    if (typeof rawPath !== 'string' || !rawPath) {
        return false
    }
    return rawPath.split('/').includes('..')
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

export async function resolvePosixPathWithReadlink (
    rawPath: string,
    readlink: (targetPath: string) => Promise<string>,
    maxSymlinks = 40,
): Promise<string> {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
        return '/'
    }
    const initialParts = rawPath.split('/').filter(part => part !== '' && part !== '.')
    if (!initialParts.includes('..')) {
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
            if (isSFTPChannelClosedError(error) || isSFTPDirectoryUnavailableError(error)) {
                return rawPath
            }
            linkTarget = null
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
