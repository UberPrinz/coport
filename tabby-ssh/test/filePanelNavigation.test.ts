import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe, it } from 'node:test'
import {
    ADB_FILE_PANEL_SCOPE,
    FILE_PANEL_STATE_IPC_CHANGED,
    FILE_PANEL_STATE_IPC_OP,
    FILE_PANEL_STATE_STORAGE_KEY,
    FilePanelStateStore,
    IpcFilePanelStateClient,
    MAX_FAVORITE_PATHS,
    MAX_RECENT_PATHS,
    MAX_SSH_SCOPES,
    createSSHFilePanelScope,
    getFilePanelScopeStorageKey,
    normalizeFilePanelPath,
    parseFilePanelScopeRecord,
    parseFilePanelStateSnapshot,
    subscribeFilePanelStateChanges,
} from '../src/utils/filePanelState.ts'
import { runStagedSFTPUpload } from '../src/session/sftpUpload.ts'
import type { FilePanelIpcRendererLike, FilePanelStorageLike } from '../src/utils/filePanelState.ts'
import {
    filterAndSortEntries,
    matchFileName,
    mergeHighlightRanges,
    splitTextByHighlights,
} from '../src/utils/filePanelFilter.ts'
import {
    SFTPChannelPool,
    cancelPendingDirectoryUpload,
    finalizeCanonicalDirectoryListing,
    inspectPosixEntryViaParentReaddir,
    isAdbDirectoryUnavailableError,
    isSFTPChannelClosedError,
    isSFTPDirectoryUnavailableError,
    isSFTPPermissionDeniedError,
    isTransientConnectionError,
    resolveCanonicalReadableDirectory,
    resolvePosixPathWithReadlink,
    resolveReadableDirectory,
    shouldSkipQueuedFileUpload,
} from '../src/utils/filePanelFallback.ts'

// Share the TypeScript loader used by plugin tests so the real FileUpload class can run here.
register(new URL('../../scripts/test-hooks.mjs', import.meta.url))
const { FileUpload } = await import('../../tabby-core/src/api/platform.ts')
const { createFilePanelStateCoordinator } = await import('../../app/lib/coport/filePanelStateCoordinator.ts')
const { resolveAtomicDownloadMode } = await import('../../app/lib/coport/downloadMode.ts')

function createMemoryStorage (): { storage: FilePanelStorageLike, map: Map<string, string> } {
    const map = new Map<string, string>()
    const storage: FilePanelStorageLike = {
        get length () {
            return map.size
        },
        key: index => [...map.keys()][index] ?? null,
        getItem: key => map.get(key) ?? null,
        setItem: (key, value) => {
            map.set(key, value)
        },
        removeItem: key => {
            map.delete(key)
        },
    }
    return { storage, map }
}

