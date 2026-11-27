import type { Observable } from 'rxjs'
import type { FileDownload, FileUpload } from 'tabby-core'
import type { SFTPFile } from '../session/sftp'

export interface FileBackend {
    atomicDownloads?: boolean
    closed$?: Observable<void>
    normalizePath?: (path: string) => string
    resolvePath?: (path: string) => Promise<string>
    isDirectoryUnavailable?: (error: unknown) => boolean
    readdir: (path: string) => Promise<SFTPFile[]>
    stat: (path: string) => Promise<SFTPFile>
    readlink: (path: string) => Promise<string>
    mkdir: (path: string) => Promise<void>
    rmdir: (path: string) => Promise<void>
    unlink: (path: string) => Promise<void>
    upload: (path: string, transfer: FileUpload) => Promise<void>
    download: (path: string, transfer: FileDownload) => Promise<void>
}
