import { randomUUID } from 'node:crypto'
import { access, realpath, stat } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { EventEmitter } from 'node:events'
import { HeadlessTerminal } from './headlessTerminal'
import { openDevice, SerialDevice } from './serialDevice'
import { SERIAL_BUDGET, SerialFailure, SerialHub } from './serialHub'
import { SerialExec } from './serialExec'

export interface SerialConfig {
    port: string
    baudrate: number
    databits: 5 | 6 | 7 | 8
    stopbits: 1 | 1.5 | 2
    parity: 'none' | 'odd' | 'even' | 'mark' | 'space'
    rtscts: boolean
    xon: boolean
    xoff: boolean
    xany: boolean
}

export interface TerminalSize {
    cols: number
    rows: number
}

type EndReason = 'disconnected' | 'device_lost' | 'quit'

export function serialConfig (input: Partial<SerialConfig> | undefined): SerialConfig {
    const {
        port, baudrate, databits = 8, stopbits = 1, parity = 'none',
        rtscts = false, xon = false, xoff = false, xany = false,
    } = input ?? {}
    if (typeof port !== 'string' || !port || !Number.isInteger(baudrate) || baudrate! < 1 || baudrate! > 0xffffffff ||
        ![5, 6, 7, 8].includes(databits) || ![1, 1.5, 2].includes(stopbits) ||
        !['none', 'odd', 'even', 'mark', 'space'].includes(parity) ||
        ![rtscts, xon, xoff, xany].every(value => typeof value === 'boolean')) {
        throw new SerialFailure('invalid_argument', 'Invalid serial port or parameters')
    }
    return { port, baudrate: baudrate!, databits, stopbits, parity, rtscts, xon, xoff, xany }
}

export async function darwinCalloutPath (
    resolved: string, exists: (path: string) => boolean | Promise<boolean> = path => access(path).then(() => true, () => false),
): Promise<string> {
    if (resolved.startsWith('/dev/tty.')) {
        const callout = '/dev/cu.' + resolved.slice('/dev/tty.'.length)
        if (await exists(callout)) {
            return callout
        }
    }
    return resolved
}

async function identifyDevice (port: string): Promise<{ path: string, identity: bigint }> {
    const path = await darwinCalloutPath(await realpath(port))
    const info = await stat(path, { bigint: true })
    if (!info.isCharacterDevice()) {
        throw new Error('Not a character device')
    }
    return { path, identity: info.rdev }
}

function timeoutError (): SerialFailure {
    return new SerialFailure('timeout', 'Serial open exceeded its deadline')
}

function channelLost (): SerialFailure {
    return new SerialFailure('channel_lost', 'Serial session ended')
}

export class SerialSession extends EventEmitter {
    readonly generation = randomUUID()
    readonly hub: SerialHub
    readonly terminal: HeadlessTerminal
    readonly exec: SerialExec
    private buffer = Buffer.allocUnsafe(16384)
    private parsing?: Promise<void>
    private ending?: Promise<void>
    private settingsUpdate?: Promise<void>
    private profileBaudOverride?: { id: string, original: number }
    private seq = 0
    private replies: Buffer[] = []
    private replyBytes = 0
    private replyTimer?: ReturnType<typeof setTimeout>
    // Preserve device chunks for profiles that apply legacy display transforms.
    // The headless parser stays authoritative for history and prompt evidence.
    private displayFrames: Buffer[] = []
    private displayBytes = 0
    private displayHead = 0

    constructor (
        public readonly config: SerialConfig, public readonly path: string,
        private device: SerialDevice, private onLoss: () => void,
        private terminalReplies: boolean, size?: TerminalSize,
    ) {
        super()
        this.hub = new SerialHub(device, () => this.watch())
        this.terminal = new HeadlessTerminal(data => this.queueReply(data), size)
        this.exec = new SerialExec(this.hub, () => this.afterOutput(() => this.terminal.history.prompt()))
        this.hub.onEnqueued = data => this.exec.enqueued(data)
        device.onReady(() => this.read(), () => {
            try {
                this.hub.drainWrites()
                this.flushReplies()
            } catch {
                this.onLoss()
            }
        }, onLoss)
    }

    setTerminalReplies (enabled: boolean): void {
        this.terminalReplies = enabled
        if (!enabled) {
            this.clearReplies()
        }
    }

