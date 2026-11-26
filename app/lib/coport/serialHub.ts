import type { SerialDevice } from './serialDevice'

export const SERIAL_BUDGET = 65536
export type WriteSource = 'human' | 'terminal' | symbol
type Submission = 'none' | 'awaitingPrompt' | 'ambiguous'
type Escape = 'none' | 'start' | 'ss3' | number[]

export class SerialFailure extends Error {
    constructor (public readonly code: string, message: string, public readonly active?: object) {
        super(message)
    }
}

interface Write {
    data: Buffer
    offset: number
    interrupt?: symbol
    done?: () => void
}

export class SerialHub {
    private writes: Write[] = []
    private outstanding = 0
    private interruptReserved = false
    private pendingInterrupt?: symbol
    private bytesAheadOfInterrupt?: number
    private inputOwner?: WriteSource
    private orphanedInput = false
    private inputStartedAtPrompt = false
    private promptReady = false
    private submission: Submission = 'none'
    private escape: Escape = 'none'
    private bracketedPaste = false
    private evidence?: { token: symbol, stale: number }
    private closed = false
    humanWriteSeq = 0

    constructor (private device: SerialDevice, private writable: () => void) {
        this.evidence = { token: Symbol(), stale: device.queuedReadBytes() }
    }

    get connected (): boolean { return !this.closed }
    get humanInputPending (): boolean { return this.inputOwner === 'human' }
    get wantsWrite (): boolean { return !!this.writes.length && !this.bytesAheadOfInterrupt }

    enqueue (data: Buffer, source: WriteSource, done?: () => void): number {
        this.reserve(data.length)
        try {
            if (this.closed) {
                throw new SerialFailure('channel_lost', 'Serial session ended')
            }
            if (!data.length) {
                return 0
            }
            this.arbitrate(data, source)
            if (source === 'human') {
                this.humanWriteSeq++
            }
            this.writes.push({ data, offset: 0, done })
            this.writable()
            return data.length
        } catch (error) {
            this.outstanding -= data.length
            throw error
        }
    }

    private reserve (size: number): void {
        if (size > SERIAL_BUDGET - this.outstanding) {
            throw new SerialFailure('queue_full', 'Serial write queue is full')
        }
        this.outstanding += size
    }

    reserveInterrupt (): void {
        if (!this.interruptReserved) {
            this.reserve(1)
            this.interruptReserved = true
        }
    }

    releaseInterrupt (): void {
        if (this.interruptReserved) {
            this.interruptReserved = false
            this.outstanding--
        }
    }

    enqueueUrgent (data: Buffer, done?: () => void): symbol | undefined {
        if (this.closed) {
            throw new SerialFailure('channel_lost', 'Serial session ended')
        }
        if (!data.length) {
            return undefined
        }
        if (this.pendingInterrupt) {
            throw this.busy()
        }
        const ctrlC = data.length === 1 && data[0] === 3
        if (this.interruptReserved && ctrlC) {
            this.interruptReserved = false
        } else {
            this.reserve(data.length)
        }

        const id = this.pendingInterrupt = Symbol()
        if (!this.orphanedInput) {
            this.invalidatePrompt()
        }
        this.writes.push({
            data, offset: 0, interrupt: id,
            done: () => {
                this.pendingInterrupt = undefined
                this.bytesAheadOfInterrupt = undefined
                if (ctrlC) {
                    this.arbitrate(data, Symbol('exec'))
                }
                done?.()
            },
        })
        this.writable()
        return id
    }

    cancelPendingInterrupt (id: symbol): boolean {
        const index = this.writes.findIndex(write => write.interrupt === id && write.offset === 0)
        if (this.pendingInterrupt !== id || index === -1) {
            return false
        }
        const [write] = this.writes.splice(index, 1)
        this.pendingInterrupt = undefined
        this.bytesAheadOfInterrupt = undefined
        this.outstanding -= write.data.length
        this.fencePromptEvidence()
        this.writable()
        return true
    }

    clientDisconnected (source: symbol): void {
        if (this.inputOwner === source) {
            this.orphanedInput = true
            this.fencePromptEvidence()
        }
    }

    private invalidatePrompt (): void {
        this.promptReady = false
        this.evidence = undefined
    }

    private fencePromptEvidence (): void {
        if (!this.closed && this.submission !== 'ambiguous' && !this.evidence && !this.writes.length &&
            (!this.inputOwner || (this.orphanedInput && this.inputStartedAtPrompt))) {
            this.evidence = { token: Symbol(), stale: this.device.queuedReadBytes() }
        }
    }

