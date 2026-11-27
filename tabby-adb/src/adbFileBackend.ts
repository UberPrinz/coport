import { ipcRenderer } from 'electron'
import { posix } from 'path'
import type { FileDownload, FileUpload } from 'tabby-core'
import type { FileBackend, SFTPFile } from 'tabby-ssh'

const chunkSize = 256 * 1024
interface Entry extends Omit<SFTPFile, 'modified'> {
    modified: number
}

export interface AdbRequestError extends Error {
    reason?: string
    stderr?: string
}

export async function adbRequest<T> (action: string, args?: object): Promise<T> {
    const reply = await ipcRenderer.invoke(`coport-adb:${action}`, args)
    if (!reply.ok) {
        const { message, stderr, reason } = reply.error
        const error: AdbRequestError = new Error(stderr ? `${message}: ${stderr.trim()}` : message)
        if (typeof reason === 'string') {
            error.reason = reason
        }
        if (typeof stderr === 'string') {
            error.stderr = stderr
        }
        throw error
    }
    return reply.result
}

export class AdbFileBackend implements FileBackend {
    readonly atomicDownloads = true
    readonly preserveExistingMode = false
    readonly normalizePath = (value: string): string => posix.normalize(value)
    readonly isDirectoryUnavailable = (error: unknown): boolean =>
        typeof error === 'object' && error !== null && (error as { reason?: unknown }).reason === 'unreadable_directory'

    private uploads = Promise.resolve()

    constructor (private serial: string) {}

    private request<T> (action: string, path: string): Promise<T> {
        return adbRequest<T>(`fs:${action}`, { serial: this.serial, path })
    }

    async readdir (path: string): Promise<SFTPFile[]> {
        const entries = await this.request<Entry[]>('list', path)
        return entries.map(entry => ({ ...entry, modified: new Date(entry.modified * 1000) }))
    }

    async stat (path: string): Promise<SFTPFile> {
        const entry = await this.request<Entry>('stat', path)
        return { ...entry, modified: new Date(entry.modified * 1000) }
    }

    readlink (path: string): Promise<string> {
        return this.request('readlink', path)
    }

    mkdir (path: string): Promise<void> {
        return this.request('mkdir', path)
    }

    rmdir (path: string): Promise<void> {
        return this.request('rmdir', path)
    }

    unlink (path: string): Promise<void> {
        return this.request('unlink', path)
    }

    private abortWhenCancelled (id: string, transfer: FileUpload | FileDownload): ReturnType<typeof setInterval> {
        const timer = setInterval(() => {
            if (transfer.isCancelled()) {
                clearInterval(timer)
                void adbRequest('fs:close', { id }).catch(console.error)
            }
        }, 100)
        return timer
    }

    upload (path: string, transfer: FileUpload): Promise<void> {
        transfer.setPendingCommit(true)
        const upload = this.uploads.then(() => this.uploadFile(path, transfer))
        this.uploads = upload.catch(() => undefined)
        return upload.finally(() => transfer.setPendingCommit(false))
    }

    private async uploadFile (path: string, transfer: FileUpload): Promise<void> {
        let id: string | undefined = undefined
        let monitor: ReturnType<typeof setInterval> | undefined = undefined
        try {
            if (transfer.isCancelled()) {
                throw new Error('Upload cancelled')
            }
            id = await this.request<string>('push', path)
            monitor = this.abortWhenCancelled(id, transfer)
            while (!transfer.isCancelled()) {
                const data = await transfer.read()
                if (transfer.isCancelled()) {
                    break
                }
                if (!data.length) {
                    await adbRequest('fs:finish', { id })
                    const optionalTransfer = transfer as { setCompleted?: (completed: boolean) => void }
                    optionalTransfer.setCompleted?.(true)
                    transfer.close()
                    return
                }
                for (let offset = 0; offset < data.length; offset += chunkSize) {
                    await adbRequest('fs:write', { id, bytes: data.subarray(offset, offset + chunkSize) })
                }
            }
            throw new Error('Upload cancelled')
        } catch (error) {
            transfer.setStatus(error.message)
            transfer.cancel()
            throw error
        } finally {
            clearInterval(monitor)
            if (id) {
                await adbRequest('fs:close', { id })
            }
        }
    }

    async download (path: string, transfer: FileDownload): Promise<void> {
        let id: string | undefined = undefined
        let monitor: ReturnType<typeof setInterval> | undefined = undefined
        try {
            id = await this.request<string>('pull', path)
            monitor = this.abortWhenCancelled(id, transfer)
            while (!transfer.isCancelled()) {
                const data = await adbRequest<Uint8Array>('fs:read', { id })
                if (transfer.isCancelled()) {
                    break
                }
                if (!data.length) {
                    await transfer.completeDownload()
                    return
                }
                await transfer.write(data)
            }
            throw new Error('Download cancelled')
        } catch (error) {
            transfer.setStatus(error.message)
            transfer.cancel()
            throw error
        } finally {
            clearInterval(monitor)
            if (id) {
                await adbRequest('fs:close', { id })
            }
        }
    }
}
