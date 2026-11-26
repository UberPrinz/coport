import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { EventEmitter } from 'node:events'
import { HeadlessTerminal } from './headlessTerminal'
import { openDevice, SerialDevice } from './serialDevice'
import { SerialFailure, SerialHub } from './serialHub'

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

export function darwinCalloutPath (resolved: string, exists = existsSync): string {
    if (resolved.startsWith('/dev/tty.')) {
        const callout = '/dev/cu.' + resolved.slice('/dev/tty.'.length)
        if (exists(callout)) {
            return callout
        }
    }
    return resolved
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
    private buffer = Buffer.allocUnsafe(16384)
    private parsing?: Promise<void>
    private ending?: Promise<void>
    private settingsUpdate?: Promise<void>
    private profileBaudOverride?: { id: string, original: number }
    private seq = 0
    // Preserve device chunks for profiles that apply legacy display transforms.
    // The headless parser stays authoritative for history and prompt evidence.
    private displayFrames: Buffer[] = []
    private displayBytes = 0
    private displayHead = 0

    constructor (
        public readonly config: SerialConfig, private device: SerialDevice, private onLoss: () => void,
        private terminalReplies: boolean, size?: TerminalSize,
    ) {
        super()
        this.hub = new SerialHub(device, () => this.watch())
        this.terminal = new HeadlessTerminal(data => {
            if (!this.terminalReplies) {
                return
            }
            try {
                this.hub.enqueue(data, 'terminal')
            } catch (error) {
                if (error.code !== 'queue_full' && error.code !== 'channel_lost') {
                    this.onLoss()
                }
            }
        }, size)
        device.onReady(() => this.read(), () => {
            try {
                this.hub.drainWrites()
            } catch {
                this.onLoss()
            }
        }, onLoss)
    }

    setTerminalReplies (enabled: boolean): void {
        this.terminalReplies = enabled
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
            this.parsing = this.terminal.ingest(bytes, evidence).then(empty => {
                if (!this.hub.connected) {
                    return
                }
                if (evidence && empty) {
                    this.hub.confirmEmptyPrompt(evidence.token)
                }
                this.hub.consumeBytesAheadOfInterrupt(count)
                this.rememberDisplayFrame(bytes)
                this.emit('output', { generation: this.generation, seq: ++this.seq, bytes })
            }).catch(() => this.onLoss()).finally(() => {
                this.parsing = undefined
                this.watch()
            })
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

    constructor (private open = openDevice, private openTimeout = 15000) {}

    async ensure (
        input: Partial<SerialConfig>, terminalReplies = true, profileId?: string, size?: TerminalSize,
    ): Promise<{ session: SerialSession, reused: boolean }> {
        const deadline = performance.now() + this.openTimeout
        if (this.stopping) {
            throw channelLost()
        }
        const config = serialConfig(input)
        let path: string | undefined = undefined
        let identity: bigint | undefined = undefined
        try {
            path = darwinCalloutPath(realpathSync(config.port))
            const stat = statSync(path, { bigint: true })
            if (!stat.isCharacterDevice()) {
                throw new Error('Not a character device')
            }
            identity = stat.rdev
        } catch (error) {
            throw new SerialFailure('invalid_argument', `Cannot use serial device ${config.port}: ${error.message}`)
        }
        let timer: ReturnType<typeof setTimeout> | undefined = undefined
        const remaining = deadline - performance.now()
        if (remaining <= 0) {
            throw timeoutError()
        }
        try {
            return await Promise.race([
                new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timeoutError()), Math.ceil(remaining)) }),
                this.ensureDevice(identity, path, config, deadline, terminalReplies, profileId, size),
            ])
        } finally {
            clearTimeout(timer)
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
            if (error.code === 'EBUSY' || /resource busy|cannot lock/i.test(error.message)) {
                throw new SerialFailure('port_busy', error.message)
            }
            throw error
        }
        let session: SerialSession | undefined = undefined
        try {
            this.checkDeadline(deadline)
            session = new SerialSession(config, device, () => {
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
