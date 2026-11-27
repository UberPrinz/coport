export const FILE_PANEL_STATE_STORAGE_KEY = 'coport.filePanelState.v1'
export const FILE_PANEL_STATE_KEY_PREFIX = `${FILE_PANEL_STATE_STORAGE_KEY}:`
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

export interface StoredFilePanelScopeRecord extends FilePanelScopeRecord {
    version: 1
}

export interface FilePanelStateSnapshot {
    version: 1
    scopes: Record<string, FilePanelScopeRecord>
}

export interface FilePanelStorageLike {
    readonly length: number
    key: (index: number) => string | null
    getItem: (key: string) => string | null
    setItem: (key: string, value: string) => void
    removeItem: (key: string) => void
}

export interface FilePanelStateChangeEvent {
    scope: string
    storageKey: string
    source: FilePanelStateStore
}

export type FilePanelStateChangeListener = (event: FilePanelStateChangeEvent) => void

const stateChangeListeners = new Set<FilePanelStateChangeListener>()

export function subscribeFilePanelStateChanges (listener: FilePanelStateChangeListener): () => void {
    stateChangeListeners.add(listener)
    return () => {
        stateChangeListeners.delete(listener)
    }
}

function notifyFilePanelStateChanges (event: FilePanelStateChangeEvent): void {
    for (const listener of [...stateChangeListeners]) {
        try {
            listener(event)
        } catch {
            // Keep sibling listeners isolated.
        }
    }
}

export function createSSHFilePanelScope (
    user: string | null | undefined,
    host: string | null | undefined,
    port?: number | null,
): string {
    const normalizedUser = (user ?? '').trim()
    const normalizedHost = (host ?? '').trim()
    const normalizedPort = typeof port === 'number' && Number.isFinite(port) && port > 0 ? Math.trunc(port) : 22
    return `ssh:${normalizedUser}@${normalizedHost}:${normalizedPort}`
}

export function getFilePanelScopeStorageKey (scope: string, keyPrefix = FILE_PANEL_STATE_KEY_PREFIX): string {
    const normalizedPrefix = keyPrefix.endsWith(':') ? keyPrefix : `${keyPrefix}:`
    return `${normalizedPrefix}${scope}`
}