    private tryReply (data: Buffer): boolean {
        try {
            this.hub.enqueue(data, 'terminal')
            return true
        } catch (error) {
            if (error.code === 'queue_full') {
                return false
            }
            if (error.code !== 'channel_lost') {
                this.onLoss()
            }
            return true
        }
    }

    private queueReply (data: Buffer): void {
        if (!this.terminalReplies || !this.hub.connected) {
            return
        }
        if (!this.replies.length && this.tryReply(data)) {
            return
        }
        // The old renderer retried queue_full because the serial hub had
        // accepted zero bytes. Keep the same bound and retry window here.
        if (data.length > SERIAL_BUDGET - this.replyBytes) {
            this.onLoss()
            return
        }
        this.replyTimer ??= setTimeout(() => this.onLoss(), 3500)
        this.replyBytes += data.length
        this.replies.push(data)
    }

    private flushReplies (): void {
        let accepted = 0
        for (const data of this.replies) {
            if (!this.tryReply(data) || !this.hub.connected) {
                break
            }
            this.replyBytes -= data.length
            accepted++
        }
        this.replies.splice(0, accepted)
        if (!this.replies.length) {
            this.clearReplies()
        }
    }

    private clearReplies (): void {
        clearTimeout(this.replyTimer)
        this.replyTimer = undefined
        this.replies.length = 0
        this.replyBytes = 0
    }

    start (): void {
        this.watch()
    }

    private watch (): void {
        if (!this.ending && this.hub.connected) {
            this.device.watch(!this.parsing, this.hub.wantsWrite)
        }
    }

    private read (): void {
        if (this.parsing ?? this.ending) {
            return
        }
        try {
            const count = this.device.read(this.buffer)
            if (count === 0) {
                this.onLoss()
                return
            }
            if (count < 0) {
                this.watch()
                return
            }
            const bytes = Buffer.from(this.buffer.subarray(0, count))
            const evidence = this.hub.observePromptOutput(count)
            let snapshotOffset = 0
            const boundary = this.listenerCount('snapshot-boundary') ? (offset: number) => {
                if (offset < count && this.listenerCount('snapshot-boundary')) {
                    snapshotOffset = offset
                    // The prefix belongs to the snapshot. Give the suffix its
                    // own sequence number and deliver it in the usual output path.
                    this.seq++
                    this.emit('snapshot-boundary')
                }
            } : undefined
            this.parsing = this.terminal.ingest(bytes, evidence, boundary).then(empty => {
                if (!this.hub.connected) {
                    return
                }
                if (evidence && empty) {
                    this.hub.confirmEmptyPrompt(evidence.token)
                }
                this.hub.consumeBytesAheadOfInterrupt(count)
                this.rememberDisplayFrame(bytes)
                this.emit('output', { generation: this.generation, seq: ++this.seq, bytes: bytes.subarray(snapshotOffset) })
            }).catch(() => this.onLoss()).finally(() => {
                this.parsing = undefined
                this.watch()
            })
            this.exec.receive(bytes)
            this.watch()
        } catch {
            this.onLoss()
        }
    }

    private rememberDisplayFrame (bytes: Buffer): void {
        this.displayFrames.push(bytes)
        this.displayBytes += bytes.length
        while (this.displayBytes > 4 * 1024 * 1024 || this.displayFrames.length - this.displayHead > 10000) {
            this.displayBytes -= this.displayFrames[this.displayHead++].length
        }
        if (this.displayHead * 2 >= this.displayFrames.length) {
            this.displayFrames = this.displayFrames.slice(this.displayHead)
            this.displayHead = 0
        }
    }

    async afterOutput<T> (apply: () => T): Promise<T> {
        await this.parsing
        if (!this.hub.connected) {
            throw channelLost()
        }
        return apply()
    }

