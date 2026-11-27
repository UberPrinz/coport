import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { PromptTracker } from './promptTracker'
import { SerialFailure, SerialHub } from './serialHub'

export class ExecFailure extends Error {
    constructor (public readonly code: string, message: string, public readonly details?: object) {
        super(message)
    }
}

export function cleanOutput (data: Buffer): string {
    return data.toString().replace(/\r\n?/g, '\n')
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}

export class OutputWindow {
    private bytes: Buffer
    private total = 0

    constructor (private limit: number) {
        // Lazy allocation avoids charging a large silent command for unused output.
        this.bytes = Buffer.alloc(0)
    }

    append (data: Buffer): void {
        if (!this.bytes.length) {
            this.bytes = Buffer.allocUnsafe(this.limit)
        }
        const half = Math.floor(this.limit / 2)
        const head = Math.min(Math.max(0, half - this.total), data.length)
        data.copy(this.bytes, Math.min(this.total, half), 0, head)
        let offset = Math.max(head, data.length - (this.limit - half))
        while (offset < data.length) {
            const position = half + (this.total + offset - half) % (this.limit - half)
            const count = Math.min(data.length - offset, this.limit - position)
            data.copy(this.bytes, position, offset, offset + count)
            offset += count
        }
        this.total += data.length
    }

    text (): { output: string, output_truncated: boolean } {
        if (this.total <= this.limit) {
            return { output: cleanOutput(this.bytes.subarray(0, this.total)), output_truncated: false }
        }
        const half = Math.floor(this.limit / 2)
        const pivot = half + (this.total - half) % (this.limit - half)
        const tail = Buffer.concat([this.bytes.subarray(pivot), this.bytes.subarray(half, pivot)])
        return {
            output: cleanOutput(this.bytes.subarray(0, half)) +
                `\n…[coport: ${this.total - this.limit} bytes omitted]…\n` + cleanOutput(tail),
            output_truncated: true,
        }
    }
}

const injection = String.raw`__cp(){ printf '\033]6973;S;%s\007' "$1"; sh -c "$2" 2>&1; printf '\033]6973;E;%s;%s\007' "$1" "$?"; }; PS1="$(printf '\033]133;A\007')` +
    '${PS1:-# }' + String.raw`$(printf '\033]133;B\007')"; export -n PS1 2>/dev/null`

interface ExecutionResult {
    channel: 'serial'
    exit_code: number
    success: boolean
    output: string
    output_truncated: boolean
    duration_ms: number
}
interface Execution {
    id: string
    output: OutputWindow
    resolve: (result: ExecutionResult) => void
    reject: (error: ExecFailure) => void
    started: boolean
    timedOut: boolean
    observingRecovery: boolean
    recovered: boolean
    writtenAt?: number
    timer?: ReturnType<typeof setTimeout>
}
interface Preparation {
    resolve: (already: boolean) => void
    reject: (error: ExecFailure) => void
    timer?: ReturnType<typeof setTimeout>
}

function busy (reason: string): ExecFailure {
    return new ExecFailure('terminal_busy', `Terminal is busy: ${reason}`, { reason })
}
function lost (): ExecFailure {
    return new ExecFailure('channel_lost', 'Serial connection is unavailable')
}
function refused (error: SerialFailure): ExecFailure {
    if (error.code === 'busy') {
        return new ExecFailure('busy', 'Another input source has an unsubmitted line')
    }
    if (error.code === 'queue_full') {
        return new ExecFailure('queue_full', 'Shared serial queue is full')
    }
    return lost()
}

export class SerialExec {
    private tracker = new PromptTracker()
    private state: 'not_prepared' | 'idle' | 'running' | 'fullscreen' | 'executing' = 'not_prepared'
    private alternate = false
    private promptHumanSeq = 0
    private checking = false
    private preparing?: Preparation
    private active?: Execution
    private execSource = Symbol('exec')
    private prepareSource = Symbol('prepare')

