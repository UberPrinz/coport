export const FILE_PANEL_STATE_STORAGE_KEY = 'coport.filePanelState.v1'
export const FILE_PANEL_STATE_KEY_PREFIX = `${FILE_PANEL_STATE_STORAGE_KEY}:`
export const FILE_PANEL_STATE_VERSION = 1
export const FILE_PANEL_STATE_IPC_OP = 'coport-file-panel-state:op'
export const FILE_PANEL_STATE_IPC_CHANGED = 'coport-file-panel-state:changed'
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

export interface FilePanelStateClient {
    getScopeState: (scope: string | null | undefined) => FilePanelScopeRecord
    getLastPath: (scope: string | null | undefined) => string | null
    getRecent: (scope: string | null | undefined) => string[]
    getFavorites: (scope: string | null | undefined) => string[]
    isFavorite: (scope: string | null | undefined, rawPath: string) => boolean
    recordVisit: (scope: string | null | undefined, rawPath: string, now?: number) => FilePanelScopeRecord | null
    addFavorite: (scope: string | null | undefined, rawPath: string, now?: number) => FilePanelScopeRecord | null
    removeFavorite: (scope: string | null | undefined, rawPath: string, now?: number) => FilePanelScopeRecord | null
    toggleFavorite: (scope: string | null | undefined, rawPath: string, now?: number) => boolean
    getSnapshot: () => FilePanelStateSnapshot
}

export interface FilePanelIpcRendererLike {
    sendSync: (channel: string, payload: unknown) => unknown
    on?: (channel: string, listener: (event: unknown, payload: unknown) => void) => unknown
}

export type FilePanelStateOpRequest =
    | { op: 'getScope', scope: string | null | undefined }
    | { op: 'recordVisit', scope: string | null | undefined, path: string, now?: number }
    | { op: 'addFavorite', scope: string | null | undefined, path: string, now?: number }
    | { op: 'removeFavorite', scope: string | null | undefined, path: string, now?: number }
    | { op: 'toggleFavorite', scope: string | null | undefined, path: string, now?: number }
    | { op: 'getSnapshot' }

export interface FilePanelStateOpResponse {
    ok: boolean
    result?: unknown
    changedScope?: string
    error?: string
}

export interface FilePanelStateChangeEvent {
    scope: string
    storageKey: string
    source: FilePanelStateClient | null
}

export type FilePanelStateChangeListener = (event: FilePanelStateChangeEvent) => void

const stateChangeListeners = new Set<FilePanelStateChangeListener>()
const registeredIpcRenderers = new WeakSet()

export function subscribeFilePanelStateChanges (listener: FilePanelStateChangeListener): () => void {
    stateChangeListeners.add(listener)
    return () => {
        stateChangeListeners.delete(listener)
    }
}