export function normalizeFilePanelPath (rawPath: string, preserveDotDot = false): string {
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

function shouldPreserveDotDot (scope: string): boolean {
    return scope.startsWith('ssh:')
}

function dedupeAndCapPaths (paths: readonly unknown[], limit: number, preserveDotDot = false): string[] {
    const result: string[] = []
    const seen = new Set<string>()
    for (const entry of paths) {
        if (typeof entry !== 'string') {
            continue
        }
        const normalized = normalizeFilePanelPath(entry, preserveDotDot)
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

function createEmptyRecord (): FilePanelScopeRecord {
    return {
        recent: [],
        favorites: [],
        updatedAt: 0,
    }
}

function isPlainRecord (value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseFilePanelScopeRecord (
    raw: string | null | undefined,
    preserveDotDot = false,
): FilePanelScopeRecord {
    if (!raw || typeof raw !== 'string') {
        return createEmptyRecord()
    }
    let parsed: unknown = null
    try {
        parsed = JSON.parse(raw)
    } catch {
        return createEmptyRecord()
    }
    if (!isPlainRecord(parsed) || parsed.version !== FILE_PANEL_STATE_VERSION) {
        return createEmptyRecord()
    }

    const recent = Array.isArray(parsed.recent)
        ? dedupeAndCapPaths(parsed.recent, MAX_RECENT_PATHS, preserveDotDot)
        : []
    const favorites = Array.isArray(parsed.favorites)
        ? dedupeAndCapPaths(parsed.favorites, MAX_FAVORITE_PATHS, preserveDotDot)
        : []
    const updatedAt = typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
        ? parsed.updatedAt
        : 0

    return {
        recent,
        favorites,
        updatedAt,
    }
}

export function cloneFilePanelScopeRecord (record: FilePanelScopeRecord | undefined): FilePanelScopeRecord {
    if (!record) {
        return createEmptyRecord()
    }
    return {
        recent: [...record.recent],
        favorites: [...record.favorites],
        updatedAt: record.updatedAt,
    }
}

export class FilePanelStateStore {
    private storage: FilePanelStorageLike | null
    private keyPrefix: string
    private sshKeyPrefix: string
    private memoryScopes = new Map<string, FilePanelScopeRecord>()
    private writeFailedScopes = new Set<string>()
    private lastTimestamp = 0

    constructor (
        storage?: FilePanelStorageLike | null,
        storageKeyPrefix = FILE_PANEL_STATE_STORAGE_KEY,
    ) {
        this.storage = storage ?? null
        this.keyPrefix = storageKeyPrefix.endsWith(':') ? storageKeyPrefix : `${storageKeyPrefix}:`
        this.sshKeyPrefix = `${this.keyPrefix}ssh:`
    }

    getScopeStorageKey (scope: string): string {
        return `${this.keyPrefix}${scope}`
    }

    private listMatchingStorageEntries (prefix: string): { key: string, scope: string, raw: string | null }[] {
        if (!this.storage) {
            return []
        }
        const entries: { key: string, scope: string, raw: string | null }[] = []
        try {
            const count = this.storage.length
            const keys: string[] = []
            for (let i = 0; i < count; i++) {
                const key = this.storage.key(i)
                if (key && key.startsWith(prefix)) {
                    keys.push(key)
                }
            }
            for (const key of keys) {
                const scope = key.slice(this.keyPrefix.length)
                if (!scope || FORBIDDEN_KEYS.has(scope)) {
                    continue
                }
                entries.push({
                    key,
                    scope,
                    raw: this.storage.getItem(key),
                })
            }
        } catch {
            return []
        }
        return entries
    }

    private getMaxExistingSSHUpdatedAt (): number {
        let maxUpdatedAt = 0
        if (this.storage) {
            for (const entry of this.listMatchingStorageEntries(this.sshKeyPrefix)) {
                const parsed = parseFilePanelScopeRecord(entry.raw, true)
                if (parsed.updatedAt > maxUpdatedAt) {
                    maxUpdatedAt = parsed.updatedAt
                }
            }
        }
        for (const [scope, record] of this.memoryScopes.entries()) {
            if (scope.startsWith('ssh:') && record.updatedAt > maxUpdatedAt) {
                maxUpdatedAt = record.updatedAt
            }
        }
        return maxUpdatedAt
    }

    private nextTimestamp (explicitNow?: number): number {
        const maxExisting = this.getMaxExistingSSHUpdatedAt()
        if (typeof explicitNow === 'number' && Number.isFinite(explicitNow)) {
            this.lastTimestamp = Math.max(this.lastTimestamp, explicitNow)
            return explicitNow
        }
        const now = Math.max(Date.now(), this.lastTimestamp + 1, maxExisting + 1)
        this.lastTimestamp = now
        return now
    }

    private readScopeRecord (scope: string): FilePanelScopeRecord {
        if (!this.storage) {
            return cloneFilePanelScopeRecord(this.memoryScopes.get(scope))
        }
        const storageKey = this.getScopeStorageKey(scope)
        let raw: string | null = null
        try {
            raw = this.storage.getItem(storageKey)
        } catch {
            return cloneFilePanelScopeRecord(this.memoryScopes.get(scope))
        }
        if (raw === null) {
            if (this.writeFailedScopes.has(scope)) {
                return cloneFilePanelScopeRecord(this.memoryScopes.get(scope))
            }
            this.memoryScopes.delete(scope)
            return createEmptyRecord()
        }
        const parsed = parseFilePanelScopeRecord(raw, shouldPreserveDotDot(scope))
        this.memoryScopes.set(scope, cloneFilePanelScopeRecord(parsed))
        this.writeFailedScopes.delete(scope)
        return parsed
    }

    private pruneSSHScopes (protectedScope?: string): void {
        if (this.storage) {
            const sshEntries = this.listMatchingStorageEntries(this.sshKeyPrefix).map(entry => ({
                ...entry,
                updatedAt: parseFilePanelScopeRecord(entry.raw, true).updatedAt,
            }))
            if (sshEntries.length <= MAX_SSH_SCOPES) {
                return
            }
            const evictable = sshEntries
                .filter(entry => entry.scope !== protectedScope && entry.scope !== ADB_FILE_PANEL_SCOPE)
                .sort((a, b) => {
                    const diff = a.updatedAt - b.updatedAt
                    if (diff !== 0) {
                        return diff
                    }
                    return a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0
                })
            const excess = sshEntries.length - MAX_SSH_SCOPES
            for (let i = 0; i < excess && i < evictable.length; i++) {
                const victim = evictable[i]
                try {
                    this.storage.removeItem(victim.key)
                } catch {
                    // Best-effort LRU eviction.
                }
                this.memoryScopes.delete(victim.scope)
                this.writeFailedScopes.delete(victim.scope)
            }
            return
        }

        const sshScopes = [...this.memoryScopes.entries()]
            .filter(([scope]) => scope.startsWith('ssh:'))
        if (sshScopes.length <= MAX_SSH_SCOPES) {
            return
        }
        const evictable = sshScopes
            .filter(([scope]) => scope !== protectedScope && scope !== ADB_FILE_PANEL_SCOPE)
            .sort(([aScope, aRec], [bScope, bRec]) => {
                const diff = aRec.updatedAt - bRec.updatedAt
                if (diff !== 0) {
                    return diff
                }
                return aScope < bScope ? -1 : aScope > bScope ? 1 : 0
            })
        const excess = sshScopes.length - MAX_SSH_SCOPES
        for (let i = 0; i < excess && i < evictable.length; i++) {
            this.memoryScopes.delete(evictable[i][0])
        }
    }

    private writeScopeRecord (scope: string, record: FilePanelScopeRecord): void {
        this.memoryScopes.set(scope, cloneFilePanelScopeRecord(record))
        if (!this.storage) {
            if (scope.startsWith('ssh:')) {
                this.pruneSSHScopes(scope)
            }
            return
        }
        const storageKey = this.getScopeStorageKey(scope)
        const payload: StoredFilePanelScopeRecord = {
            version: FILE_PANEL_STATE_VERSION,
            recent: [...record.recent],
            favorites: [...record.favorites],
            updatedAt: record.updatedAt,
        }
        const serialized = JSON.stringify(payload)
        try {
            this.storage.setItem(storageKey, serialized)
            this.writeFailedScopes.delete(scope)
            if (scope.startsWith('ssh:')) {
                this.pruneSSHScopes(scope)
            }
            notifyFilePanelStateChanges({
                scope,
                storageKey,
                source: this,
            })
        } catch {
            this.writeFailedScopes.add(scope)
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
        const record = this.readScopeRecord(scope)
        mutator(record)
        record.updatedAt = this.nextTimestamp(now)
        this.writeScopeRecord(scope, record)
        return cloneFilePanelScopeRecord(record)
    }

    getSnapshot (): FilePanelStateSnapshot {
        const scopes: Record<string, FilePanelScopeRecord> = {}
        if (this.storage) {
            for (const entry of this.listMatchingStorageEntries(this.keyPrefix)) {
                scopes[entry.scope] = parseFilePanelScopeRecord(entry.raw, shouldPreserveDotDot(entry.scope))
            }
            for (const failedScope of this.writeFailedScopes) {
                if (!Object.prototype.hasOwnProperty.call(scopes, failedScope)) {
                    const cached = this.memoryScopes.get(failedScope)
                    if (cached) {
                        scopes[failedScope] = cloneFilePanelScopeRecord(cached)
                    }
                }
            }
        } else {
            for (const [scope, record] of this.memoryScopes.entries()) {
                scopes[scope] = cloneFilePanelScopeRecord(record)
            }
        }
        return {
            version: FILE_PANEL_STATE_VERSION,
            scopes,
        }
    }

    getScopeState (scope: string | null | undefined): FilePanelScopeRecord {
        if (!scope || FORBIDDEN_KEYS.has(scope)) {
            return createEmptyRecord()
        }
        return this.readScopeRecord(scope)
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
        if (!scope || FORBIDDEN_KEYS.has(scope)) {
            return false
        }
        const normalized = normalizeFilePanelPath(rawPath, shouldPreserveDotDot(scope))
        return this.getScopeState(scope).favorites.includes(normalized)
    }

    recordVisit (scope: string | null | undefined, rawPath: string, now?: number): FilePanelScopeRecord | null {
        if (!scope || FORBIDDEN_KEYS.has(scope)) {
            return null
        }
        const normalized = normalizeFilePanelPath(rawPath, shouldPreserveDotDot(scope))
        return this.mutateScope(scope, now, record => {
            record.recent = [normalized, ...record.recent.filter(item => item !== normalized)].slice(0, MAX_RECENT_PATHS)
        })
    }

    addFavorite (scope: string | null | undefined, rawPath: string, now?: number): FilePanelScopeRecord | null {
        if (!scope || FORBIDDEN_KEYS.has(scope)) {
            return null
        }
        const normalized = normalizeFilePanelPath(rawPath, shouldPreserveDotDot(scope))
        return this.mutateScope(scope, now, record => {
            record.favorites = [normalized, ...record.favorites.filter(item => item !== normalized)].slice(0, MAX_FAVORITE_PATHS)
        })
    }

    removeFavorite (scope: string | null | undefined, rawPath: string, now?: number): FilePanelScopeRecord | null {
        if (!scope || FORBIDDEN_KEYS.has(scope)) {
            return null
        }
        const normalized = normalizeFilePanelPath(rawPath, shouldPreserveDotDot(scope))
        return this.mutateScope(scope, now, record => {
            record.favorites = record.favorites.filter(item => item !== normalized)
        })
    }

    toggleFavorite (scope: string | null | undefined, rawPath: string, now?: number): boolean {
        if (!scope || FORBIDDEN_KEYS.has(scope)) {
            return false
        }
        const normalized = normalizeFilePanelPath(rawPath, shouldPreserveDotDot(scope))
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