describe('filePanelState', () => {
    it('normalizes POSIX paths, preserves case sensitivity, trailing spaces, and optional .. segments', () => {
        assert.equal(normalizeFilePanelPath(''), '/')
        assert.equal(normalizeFilePanelPath('   '), '/')
        assert.equal(normalizeFilePanelPath('///'), '/')
        assert.equal(normalizeFilePanelPath('/sdcard/'), '/sdcard')
        assert.equal(normalizeFilePanelPath('/sdcard//left/./link/..'), '/sdcard/left')
        assert.equal(normalizeFilePanelPath('/a/../../b/c/'), '/b/c')
        assert.equal(normalizeFilePanelPath('data/local/tmp'), '/data/local/tmp')
        assert.notEqual(normalizeFilePanelPath('/Data/App'), normalizeFilePanelPath('/data/app'))
        assert.equal(normalizeFilePanelPath('/tmp/trail '), '/tmp/trail ')
        assert.equal(normalizeFilePanelPath('/tmp/trail /'), '/tmp/trail ')
        assert.equal(normalizeFilePanelPath('/tmp/link/..', true), '/tmp/link/..')
        assert.equal(normalizeFilePanelPath('/tmp//link/./../', true), '/tmp/link/..')
    })

    it('isolates ADB global scope from SSH authUsername@host:port scopes using per-scope keys', () => {
        const { storage, map } = createMemoryStorage()
        const store = new FilePanelStateStore(storage)
        const sshA = createSSHFilePanelScope('alice', '10.0.0.1', 22)
        const sshB = createSSHFilePanelScope('bob', '10.0.0.1', 22)
        const sshPort = createSSHFilePanelScope('alice', '10.0.0.1', 2222)

        assert.equal(sshA, 'ssh:alice@10.0.0.1:22')
        assert.equal(createSSHFilePanelScope('alice', '10.0.0.1'), 'ssh:alice@10.0.0.1:22')

        store.recordVisit(ADB_FILE_PANEL_SCOPE, '/data/local/tmp/')
        store.addFavorite(ADB_FILE_PANEL_SCOPE, '/vendor/etc')
        store.recordVisit(sshA, '/var/log')
        store.addFavorite(sshA, '/etc/nginx')
        store.recordVisit(sshB, '/home/bob')
        store.addFavorite(sshB, '/srv/bob')
        store.recordVisit(sshPort, '/opt/app')

        assert.ok(map.has(getFilePanelScopeStorageKey(ADB_FILE_PANEL_SCOPE)))
        assert.ok(map.has(getFilePanelScopeStorageKey(sshA)))
        assert.ok(map.has(getFilePanelScopeStorageKey(sshB)))
        assert.equal(store.getLastPath(ADB_FILE_PANEL_SCOPE), '/data/local/tmp')
        assert.deepEqual(store.getFavorites(ADB_FILE_PANEL_SCOPE), ['/vendor/etc'])
        assert.equal(store.getLastPath(sshA), '/var/log')
        assert.deepEqual(store.getFavorites(sshA), ['/etc/nginx'])
        assert.equal(store.getLastPath(sshB), '/home/bob')
        assert.deepEqual(store.getFavorites(sshB), ['/srv/bob'])
        assert.equal(store.getLastPath(sshPort), '/opt/app')
        assert.equal(store.getLastPath(null), null)
    })

    it('enforces 20 recent cap, 50 favorites cap, case-sensitive dedupe, and preserves recent on unfavorite', () => {
        const { storage } = createMemoryStorage()
        const store = new FilePanelStateStore(storage)

        for (let i = 1; i <= 25; i++) {
            store.recordVisit(ADB_FILE_PANEL_SCOPE, `/dir-${i}/`)
        }
        store.recordVisit(ADB_FILE_PANEL_SCOPE, '/Dir-25')
        store.recordVisit(ADB_FILE_PANEL_SCOPE, '/dir-20')

        const recent = store.getRecent(ADB_FILE_PANEL_SCOPE)
        assert.equal(recent.length, MAX_RECENT_PATHS)
        assert.equal(recent[0], '/dir-20')
        assert.equal(recent[1], '/Dir-25')
        assert.equal(recent[2], '/dir-25')
        assert.ok(!recent.includes('/dir-1'))

        for (let i = 1; i <= 55; i++) {
            store.addFavorite(ADB_FILE_PANEL_SCOPE, `/fav-${i}`)
        }
        const favorites = store.getFavorites(ADB_FILE_PANEL_SCOPE)
        assert.equal(favorites.length, MAX_FAVORITE_PATHS)
        assert.equal(favorites[0], '/fav-55')
        assert.equal(favorites[MAX_FAVORITE_PATHS - 1], '/fav-6')
        assert.ok(!favorites.includes('/fav-1'))

        assert.equal(store.toggleFavorite(ADB_FILE_PANEL_SCOPE, '/dir-20'), true)
        assert.equal(store.isFavorite(ADB_FILE_PANEL_SCOPE, '/dir-20/'), true)
        assert.equal(store.toggleFavorite(ADB_FILE_PANEL_SCOPE, '/dir-20'), false)
        assert.equal(store.isFavorite(ADB_FILE_PANEL_SCOPE, '/dir-20'), false)
        assert.ok(store.getRecent(ADB_FILE_PANEL_SCOPE).includes('/dir-20'))
    })

    it('enforces 50 SSH scope LRU cap without ever evicting adb:shared', () => {
        const { storage } = createMemoryStorage()
        const store = new FilePanelStateStore(storage)

        store.recordVisit(ADB_FILE_PANEL_SCOPE, '/data', 1)
        store.addFavorite(ADB_FILE_PANEL_SCOPE, '/system', 2)

        for (let i = 1; i <= 55; i++) {
            store.recordVisit(createSSHFilePanelScope('u', `host-${i}`, 22), `/p/${i}`, 100 + i)
        }
        // Refresh host-10 so it stays newest when adding more hosts.
        store.recordVisit(createSSHFilePanelScope('u', 'host-10', 22), '/p/10-refreshed', 1000)
        for (let i = 56; i <= 60; i++) {
            store.recordVisit(createSSHFilePanelScope('u', `host-${i}`, 22), `/p/${i}`, 200 + i)
        }

        const snapshot = store.getSnapshot()
        const sshScopes = Object.keys(snapshot.scopes).filter(key => key.startsWith('ssh:'))
        assert.equal(sshScopes.length, MAX_SSH_SCOPES)
        assert.equal(store.getLastPath(ADB_FILE_PANEL_SCOPE), '/data')
        assert.deepEqual(store.getFavorites(ADB_FILE_PANEL_SCOPE), ['/system'])
        assert.equal(store.getLastPath(createSSHFilePanelScope('u', 'host-10', 22)), '/p/10-refreshed')
        assert.equal(store.getLastPath(createSSHFilePanelScope('u', 'host-60', 22)), '/p/60')
        assert.equal(store.getLastPath(createSSHFilePanelScope('u', 'host-1', 22)), null)
    })

    it('never evicts the newly written 51st SSH host when two stores share the same Date.now() millisecond', () => {
        const { storage } = createMemoryStorage()
        const store1 = new FilePanelStateStore(storage)
        const store2 = new FilePanelStateStore(storage)
        const originalNow = Date.now
        Date.now = () => 1700000000000
        try {
            store1.recordVisit(ADB_FILE_PANEL_SCOPE, '/etc')
            for (let i = 1; i <= MAX_SSH_SCOPES; i++) {
                store1.recordVisit(createSSHFilePanelScope('dev', `host-${String(i).padStart(2, '0')}`, 22), `/srv/${i}`)
            }
            const host51 = createSSHFilePanelScope('dev', 'host-51', 22)
            store2.recordVisit(host51, '/srv/51')

            const snapshot = store2.getSnapshot()
            const sshScopes = Object.keys(snapshot.scopes).filter(key => key.startsWith('ssh:'))
            assert.equal(sshScopes.length, MAX_SSH_SCOPES)
            assert.equal(store2.getLastPath(host51), '/srv/51')
            assert.equal(store1.getLastPath(host51), '/srv/51')
            assert.equal(store2.getLastPath(createSSHFilePanelScope('dev', 'host-01', 22)), null)
            assert.equal(store2.getLastPath(createSSHFilePanelScope('dev', 'host-02', 22)), '/srv/2')
            assert.equal(store2.getLastPath(ADB_FILE_PANEL_SCOPE), '/etc')
        } finally {
            Date.now = originalNow
        }
    })

    it('preserves interleaved multi-window writes to different scopes without lost updates', () => {
        const map = new Map<string, string>()
        let interleaved = false
        let windowBRef: FilePanelStateStore | null = null

        const baseStorage: FilePanelStorageLike = {
            get length () {
                return map.size
            },
            key: index => [...map.keys()][index] ?? null,
            getItem: key => map.get(key) ?? null,
            setItem: (key, value) => {
                map.set(key, value)
            },
            removeItem: key => {
                map.delete(key)
            },
        }

        // Simulate Window B interleaving a full read-modify-write on ssh:host-b
        // right between Window A's read and write of adb:shared.
        const windowAStorage: FilePanelStorageLike = {
            get length () {
                return baseStorage.length
            },
            key: index => baseStorage.key(index),
            getItem: key => {
                const value = baseStorage.getItem(key)
                if (!interleaved && key === getFilePanelScopeStorageKey(ADB_FILE_PANEL_SCOPE) && windowBRef) {
                    interleaved = true
                    windowBRef.recordVisit('ssh:dev@host-b:22', '/srv/b')
                    windowBRef.addFavorite('ssh:dev@host-b:22', '/etc/b')
                }
                return value
            },
            setItem: (key, value) => baseStorage.setItem(key, value),
            removeItem: key => baseStorage.removeItem(key),
        }

        const windowA = new FilePanelStateStore(windowAStorage)
        const windowB = new FilePanelStateStore(baseStorage)
        windowBRef = windowB

        windowA.recordVisit(ADB_FILE_PANEL_SCOPE, '/data/a')
        windowA.addFavorite(ADB_FILE_PANEL_SCOPE, '/etc/a')

        assert.equal(interleaved, true)
        assert.equal(windowB.getLastPath(ADB_FILE_PANEL_SCOPE), '/data/a')
        assert.deepEqual(windowB.getFavorites(ADB_FILE_PANEL_SCOPE), ['/etc/a'])
        assert.equal(windowA.getLastPath('ssh:dev@host-b:22'), '/srv/b')
        assert.deepEqual(windowA.getFavorites('ssh:dev@host-b:22'), ['/etc/b'])
    })

    it('notifies same-window subscribers upon successful storage writes', () => {
        const { storage } = createMemoryStorage()
        const store = new FilePanelStateStore(storage)
        const events: string[] = []
        const unsubscribe = subscribeFilePanelStateChanges(event => {
            events.push(`${event.scope}:${event.storageKey}`)
        })
        try {
            store.addFavorite(ADB_FILE_PANEL_SCOPE, '/etc')
            assert.deepEqual(events, [`${ADB_FILE_PANEL_SCOPE}:${getFilePanelScopeStorageKey(ADB_FILE_PANEL_SCOPE)}`])
        } finally {
            unsubscribe()
        }
        store.removeFavorite(ADB_FILE_PANEL_SCOPE, '/etc')
        assert.equal(events.length, 1)
    })

    it('tolerates corrupted JSON, unsupported versions, and QuotaExceededError writes', () => {
        assert.deepEqual(parseFilePanelScopeRecord('{broken json'), { recent: [], favorites: [], updatedAt: 0 })
        assert.deepEqual(parseFilePanelScopeRecord(JSON.stringify({ version: 2, recent: ['/x'], favorites: [], updatedAt: 1 })), {
            recent: [],
            favorites: [],
            updatedAt: 0,
        })
        assert.deepEqual(parseFilePanelScopeRecord(JSON.stringify({
            version: 1,
            recent: ['/ok//', '/ok'],
            favorites: ['/fav/'],
            updatedAt: 5,
        })), {
            recent: ['/ok'],
            favorites: ['/fav'],
            updatedAt: 5,
        })

        const quotaStorage: FilePanelStorageLike = {
            length: 0,
            key: () => null,
            getItem: () => null,
            setItem: () => {
                throw new Error('QuotaExceededError')
            },
            removeItem: () => undefined,
        }
        const store = new FilePanelStateStore(quotaStorage, FILE_PANEL_STATE_STORAGE_KEY)
        assert.doesNotThrow(() => {
            store.recordVisit(ADB_FILE_PANEL_SCOPE, '/data/app')
            store.addFavorite(ADB_FILE_PANEL_SCOPE, '/data/app')
        })
        assert.equal(store.getLastPath(ADB_FILE_PANEL_SCOPE), '/data/app')
        assert.deepEqual(store.getFavorites(ADB_FILE_PANEL_SCOPE), ['/data/app'])
    })

    it('preserves in-memory updates when storage write fails on a scope that already has a stored record', () => {
        const { storage } = createMemoryStorage()
        let failWrites = false
        const flakyStorage: FilePanelStorageLike = {
            get length () {
                return storage.length
            },
            key: index => storage.key(index),
            getItem: key => storage.getItem(key),
            setItem: (key, value) => {
                if (failWrites) {
                    throw new Error('QuotaExceededError')
                }
                storage.setItem(key, value)
            },
            removeItem: key => storage.removeItem(key),
        }

        const store = new FilePanelStateStore(flakyStorage)
        store.recordVisit(ADB_FILE_PANEL_SCOPE, '/old')
        assert.equal(store.getLastPath(ADB_FILE_PANEL_SCOPE), '/old')

        failWrites = true
        store.recordVisit(ADB_FILE_PANEL_SCOPE, '/new')
        assert.equal(store.toggleFavorite(ADB_FILE_PANEL_SCOPE, '/new'), true)

        const state = store.getScopeState(ADB_FILE_PANEL_SCOPE)
        assert.deepEqual(state.recent, ['/new', '/old'])
        assert.deepEqual(state.favorites, ['/new'])
        assert.deepEqual(store.getSnapshot().scopes[ADB_FILE_PANEL_SCOPE].recent, ['/new', '/old'])
        assert.deepEqual(store.getSnapshot().scopes[ADB_FILE_PANEL_SCOPE].favorites, ['/new'])

        // External write to underlying storage supersedes the failed cached record cleanly.
        const scopeKey = getFilePanelScopeStorageKey(ADB_FILE_PANEL_SCOPE)
        storage.setItem(scopeKey, JSON.stringify({
            version: 1,
            recent: ['/external'],
            favorites: ['/external-fav'],
            updatedAt: 9999999999999,
        }))
        const afterExternal = store.getScopeState(ADB_FILE_PANEL_SCOPE)
        assert.deepEqual(afterExternal.recent, ['/external'])
        assert.deepEqual(afterExternal.favorites, ['/external-fav'])
    })

    it('tests the production coordinator directly for monotonic timestamps, forged now rejection, fsOps failure retention, and LRU eviction broadcasts', () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'coport-file-panel-state-'))
        const filePath = join(tempDir, 'coport-file-panel-state.json')
        let clockCall = 0
        const clockSequence = [5000, 4000, 4000]
        const nowProvider = (): number => {
            if (clockCall < clockSequence.length) {
                return clockSequence[clockCall++]
            }
            return 4000
        }
        try {
            const broadcastEvents: { scope: string, evictedScopes: string[] }[] = []
            const broadcastListeners: ((event: unknown, payload: unknown) => void)[] = []
            let failWriteFile = false
            let failRename = false
            let unlinkCalls = 0

            const coordinator = createFilePanelStateCoordinator({
                filePath,
                nowProvider,
                fsOps: {
                    writeFileSync: (...args) => {
                        if (failWriteFile) {
                            throw Object.assign(new Error('EACCES: read-only'), { code: 'EACCES' })
                        }
                        return writeFileSync(...args)
                    },
                    renameSync: (...args) => {
                        if (failRename) {
                            throw Object.assign(new Error('EXDEV: rename failed'), { code: 'EXDEV' })
                        }
                        return renameSync(...args)
                    },
                    unlinkSync: (...args) => {
                        unlinkCalls++
                        return unlinkSync(...args)
                    },
                },
                broadcast: payload => {
                    broadcastEvents.push(payload)
                    for (const listener of broadcastListeners) {
                        listener({}, payload)
                    }
                },
            })

            const makeWindowClient = (): IpcFilePanelStateClient => {
                const ipc: FilePanelIpcRendererLike = {
                    sendSync: (channel, payload) => {
                        assert.equal(channel, FILE_PANEL_STATE_IPC_OP)
                        return coordinator.handleOp(payload)
                    },
                    on: (channel, listener) => {
                        if (channel === FILE_PANEL_STATE_IPC_CHANGED) {
                            broadcastListeners.push(listener)
                        }
                    },
                }
                return new IpcFilePanelStateClient(ipc)
            }

            const winA = makeWindowClient()
            const winB = makeWindowClient()
            const observedBroadcasts: { scope: string, evictedScopes: string[] }[] = []
            const unsubscribe = subscribeFilePanelStateChanges(event => {
                if (event.source === null) {
                    observedBroadcasts.push({
                        scope: event.scope,
                        evictedScopes: [...(event.evictedScopes ?? [])],
                    })
                }
            })

            try {
                // Forged backwards/duplicate `now` values passed via IPC MUST be ignored and timestamps stay strictly monotonic
                const forged1 = coordinator.handleOp({ op: 'recordVisit', scope: ADB_FILE_PANEL_SCOPE, path: '/old', now: 5000 })
                const forged2 = coordinator.handleOp({ op: 'recordVisit', scope: ADB_FILE_PANEL_SCOPE, path: '/old-2', now: 4000 })
                const forged3 = coordinator.handleOp({ op: 'addFavorite', scope: ADB_FILE_PANEL_SCOPE, path: '/old', now: 4000 })
                assert.equal(forged1.ok, true)
                assert.equal(forged2.ok, true)
                assert.equal(forged3.ok, true)
                const ts1 = (forged1.result as { updatedAt: number }).updatedAt
                const ts2 = (forged2.result as { updatedAt: number }).updatedAt
                const ts3 = (forged3.result as { updatedAt: number }).updatedAt
                assert.equal(ts1, 5000)
                assert.equal(ts2, 5001)
                assert.equal(ts3, 5002)

                // Fill 50 SSH scopes with forged decreasing `now` values -> LRU order still follows real monotonic server order
                for (let i = 1; i <= MAX_SSH_SCOPES; i++) {
                    const scope = createSSHFilePanelScope('dev', `host-${String(i).padStart(2, '0')}`, 22)
                    const resp = coordinator.handleOp({ op: 'recordVisit', scope, path: `/srv/${i}`, now: 1000 - i })
                    assert.equal(resp.ok, true)
                    assert.deepEqual(resp.evictedScopes, [])
                }

                // Refresh host-05 and add host-51 & host-52 across windows -> host-01 & host-02 are evicted and broadcast includes evictedScopes
                const host01 = createSSHFilePanelScope('dev', 'host-01', 22)
                const host02 = createSSHFilePanelScope('dev', 'host-02', 22)
                const host05 = createSSHFilePanelScope('dev', 'host-05', 22)
                const host51 = createSSHFilePanelScope('dev', 'host-51', 22)
                const host52 = createSSHFilePanelScope('dev', 'host-52', 22)
                const rec05 = winB.recordVisit(host05, '/srv/05-refreshed', 1)
                const rec51 = winA.recordVisit(host51, '/srv/51', 1)
                const rec52 = winB.recordVisit(host52, '/srv/52', 1)

                assert.ok(rec05 && rec51 && rec52)
                assert.ok(rec51.updatedAt > rec05.updatedAt, 'timestamps must strictly increase across windows')
                assert.ok(rec52.updatedAt > rec51.updatedAt, 'timestamps must strictly increase across windows')

                const evictEvent51 = broadcastEvents.find(ev => ev.scope === host51)
                const evictEvent52 = broadcastEvents.find(ev => ev.scope === host52)
                assert.deepEqual(evictEvent51, { scope: host51, evictedScopes: [host01] })
                assert.deepEqual(evictEvent52, { scope: host52, evictedScopes: [host02] })
                assert.ok(
                    observedBroadcasts.some(ev => ev.scope === host51 && ev.evictedScopes.includes(host01)),
                    'IPC change bridge must propagate evictedScopes to subscribers',
                )

                const snapshot = winA.getSnapshot()
                const sshScopes = Object.keys(snapshot.scopes).filter(k => k.startsWith('ssh:'))
                assert.equal(sshScopes.length, MAX_SSH_SCOPES)
                assert.equal(winB.getLastPath(host05), '/srv/05-refreshed')
                assert.equal(winB.getLastPath(host51), '/srv/51')
                assert.equal(winA.getLastPath(host52), '/srv/52')
                assert.equal(winA.getLastPath(host01), null)
                assert.equal(winA.getLastPath(host02), null)
                assert.equal(winA.getLastPath(createSSHFilePanelScope('dev', 'host-03', 22)), '/srv/3')
                assert.equal(winB.getLastPath(ADB_FILE_PANEL_SCOPE), '/old-2')

                // Reloading from the atomic JSON file via production coordinator preserves full state across restart
                const reloaded = createFilePanelStateCoordinator({ filePath })
                assert.equal(reloaded.store.getLastPath(host51), '/srv/51')
                assert.equal(reloaded.store.getLastPath(host52), '/srv/52')
                assert.equal(reloaded.store.getLastPath(ADB_FILE_PANEL_SCOPE), '/old-2')

                // Inject writeFileSync failure when /old-2 is already persisted -> /new & favorite remain in memory, not overwritten by old disk JSON
                failWriteFile = true
                winA.recordVisit(ADB_FILE_PANEL_SCOPE, '/new')
                assert.equal(winA.toggleFavorite(ADB_FILE_PANEL_SCOPE, '/new'), true)
                assert.equal(winB.getLastPath(ADB_FILE_PANEL_SCOPE), '/new')
                assert.deepEqual(winB.getFavorites(ADB_FILE_PANEL_SCOPE), ['/new', '/old'])

                // Inject renameSync failure too -> temp file cleaned up and in-memory state preserved
                failWriteFile = false
                failRename = true
                const unlinkBefore = unlinkCalls
                winB.recordVisit(ADB_FILE_PANEL_SCOPE, '/new-after-rename-fail')
                assert.equal(winA.getLastPath(ADB_FILE_PANEL_SCOPE), '/new-after-rename-fail')
                assert.ok(unlinkCalls > unlinkBefore, 'failed rename must clean up temp file')
                // Disk file still holds previous valid atomic snapshot (never corrupted)
                const diskAfterFail = parseFilePanelStateSnapshot(readFileSync(filePath, 'utf8'))
                assert.equal(diskAfterFail.scopes[ADB_FILE_PANEL_SCOPE].recent[0], '/old-2')
            } finally {
                unsubscribe()
            }
        } finally {
            try {
                chmodSync(tempDir, 0o700)
            } catch {
                // Ignore cleanup chmod error.
            }
            rmSync(tempDir, { recursive: true, force: true })
        }
    })
})

