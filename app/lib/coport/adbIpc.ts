import { BrowserWindow, ipcMain, WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { FileHandle, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { AdbFailure, AdbService } from './adbService'

const chunkSize = 256 * 1024
type Direction = 'upload' | 'download'

interface Transfer {
    direction: Direction
    directory: string
    serial: string
    path: string
    abort: AbortController
    handle?: FileHandle
    ready?: Promise<void>
    pending?: Promise<unknown>
}

interface Owner {
    transfers: Map<string, Transfer>
    disposing: Map<string, Promise<void>>
    destinations: Map<string, string>
    revision: number
}

export function installAdbIpc (adb: AdbService): () => Promise<void> {
    const owners = new Map<WebContents, Owner>()
    const cleanup = new Set<Promise<unknown>>()
    let stopping = false

    function track<T> (operation: Promise<T>): Promise<T> {
        const task = operation.finally(() => cleanup.delete(task))
        cleanup.add(task)
        return task
    }

    function dispose (owner: Owner, id: string): Promise<void> {
        const transfer = owner.transfers.get(id)
        if (!transfer) {
            return owner.disposing.get(id) ?? Promise.resolve()
        }
        owner.transfers.delete(id)
        transfer.abort.abort()
        const close = async () => {
            await Promise.allSettled([transfer.ready, transfer.pending])
            try {
                await transfer.handle?.close()
            } finally {
                await rm(transfer.directory, { recursive: true, force: true })
            }
        }
        const task = track(close().finally(() => owner.disposing.delete(id)))
        owner.disposing.set(id, task)
        return task
    }

    function releaseDestination (owner: Owner, id: string): Promise<void> {
        const path = owner.destinations.get(id)
        if (!path) {
            return Promise.resolve()
        }
        owner.destinations.delete(id)
        return track(rm(path, { force: true }))
    }

    function cancelTransfers (owner: Owner): void {
        owner.revision++
        for (const id of owner.transfers.keys()) {
            void dispose(owner, id).catch(console.error)
        }
        for (const id of owner.destinations.keys()) {
            void releaseDestination(owner, id).catch(console.error)
        }
    }

    function transfers (sender: WebContents): Owner {
        let owner = owners.get(sender)
        if (!owner) {
            const known: Owner = { transfers: new Map(), disposing: new Map(), destinations: new Map(), revision: 0 }
            owners.set(sender, known)
            sender.once('destroyed', () => {
                owners.delete(sender)
                cancelTransfers(known)
            })
            sender.on('render-process-gone', () => cancelTransfers(known))
            sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
                if (isMainFrame && !isInPlace) {
                    cancelTransfers(known)
                }
            })
            owner = known
        }
        return owner
    }

    function listen (action: string, handler: (sender: WebContents, args: any) => unknown): void {
        ipcMain.handle(`coport-adb:${action}`, async (event, args) => {
            try {
                if (stopping || !BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) {
                    throw new AdbFailure('ADB IPC requires the main window frame')
                }
                return { ok: true, result: await handler(event.sender, args ?? {}) }
            } catch (error) {
                return { ok: false, error: {
                    code: 'adb_error', message: error.message, retryable: true,
                    stderr: error.stderr ?? '', reason: error.reason ?? 'adb_error',
                } }
            }
        })
    }

    function active (sender: WebContents, id: string, direction: Direction): Transfer {
        const transfer = transfers(sender).transfers.get(id)
        if (!transfer || transfer.direction !== direction || transfer.pending !== undefined || !transfer.handle) {
            throw new AdbFailure('ADB transfer is unavailable')
        }
        return transfer
    }

    async function begin (sender: WebContents, direction: Direction, serial: string, path: string): Promise<string> {
        const owner = transfers(sender)
        const revision = owner.revision
        const id = randomUUID()
        const directory = await mkdtemp(join(tmpdir(), 'coport-adb-'))
        if (owner.transfers.size >= 16 || stopping || sender.isDestroyed() || revision !== owner.revision) {
            await rm(directory, { recursive: true, force: true })
            throw new AdbFailure('ADB transfer is unavailable')
        }
        const transfer: Transfer = { direction, directory, serial, path, abort: new AbortController() }
        owner.transfers.set(id, transfer)
        const local = join(directory, 'transfer')
        const prepare = async () => {
            if (direction === 'download') {
                await adb.download(serial, path, local, transfer.abort.signal)
            }
            transfer.handle = await open(local, direction === 'download' ? 'r' : 'wx', 0o600)
        }
        transfer.ready = prepare()
        // Download callers may cancel the transfer before the first read request arrives.
        void transfer.ready.catch(() => null)
        return id
    }

    async function reserveDestination (sender: WebContents, target: string): Promise<{ id: string, path: string }> {
        if (typeof target !== 'string' || !isAbsolute(target) || target.includes('\0')) {
            throw new AdbFailure('Invalid download destination')
        }
        const owner = transfers(sender)
        const revision = owner.revision
        const id = randomUUID()
        const path = join(dirname(target), `.coport-download-${id}`)
        const handle = await open(path, 'wx', 0o600)
        try {
            await handle.close()
            if (stopping || sender.isDestroyed() || revision !== owner.revision) {
                throw new AdbFailure('ADB download destination is unavailable')
            }
            owner.destinations.set(id, path)
            return { id, path }
        } catch (error) {
            await rm(path, { force: true })
            throw error
        }
    }

    listen('fs:reserve-local', (sender, { target }) => track(reserveDestination(sender, target)))
    listen('fs:release-local', (sender, { id }) => releaseDestination(transfers(sender), id))
    listen('devices', async () => (await adb.devices()).devices)
    listen('select', (_sender, { serial }) => adb.select(serial))
    listen('fs:list', (_sender, { serial, path }) => adb.list(serial, path))
    listen('fs:stat', (_sender, { serial, path }) => adb.stat(serial, path))
    listen('fs:readlink', (_sender, { serial, path }) => adb.readlink(serial, path))
    for (const operation of ['mkdir', 'rmdir', 'unlink'] as const) {
        listen(`fs:${operation}`, (_sender, { serial, path }) => adb.mutate(serial, operation, path))
    }
    listen('fs:push', (sender, { serial, path }) => track(begin(sender, 'upload', serial, path)))
    listen('fs:pull', (sender, { serial, path }) => track(begin(sender, 'download', serial, path)))
    listen('fs:read', async (sender, { id }) => {
        await transfers(sender).transfers.get(id)?.ready
        const transfer = active(sender, id, 'download')
        const bytes = Buffer.allocUnsafe(chunkSize)
        const read = transfer.handle!.read(bytes)
        transfer.pending = read
        try {
            const { bytesRead } = await read
            return bytes.subarray(0, bytesRead)
        } finally {
            transfer.pending = undefined
        }
    })
    listen('fs:write', async (sender, { id, bytes }) => {
        await transfers(sender).transfers.get(id)?.ready
        const transfer = active(sender, id, 'upload')
        if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > chunkSize) {
            throw new AdbFailure('Invalid transfer chunk')
        }
        const write = async () => {
            let offset = 0
            while (offset < bytes.length) {
                const { bytesWritten } = await transfer.handle!.write(bytes, offset, bytes.length - offset)
                if (!bytesWritten) {
                    throw new AdbFailure('Could not write local upload staging file')
                }
                offset += bytesWritten
            }
        }
        transfer.pending = write()
        try {
            await transfer.pending
        } finally {
            transfer.pending = undefined
        }
    })
    listen('fs:finish', async (sender, { id }) => {
        await transfers(sender).transfers.get(id)?.ready
        const transfer = active(sender, id, 'upload')
        const owned = transfers(sender)
        const commit = async () => {
            await transfer.handle!.close()
            transfer.handle = undefined
            await adb.upload(transfer.serial, transfer.path, join(transfer.directory, 'transfer'), transfer.abort.signal)
        }
        transfer.pending = commit()
        try {
            await transfer.pending
        } finally {
            await dispose(owned, id)
        }
    })
    listen('fs:close', (sender, { id }) => dispose(transfers(sender), id))

    return async () => {
        stopping = true
        for (const owned of owners.values()) {
            cancelTransfers(owned)
        }
        await Promise.allSettled(cleanup)
    }
}
