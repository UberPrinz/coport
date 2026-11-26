import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { createConnection, createServer, Server as Listener, Socket } from 'node:net'
import { dirname } from 'node:path'
import { McpConnection, tools } from './mcpTools'
import type { AdbService } from './adbService'
import type { SessionManager } from './sessionManager'

// The SDK's Zod 4 declarations require TS 5. The Tabby build uses TS 4.
const { Server } = require('@modelcontextprotocol/sdk/server/index.js')
const { deserializeMessage, serializeMessage } = require('@modelcontextprotocol/sdk/shared/stdio.js')
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js')

interface WireMessage {
    jsonrpc?: '2.0'
    id?: string | number
    method?: string
    result?: unknown
    error?: unknown
}

function adapt (message: any): WireMessage {
    const params = message?.params
    if (params && typeof params === 'object' && !Array.isArray(params)) {
        if (message.method === 'initialize') {
            const info = params.clientInfo ?? {}
            params.clientInfo = { ...info, name: info.name ?? 'AI', version: info.version ?? '0' }
            // Coport uses no client capabilities. Keep the Swift shim contract
            // for clients advertising extensions the server does not understand.
            params.capabilities = {}
        } else if (message.method === 'tools/call' && 'arguments' in params) {
            const args = params.arguments
            if (!args || typeof args !== 'object' || Array.isArray(args)) {
                params.arguments = { __invalid_arguments: true }
            }
        }
    }
    return deserializeMessage(JSON.stringify(message))
}

const maxFrameBytes = 1024 * 1024

function socketFd (socket: Socket): number | undefined {
    return (socket as Socket & { _handle?: { fd: number } })._handle?.fd
}

class SocketTransport {
    onmessage?: (message: object) => void
    onclose?: () => void
    onerror?: (error: Error) => void
    private pending = Buffer.alloc(0)
    private batching = false
    private queued: Buffer[] = []
    private queuedBytes = 0
    private batchReply?: { id: string | number, resolve: (reply?: WireMessage) => void }
    private pauseMonitor?: ReturnType<typeof setInterval>

    constructor (private socket: Socket) {}

    async start (): Promise<void> {
        this.socket.on('data', data => this.read(data))
        this.socket.once('close', () => {
            this.batchReply?.resolve()
            clearInterval(this.pauseMonitor)
            this.queued = []
            this.queuedBytes = 0
            this.onclose?.()
        })
    }

    private read (chunk: Buffer): void {
        if (this.batching) {
            if (chunk.length) {
                this.queued.push(chunk)
                this.queuedBytes += chunk.length
                if (this.queuedBytes >= maxFrameBytes && !this.pauseMonitor) {
                    this.socket.pause()
                    this.pauseMonitor = setInterval(() => this.checkPausedPeer(), 20)
                }
            }
            return
        }
        let start = 0
        for (;;) {
            const end = chunk.indexOf(10, start)
            const slice = chunk.subarray(start, end === -1 ? undefined : end)
            if (this.pending.length + slice.length > maxFrameBytes) {
                this.socket.destroy()
                return
            }
            const frame = this.pending.length ? Buffer.concat([this.pending, slice]) : slice
            if (end === -1) {
                this.pending = frame
                return
            }
            this.pending = Buffer.alloc(0)
            start = end + 1
            if (frame.length && this.readFrame(frame)) {
                this.read(chunk.subarray(start))
                return
            }
        }
    }

    private readFrame (frame: Buffer): boolean {
        let message: any = undefined
        try {
            message = JSON.parse(frame.toString())
            if (Array.isArray(message)) {
                if (!message.length) {
                    this.protocolError(-32600, 'Invalid Request', 'Batch array must not be empty')
                    return false
                }
                const batch = message.map(adapt)
                if (batch.some(item => item.method === undefined)) {
                    throw new Error('Expected only requests and notifications in an MCP batch')
                }
                void this.runBatch(batch).catch(error => this.onerror?.(error))
                return true
            }
            this.onmessage?.(adapt(message))
        } catch {
            this.protocolError(-32700, 'Parse error: Invalid JSON', 'Invalid message format', message?.id)
        }
        return false
    }

    private protocolError (code: number, kind: string, detail: string, requestId?: unknown): void {
        const id = typeof requestId === 'string' || Number.isInteger(requestId) ? requestId as string | number : randomUUID().toUpperCase()
        const error = { code, message: `${kind}: ${detail}`, data: { detail } }
        void this.writeFrame({ jsonrpc: '2.0', id, error }).catch(reason => this.onerror?.(reason))
    }

    private checkPausedPeer (): boolean {
        if (this.pauseMonitor) {
            const fd = socketFd(this.socket)
            const { peerEnded } = require('./coport-queued-read.node')
            if (fd === undefined || peerEnded(fd)) {
                this.socket.destroy()
                return false
            }
        }
        return !this.socket.destroyed
    }