describe('filePanelFallback', () => {
    it('walks up parent directories until a readable directory is found', async () => {
        const attempted: string[] = []
        const result = await resolveReadableDirectory(
            '/data/local/missing/deep',
            async dirPath => {
                attempted.push(dirPath)
                if (dirPath === '/data/local') {
                    return ['tmp', 'bin']
                }
                const error = Object.assign(new Error(`Unable to list directory: ${dirPath}`), {
                    reason: 'unreadable_directory',
                })
                throw error
            },
            isAdbDirectoryUnavailableError,
        )

        assert.equal(result.ok, true)
        if (result.ok) {
            assert.equal(result.path, '/data/local')
            assert.equal(result.fellBackFrom, '/data/local/missing/deep')
            assert.ok(result.fallbackReason?.includes('/data/local/missing/deep'))
            assert.deepEqual(result.entries, ['tmp', 'bin'])
        }
        assert.deepEqual(attempted, ['/data/local/missing/deep', '/data/local/missing', '/data/local'])
    })

    it('stops immediately on transient disconnect or timeout errors without walking parents', async () => {
        const attempted: string[] = []
        const result = await resolveReadableDirectory(
            '/data/local/tmp',
            async dirPath => {
                attempted.push(dirPath)
                throw new Error('ADB file operation failed: error: device offline')
            },
            isAdbDirectoryUnavailableError,
        )

        assert.equal(result.ok, false)
        assert.equal(result.cancelled, false)
        if (!result.ok && !result.cancelled) {
            assert.equal(result.path, '/data/local/tmp')
            assert.equal(result.isUnavailable, false)
            assert.ok(result.errorMessage.includes('device offline'))
        }
        assert.deepEqual(attempted, ['/data/local/tmp'])
    })

    it('returns failure cleanly when root directory itself is unreadable', async () => {
        const attempted: string[] = []
        const result = await resolveReadableDirectory(
            '/missing',
            async dirPath => {
                attempted.push(dirPath)
                throw Object.assign(new Error('Permission denied'), { code: 3 })
            },
            isSFTPDirectoryUnavailableError,
        )

        assert.equal(result.ok, false)
        assert.equal(result.cancelled, false)
        if (!result.ok && !result.cancelled) {
            assert.equal(result.path, '/')
            assert.equal(result.isUnavailable, true)
        }
        assert.deepEqual(attempted, ['/missing', '/'])
    })

    it('classifies ADB and SFTP unavailable vs transient errors accurately', () => {
        assert.equal(isAdbDirectoryUnavailableError({ reason: 'unreadable_directory' }), true)
        assert.equal(isAdbDirectoryUnavailableError({ reason: 'adb_error' }), false)
        assert.equal(isAdbDirectoryUnavailableError(new Error('device offline')), false)

        assert.equal(isSFTPDirectoryUnavailableError(new Error('No such file')), true)
        assert.equal(isSFTPDirectoryUnavailableError(new Error('NoSuchFile')), true)
        assert.equal(isSFTPDirectoryUnavailableError(new Error('Permission denied')), true)
        assert.equal(isSFTPDirectoryUnavailableError(new Error('PermissionDenied')), true)
        assert.equal(isSFTPDirectoryUnavailableError(new Error('Not a directory')), true)
        assert.equal(isSFTPDirectoryUnavailableError(Object.assign(new Error('failed'), { code: 'ENOENT' })), true)
        assert.equal(isSFTPDirectoryUnavailableError(Object.assign(new Error('failed'), { code: 2 })), true)
        assert.equal(isSFTPDirectoryUnavailableError(Object.assign(new Error('failed'), { statusCode: 3 })), true)
        assert.equal(isSFTPDirectoryUnavailableError(new Error('SFTP channel closed')), false)
        assert.equal(isSFTPDirectoryUnavailableError(new Error('Request timed out')), false)
        assert.equal(isSFTPDirectoryUnavailableError(new Error('Connection reset by peer')), false)
    })

    it('discards stale concurrent requests without continuing fallback', async () => {
        let stale = false
        const attempted: string[] = []
        const result = await resolveReadableDirectory(
            '/a/b/c',
            async dirPath => {
                attempted.push(dirPath)
                stale = true
                throw Object.assign(new Error('missing'), { reason: 'unreadable_directory' })
            },
            isAdbDirectoryUnavailableError,
            () => stale,
        )

        assert.equal(result.ok, false)
        assert.equal(result.cancelled, true)
        assert.deepEqual(attempted, ['/a/b/c'])
    })

    it('reuses a recovered shared SFTP channel across sequential retries and never leaks or prematurely closes healthy channels', async () => {
        interface MockChannel {
            id: number
            closeCalls: number
            closedListeners: (() => void)[]
            closed$: { subscribe: (fn: () => void) => void }
            close: () => Promise<void>
            emitClose: () => void
        }
        const created: MockChannel[] = []
        let nextId = 0
        const pool = new SFTPChannelPool<MockChannel>(async () => {
            const closedListeners: (() => void)[] = []
            const ch: MockChannel = {
                id: ++nextId,
                closeCalls: 0,
                closedListeners,
                closed$: {
                    subscribe: fn => {
                        closedListeners.push(fn)
                    },
                },
                close: async () => {
                    ch.closeCalls++
                },
                emitClose: () => {
                    for (const fn of closedListeners) {
                        fn()
                    }
                },
            }
            created.push(ch)
            return ch
        })

        // Two panels share ch1
        const [p1Initial, p2Initial] = await Promise.all([pool.acquire(), pool.acquire()])
        assert.equal(p1Initial, p2Initial)
        assert.equal(created.length, 1)

        // Normal SFTP operational Failure must NOT invalidate, leak, or close healthy shared ch1 on Retry
        const operationalFailure = new Error('Status(Failure)')
        assert.equal(isSFTPChannelClosedError(new Error('Failure')), false)
        assert.equal(isSFTPChannelClosedError(operationalFailure), false)
        assert.equal(isTransientConnectionError(operationalFailure), false)
        assert.equal(isSFTPChannelClosedError(new Error('No such file')), false)
        assert.equal(isSFTPChannelClosedError(new Error('Permission denied')), false)
        assert.equal(isSFTPChannelClosedError(new Error('Request timed out')), false)
        assert.equal(isTransientConnectionError(new Error('Request timed out')), true)
        assert.equal(isSFTPChannelClosedError(new Error('SFTP channel closed')), true)
        assert.equal(isSFTPChannelClosedError(new Error('UnexpectedEof')), true)
        assert.equal(isSFTPChannelClosedError(new Error('broken pipe')), true)
        assert.equal(isSFTPChannelClosedError(new Error('disconnected')), true)
        assert.equal(pool.current, p1Initial)

        // Simulating Panel 1 Retry after operational Failure (failedBackend NOT set) -> reuses ch1 with 0 close() calls
        const p1RetryAfterOperationalError = await pool.acquire(undefined)
        assert.equal(p1RetryAfterOperationalError, p1Initial)
        assert.equal(p1Initial.closeCalls, 0)
        assert.equal(created.length, 1)

        // Panel 1 retries with failed channel ch1 -> closes ch1 exactly once and opens ch2
        const p1Recovered = await pool.acquire(p1Initial)
        assert.notEqual(p1Recovered, p1Initial)
        assert.equal(p1Initial.closeCalls, 1)
        assert.equal(p1Recovered.closeCalls, 0)
        assert.equal(created.length, 2)

        // Panel 2 then retries with its stale failed channel ch1 -> MUST reuse ch2 and NEVER close ch2
        const p2Recovered = await pool.acquire(p2Initial)
        assert.equal(p2Recovered, p1Recovered)
        assert.equal(p1Recovered.closeCalls, 0)
        assert.equal(created.length, 2)

        // Invalidate on genuine channel-closed error clears cache and calls close() on ch2
        pool.invalidate(p1Recovered)
        assert.equal(pool.current, null)
        assert.equal(p1Recovered.closeCalls, 1)
    })

    it('resolves POSIX symlink paths containing .. via readlink and converges to / without extra RTTs on normal paths', async () => {
        let readlinkCalls = 0
        const links = new Map<string, string>([
            ['/link', '/real'],
            ['/a/link-parent/to-real-child', '/a/real-parent/real-child'],
            ['/a/b/rel', '../c/d'],
            ['/loop-a', '/loop-b'],
            ['/loop-b', '/loop-a'],
        ])
        const liveDirs = new Set<string>([
            '/real',
            '/a',
            '/a/link-parent',
            '/a/real-parent',
            '/a/real-parent/real-child',
            '/a/b',
            '/a/c',
            '/a/c/d',
        ])
        const readlink = async (target: string): Promise<string> => {
            readlinkCalls++
            if (target === '/missing') {
                throw new Error('No such file')
            }
            const found = links.get(target)
            if (found !== undefined) {
                return found
            }
            throw new Error('Failure')
        }
        const statDir = async (target: string) => {
            if (liveDirs.has(target)) {
                return { isDirectory: true, isSymlink: false }
            }
            throw new Error('No such file')
        }

        // Normal path without '..' triggers zero readlink calls and preserves trailing spaces
        assert.equal(await resolvePosixPathWithReadlink('/tmp/trail ', readlink, statDir), '/tmp/trail ')
        assert.equal(readlinkCalls, 0)

        // Symlink directly under / followed by .. converges cleanly to /
        assert.equal(await resolvePosixPathWithReadlink('/link/..', readlink, statDir), '/')
        assert.equal(await resolvePosixPathWithReadlink('/link/../..', readlink, statDir), '/')

        // Cross-parent absolute symlink + .. resolves to server's real parent
        assert.equal(
            await resolvePosixPathWithReadlink('/a/link-parent/to-real-child/..', readlink, statDir),
            '/a/real-parent',
        )

        // Relative symlink + .. resolves against symlink's parent directory
        assert.equal(await resolvePosixPathWithReadlink('/a/b/rel/..', readlink, statDir), '/a/c')

        // Explicit EINVAL / "not a symlink" allows folding without requiring stat
        assert.equal(
            await resolvePosixPathWithReadlink('/normal/..', async () => {
                throw Object.assign(new Error('not a symlink'), { code: 'EINVAL' })
            }),
            '/',
        )

        // OpenSSH macOS sftp-server returns BadMessage for readlink on a regular directory -> verified via stat
        assert.equal(
            await resolvePosixPathWithReadlink(
                '/real/..',
                async () => {
                    throw new Error('Status(Status { id: 35, status_code: BadMessage, error_message: "Bad message", language_tag: "" })')
                },
                statDir,
            ),
            '/',
        )

        // Symlink loop respects depth limit and falls back to original path cleanly
        assert.equal(await resolvePosixPathWithReadlink('/loop-a/..', readlink, statDir), '/loop-a/..')

        // Missing intermediate throws instead of silently returning stale rawPath
        await assert.rejects(
            () => resolvePosixPathWithReadlink('/missing/..', readlink, statDir),
            /No such file/,
        )

        // Timeout (ETIMEDOUT / timed out) during readlink throws instead of folding to '/'
        await assert.rejects(
            () => resolvePosixPathWithReadlink('/link/..', async () => {
                throw Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' })
            }, statDir),
            /timed out/i,
        )

        // Generic Failure without inspectEntry confirmation OR when entry is non-dir/missing throws
        await assert.rejects(
            () => resolvePosixPathWithReadlink('/real/..', async () => {
                throw new Error('Status(Failure)')
            }),
            /Failure/,
        )
        await assert.rejects(
            () => resolvePosixPathWithReadlink('/regular-file/..', async () => {
                throw new Error('Status(Failure)')
            }, async () => ({ isDirectory: false, isSymlink: false })),
            /Failure/,
        )
        await assert.rejects(
            () => resolvePosixPathWithReadlink('/vanished/..', async () => {
                throw new Error('Status(Failure)')
            }, async () => null),
            /No such file/,
        )

        // Round-6 P2 #3: readlink('/dir') returns Failure after /dir was replaced by a symlink to another dir.
        // Parent readdir reports isSymlink: true (unlike symlink-following stat which would say isDirectory: true).
        // Case A: persistent Failure on retry -> rejects and NEVER folds '..' to '/'.
        let rootReaddirCalls = 0
        const parentReaddirWithSymlink = async (dirPath: string) => {
            if (dirPath === '/') {
                rootReaddirCalls++
                return [
                    { name: 'dir', isDirectory: false, isSymlink: true },
                    { name: 'plain', isDirectory: true, isSymlink: false },
                ]
            }
            return []
        }
        assert.deepEqual(
            await inspectPosixEntryViaParentReaddir('/', parentReaddirWithSymlink),
            { isDirectory: true, isSymlink: false },
        )
        assert.equal(rootReaddirCalls, 0)
        await assert.rejects(
            () => resolvePosixPathWithReadlink(
                '/dir/..',
                async () => {
                    throw new Error('Status(Failure)')
                },
                target => inspectPosixEntryViaParentReaddir(target, parentReaddirWithSymlink),
            ),
            /Failure/,
        )
        assert.equal(rootReaddirCalls, 1)

        // Case B: one-shot Failure followed by /dir becoming symlink -> '/other/child' retries readlink and resolves to '/other' (never '/').
        let dirReadlinkAttempts = 0
        const retriedCanonical = await resolvePosixPathWithReadlink(
            '/dir/..',
            async target => {
                if (target === '/dir') {
                    dirReadlinkAttempts++
                    if (dirReadlinkAttempts === 1) {
                        throw new Error('Status(Failure)')
                    }
                    return '/other/child'
                }
                throw new Error('Status(Failure)')
            },
            target => inspectPosixEntryViaParentReaddir(target, async dirPath => {
                if (dirPath === '/') {
                    return [
                        { name: 'dir', isDirectory: false, isSymlink: true },
                        { name: 'other', isDirectory: true, isSymlink: false },
                    ]
                }
                if (dirPath === '/other') {
                    return [{ name: 'child', isDirectory: true, isSymlink: false }]
                }
                return []
            }),
        )
        assert.equal(dirReadlinkAttempts, 2)
        assert.equal(retriedCanonical, '/other')

        // Post-readdir fallback flow: /link/../missing -> server rejects missing, reads /link/.. -> post-resolve converges to '/'
        const readdirAttempted: string[] = []
        const fallbackResult = await resolveReadableDirectory(
            '/link/../missing',
            async dirPath => {
                readdirAttempted.push(dirPath)
                if (dirPath === '/link/..') {
                    return ['real', 'etc']
                }
                throw new Error('No such file')
            },
            isSFTPDirectoryUnavailableError,
            undefined,
            true,
        )
        assert.equal(fallbackResult.ok, true)
        assert.deepEqual(readdirAttempted, ['/link/../missing', '/link/..'])
        if (fallbackResult.ok) {
            const canonical = await resolvePosixPathWithReadlink(fallbackResult.path, readlink, statDir)
            assert.equal(canonical, '/')
        }

        // Manual /regular-file/.. hits server readdir FIRST (fails ENOTDIR/Failure) without prematurely calling readlink or listing '/'
        const readlinkBeforeManual = readlinkCalls
        let listedRoot = false
        await assert.rejects(async () => {
            const candidate = '/regular-file/..'
            if (candidate === '/') {
                listedRoot = true
                return []
            }
            throw new Error('Status(Failure)')
        }, /Status\(Failure\)/)
        assert.equal(listedRoot, false)
        assert.equal(readlinkCalls, readlinkBeforeManual)
    })

    it('re-reads the final canonical directory when a symlink changes between initial readdir and readlink', async () => {
        let linkTarget = '/parent-a/child'
        const readdirCalls: string[] = []
        const entriesByDir: Record<string, { name: string, fullPath: string }[]> = {
            '/parent-a': [{ name: 'only-in-a.txt', fullPath: '/parent-a/only-in-a.txt' }],
            '/parent-b': [{ name: 'only-in-b.txt', fullPath: '/parent-b/only-in-b.txt' }],
        }
        const readdir = async (dirPath: string) => {
            readdirCalls.push(dirPath)
            if (dirPath === '/link/..') {
                // Initial readdir sees /parent-a, then symlink retargets before post-readdir readlink runs.
                const entries = [{ name: 'only-in-a.txt', fullPath: '/link/../only-in-a.txt' }]
                linkTarget = '/parent-b/child'
                return entries
            }
            return entriesByDir[dirPath] ?? []
        }
        const readlink = async (target: string): Promise<string> => {
            if (target === '/link') {
                return linkTarget
            }
            throw new Error('Failure')
        }
        const statDir = async () => ({ isDirectory: true, isSymlink: false })

        const initialEntries = await readdir('/link/..')
        let recordedCanonical: string | null = null
        const finalized = await finalizeCanonicalDirectoryListing(
            '/link/..',
            initialEntries,
            dirPath => resolvePosixPathWithReadlink(dirPath, readlink, statDir),
            readdir,
            raw => normalizeFilePanelPath(raw, true),
            () => false,
            true,
            resolved => {
                recordedCanonical = resolved
            },
        )

        assert.equal(finalized.cancelled, false)
        assert.equal(finalized.path, '/parent-b')
        assert.equal(recordedCanonical, '/parent-b')
        assert.deepEqual(readdirCalls, ['/link/..', '/parent-b'])
        assert.deepEqual(finalized.entries, [{ name: 'only-in-b.txt', fullPath: '/parent-b/only-in-b.txt' }])

        // Normal path without relative segments performs zero resolvePath and zero extra readdir calls.
        const callsBeforeNormal = readdirCalls.length
        let resolveCalledOnNormal = false
        const normalFinalized = await finalizeCanonicalDirectoryListing(
            '/parent-b',
            entriesByDir['/parent-b'],
            async () => {
                resolveCalledOnNormal = true
                return '/parent-b'
            },
            readdir,
            raw => normalizeFilePanelPath(raw, true),
            () => false,
            true,
        )
        assert.equal(normalFinalized.cancelled, false)
        assert.equal(normalFinalized.path, '/parent-b')
        assert.equal(resolveCalledOnNormal, false)
        assert.equal(readdirCalls.length, callsBeforeNormal)

        // Symlink removed between initial readdir and readlink propagates error instead of returning stale entries.
        await assert.rejects(
            () => finalizeCanonicalDirectoryListing(
                '/link/..',
                [{ name: 'stale-a.txt', fullPath: '/link/../stale-a.txt' }],
                dirPath => resolvePosixPathWithReadlink(dirPath, async () => {
                    throw new Error('No such file')
                }, statDir),
                readdir,
                raw => normalizeFilePanelPath(raw, true),
                () => false,
                true,
            ),
            /No such file/,
        )

        // Timeout during readlink propagates error instead of collapsing to '/' or returning stale entries.
        await assert.rejects(
            () => finalizeCanonicalDirectoryListing(
                '/link/..',
                [{ name: 'stale-a.txt', fullPath: '/link/../stale-a.txt' }],
                dirPath => resolvePosixPathWithReadlink(dirPath, async () => {
                    throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })
                }, statDir),
                readdir,
                raw => normalizeFilePanelPath(raw, true),
                () => false,
                true,
            ),
            /ETIMEDOUT/,
        )
    })

    it('discards stale canonicalization and re-read results when backend closes mid-resolution', async () => {
        let navigation = 1
        let active = true
        const request = navigation
        const isStale = () => !active || request !== navigation

        // Case 1: closed$ triggers while resolvePath is pending -> stale result discarded, no second readdir
        let releaseResolve: ((value: string) => void) | null = null
        let secondReaddirCalls = 0
        const pendingResolvePromise = finalizeCanonicalDirectoryListing(
            '/link/..',
            [{ name: 'stale.txt', fullPath: '/link/../stale.txt' }],
            () => new Promise<string>(resolve => {
                releaseResolve = resolve
            }),
            async () => {
                secondReaddirCalls++
                return [{ name: 'fresh.txt', fullPath: '/real/fresh.txt' }]
            },
            raw => normalizeFilePanelPath(raw, true),
            isStale,
            true,
        )
        assert.ok(releaseResolve)
        // Simulate backend.closed$: increment navigation & mark backend inactive
        navigation++
        active = false
        releaseResolve('/real')
        const result1 = await pendingResolvePromise
        assert.equal(result1.cancelled, true)
        assert.equal(secondReaddirCalls, 0)

        // Case 2: closed$ triggers while canonical second readdir is pending -> stale entries discarded
        navigation = 2
        active = true
        const request2 = navigation
        let releaseSecondReaddir: ((entries: { name: string }[]) => void) | null = null
        const pendingReaddirPromise = finalizeCanonicalDirectoryListing(
            '/link/..',
            [{ name: 'stale.txt' }],
            async () => '/real',
            () => new Promise<{ name: string }[]>(resolve => {
                releaseSecondReaddir = resolve
            }),
            raw => normalizeFilePanelPath(raw, true),
            () => !active || request2 !== navigation,
            true,
        )
        await new Promise(resolve => setTimeout(resolve, 10))
        assert.ok(releaseSecondReaddir)
        navigation++
        active = false
        releaseSecondReaddir([{ name: 'late.txt' }])
        const result2 = await pendingReaddirPromise
        assert.equal(result2.cancelled, true)

        // Case 3: channel-closed error inside readlink propagates instead of silently falling back to stale path
        await assert.rejects(
            () => finalizeCanonicalDirectoryListing(
                '/link/..',
                [{ name: 'stale.txt' }],
                dirPath => resolvePosixPathWithReadlink(dirPath, async () => {
                    throw new Error('SFTP channel closed')
                }),
                async () => [],
                raw => normalizeFilePanelPath(raw, true),
                () => false,
                true,
            ),
            /SFTP channel closed/,
        )
    })

    it('falls back past 16 levels of canonicalization permission errors without stalling', async () => {
        const deepSegments: string[] = []
        for (let i = 1; i <= 20; i++) {
            deepSegments.push(`d${i}`, '..')
        }
        const deepPath = `/${deepSegments.join('/')}`

        // Case A: 20 levels deep with '..' at every level, canonicalization hits EACCES at every level, /d1 is readable
        let resolveAttempts = 0
        const recovered = await resolveCanonicalReadableDirectory(
            deepPath,
            async dirPath => [{ name: `entry-of-${dirPath}` }],
            isSFTPDirectoryUnavailableError,
            async () => {
                resolveAttempts++
                throw Object.assign(new Error('Permission denied'), { code: 'EACCES' })
            },
            raw => normalizeFilePanelPath(raw, true),
            () => false,
            true,
        )
        assert.equal(recovered.ok, true)
        assert.equal(resolveAttempts, 39)
        if (recovered.ok) {
            assert.equal(recovered.path, '/d1')
            assert.equal(recovered.fellBackFrom, deepPath)
        }

        // Case B: even /d1 and / fail with EACCES -> exits with explicit failure (never hangs/silent exit)
        const failed = await resolveCanonicalReadableDirectory(
            deepPath,
            async dirPath => {
                if (!dirPath.includes('..')) {
                    throw Object.assign(new Error('Permission denied at ancestor'), { code: 'EACCES' })
                }
                return [{ name: 'stale' }]
            },
            isSFTPDirectoryUnavailableError,
            async () => {
                throw Object.assign(new Error('Permission denied during resolve'), { code: 'EACCES' })
            },
            raw => normalizeFilePanelPath(raw, true),
            () => false,
            true,
        )
        assert.equal(failed.ok, false)
        assert.equal(failed.cancelled, false)
        if (!failed.ok && !failed.cancelled) {
            assert.equal(failed.path, '/')
            assert.match(failed.errorMessage, /Permission denied/)
        }
    })

    it('recursively cancels every remaining pending FileUpload in nested directories at most once', () => {
        interface MockUpload {
            name: string
            size: number
            cancelled: boolean
            completed: boolean
            closed: boolean
            cancelCalls: number
            isCancelled: () => boolean
            isComplete: () => boolean
            getSize: () => number
            close: () => void
            cancel: () => void
        }
        interface MockDir {
            children: (MockUpload | MockDir)[]
            getChildrens: () => (MockUpload | MockDir)[]
        }
        const makeFile = (name: string, size: number, opts?: { cancelled?: boolean, completed?: boolean, closed?: boolean }): MockUpload => {
            const file: MockUpload = {
                name,
                size,
                cancelled: opts?.cancelled ?? false,
                completed: opts?.completed ?? false,
                closed: opts?.closed ?? Boolean(opts?.completed),
                cancelCalls: 0,
                isCancelled: () => file.cancelled,
                isComplete: () => file.closed && !file.cancelled && (file.completed || file.size === 0),
                getSize: () => file.size,
                close: () => {
                    file.closed = true
                },
                cancel: () => {
                    file.cancelCalls++
                    file.cancelled = true
                    file.closed = true
                },
            }
            return file
        }
        const makeDir = (children: (MockUpload | MockDir)[]): MockDir => ({
            children,
            getChildrens: () => children,
        })

        const firstHandled = makeFile('first.txt', 100)
        const secondPending = makeFile('second.txt', 50)
        const zeroBytePending = makeFile('empty.txt', 0)
        const zeroByteCompleted = makeFile('done-empty.txt', 0, { closed: true })
        const alreadyCancelled = makeFile('cancelled.txt', 25, { cancelled: true })
        const alreadyCompleted = makeFile('done.txt', 40, { completed: true })
        const nestedPending = makeFile('nested.txt', 75)
        const deepPending = makeFile('deep.txt', 120)

        assert.equal(zeroBytePending.isComplete(), false)
        assert.equal(zeroByteCompleted.isComplete(), true)

        const tree = makeDir([
            firstHandled,
            secondPending,
            zeroBytePending,
            zeroByteCompleted,
            alreadyCancelled,
            alreadyCompleted,
            makeDir([
                nestedPending,
                makeDir([deepPending]),
            ]),
        ])

        const handled = new Set<MockUpload>([firstHandled])
        const firstPassCancelled = cancelPendingDirectoryUpload(tree, handled)
        const secondPassCancelled = cancelPendingDirectoryUpload(tree, handled)

        assert.equal(firstPassCancelled, 4)
        assert.equal(secondPassCancelled, 0)
        assert.equal(firstHandled.cancelCalls, 0)
        assert.equal(zeroByteCompleted.cancelCalls, 0)
        assert.equal(alreadyCancelled.cancelCalls, 0)
        assert.equal(alreadyCompleted.cancelCalls, 0)
        assert.equal(secondPending.cancelCalls, 1)
        assert.equal(zeroBytePending.cancelCalls, 1)
        assert.equal(nestedPending.cancelCalls, 1)
        assert.equal(deepPending.cancelCalls, 1)
    })

    it('skips pre-cancelled or already-completed queued files including zero-byte files only once cancelled or closed', () => {
        const makeUpload = (opts: { size: number, cancelled?: boolean, completed?: boolean, closed?: boolean }) => ({
            isCancelled: () => Boolean(opts.cancelled),
            isComplete: () => Boolean(opts.closed ?? opts.completed) && !opts.cancelled && (Boolean(opts.completed) || opts.size === 0),
            getSize: () => opts.size,
            cancel: () => undefined,
        })

        const pendingNonEmpty = makeUpload({ size: 100 })
        const cancelledQueued = makeUpload({ size: 100, cancelled: true })
        const completedNonEmpty = makeUpload({ size: 100, completed: true })
        const pendingZeroByte = makeUpload({ size: 0 })
        const cancelledZeroByte = makeUpload({ size: 0, cancelled: true })
        const completedZeroByte = makeUpload({ size: 0, closed: true })

        assert.equal(pendingZeroByte.isComplete(), false)
        assert.equal(completedZeroByte.isComplete(), true)
        assert.equal(shouldSkipQueuedFileUpload(pendingNonEmpty), false)
        assert.equal(shouldSkipQueuedFileUpload(cancelledQueued), true)
        assert.equal(shouldSkipQueuedFileUpload(completedNonEmpty), true)
        assert.equal(shouldSkipQueuedFileUpload(pendingZeroByte), false)
        assert.equal(shouldSkipQueuedFileUpload(cancelledZeroByte), true)
        assert.equal(shouldSkipQueuedFileUpload(completedZeroByte), true)
    })

    it('resolves regular directories below 0111 search-only parents via stat + second readlink sandwich while keeping readable-parent protection', async () => {
        assert.equal(isSFTPPermissionDeniedError(Object.assign(new Error('Permission denied'), { code: 'EACCES' })), true)
        assert.equal(isSFTPPermissionDeniedError(Object.assign(new Error('failed'), { statusCode: 3 })), true)
        assert.equal(isSFTPPermissionDeniedError(new Error('Status(Status { status_code: PermissionDenied, error_message: "Permission denied" })')), true)
        assert.equal(isSFTPPermissionDeniedError(Object.assign(new Error('No such file'), { code: 'ENOENT' })), false)
        assert.equal(isSFTPPermissionDeniedError(new Error('Request timed out')), false)

        // Case A: /search-only is 0111 (readdir -> EACCES), /search-only/team & child are regular readable dirs.
        let statCalls = 0
        const readlinkCounts = new Map<string, number>()
        const resolved0111 = await resolvePosixPathWithReadlink(
            '/search-only/team/child/..',
            async target => {
                readlinkCounts.set(target, (readlinkCounts.get(target) ?? 0) + 1)
                throw new Error('Status(Status { status_code: BadMessage, error_message: "Bad message" })')
            },
            target => inspectPosixEntryViaParentReaddir(
                target,
                async dirPath => {
                    if (dirPath === '/') {
                        return [{ name: 'search-only', isDirectory: true, isSymlink: false }]
                    }
                    if (dirPath === '/search-only') {
                        throw Object.assign(new Error('Permission denied'), { code: 'EACCES' })
                    }
                    if (dirPath === '/search-only/team') {
                        return [{ name: 'child', isDirectory: true, isSymlink: false }]
                    }
                    return []
                },
                async statTarget => {
                    statCalls++
                    assert.equal(statTarget, '/search-only/team')
                    return { isDirectory: true, isSymlink: false }
                },
            ),
        )
        assert.equal(resolved0111, '/search-only/team')
        assert.equal(statCalls, 1)
        // Sandwich check: readlink('/search-only/team') called twice (before & after stat fallback), others only once.
        assert.equal(readlinkCounts.get('/search-only'), 1)
        assert.equal(readlinkCounts.get('/search-only/team'), 2)
        assert.equal(readlinkCounts.get('/search-only/team/child'), 1)

        // Case B: Under 0111 parent, entry turns into a symlink between 1st readlink and 2nd readlink -> expands symlink target!
        let teamReadlinkAttempts = 0
        const expandedAfterSwap = await resolvePosixPathWithReadlink(
            '/search-only/team/..',
            async target => {
                if (target === '/search-only/team') {
                    teamReadlinkAttempts++
                    if (teamReadlinkAttempts === 1) {
                        throw new Error('Status(Failure)')
                    }
                    return '/other/child'
                }
                throw new Error('Status(Failure)')
            },
            target => inspectPosixEntryViaParentReaddir(
                target,
                async dirPath => {
                    if (dirPath === '/') {
                        return [
                            { name: 'search-only', isDirectory: true, isSymlink: false },
                            { name: 'other', isDirectory: true, isSymlink: false },
                        ]
                    }
                    if (dirPath === '/search-only') {
                        throw Object.assign(new Error('Permission denied'), { code: 'EACCES' })
                    }
                    if (dirPath === '/other') {
                        return [{ name: 'child', isDirectory: true, isSymlink: false }]
                    }
                    return []
                },
                async () => ({ isDirectory: true, isSymlink: false }),
            ),
        )
        assert.equal(teamReadlinkAttempts, 2)
        assert.equal(expandedAfterSwap, '/other')

        // Case C: Under 0111 parent, 2nd readlink throws timeout / channel closed / ENOENT -> propagates directly (never folds).
        for (const err of [
            Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' }),
            new Error('SFTP channel closed'),
            Object.assign(new Error('No such file'), { code: 'ENOENT' }),
        ]) {
            let calls = 0
            await assert.rejects(
                () => resolvePosixPathWithReadlink(
                    '/search-only/team/..',
                    async target => {
                        if (target === '/search-only/team') {
                            calls++
                            if (calls === 1) {
                                throw new Error('Status(Failure)')
                            }
                            throw err
                        }
                        throw new Error('Status(Failure)')
                    },
                    target => inspectPosixEntryViaParentReaddir(
                        target,
                        async dirPath => {
                            if (dirPath === '/') {
                                return [{ name: 'search-only', isDirectory: true, isSymlink: false }]
                            }
                            throw Object.assign(new Error('Permission denied'), { code: 'EACCES' })
                        },
                        async () => ({ isDirectory: true, isSymlink: false }),
                    ),
                ),
                error => error === err,
            )
            assert.equal(calls, 2)
        }

        // Case D: Parent readdir fails with ENOENT (not EACCES) -> statFallback is NEVER called.
        let enoentStatCalls = 0
        await assert.rejects(
            () => inspectPosixEntryViaParentReaddir(
                '/missing-parent/child',
                async () => {
                    throw Object.assign(new Error('No such file'), { code: 'ENOENT' })
                },
                async () => {
                    enoentStatCalls++
                    return { isDirectory: true, isSymlink: false }
                },
            ),
            /No such file/,
        )
        assert.equal(enoentStatCalls, 0)

        // Case E: Readable parent with symlink still rejects persistent Failure and NEVER invokes statFallback.
        let readableParentStatCalls = 0
        await assert.rejects(
            () => resolvePosixPathWithReadlink(
                '/dir/..',
                async () => {
                    throw new Error('Status(Failure)')
                },
                target => inspectPosixEntryViaParentReaddir(
                    target,
                    async () => [{ name: 'dir', isDirectory: false, isSymlink: true }],
                    async () => {
                        readableParentStatCalls++
                        return { isDirectory: true, isSymlink: false }
                    },
                ),
            ),
            /Failure/,
        )
        assert.equal(readableParentStatCalls, 0)
    })

    it('falls back from parent of failed canonicalPath when canonical re-read is unavailable and prevents cycles', async () => {
        // Startup fallback: /home/user/link/.. reads OK -> canonical /srv/shared reread fails EACCES -> falls back directly to /srv (skips /home/user/link).
        const readdirLog: string[] = []
        const result = await resolveCanonicalReadableDirectory(
            '/home/user/link/..',
            async dirPath => {
                readdirLog.push(dirPath)
                if (dirPath === '/home/user/link/..') {
                    return [{ name: 'old-shared-item' }]
                }
                if (dirPath === '/srv/shared') {
                    throw Object.assign(new Error('Permission denied: /srv/shared'), { code: 'EACCES' })
                }
                if (dirPath === '/srv') {
                    return [{ name: 'srv-marker.txt' }]
                }
                throw Object.assign(new Error(`Unexpected readdir: ${dirPath}`), { code: 'ENOENT' })
            },
            isSFTPDirectoryUnavailableError,
            async dirPath => {
                assert.equal(dirPath, '/home/user/link/..')
                return '/srv/shared'
            },
            raw => normalizeFilePanelPath(raw, true),
            () => false,
            true,
        )
        assert.equal(result.ok, true)
        if (result.ok) {
            assert.equal(result.path, '/srv')
            assert.equal(result.fellBackFrom, '/home/user/link/..')
            assert.match(result.fallbackReason ?? '', /Permission denied/)
            assert.deepEqual(result.entries, [{ name: 'srv-marker.txt' }])
        }
        assert.deepEqual(readdirLog, ['/home/user/link/..', '/srv/shared', '/srv'])
        assert.equal(readdirLog.includes('/home/user/link'), false)

        // When canonical path itself is '/' and reread fails EACCES, stops cleanly without looping back to raw parent.
        const rootFailLog: string[] = []
        const rootFail = await resolveCanonicalReadableDirectory(
            '/home/user/root-link/..',
            async dirPath => {
                rootFailLog.push(dirPath)
                if (dirPath === '/home/user/root-link/..') {
                    return [{ name: 'stale' }]
                }
                throw Object.assign(new Error('Permission denied: /'), { code: 'EACCES' })
            },
            isSFTPDirectoryUnavailableError,
            async () => '/',
            raw => normalizeFilePanelPath(raw, true),
            () => false,
            true,
        )
        assert.equal(rootFail.ok, false)
        assert.equal(rootFail.cancelled, false)
        if (!rootFail.ok && !rootFail.cancelled) {
            assert.equal(rootFail.path, '/')
            assert.equal(rootFail.isUnavailable, true)
        }
        assert.deepEqual(rootFailLog, ['/home/user/root-link/..', '/'])
    })

    for (const phase of ['close', 'unlink', 'rename-success', 'rename-failure']) {
        it(`handles cancellation during SFTP upload ${phase}`, async () => {
            class TestUpload extends FileUpload {
                getName () { return 'target' }
                getSize () { return 1 }
                getMode () { return 0o644 }
                close () {}
                async read () {
                    if (this.getCompletedBytes()) {
                        return new Uint8Array(0)
                    }
                    this.increaseProgress(1)
                    return Uint8Array.of(42)
                }
            }
            const transfer = new TestUpload()
            const target = '/remote/target'
            const commitError = new Error('Rename failed')
            const files = new Map([[target, 7]])
            const operations: string[] = []
            let tempPath = ''

            const cancelAt = async (operation: string) => {
                if (phase === operation || (operation === 'rename' && phase.startsWith('rename-'))) {
                    assert.equal(transfer.isComplete(), false)
                    transfer.cancel()
                    assert.equal(transfer.isCancelled(), phase === 'close')
                }
            }
            const upload = runStagedSFTPUpload(target, transfer, {
                openTemp: async path => {
                    tempPath = path
                    return {
                        write: async chunk => { files.set(path, chunk[0]) },
                        close: () => cancelAt('close'),
                    }
                },
                unlink: async path => {
                    if (path === target) {
                        operations.push('unlink')
                        await cancelAt('unlink')
                    }
                    files.delete(path)
                },
                rename: async (src, dst) => {
                    operations.push('rename')
                    await cancelAt('rename')
                    if (phase === 'rename-failure') {
                        throw commitError
                    }
                    files.set(dst, files.get(src)!)
                    files.delete(src)
                },
            })
            if (phase === 'close') {
                await assert.rejects(upload, /Upload cancelled/)
                assert.deepEqual(operations, [])
                assert.equal(files.get(target), 7)
            } else if (phase === 'rename-failure') {
                await assert.rejects(upload, error => error === commitError)
                assert.equal(transfer.getStatus(), 'Upload cancelled')
            } else {
                await upload
                assert.deepEqual(operations, ['unlink', 'rename'])
                assert.equal(files.get(target), 42)
                transfer.cancel()
            }
            const committed = phase === 'unlink' || phase === 'rename-success'
            assert.match(tempPath, /^\/remote\/\.[^/]+\.tabby-upload$/)
            assert.equal(files.has(tempPath), false)
            assert.equal(transfer.isComplete(), committed)
            assert.equal(transfer.isCancelled(), !committed)
        })
    }

    it('resolves atomic download permissions for SSH preserveExistingMode, explicit 0000 vs undefined, and ADB rules', () => {
        // SSH overwrite (preserveExistingMode = true): strictly preserves target's original mode (neither loosens nor tightens)
        assert.equal(resolveAtomicDownloadMode(0o644, 0o022, 0o100755, true), 0o755)
        assert.equal(resolveAtomicDownloadMode(0o644, 0o022, 0o100600, true), 0o600)
        assert.equal(resolveAtomicDownloadMode(0o000, 0o022, 0o100644, true), 0o644)
        assert.equal(resolveAtomicDownloadMode(undefined, 0o022, 0o100750, true), 0o750)

        // SSH new file (existingMode = undefined): explicit 0000 stays strictly 0000; undefined falls back to 0666 & ~umask
        assert.equal(resolveAtomicDownloadMode(0o000, 0o022, undefined, true), 0o000)
        assert.equal(resolveAtomicDownloadMode(0o000, 0o077, undefined, true), 0o000)
        assert.equal(resolveAtomicDownloadMode(undefined, 0o022, undefined, true), 0o644)
        assert.equal(resolveAtomicDownloadMode(undefined, 0o077, undefined, true), 0o600)
        assert.equal(resolveAtomicDownloadMode(0o755, 0o022, undefined, true), 0o755)
        assert.equal(resolveAtomicDownloadMode(0o666, 0o022, undefined, true), 0o644)

        // ADB overwrite keeps only permission bits allowed by both modes.
        assert.equal(resolveAtomicDownloadMode(0o444, 0o022, 0o100644, false), 0o444)
        assert.equal(resolveAtomicDownloadMode(0o644, 0o022, 0o100600, false), 0o600)
        assert.equal(resolveAtomicDownloadMode(undefined, 0o022, undefined, false), 0o644)
        assert.equal(resolveAtomicDownloadMode(0, 0o022, undefined, false), 0o644)
        assert.equal(resolveAtomicDownloadMode(0o444, 0o022, 0o104644, false), 0o4444)
    })
})

