import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { describe, it } from 'node:test'
import {
    ADB_FILE_PANEL_SCOPE,
    FILE_PANEL_STATE_STORAGE_KEY,
    FilePanelStateStore,
    MAX_FAVORITE_PATHS,
    MAX_RECENT_PATHS,
    MAX_SSH_SCOPES,
    createSSHFilePanelScope,
    getFilePanelScopeStorageKey,
    normalizeFilePanelPath,
    parseFilePanelScopeRecord,
    subscribeFilePanelStateChanges,
} from '../src/utils/filePanelState.ts'
import type { FilePanelStorageLike } from '../src/utils/filePanelState.ts'
import {
    filterAndSortEntries,
    matchFileName,
    mergeHighlightRanges,
    splitTextByHighlights,
} from '../src/utils/filePanelFilter.ts'
import {
    isAdbDirectoryUnavailableError,
    isSFTPDirectoryUnavailableError,
    resolveReadableDirectory,
} from '../src/utils/filePanelFallback.ts'

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
