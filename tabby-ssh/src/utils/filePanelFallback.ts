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

const TRANSIENT_ERROR_PATTERN = /\b(timeout|timed out|channel closed|disconnected|connection reset|connection refused|econnreset|epipe|broken pipe|not connected|session closed|offline|transport closed)\b/i
const UNAVAILABLE_ERROR_PATTERN = /no such file|permission denied|not a directory|enoent|eacces|enotdir|ssh_fx_no_such_file|ssh_fx_permission_denied|status(?:\s+code)?\s*[:=]?\s*[23]\b/i

export function normalizeFallbackPath (rawPath: string): string {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
        return '/'
    }
    const segments = rawPath.split('/')
    const resolved: string[] = []
    for (const segment of segments) {
        if (!segment || segment === '.') {
            continue
        }
        if (segment === '..') {
            resolved.pop()
        } else {
            resolved.push(segment)
        }
    }
    return resolved.length > 0 ? `/${resolved.join('/')}` : '/'
}

export function getParentDirectoryPath (dirPath: string): string | null {
    const normalized = normalizeFallbackPath(dirPath)
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

export async function resolveReadableDirectory<T> (
    startPath: string,
    readdir: (dirPath: string) => Promise<T[]>,
    isUnavailable: (error: unknown) => boolean,
    isStale?: () => boolean,
): Promise<DirectoryFallbackSuccess<T> | DirectoryFallbackFailure | DirectoryFallbackCancelled> {
    const requestedPath = normalizeFallbackPath(startPath)
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
            const parentPath = getParentDirectoryPath(currentPath)
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
