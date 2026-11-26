import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { SerialHub } from './serialHub'

const { History } = require('./history.js')

export class HeadlessTerminal {
    private terminal: Terminal
    private serializer = new SerializeAddon()
    readonly history: InstanceType<typeof History>

    constructor (onReply: (bytes: Buffer) => void, size = { cols: 80, rows: 24 }) {
        this.terminal = new Terminal({ ...size, scrollback: 10000, allowProposedApi: true })
        this.history = new History(this.terminal, 10000)
        this.terminal.loadAddon(this.serializer)
        this.terminal.onData(data => onReply(Buffer.from(data)))
        this.terminal.onBinary(data => onReply(Buffer.from(data, 'latin1')))
    }

    async ingest (data: Buffer, evidence: ReturnType<SerialHub['observePromptOutput']>): Promise<boolean> {
        const token = evidence?.token
        let offset = evidence?.skip ?? data.length
        if (offset) {
            await this.write(data.subarray(0, offset), undefined)
        }
        offset += this.history.staleOSCPrefix(data, offset, data.length, token)
        const prefix = evidence?.skip ?? data.length
        if (offset > prefix) {
            await this.write(data.subarray(prefix, offset), undefined)
        }
        if (offset < data.length) {
            await this.write(data.subarray(offset), token)
        }
        return this.history.takeEmptyPrompt(token)
    }

    private write (data: Buffer, token: symbol | undefined): Promise<void> {
        this.history.outputToken = token
        return new Promise(resolve => this.terminal.write(data, resolve))
    }

    snapshot (): string {
        const snapshot = this.serializer.serialize()
        const { cursorX } = this.terminal.buffer.active
        // Relative cursor moves in the serializer can start one column early
        // when its last written cell is in the rightmost column. Restore the
        // absolute column except when xterm is waiting to wrap the next cell.
        return cursorX < this.terminal.cols ? snapshot + `\x1b[${cursorX + 1}G` : snapshot
    }

    resize (cols: number, rows: number): void {
        this.terminal.resize(cols, rows)
    }

    close (): void {
        this.history.end()
        this.terminal.dispose()
    }
}
