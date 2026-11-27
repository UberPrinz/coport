export const FILE_PANEL_STATE_STORAGE_KEY = 'coport.filePanelState.v1'
export const FILE_PANEL_STATE_VERSION = 1
export const ADB_FILE_PANEL_SCOPE = 'adb:shared'
export const MAX_RECENT_PATHS = 20
export const MAX_FAVORITE_PATHS = 50
export const MAX_SSH_SCOPES = 50

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export interface FilePanelScopeRecord {
    recent: string[]
    favorites: string[]
    updatedAt: number
}

export interface FilePanelStateSnapshot {
    version: 1
    scopes: Record<string, FilePanelScopeRecord>
}

export interface FilePanelStorageLike {
    getItem: (key: string) => string | null
    setItem: (key: string, value: string) => void
}

export function createSSHFilePanelScope (user: string, host: string, port?: number | null): string {
    const normalizedUser = user.trim()
    const normalizedHost = host.trim()
    const normalizedPort = typeof port === 'number' && Number.isFinite(port) && port > 0 ? Math.trunc(port) : 22
    return `ssh:${normalizedUser}@${normalizedHost}:${normalizedPort}`
}

export function normalizeFilePanelPath (rawPath: string): string {
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

function dedupeAndCapPaths (paths: readonly unknown[], limit: number): string[] {
    const result: string[] = []
    const seen = new Set<string>()
    for (const entry of paths) {
        if (typeof entry !== 'string') {
            continue
        }
        const normalized = normalizeFilePanelPath(entry)
        if (seen.has(normalized)) {
            continue
        }
        seen.add(normalized)
        result.push(normalized)
        if (result.length >= limit) {
            break
        }
    }
    return result
}

function createEmptySnapshot (): FilePanelStateSnapshot {
    return {
        version: FILE_PANEL_STATE_VERSION,
        scopes: {},
    }
}

function isPlainRecord (value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pruneSSHScopes (scopes: Record<string, FilePanelScopeRecord>): void {
    const sshKeys = Object.keys(scopes).filter(key => key.startsWith('ssh:'))
    if (sshKeys.length <= MAX_SSH_SCOPES) {
        return
    }
    sshKeys.sort((a, b) => {
        const diff = scopes[a].updatedAt - scopes[b].updatedAt
        if (diff !== 0) {
            return diff
        }
        return a < b ? -1 : a > b ? 1 : 0
    })
    const excess = sshKeys.length - MAX_SSH_SCOPES
    for (let i = 0; i < excess; i++) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete scopes[sshKeys[i]]
    }
}

export function parseFilePanelState (raw: string | null | undefined): FilePanelStateSnapshot {
    if (!raw || typeof raw !== 'string') {
        return createEmptySnapshot()
    }
    let parsed: unknown = null
    try {
        parsed = JSON.parse(raw)
    } catch {
        return createEmptySnapshot()
    }
    if (!isPlainRecord(parsed) || parsed.version !== FILE_PANEL_STATE_VERSION || !isPlainRecord(parsed.scopes)) {
        return createEmptySnapshot()
    }

    const scopes: Record<string, FilePanelScopeRecord> = {}
    for (const [scopeKey, rawScope] of Object.entries(parsed.scopes)) {
        if (!scopeKey || FORBIDDEN_KEYS.has(scopeKey) || !isPlainRecord(rawScope)) {
            continue
        }
        const recent = Array.isArray(rawScope.recent)
            ? dedupeAndCapPaths(rawScope.recent, MAX_RECENT_PATHS)
            : []
        const favorites = Array.isArray(rawScope.favorites)
            ? dedupeAndCapPaths(rawScope.favorites, MAX_FAVORITE_PATHS)
            : []
        const updatedAt = typeof rawScope.updatedAt === 'number' && Number.isFinite(rawScope.updatedAt)
            ? rawScope.updatedAt
            : 0
        scopes[scopeKey] = {
            recent,
            favorites,
            updatedAt,
        }
    }

    pruneSSHScopes(scopes)
    return {
        version: FILE_PANEL_STATE_VERSION,
        scopes,
    }
}

export function cloneFilePanelScopeRecord (record: FilePanelScopeRecord | undefined): FilePanelScopeRecord {
    if (!record) {
        return { recent: [], favorites: [], updatedAt: 0 }
    }
    return {
        recent: [...record.recent],
        favorites: [...record.favorites],
        updatedAt: record.updatedAt,
    }
}

export class FilePanelStateStore {
    private storage: FilePanelStorageLike | null
    private storageKey: string
    private memoryState: FilePanelStateSnapshot = createEmptySnapshot()
    private lastStorageRaw: string | null = null
    private hasLoadedFromStorage = false
    private writeFailed = false
    private lastTimestamp = 0

    constructor (
        storage?: FilePanelStorageLike | null,
        storageKey = FILE_PANEL_STATE_STORAGE_KEY,
    ) {
        this.storage = storage ?? null
        this.storageKey = storageKey
    }

    private nextTimestamp (explicitNow?: number): number {
        if (typeof explicitNow === 'number' && Number.isFinite(explicitNow)) {
            this.lastTimestamp = Math.max(this.lastTimestamp, explicitNow)
            return explicitNow
        }
        const now = Math.max(Date.now(), this.lastTimestamp + 1)
        this.lastTimestamp = now
        return now
    }

    private readSnapshot (): FilePanelStateSnapshot {
        if (!this.storage) {
            return this.memoryState
        }
        let raw: string | null = null
        try {
            raw = this.storage.getItem(this.storageKey)
        } catch {
            return this.memoryState
        }
        if (!this.hasLoadedFromStorage || raw !== this.lastStorageRaw) {
            if (raw === null && this.writeFailed) {
                return this.memoryState
            }
            this.memoryState = parseFilePanelState(raw)
            this.lastStorageRaw = raw
            this.hasLoadedFromStorage = true
            this.writeFailed = false
        }
        return this.memoryState
    }

    private writeSnapshot (snapshot: FilePanelStateSnapshot): void {
        pruneSSHScopes(snapshot.scopes)
        this.memoryState = snapshot
        if (!this.storage) {
            return
        }
        const serialized = JSON.stringify(snapshot)
        try {
            this.storage.setItem(this.storageKey, serialized)
            this.lastStorageRaw = serialized
            this.hasLoadedFromStorage = true
            this.writeFailed = false
        } catch {
            this.writeFailed = true
        }
    }

    private mutateScope (
        scope: string | null | undefined,
        now: number | undefined,
        mutator: (record: FilePanelScopeRecord) => void,
    ): FilePanelScopeRecord | null {
        if (!scope || FORBIDDEN_KEYS.has(scope)) {
            return null
        }
        const snapshot = this.readSnapshot()
        const existing = Object.prototype.hasOwnProperty.call(snapshot.scopes, scope)
            ? snapshot.scopes[scope]
            : undefined
        const record = cloneFilePanelScopeRecord(existing)
        mutator(record)
        record.updatedAt = this.nextTimestamp(now)
        snapshot.scopes[scope] = record
        this.writeSnapshot(snapshot)
        return cloneFilePanelScopeRecord(record)
    }

    getSnapshot (): FilePanelStateSnapshot {
        const snapshot = this.readSnapshot()
        const scopes: Record<string, FilePanelScopeRecord> = {}
        for (const [key, value] of Object.entries(snapshot.scopes)) {
            scopes[key] = cloneFilePanelScopeRecord(value)
        }
        return {
            version: FILE_PANEL_STATE_VERSION,
            scopes,
        }
    }

    getScopeState (scope: string | null | undefined): FilePanelScopeRecord {
        if (!scope || FORBIDDEN_KEYS.has(scope)) {
            return { recent: [], favorites: [], updatedAt: 0 }
        }
        const snapshot = this.readSnapshot()
        const existing = Object.prototype.hasOwnProperty.call(snapshot.scopes, scope)
            ? snapshot.scopes[scope]
            : undefined
        return cloneFilePanelScopeRecord(existing)
    }

    getLastPath (scope: string | null | undefined): string | null {
        const state = this.getScopeState(scope)
        return state.recent.length > 0 ? state.recent[0] : null
    }

    getRecent (scope: string | null | undefined): string[] {
        return this.getScopeState(scope).recent
    }

    getFavorites (scope: string | null | undefined): string[] {
        return this.getScopeState(scope).favorites
    }

    isFavorite (scope: string | null | undefined, rawPath: string): boolean {
        if (!scope) {
            return false
        }
        const normalized = normalizeFilePanelPath(rawPath)
        return this.getScopeState(scope).favorites.includes(normalized)
    }

    recordVisit (scope: string | null | undefined, rawPath: string, now?: number): FilePanelScopeRecord | null {
        const normalized = normalizeFilePanelPath(rawPath)
        return this.mutateScope(scope, now, record => {
            record.recent = [normalized, ...record.recent.filter(item => item !== normalized)].slice(0, MAX_RECENT_PATHS)
        })
    }

    addFavorite (scope: string | null | undefined, rawPath: string, now?: number): FilePanelScopeRecord | null {
        const normalized = normalizeFilePanelPath(rawPath)
        return this.mutateScope(scope, now, record => {
            record.favorites = [normalized, ...record.favorites.filter(item => item !== normalized)].slice(0, MAX_FAVORITE_PATHS)
        })
    }

    removeFavorite (scope: string | null | undefined, rawPath: string, now?: number): FilePanelScopeRecord | null {
        const normalized = normalizeFilePanelPath(rawPath)
        return this.mutateScope(scope, now, record => {
            record.favorites = record.favorites.filter(item => item !== normalized)
        })
    }

    toggleFavorite (scope: string | null | undefined, rawPath: string, now?: number): boolean {
        if (!scope || FORBIDDEN_KEYS.has(scope)) {
            return false
        }
        const normalized = normalizeFilePanelPath(rawPath)
        let added = false
        this.mutateScope(scope, now, record => {
            if (record.favorites.includes(normalized)) {
                record.favorites = record.favorites.filter(item => item !== normalized)
                added = false
            } else {
                record.favorites = [normalized, ...record.favorites].slice(0, MAX_FAVORITE_PATHS)
                added = true
            }
        })
        return added
    }
}