describe('filePanelFilter', () => {
    it('matches case-insensitively with tier ranking, directory priority, and merged highlight ranges', () => {
        const entries = [
            { name: 'good_config', isDirectory: false },
            { name: 'log_comp', isDirectory: true },
            { name: 'g_comp', isDirectory: true },
            { name: 'g_c', isDirectory: false },
            { name: 'G_Config', isDirectory: false },
            { name: 'other.txt', isDirectory: false },
        ]

        const results = filterAndSortEntries(entries, 'g_c')
        assert.deepEqual(results.map(r => r.item.name), [
            'g_c',         // tier 0: exact
            'g_comp',      // tier 1: prefix, directory
            'G_Config',    // tier 1: prefix, file
            'log_comp',    // tier 2: contiguous substring
            'good_config', // tier 3: subsequence
        ])

        assert.deepEqual(results[1].ranges, [[0, 3]])
        assert.deepEqual(results[3].ranges, [[2, 5]])
        assert.deepEqual(results[4].ranges, [[0, 1], [4, 6]])
        assert.deepEqual(results[4].segments, [
            { text: 'g', highlighted: true },
            { text: 'ood', highlighted: false },
            { text: '_c', highlighted: true },
            { text: 'onfig', highlighted: false },
        ])

        assert.deepEqual(matchFileName('g_comp', 'gc')?.ranges, [[0, 1], [2, 3]])
        assert.deepEqual(mergeHighlightRanges([0, 1, 2, 5, 6]), [[0, 3], [5, 7]])
        assert.deepEqual(splitTextByHighlights('<b>test</b>', [[3, 7]]), [
            { text: '<b>', highlighted: false },
            { text: 'test', highlighted: true },
            { text: '</b>', highlighted: false },
        ])
    })

    it('maps highlight ranges accurately when toLowerCase() expands UTF-16 length (e.g. İxa.txt)', () => {
        const matchX = matchFileName('İxa.txt', 'x')
        assert.ok(matchX)
        assert.equal(matchX.tier, 2)
        assert.deepEqual(matchX.ranges, [[1, 2]])
        assert.deepEqual(splitTextByHighlights('İxa.txt', matchX.ranges), [
            { text: 'İ', highlighted: false },
            { text: 'x', highlighted: true },
            { text: 'a.txt', highlighted: false },
        ])

        const matchPrefix = matchFileName('İxa.txt', 'İx')
        assert.ok(matchPrefix)
        assert.equal(matchPrefix.tier, 1)
        assert.deepEqual(matchPrefix.ranges, [[0, 2]])
        assert.deepEqual(splitTextByHighlights('İxa.txt', matchPrefix.ranges), [
            { text: 'İx', highlighted: true },
            { text: 'a.txt', highlighted: false },
        ])

        const matchSubseq = matchFileName('İxa.txt', 'xtt')
        assert.ok(matchSubseq)
        assert.equal(matchSubseq.tier, 3)
        assert.deepEqual(matchSubseq.ranges, [[1, 2], [4, 5], [6, 7]])

        // Context-sensitive Unicode lowercase (Greek final sigma Σ -> ς alongside expanding İ -> i\u0307)
        const matchGreek = matchFileName('İΟΣ', 'ος')
        assert.ok(matchGreek)
        assert.equal(matchGreek.tier, 2)
        assert.deepEqual(matchGreek.ranges, [[1, 3]])
        assert.deepEqual(splitTextByHighlights('İΟΣ', matchGreek.ranges), [
            { text: 'İ', highlighted: false },
            { text: 'ΟΣ', highlighted: true },
        ])

        for (const sigmaQuery of ['Σ', 'σ', 'ς']) {
            const matchSigma = matchFileName('İΟΣ', sigmaQuery)
            assert.ok(matchSigma, `expected 'İΟΣ' to match '${sigmaQuery}'`)
            assert.equal(matchSigma.tier, 2)
            assert.deepEqual(matchSigma.ranges, [[2, 3]])
            assert.deepEqual(splitTextByHighlights('İΟΣ', matchSigma.ranges), [
                { text: 'İΟ', highlighted: false },
                { text: 'Σ', highlighted: true },
            ])
        }
    })

    it('preserves directory-first lexicographical order when query is empty', () => {
        const entries = [
            { name: 'z.txt', isDirectory: false },
            { name: 'b_dir', isDirectory: true },
            { name: 'a.txt', isDirectory: false },
            { name: 'a_dir', isDirectory: true },
        ]
        const results = filterAndSortEntries(entries, '   ')
        assert.deepEqual(results.map(r => r.item.name), ['a_dir', 'b_dir', 'a.txt', 'z.txt'])
        assert.ok(results.every(r => r.ranges.length === 0))
    })

    it('filters 1,000 entries within 16 ms budget', () => {
        const entries = Array.from({ length: 1000 }, (_, i) => ({
            name: i % 5 === 0
                ? `g_comp_module_${String(i).padStart(4, '0')}`
                : `service_entry_${String(i).padStart(4, '0')}.log`,
            isDirectory: i % 3 === 0,
        }))

        const queries = ['g_c', 'g_comp', 'e', 'svc009', 'zzzz_no_match']
        const durations: number[] = []

        // Warm up JIT once
        filterAndSortEntries(entries, 'g_c')

        for (let round = 0; round < 5; round++) {
            for (const query of queries) {
                const start = performance.now()
                const matched = filterAndSortEntries(entries, query)
                const elapsed = performance.now() - start
                durations.push(elapsed)
                if (query === 'g_c') {
                    assert.equal(matched.length, 200)
                }
                if (query === 'zzzz_no_match') {
                    assert.equal(matched.length, 0)
                }
            }
        }

        const maxMs = Math.max(...durations)
        const sorted = [...durations].sort((a, b) => a - b)
        const p95Ms = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
        console.log(`filePanelFilter 1000-entry benchmark: p95=${p95Ms.toFixed(2)}ms, max=${maxMs.toFixed(2)}ms`)
        assert.ok(p95Ms <= 16, `Expected P95 <= 16ms, got ${p95Ms.toFixed(2)}ms`)
        assert.ok(maxMs <= 16, `Expected max <= 16ms, got ${maxMs.toFixed(2)}ms`)
    })
})
