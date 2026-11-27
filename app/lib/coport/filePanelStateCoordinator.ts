import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
    executeFilePanelStateOp,
    type FilePanelStateOpResponse,
    FilePanelStateStore,
    parseFilePanelStateSnapshot,
} from '../../../tabby-ssh/src/utils/filePanelState'

export const FILE_PANEL_STATE_FILENAME = 'coport-file-panel-state.json'

export interface FilePanelStateFsOps {
    readFileSync: typeof readFileSync
    mkdirSync: typeof mkdirSync
    writeFileSync: typeof writeFileSync
    renameSync: typeof renameSync
    unlinkSync: typeof unlinkSync
}

export interface FilePanelStateBroadcastPayload {
    scope: string
    evictedScopes: string[]
}

export interface FilePanelStateCoordinatorOptions {
    filePath: string
    fsOps?: Partial<FilePanelStateFsOps>
    broadcast?: (payload: FilePanelStateBroadcastPayload) => void
    nowProvider?: () => number
}

export interface FilePanelStateCoordinator {
    readonly store: FilePanelStateStore
    handleOp: (request: unknown) => FilePanelStateOpResponse
}

export function createFilePanelStateCoordinator (
    options: FilePanelStateCoordinatorOptions,
): FilePanelStateCoordinator {
    const fsOps: FilePanelStateFsOps = {
        readFileSync,
        mkdirSync,
        writeFileSync,
        renameSync,
        unlinkSync,
        ...options.fsOps,
    }
    const store = new FilePanelStateStore(null, undefined, options.nowProvider)
    let writeCounter = 0

    try {
        const raw = fsOps.readFileSync(options.filePath, 'utf8')
        store.loadSnapshot(parseFilePanelStateSnapshot(raw))
    } catch {
        // Missing or unreadable state file starts cleanly with empty state.
    }

    const persistSnapshot = (): void => {
        const serialized = JSON.stringify(store.getSnapshot())
        const tempPath = `${options.filePath}.${process.pid}.${++writeCounter}.tmp`
        try {
            fsOps.mkdirSync(dirname(options.filePath), { recursive: true, mode: 0o700 })
            fsOps.writeFileSync(tempPath, serialized, { encoding: 'utf8', mode: 0o600 })
            fsOps.renameSync(tempPath, options.filePath)
        } catch {
            // Keep in-memory store intact on write failure without rolling back.
            try {
                fsOps.unlinkSync(tempPath)
            } catch {
                // Best-effort cleanup of temp file.
            }
        }
    }

    return {
        store,
        handleOp: (request: unknown): FilePanelStateOpResponse => {
            const response = executeFilePanelStateOp(store, request)
            if (response.ok && response.changedScope) {
                persistSnapshot()
                options.broadcast?.({
                    scope: response.changedScope,
                    evictedScopes: response.evictedScopes ?? [],
                })
            }
            return response
        },
    }
}