    afterSnapshotBoundary<T> (apply: () => T, signal: AbortSignal): Promise<T> {
        return new Promise((resolve, reject) => {
            let cleanup: (() => void) | undefined = undefined
            const cancel = () => {
                cleanup?.()
                reject(new SerialFailure('channel_lost', 'Serial view was detached'))
            }
            const attempt = () => {
                try {
                    if (this.terminal.atSnapshotBoundary()) {
                        cleanup?.()
                        resolve(apply())
                    }
                } catch (error) {
                    cleanup?.()
                    reject(error)
                }
            }
            const timer = setTimeout(() => {
                cleanup?.()
                reject(new SerialFailure('timeout', 'Timed out waiting for a complete terminal sequence'))
            }, 2000)
            cleanup = () => {
                clearTimeout(timer)
                this.off('output', attempt)
                this.off('snapshot-boundary', attempt)
                signal.removeEventListener('abort', cancel)
            }

            if (signal.aborted || !this.hub.connected) {
                cancel()
                return
            }
            signal.addEventListener('abort', cancel, { once: true })
            // Output fires only once the parsed bytes have a sequence number.
            // Leave the reader running so the next frame can finish the sequence.
            this.on('output', attempt)
            this.on('snapshot-boundary', attempt)
            if (!this.parsing) {
                attempt()
            }
        })
    }

    snapshot (legacyDisplay = false): { snapshot: string, seq: number, displayFrames?: Buffer[] } {
        if (legacyDisplay) {
            return { snapshot: '', seq: this.seq, displayFrames: this.displayFrames.slice(this.displayHead) }
        }
        return { snapshot: this.terminal.snapshot(), seq: this.seq }
    }

    async waitForSettings (): Promise<void> {
        await this.settingsUpdate?.catch(() => undefined)
    }

    effectiveBaudRate (requested: number, profileId?: string): number {
        const override = this.profileBaudOverride
        return override && override.id === profileId && override.original === requested ? this.config.baudrate : requested
    }

    async changeBaudRate (baudrate: number, profileId?: string): Promise<void> {
        const next = serialConfig({ ...this.config, baudrate })
        const previous = this.settingsUpdate
        const update = (async () => {
            await previous?.catch(() => undefined)
            if (!this.hub.connected) {
                throw channelLost()
            }
            try {
                await this.device.setBaudRate(next.baudrate)
            } catch (error) {
                throw new SerialFailure('invalid_argument', error.message)
            }
            if (profileId && this.profileBaudOverride?.id !== profileId) {
                this.profileBaudOverride = { id: profileId, original: this.config.baudrate }
            } else if (!profileId) {
                this.profileBaudOverride = undefined
            }
            this.config.baudrate = next.baudrate
        })()
        this.settingsUpdate = update
        try {
            await update
        } finally {
            if (this.settingsUpdate === update) {
                this.settingsUpdate = undefined
            }
        }
    }

    close (reason: EndReason): Promise<void> {
        if (!this.ending) {
            this.clearReplies()
            this.exec.close()
            this.hub.close()
            this.displayFrames.length = 0
            this.ending = this.waitForSettings().then(() => this.device.close()).finally(async () => {
                await this.parsing
                this.terminal.close()
            })
            this.emit('ended', { generation: this.generation, reason })
        }
        return this.ending
    }
}

export class SessionManager {
    private sessions = new Map<bigint, SerialSession>()
    private opening = new Map<bigint, Promise<SerialSession>>()
    private closing = new Map<bigint, Promise<void>>()
    private stopping = false
    private resolutionOrder = Promise.resolve()

    constructor (
        private open = openDevice, private openTimeout = 15000, private identify = identifyDevice,
    ) {}