    private async runBatch (messages: WireMessage[]): Promise<void> {
        // Swift finishes the whole batch before dispatching any later frame.
        // Monitor kernel EOF independently while stream backpressure pauses reads.
        this.batching = true
        try {
            await this.readBatch(messages)
        } finally {
            this.batching = false
            const queued = this.queued
            this.queued = []
            this.queuedBytes = 0
            for (const chunk of queued) {
                if (!this.checkPausedPeer()) {
                    break
                }
                this.read(chunk)
            }
            if (!this.socket.destroyed && this.queuedBytes < maxFrameBytes && this.pauseMonitor) {
                clearInterval(this.pauseMonitor)
                this.pauseMonitor = undefined
                this.socket.resume()
            }
        }
    }

    private async readBatch (messages: WireMessage[]): Promise<void> {
        const replies: WireMessage[] = []
        for (const message of messages) {
            const id = message.id
            if (id === undefined) {
                this.onmessage?.(message)
                continue
            }
            try {
                const reply = await new Promise<WireMessage | undefined>(resolve => {
                    this.batchReply = { id, resolve }
                    this.onmessage?.(message)
                })
                if (!reply || !this.checkPausedPeer()) {
                    return
                }
                replies.push(reply)
            } finally {
                this.batchReply = undefined
            }
        }
        if (replies.length) {
            await this.writeFrame(replies)
        }
    }

    async close (): Promise<void> {
        this.socket.destroy()
    }

    async send (message: WireMessage): Promise<void> {
        if (this.batchReply && this.batchReply.id === message.id && ('result' in message || 'error' in message)) {
            this.batchReply.resolve(message)
            return
        }
        await this.writeFrame(message)
    }

    private async writeFrame (message: WireMessage | WireMessage[]): Promise<void> {
        if (this.socket.destroyed) {
            return
        }
        await new Promise<void>((resolve, reject) => {
            this.socket.write(serializeMessage(message), error => error ? reject(error) : resolve())
        })
    }
}

function socketInfo (path: string) {
    return lstatSync(path, { throwIfNoEntry: false })
}

// Remove an owned stale socket only after connect confirms no listener.
async function clearStaleSocket (path: string, uid: number): Promise<void> {
    const existing = socketInfo(path)
    if (!existing) {
        return
    }
    if (!existing.isSocket() || existing.uid !== uid) {
        throw new Error('EACCES: Coport MCP socket path is occupied')
    }
    await new Promise<void>((resolve, reject) => {
        const probe = createConnection(path)
        probe.once('connect', () => {
            probe.destroy()
            reject(new Error('EADDRINUSE: Coport MCP socket already has a listener'))
        })
        probe.once('error',  (error: Error & { code?: string }) => {
            if (['ECONNREFUSED', 'ENOENT'].includes(error.code ?? '')) {
                resolve()
            } else {
                reject(error)
            }
        })
    })
    const current = socketInfo(path)
    if (current?.dev === existing.dev && current.ino === existing.ino && current.isSocket()) {
        unlinkSync(path)
    }
}

export class McpHost {
    private listener?: Listener
    private sockets = new Set<Socket>()

    constructor (
        private sessions: SessionManager,
        private path: string,
        private peerUid: (fd: number) => number = fd => require('./coport-queued-read.node').peerUid(fd),
        private adb?: AdbService,
    ) {}

    async start (): Promise<void> {
        if (Buffer.byteLength(this.path) >= 104) {
            throw new Error('ENAMETOOLONG: Coport MCP socket path exceeds the Unix socket address size')
        }
        const uid = process.getuid!()
        const dir = dirname(this.path)
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        const info = lstatSync(dir)
        if (!info.isDirectory() || info.uid !== uid) {
            throw new Error('EACCES: Coport MCP directory must be owned by the current user')
        }
        if (info.mode & 0o077) {
            chmodSync(dir, 0o700)
        }
        await clearStaleSocket(this.path, uid)
        const listener = createServer(socket => {
            const fd = socketFd(socket)
            if (this.sockets.size >= 16 || fd === undefined || this.peerUid(fd) !== uid) {
                socket.destroy()
                return
            }
            this.accept(socket)
        })
        await new Promise<void>((resolve, reject) => {
            listener.once('error', reject)
            listener.listen(this.path, 16, () => {
                listener.removeListener('error', reject)
                resolve()
            })
        })
        this.listener = listener
        listener.on('error', error => console.error('coport: MCP listener failed', error))
        try {
            chmodSync(this.path, 0o600)
        } catch (error) {
            await this.stop()
            throw error
        }
    }

    private accept (socket: Socket): void {
        this.sockets.add(socket)
        const connection = new McpConnection(this.sessions, this.adb)
        const server = new Server({ name: 'Coport', version: '1.0.0' }, { capabilities: { tools: {} } })
        server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }))
        server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
            const structuredContent = await connection.call(params.name, params.arguments ?? {})
            return {
                content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
                structuredContent,
                isError: 'error' in structuredContent,
            }
        })
        socket.once('end', () => connection.close())
        socket.once('close', () => {
            connection.close()
            this.sockets.delete(socket)
        })
        socket.on('error', () => socket.destroy())
        void server.connect(new SocketTransport(socket)).catch(() => socket.destroy())
    }

    async stop (): Promise<void> {
        const listener = this.listener
        this.listener = undefined
        if (listener) {
            const closed = new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
            for (const socket of this.sockets) {
                socket.destroy()
            }
            await closed
        }
    }
}
