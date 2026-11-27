import { randomUUID } from 'node:crypto'
import type { FileUpload } from 'tabby-core'
import type { SFTPFileHandle } from './sftp'

// Some SFTP callers provide only the original transfer methods.
interface UploadTransfer extends Pick<FileUpload, 'isCancelled' | 'read' | 'close' | 'cancel' | 'setStatus'> {
    setPendingCommit?: FileUpload['setPendingCommit']
    setCommitting?: FileUpload['setCommitting']
    consumeCancelRequestedDuringCommit?: FileUpload['consumeCancelRequestedDuringCommit']
    markCommitted?: FileUpload['markCommitted']
    setCompleted?: FileUpload['setCompleted']
}

export async function runStagedSFTPUpload (
    path: string,
    transfer: UploadTransfer,
    ops: {
        openTemp: (tempPath: string) => Promise<Pick<SFTPFileHandle, 'write' | 'close'>>
        unlink: (filePath: string) => Promise<void>
        rename: (oldPath: string, newPath: string) => Promise<void>
    },
): Promise<void> {
    // Use a separate sibling for each upload, including concurrent uploads to the same target.
    const parent = path.slice(0, path.lastIndexOf('/') + 1)
    const tempPath = `${parent}.${randomUUID()}.tabby-upload`
    let handle: Awaited<ReturnType<typeof ops.openTemp>> | undefined = undefined
    let tempCreated = false
    transfer.setPendingCommit?.(true)
    try {
        if (transfer.isCancelled()) {
            throw new Error('Upload cancelled')
        }
        handle = await ops.openTemp(tempPath)
        tempCreated = true
        while (!transfer.isCancelled()) {
            const chunk = await transfer.read()
            if (transfer.isCancelled()) {
                break
            }
            if (chunk.length) {
                await handle.write(chunk)
                continue
            }

            // Closing the handle can block on the server. Cancellation still wins here.
            await handle.close()
            handle = undefined
            if (transfer.isCancelled()) {
                throw new Error('Upload cancelled')
            }

            transfer.setCommitting?.(true)
            await ops.unlink(path).catch(() => null)
            await ops.rename(tempPath, path)
            tempCreated = false
            transfer.markCommitted?.()
            transfer.setCompleted?.(true)
            transfer.close()
            return
        }
        throw new Error('Upload cancelled')
    } catch (error) {
        transfer.setCommitting?.(false)
        const cancelRequested = transfer.consumeCancelRequestedDuringCommit?.()
        transfer.setStatus(cancelRequested ? 'Upload cancelled' : error instanceof Error ? error.message : String(error))
        transfer.cancel()
        await handle?.close().catch(() => null)
        if (tempCreated) {
            await ops.unlink(tempPath).catch(() => null)
        }
        throw error
    } finally {
        transfer.setPendingCommit?.(false)
    }
}
