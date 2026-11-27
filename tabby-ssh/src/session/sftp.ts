/* eslint-disable @typescript-eslint/no-unused-vars */
import { Subject, Observable } from 'rxjs'
import { posix as posixPath } from 'path'
import { Injector } from '@angular/core'
import { FileDownload, FileUpload, Logger, LogService } from 'tabby-core'
import * as russh from 'russh'
import type { FileBackend } from '../api/fileBackend'
import { runStagedSFTPUpload } from './sftpUpload'
import {
    inspectPosixEntryViaParentReaddir,
    isSFTPChannelClosedError,
    isSFTPDirectoryUnavailableError,
    resolvePosixPathWithReadlink,
} from '../utils/filePanelFallback'

export interface SFTPFile {
    name: string
    fullPath: string
    isDirectory: boolean
    isSymlink: boolean
    mode: number
    hasMode?: boolean
    size: number
    modified: Date
}

export class SFTPFileHandle {
    position = 0

    constructor (
        private inner: russh.SFTPFile|null,
    ) { }

    async read (): Promise<Uint8Array> {
        if (!this.inner) {
            return Promise.resolve(new Uint8Array(0))
        }
        return this.inner.read(256 * 1024)
    }

    async write (chunk: Uint8Array): Promise<void> {
        if (!this.inner) {
            throw new Error('File handle is closed')
        }
        await this.inner.writeAll(chunk)
    }

    async close (): Promise<void> {
        await this.inner?.shutdown()
        this.inner = null
    }
}

export class SFTPSession implements FileBackend {
    readonly atomicDownloads = true
    readonly preserveExistingMode = true
    get closed$ (): Observable<void> { return this.closed }
    get rawSftp (): russh.SFTP { return this.sftp }
    private closed = new Subject<void>()
    private logger: Logger

    constructor (
        private sftp: russh.SFTP,
        injector: Injector,
        private onInvalidate?: () => void,
    ) {
        this.logger = injector.get(LogService).create('sftp')
        sftp.closed$.subscribe(() => {
            this.onInvalidate?.()
            this.closed.next()
            this.closed.complete()
        })
    }

    isDirectoryUnavailable (error: unknown): boolean {
        return isSFTPDirectoryUnavailableError(error)
    }

    resolvePath (rawPath: string): Promise<string> {
        return resolvePosixPathWithReadlink(
            rawPath,
            target => this.sftp.readlink(target),
            target => inspectPosixEntryViaParentReaddir(
                target,
                dir => this.readdir(dir),
                p => this.stat(p),
            ),
        )
    }

    async readdir (p: string): Promise<SFTPFile[]> {
        this.logger.debug('readdir', p)
        try {
            const entries = await this.sftp.readDirectory(p)
            return entries.map(entry => {
                const fullPath = !p || p === '/'
                    ? `/${entry.name}`
                    : p.endsWith('/') ? `${p}${entry.name}` : `${p}/${entry.name}`
                return this._makeFile(fullPath, entry)
            })
        } catch (error) {
            if (isSFTPChannelClosedError(error)) {
                this.onInvalidate?.()
            }
            throw error
        }
    }

    readlink (p: string): Promise<string> {
        this.logger.debug('readlink', p)
        return this.sftp.readlink(p)
    }

    async stat (p: string): Promise<SFTPFile> {
        this.logger.debug('stat', p)
        const stats = await this.sftp.stat(p)
        return {
            name: posixPath.basename(p),
            fullPath: p,
            isDirectory: stats.type === russh.SFTPFileType.Directory,
            isSymlink: stats.type === russh.SFTPFileType.Symlink,
            mode: stats.permissions ?? 0,
            hasMode: stats.permissions != null,
            size: stats.size,
            modified: new Date((stats.mtime ?? 0) * 1000),
        }
    }

    async open (p: string, mode: number): Promise<SFTPFileHandle> {
        this.logger.debug('open', p, mode)
        const handle = await this.sftp.open(p, mode)
        return new SFTPFileHandle(handle)
    }

    async rmdir (p: string): Promise<void> {
        await this.sftp.removeDirectory(p)
    }

    async mkdir (p: string): Promise<void> {
        await this.sftp.createDirectory(p)
    }

    async rename (oldPath: string, newPath: string): Promise<void> {
        this.logger.debug('rename', oldPath, newPath)
        await this.sftp.rename(oldPath, newPath)
    }

    async unlink (p: string): Promise<void> {
        await this.sftp.removeFile(p)
    }

    async chmod (p: string, mode: string|number): Promise<void> {
        this.logger.debug('chmod', p, mode)
        await this.sftp.chmod(p, mode)
    }

    async upload (path: string, transfer: FileUpload): Promise<void> {
        this.logger.info('Uploading into', path)
        await runStagedSFTPUpload(path, transfer, {
            openTemp: tempPath => this.open(tempPath, russh.OPEN_WRITE | russh.OPEN_CREATE),
            unlink: targetPath => this.unlink(targetPath),
            rename: (oldPath, newPath) => this.rename(oldPath, newPath),
        })
    }

    async download (path: string, transfer: FileDownload): Promise<void> {
        this.logger.info('Downloading', path)
        let handle: SFTPFileHandle | null = null
        try {
            if (transfer.isCancelled()) {
                throw new Error('Download cancelled')
            }
            handle = await this.open(path, russh.OPEN_READ)
            while (!transfer.isCancelled()) {
                const chunk = await handle.read()
                if (transfer.isCancelled()) {
                    break
                }
                if (!chunk.length) {
                    await transfer.completeDownload()
                    return
                }
                await transfer.write(chunk)
            }
            throw new Error('Download cancelled')
        } catch (e) {
            transfer.setStatus(e instanceof Error ? e.message : String(e))
            transfer.cancel()
            throw e
        } finally {
            await handle?.close().catch(() => null)
        }
    }

    private _makeFile (p: string, entry: russh.SFTPDirectoryEntry): SFTPFile {
        return {
            fullPath: p,
            name: entry.name,
            isDirectory: entry.metadata.type === russh.SFTPFileType.Directory,
            isSymlink: entry.metadata.type === russh.SFTPFileType.Symlink,
            mode: entry.metadata.permissions ?? 0,
            hasMode: entry.metadata.permissions != null,
            size: entry.metadata.size,
            modified: new Date((entry.metadata.mtime ?? 0) * 1000),
        }
    }
}