    constructor (private hub: SerialHub, private prompt: () => Promise<{ text: string, current_line: string }>) {}

    private runningOperation (): boolean {
        return !!(this.active ?? this.preparing) || this.checking
    }

    private reason (): string | undefined {
        if (this.alternate) {
            return 'fullscreen'
        }
        if (this.runningOperation()) {
            return 'executing'
        }
        return this.state === 'idle' ? undefined : this.state
    }

    private available (closed: () => boolean): boolean {
        return this.hub.connected && !closed()
    }

    private async checkPrompt (closed: () => boolean) {
        if (!this.available(closed)) {
            throw lost()
        }
        this.checking = true
        try {
            const input = await this.prompt().catch(() => undefined)
            if (!input || !this.available(closed)) {
                throw lost()
            }
            return input
        } finally {
            this.checking = false
        }
    }

    async run (command: string, timeout: number, limit: number, closed: () => boolean): Promise<ExecutionResult> {
        if (!this.available(closed)) {
            throw lost()
        }
        const reason = this.reason()
        if (reason) {
            throw busy(reason)
        }
        const quoted = '\'' + command.replace(/'/g, '\'\\\'\'') + '\''
        if (Buffer.byteLength(quoted) > 900) {
            throw new ExecFailure('command_too_long', 'Escaped command exceeds 900 bytes')
        }
        const seq = this.hub.humanWriteSeq
        const input = await this.checkPrompt(closed)
        if (seq !== this.hub.humanWriteSeq) {
            throw busy('user_input_pending')
        }
        const current = this.reason()
        if (current) {
            throw busy(current)
        }
        if (input.text || (this.hub.humanInputPending && seq !== this.promptHumanSeq)) {
            throw busy('user_input_pending')
        }
        return new Promise((resolve, reject) => {
            const job: Execution = {
                id: randomBytes(4).toString('hex'), output: new OutputWindow(limit), resolve, reject,
                started: false, timedOut: false, observingRecovery: false, recovered: false,
            }
            try {
                this.hub.reserveInterrupt()
                this.hub.enqueue(Buffer.from(`__cp ${job.id} ${quoted}\r`), this.execSource, () => {
                    job.writtenAt = performance.now()
                    job.timer = setTimeout(() => this.interrupt(job), timeout)
                })
                this.active = job
                this.state = 'executing'
            } catch (error) {
                this.hub.releaseInterrupt()
                reject(refused(error))
            }
        })
    }

    private humanChanged (seq: number): boolean {
        return seq !== this.hub.humanWriteSeq || this.hub.humanInputPending
    }

    private prepareBusyReason (): 'fullscreen' | 'executing' | undefined {
        if (this.alternate) {
            return 'fullscreen'
        }
        return this.runningOperation() ? 'executing' : undefined
    }