export function notifyFilePanelStateChanges (event: FilePanelStateChangeEvent): void {
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

function createEmptySnapshot (): FilePanelStateSnapshot {
    return {
        version: FILE_PANEL_STATE_VERSION,
        scopes: {},
    }
}

function isPlainRecord (value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeScopeRecord (candidate: Record<string, unknown>, preserveDotDot: boolean): FilePanelScopeRecord {
    const recent = Array.isArray(candidate.recent)
        ? dedupeAndCapPaths(candidate.recent, MAX_RECENT_PATHS, preserveDotDot)
        : []
    const favorites = Array.isArray(candidate.favorites)
        ? dedupeAndCapPaths(candidate.favorites, MAX_FAVORITE_PATHS, preserveDotDot)
        : []
    const updatedAt = typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
        ? candidate.updatedAt
        : 0

    return {
        recent,
        favorites,
        updatedAt,
    }
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

    return sanitizeScopeRecord(parsed, preserveDotDot)
}

export function parseFilePanelStateSnapshot (raw: string | null | undefined): FilePanelStateSnapshot {
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
    for (const [scope, value] of Object.entries(parsed.scopes)) {
        if (!scope || FORBIDDEN_KEYS.has(scope) || !isPlainRecord(value)) {
            continue
        }
        scopes[scope] = sanitizeScopeRecord(value, shouldPreserveDotDot(scope))
    }
    return {
        version: FILE_PANEL_STATE_VERSION,
        scopes,
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

export class FilePanelStateStore implements FilePanelStateClient {
    private storage: FilePanelStorageLike | null
    private keyPrefix: string
    private sshKeyPrefix: string
    private memoryScopes = new Map<string, FilePanelScopeRecord>()
    private failedStorageRaw = new Map<string, string | null>()
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

    loadSnapshot (snapshot: FilePanelStateSnapshot): void {
        this.memoryScopes.clear()
        this.failedStorageRaw.clear()
        this.lastTimestamp = 0
        for (const [scope, record] of Object.entries(snapshot.scopes)) {
            if (!scope || FORBIDDEN_KEYS.has(scope)) {
                continue
            }
            const cloned = cloneFilePanelScopeRecord(record)
            this.memoryScopes.set(scope, cloned)
            if (cloned.updatedAt > this.lastTimestamp) {
                this.lastTimestamp = cloned.updatedAt
            }
        }
        this.pruneMemorySSHScopes()
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

    private getMaxExistingUpdatedAt (): number {
        let maxUpdatedAt = 0
        if (this.storage) {
            for (const entry of this.listMatchingStorageEntries(this.keyPrefix)) {
                const parsed = parseFilePanelScopeRecord(entry.raw, shouldPreserveDotDot(entry.scope))
                if (parsed.updatedAt > maxUpdatedAt) {
                    maxUpdatedAt = parsed.updatedAt
                }
            }
        }
        for (const record of this.memoryScopes.values()) {
            if (record.updatedAt > maxUpdatedAt) {
                maxUpdatedAt = record.updatedAt
            }
        }
        return maxUpdatedAt
    }

    private nextTimestamp (explicitNow?: number): number {
        const maxExisting = this.getMaxExistingUpdatedAt()
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
        if (this.failedStorageRaw.has(scope)) {
            if (raw === this.failedStorageRaw.get(scope)) {
                return cloneFilePanelScopeRecord(this.memoryScopes.get(scope))
            }
            this.failedStorageRaw.delete(scope)
        }
        if (raw === null) {
            this.memoryScopes.delete(scope)
            return createEmptyRecord()
        }
        const parsed = parseFilePanelScopeRecord(raw, shouldPreserveDotDot(scope))
        this.memoryScopes.set(scope, cloneFilePanelScopeRecord(parsed))
        return parsed
    }

    private pruneMemorySSHScopes (protectedScope?: string): void {
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
            const victimScope = evictable[i][0]
            this.memoryScopes.delete(victimScope)
            this.failedStorageRaw.delete(victimScope)
        }
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
                this.failedStorageRaw.delete(victim.scope)
            }
            return
        }

        this.pruneMemorySSHScopes(protectedScope)
    }

    private writeScopeRecord (scope: string, record: FilePanelScopeRecord): void {
        this.memoryScopes.set(scope, cloneFilePanelScopeRecord(record))
        if (!this.storage) {
            if (scope.startsWith('ssh:')) {
                this.pruneMemorySSHScopes(scope)
            }
            return
        }
        const storageKey = this.getScopeStorageKey(scope)
        let previousRaw: string | null = null
        if (this.failedStorageRaw.has(scope)) {
            previousRaw = this.failedStorageRaw.get(scope) ?? null
        } else {
            try {
                previousRaw = this.storage.getItem(storageKey)
            } catch {
                previousRaw = null
            }
        }
        const payload: StoredFilePanelScopeRecord = {
            version: FILE_PANEL_STATE_VERSION,
            recent: [...record.recent],
            favorites: [...record.favorites],
            updatedAt: record.updatedAt,
        }
        const serialized = JSON.stringify(payload)
        try {
            this.storage.setItem(storageKey, serialized)
            this.failedStorageRaw.delete(scope)
            if (scope.startsWith('ssh:')) {
                this.pruneSSHScopes(scope)
            }
            notifyFilePanelStateChanges({
                scope,
                storageKey,
                source: this,
            })
        } catch {
            this.failedStorageRaw.set(scope, previousRaw)
            if (scope.startsWith('ssh:')) {
                this.pruneMemorySSHScopes(scope)
            }
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
            const rawByScope = new Map<string, string | null>()
            for (const entry of this.listMatchingStorageEntries(this.keyPrefix)) {
                rawByScope.set(entry.scope, entry.raw)
                scopes[entry.scope] = parseFilePanelScopeRecord(entry.raw, shouldPreserveDotDot(entry.scope))
            }
            for (const [failedScope, failedRaw] of this.failedStorageRaw.entries()) {
                const currentRaw = rawByScope.has(failedScope) ? (rawByScope.get(failedScope) ?? null) : null
                if (currentRaw === failedRaw) {
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

export function executeFilePanelStateOp (
    store: FilePanelStateStore,
    request: unknown,
): FilePanelStateOpResponse {
    if (!isPlainRecord(request) || typeof request.op !== 'string') {
        return { ok: false, error: 'Invalid file panel state operation' }
    }
    const scope = typeof request.scope === 'string' ? request.scope : null
    const pathValue = typeof request.path === 'string' ? request.path : ''
    const now = typeof request.now === 'number' && Number.isFinite(request.now) ? request.now : undefined

    switch (request.op) {
        case 'getScope':
            return { ok: true, result: store.getScopeState(scope) }
        case 'getSnapshot':
            return { ok: true, result: store.getSnapshot() }
        case 'recordVisit': {
            const result = store.recordVisit(scope, pathValue, now)
            return { ok: true, result, changedScope: result && scope ? scope : undefined }
        }
        case 'addFavorite': {
            const result = store.addFavorite(scope, pathValue, now)
            return { ok: true, result, changedScope: result && scope ? scope : undefined }
        }
        case 'removeFavorite': {
            const result = store.removeFavorite(scope, pathValue, now)
            return { ok: true, result, changedScope: result && scope ? scope : undefined }
        }
        case 'toggleFavorite': {
            const added = store.toggleFavorite(scope, pathValue, now)
            const validScope = scope && !FORBIDDEN_KEYS.has(scope) ? scope : undefined
            return { ok: true, result: added, changedScope: validScope }
        }
        default:
            return { ok: false, error: `Unknown file panel state operation: ${request.op}` }
    }
}

function attachIpcChangeBridge (ipcRenderer: FilePanelIpcRendererLike): void {
    if (registeredIpcRenderers.has(ipcRenderer) || typeof ipcRenderer.on !== 'function') {
        return
    }
    registeredIpcRenderers.add(ipcRenderer)
    ipcRenderer.on(FILE_PANEL_STATE_IPC_CHANGED, (_event, payload) => {
        if (!isPlainRecord(payload) || typeof payload.scope !== 'string' || !payload.scope) {
            return
        }
        notifyFilePanelStateChanges({
            scope: payload.scope,
            storageKey: getFilePanelScopeStorageKey(payload.scope),
            source: null,
        })
    })
}

export class IpcFilePanelStateClient implements FilePanelStateClient {
    private ipc: FilePanelIpcRendererLike
    private fallback: FilePanelStateStore

    constructor (
        ipcRenderer: FilePanelIpcRendererLike,
        fallbackStore?: FilePanelStateStore,
    ) {
        this.ipc = ipcRenderer
        this.fallback = fallbackStore ?? new FilePanelStateStore(null)
        attachIpcChangeBridge(ipcRenderer)
    }

    private invoke (request: FilePanelStateOpRequest): FilePanelStateOpResponse | null {
        try {
            const response = this.ipc.sendSync(FILE_PANEL_STATE_IPC_OP, request)
            if (isPlainRecord(response) && response.ok === true) {
                return response as unknown as FilePanelStateOpResponse
            }
        } catch {
            // Fall back to local store when IPC is unavailable.
        }
        return null
    }

    private notifyLocalChange (scope: string | null | undefined): void {
        if (!scope || FORBIDDEN_KEYS.has(scope)) {
            return
        }
        notifyFilePanelStateChanges({
            scope,
            storageKey: getFilePanelScopeStorageKey(scope),
            source: this,
        })
    }

    getSnapshot (): FilePanelStateSnapshot {
        const response = this.invoke({ op: 'getSnapshot' })
        if (response && isPlainRecord(response.result) && isPlainRecord(response.result.scopes)) {
            return response.result as unknown as FilePanelStateSnapshot
        }
        return this.fallback.getSnapshot()
    }

    getScopeState (scope: string | null | undefined): FilePanelScopeRecord {
        if (!scope || FORBIDDEN_KEYS.has(scope)) {
            return createEmptyRecord()
        }
        const response = this.invoke({ op: 'getScope', scope })
        if (response && isPlainRecord(response.result)) {
            return sanitizeScopeRecord(response.result, shouldPreserveDotDot(scope))
        }
        return this.fallback.getScopeState(scope)
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
        const response = this.invoke({ op: 'recordVisit', scope, path: rawPath, now })
        if (response) {
            this.notifyLocalChange(scope)
            return isPlainRecord(response.result)
                ? sanitizeScopeRecord(response.result, shouldPreserveDotDot(scope))
                : null
        }
        return this.fallback.recordVisit(scope, rawPath, now)
    }

    addFavorite (scope: string | null | undefined, rawPath: string, now?: number): FilePanelScopeRecord | null {
        if (!scope || FORBIDDEN_KEYS.has(scope)) {
            return null
        }
        const response = this.invoke({ op: 'addFavorite', scope, path: rawPath, now })
        if (response) {
            this.notifyLocalChange(scope)
            return isPlainRecord(response.result)
                ? sanitizeScopeRecord(response.result, shouldPreserveDotDot(scope))
                : null
        }
        return this.fallback.addFavorite(scope, rawPath, now)
    }

    removeFavorite (scope: string | null | undefined, rawPath: string, now?: number): FilePanelScopeRecord | null {
        if (!scope || FORBIDDEN_KEYS.has(scope)) {
            return null
        }
        const response = this.invoke({ op: 'removeFavorite', scope, path: rawPath, now })
        if (response) {
            this.notifyLocalChange(scope)
            return isPlainRecord(response.result)
                ? sanitizeScopeRecord(response.result, shouldPreserveDotDot(scope))
                : null
        }
        return this.fallback.removeFavorite(scope, rawPath, now)
    }

    toggleFavorite (scope: string | null | undefined, rawPath: string, now?: number): boolean {
        if (!scope || FORBIDDEN_KEYS.has(scope)) {
            return false
        }
        const response = this.invoke({ op: 'toggleFavorite', scope, path: rawPath, now })
        if (response && typeof response.result === 'boolean') {
            this.notifyLocalChange(scope)
            return response.result
        }
        return this.fallback.toggleFavorite(scope, rawPath, now)
    }
}

export function createDefaultFilePanelStateClient (): FilePanelStateClient {
    const localFallback = new FilePanelStateStore(typeof window !== 'undefined' ? window.localStorage : null)
    if (typeof window !== 'undefined') {
        try {
            const win = window as unknown as { require?: (id: string) => unknown }
            const electronModule = win.require?.('electron')
            if (isPlainRecord(electronModule) && isPlainRecord(electronModule.ipcRenderer)) {
                const candidate = electronModule.ipcRenderer as unknown as FilePanelIpcRendererLike
                if (typeof candidate.sendSync === 'function') {
                    return new IpcFilePanelStateClient(candidate, localFallback)
                }
            }
        } catch {
            // Non-Electron environment; fall back to local FilePanelStateStore.
        }
    }
    return localFallback
}