    async ensure (
        input: Partial<SerialConfig>, terminalReplies = true, profileId?: string, size?: TerminalSize,
    ): Promise<{ session: SerialSession, reused: boolean }> {
        const deadline = performance.now() + this.openTimeout
        if (this.stopping) {
            throw channelLost()
        }
        const config = serialConfig(input)
        // Resolve paths in parallel, but admit them to the device queue in request order.
        const previous = this.resolutionOrder
        const slot: { release?: () => void } = {}
        const turn = new Promise<void>(resolve => { slot.release = resolve })
        this.resolutionOrder = previous.then(() => turn)
        const request = async () => {
            const resolution = this.identify(config.port).catch(error => {
                this.checkDeadline(deadline)
                throw new SerialFailure('invalid_argument', `Cannot use serial device ${config.port}: ${error.message}`)
            })
            const [{ path, identity }] = await Promise.all([resolution, previous])
            this.checkDeadline(deadline)
            const session = this.ensureDevice(identity, path, config, deadline, terminalReplies, profileId, size)
            slot.release?.()
            return session
        }
        let timer: ReturnType<typeof setTimeout> | undefined = undefined
        try {
            return await Promise.race([
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(timeoutError()), Math.max(0, Math.ceil(deadline - performance.now())))
                }),
                request(),
            ])
        } finally {
            clearTimeout(timer)
            slot.release?.()
        }
    }

    private async ensureDevice (
        identity: bigint, path: string, config: SerialConfig, deadline: number, terminalReplies: boolean,
        profileId?: string, size?: TerminalSize,
    ) {
        await this.closing.get(identity)
        this.checkDeadline(deadline)
        const existing = this.sessions.get(identity) ?? this.opening.get(identity)
        if (existing) {
            const session = await existing
            await session.waitForSettings()
            this.checkDeadline(deadline)
            const { port, ...active } = session.config
            const { port: requestedPort, ...requested } = config
            requested.baudrate = session.effectiveBaudRate(requested.baudrate, profileId)
            if (JSON.stringify(active) !== JSON.stringify(requested)) {
                throw new SerialFailure('config_conflict', `Active serial configuration on ${port} conflicts with ${requestedPort}`, session.config)
            }
            if (!session.hub.connected) {
                throw channelLost()
            }
            return { session, reused: true }
        }
        if (new Set([...this.sessions.keys(), ...this.opening.keys()]).size >= 16) {
            throw new SerialFailure('queue_full', 'Shared serial queue is full')
        }
        const opening = this.openSession(identity, path, config, deadline, terminalReplies, size)
        this.opening.set(identity, opening)
        try {
            return { session: await opening, reused: false }
        } finally {
            this.opening.delete(identity)
        }
    }

    private checkDeadline (deadline: number): void {
        if (performance.now() >= deadline) {
            throw timeoutError()
        }
        if (this.stopping) {
            throw channelLost()
        }
    }

    private async openSession (
        identity: bigint, path: string, config: SerialConfig, deadline: number, terminalReplies: boolean, size?: TerminalSize,
    ): Promise<SerialSession> {
        let device: SerialDevice | undefined = undefined
        try {
            device = await this.open(path, identity, config)
        } catch (error) {
            this.checkDeadline(deadline)
            // The native binding includes strerror in the message but omits errno.
            if (['EBUSY', 'EACCES', 'EWOULDBLOCK'].includes(error.code) ||
                /^Error .+ Cannot lock port$|^Error: (Resource busy|Permission denied|Resource temporarily unavailable), cannot open /.test(error.message)) {
                throw new SerialFailure('port_busy', error.message)
            }
            if (error.code === 'ENOENT' || error.message?.startsWith('Error: No such file or directory, cannot open ')) {
                throw new SerialFailure('invalid_argument', error.message)
            }
            throw error
        }
        let session: SerialSession | undefined = undefined
        try {
            this.checkDeadline(deadline)
            session = new SerialSession(config, path, device, () => {
                void this.end(identity, 'device_lost').catch(console.error)
            }, terminalReplies, size)
            this.checkDeadline(deadline)
            this.sessions.set(identity, session)
            session.start()
            return session
        } catch (error) {
            this.sessions.delete(identity)
            await (session ? session.close('device_lost') : device.close())
            throw error
        }
    }

    get (generation: string): SerialSession {
        for (const session of this.sessions.values()) {
            if (session.generation === generation && session.hub.connected) {
                return session
            }
        }
        throw channelLost()
    }

    async disconnect (generation: string): Promise<void> {
        for (const [identity, session] of this.sessions) {
            if (session.generation === generation) {
                return this.end(identity, 'disconnected')
            }
        }
        throw channelLost()
    }

    private async end (identity: bigint, reason: EndReason): Promise<void> {
        const current = this.sessions.get(identity)
        if (!current) {
            return
        }
        this.sessions.delete(identity)
        const closing = current.close(reason)
        this.closing.set(identity, closing)
        try {
            await closing
        } finally {
            this.closing.delete(identity)
        }
    }

    clientDisconnected (source: symbol): void {
        for (const [identity, session] of this.sessions) {
            try {
                session.hub.clientDisconnected(source)
            } catch {
                void this.end(identity, 'device_lost').catch(console.error)
            }
        }
    }

    async shutdown (): Promise<void> {
        this.stopping = true
        await Promise.allSettled([
            ...Array.from(this.sessions.keys(), identity => this.end(identity, 'quit')),
            ...this.closing.values(),
            // Pending opens own no published generation. A late result closes
            // through checkDeadline, and shutdown never waits for a stuck open.
        ])
    }
}