    observePromptOutput (byteCount: number): { token: symbol, skip: number } | undefined {
        this.promptReady = false
        if (this.evidence) {
            const { token, stale } = this.evidence
            this.evidence.stale = Math.max(0, stale - byteCount)
            if (stale < byteCount) {
                return { token, skip: stale }
            }
        }
        return undefined
    }

    confirmEmptyPrompt (token: symbol): void {
        if (this.closed || this.evidence?.token !== token || this.device.queuedReadBytes() !== 0) {
            return
        }
        if (this.orphanedInput) {
            this.clearInputOwner()
            this.evidence = { token: Symbol(), stale: 0 }
        }
        this.submission = 'none'
        this.promptReady = !this.pendingInterrupt
    }

    consumeBytesAheadOfInterrupt (count: number): void {
        if (this.bytesAheadOfInterrupt) {
            this.bytesAheadOfInterrupt = Math.max(0, this.bytesAheadOfInterrupt - count)
            if (this.bytesAheadOfInterrupt === 0) {
                this.writable()
            }
        }
    }

    private clearInputOwner (): void {
        this.inputOwner = undefined
        this.orphanedInput = false
        this.inputStartedAtPrompt = false
        this.escape = 'none'
        this.bracketedPaste = false
    }

    private busy (): SerialFailure {
        return new SerialFailure('busy', 'Another input source owns the serial line')
    }

    private arbitrate (data: Buffer, source: WriteSource): void {
        if (source === 'terminal') {
            return
        }
        if (this.pendingInterrupt) {
            throw this.busy()
        }
        if (data.length === 1 && data[0] === 3) {
            this.clearInputOwner()
            if (this.submission === 'awaitingPrompt') {
                this.submission = 'ambiguous'
            }
            this.invalidatePrompt()
            return
        }
        if (this.orphanedInput || (this.inputOwner && this.inputOwner !== source)) {
            throw this.busy()
        }
        for (const byte of data) {
            if (!this.inputOwner) {
                this.inputStartedAtPrompt = this.promptReady && this.device.queuedReadBytes() === 0
                this.invalidatePrompt()
            }
            this.inputOwner = source
            // Raw controls can submit input through shell bindings such as Ctrl-O.
            if ((byte < 32 && byte !== 10 && byte !== 13) || byte === 127) {
                this.inputStartedAtPrompt = false
                this.submission = 'ambiguous'
            }
            switch (this.escape) {
                case 'none':
                    if (byte === 27) {
                        this.escape = 'start'
                    } else if (!this.bracketedPaste && (byte === 10 || byte === 13)) {
                        this.submission = this.inputStartedAtPrompt ? 'awaitingPrompt' : 'ambiguous'
                        this.clearInputOwner()
                    }
                    break
                case 'start':
                    this.escape = byte === 91 ? [] : byte === 79 ? 'ss3' : 'none'
                    break
                case 'ss3':
                    this.escape = 'none'
                    break
                default:
                    if (byte >= 0x40 && byte <= 0x7e) {
                        if (byte === 126 && this.escape.length === 3 && this.escape[0] === 50 && this.escape[1] === 48) {
                            if (this.escape[2] === 48) {
                                this.bracketedPaste = true
                            } else if (this.escape[2] === 49) {
                                this.bracketedPaste = false
                            }
                        }
                        this.escape = 'none'
                    } else if (byte === 27) {
                        this.escape = 'start'
                    } else if (this.escape.length < 4) {
                        this.escape.push(byte)
                    }
                    break
            }
        }
    }

    drainWrites (): void {
        let budget = SERIAL_BUDGET
        while (this.writes.length && budget > 0) {
            const write = this.writes[0]
            if (this.pendingInterrupt && write.interrupt === this.pendingInterrupt) {
                this.bytesAheadOfInterrupt ??= this.device.queuedReadBytes()
                if (this.bytesAheadOfInterrupt > 0) {
                    break
                }
            }
            const count = this.device.write(write.data, write.offset)
            if (count <= 0) {
                break
            }
            write.offset += count
            this.outstanding -= count
            budget -= count
            if (write.offset === write.data.length) {
                this.writes.shift()
                write.done?.()
            }
        }
        this.fencePromptEvidence()
        this.writable()
    }

    close (): void {
        this.closed = true
        this.writes.length = 0
        this.outstanding = 0
        this.pendingInterrupt = undefined
        this.interruptReserved = false
        this.bytesAheadOfInterrupt = undefined
        this.clearInputOwner()
        this.invalidatePrompt()
    }
}