    async prepare (closed: () => boolean): Promise<boolean> {
        if (!this.available(closed)) {
            throw lost()
        }
        const reason = this.prepareBusyReason()
        if (reason) {
            throw busy(reason)
        }
        if (this.hub.humanInputPending) {
            throw busy('user_input_pending')
        }
        if (this.state === 'idle') {
            return true
        }
        const seq = this.hub.humanWriteSeq
        const input = await this.checkPrompt(closed)
        if (this.humanChanged(seq)) {
            throw busy('user_input_pending')
        }
        const current = this.prepareBusyReason()
        if (current) {
            throw busy(current)
        }
        if (this.reason() === undefined) {
            return true
        }
        if (!/[#$] *$/.test(input.current_line)) {
            throw busy('not_at_prompt')
        }
        return new Promise((resolve, reject) => {
            const pending: Preparation = { resolve, reject }
            try {
                this.hub.enqueue(Buffer.from(injection + '\r'), this.prepareSource, () => {
                    pending.timer = setTimeout(() => {
                        if (this.preparing === pending) {
                            this.preparing = undefined
                            reject(new ExecFailure('prepare_failed', 'No prompt marker within 3 seconds'))
                        }
                    }, 3000)
                })
                this.preparing = pending
                this.state = 'running'
            } catch (error) {
                reject(refused(error))
            }
        })
    }

    enqueued (data: Buffer): void {
        if (data.includes(13) && this.state === 'idle') {
            this.state = 'running'
        }
    }

    receive (data: Buffer): void {
        this.tracker.feed(data, event => {
            const job = this.active
            switch (event.type) {
                case 'bytes':
                    if (job?.started) {
                        job.output.append(event.data)
                    }
                    break
                case 'fullscreen':
                    this.alternate = event.enabled
                    this.state = event.enabled ? 'fullscreen' : 'running'
                    break
                case 'promptA':
                    if (job?.timedOut) {
                        job.started = false
                    }
                    if (job?.observingRecovery) {
                        job.recovered = true
                    }
                    break
                case 'promptB':
                    this.promptHumanSeq = this.hub.humanWriteSeq
                    if (!this.alternate) {
                        this.state = 'idle'
                        this.finishPrepare()
                    }
                    if (job?.observingRecovery) {
                        job.recovered = true
                    }
                    break
                case 'start':
                    if (job?.id === event.id) {
                        job.started = true
                    }
                    break
                case 'end':
                    if (job?.id === event.id && job.started) {
                        job.started = false
                        if (!this.alternate) {
                            this.state = 'running'
                        }
                        if (!job.timedOut) {
                            this.finish(job)
                            job.resolve({
                                channel: 'serial', exit_code: event.status, success: event.status === 0,
                                ...job.output.text(),
                                duration_ms: Math.floor(performance.now() - (job.writtenAt ?? performance.now())),
                            })
                        }
                    }
                    break
            }
        })
    }

    private interrupt (job: Execution): void {
        job.timedOut = true
        if (!this.alternate) {
            this.state = 'running'
        }
        try {
            const pending = this.hub.enqueueUrgent(Buffer.from([3]), () => {
                clearTimeout(job.timer)
                job.observingRecovery = true
                job.timer = setTimeout(() => this.finishTimeout(job, 'ctrl_c_sent'), 2000)
            })
            if (pending) {
                job.timer = setTimeout(() => {
                    if (this.hub.cancelPendingInterrupt(pending)) {
                        this.finishTimeout(job, 'ctrl_c_not_sent')
                    }
                }, 2000)
            }
        } catch (error) {
            this.finish(job)
            job.reject(refused(error))
        }
    }

    private finishTimeout (job: Execution, interrupt: 'ctrl_c_sent' | 'ctrl_c_not_sent'): void {
        if (!job.recovered && !this.alternate && (interrupt === 'ctrl_c_sent' || this.state !== 'idle')) {
            this.state = 'running'
        }
        this.finish(job)
        job.reject(new ExecFailure('timeout', interrupt === 'ctrl_c_sent'
            ? 'Serial command timed out; Ctrl+C sent' : 'Serial command timed out; Ctrl+C could not be written', {
            channel: 'serial', partial_output: job.output.text().output, interrupt, shell_recovered: job.recovered,
        }))
    }

    private finish (job: Execution): void {
        clearTimeout(job.timer)
        this.active = undefined
        this.hub.releaseInterrupt()
    }

    private finishPrepare (error?: ExecFailure): void {
        const pending = this.preparing
        if (pending) {
            clearTimeout(pending.timer)
            this.preparing = undefined
            if (error) {
                pending.reject(error)
            } else {
                pending.resolve(false)
            }
        }
    }

    close (): void {
        if (this.active) {
            const job = this.active
            this.finish(job)
            job.reject(new ExecFailure('channel_lost', 'Serial connection lost', {
                channel: 'serial', partial_output: job.output.text().output,
            }))
        }
        this.finishPrepare(lost())
    }
}
