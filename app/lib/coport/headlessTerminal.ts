import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { SerialHub } from './serialHub'
import { installTerminalReplies } from './terminalReplies'

const { History } = require('./history.js')

export class HeadlessTerminal {
    private terminal: Terminal
    private serializer = new SerializeAddon()
    readonly history: InstanceType<typeof History>

    constructor (onReply: (bytes: Buffer) => void, size = { cols: 80, rows: 24 }) {
        this.terminal = new Terminal({ ...size, scrollback: 10000, allowProposedApi: true })
        this.history = new History(this.terminal, 10000)
        this.terminal.loadAddon(this.serializer)
        installTerminalReplies(this.terminal, onReply)
        this.terminal.onData(data => onReply(Buffer.from(data)))
        this.terminal.onBinary(data => onReply(Buffer.from(data, 'latin1')))
    }

    async ingest (
        data: Buffer, evidence: ReturnType<SerialHub['observePromptOutput']>, onBoundary?: (offset: number) => void,
    ): Promise<boolean> {
        const split = onBoundary ? this.partialTailStart(data) : 0
        const write = async (start: number, end: number, token: symbol | undefined) => {
            if (split > 0 && start <= split && split < end) {
                if (start < split) {
                    await this.write(data.subarray(start, split), token)
                }
                if (this.atSnapshotBoundary()) {
                    onBoundary?.(split)
                }
                start = split
            }
            await this.write(data.subarray(start, end), token)
        }
        const token = evidence?.token
        let offset = evidence?.skip ?? data.length
        if (offset) {
            await write(0, offset, undefined)
        }
        offset += this.history.staleOSCPrefix(data, offset, data.length, token)
        const prefix = evidence?.skip ?? data.length
        if (offset > prefix) {
            await write(prefix, offset, undefined)
        }
        if (offset < data.length) {
            await write(offset, data.length, token)
        }
        return this.history.takeEmptyPrompt(token)
    }

    private partialTailStart (data: Buffer): number {
        // Keep complete reads atomic. For an unfinished ESC/CSI, the start
        // of its tail is a candidate; xterm confirms the prefix is complete.
        // The parser executes or ignores C0 (except CAN, SUB and ESC) and
        // DEL inside an escape sequence without completing that sequence.
        // eslint-disable-next-line no-control-regex
        const escape = /(?:(?:\x1b[\x00-\x17\x19\x1c-\x1f\x7f]*\[|\xc2\x9b)[\x00-\x17\x19\x1c-\x3f\x7f]*|\x1b[\x00-\x17\x19\x1c-\x2f\x7f]*)$/.exec(data.toString('latin1'))
        if (escape && escape.index + escape[0].length === data.length) {
            return escape.index
        }

        // A UTF-8 lead byte and up to two continuation bytes at the end
        // can be the prefix of the next code point.
        let start = data.length - 1
        while (start > 0 && data.length - start < 4 && (data[start] & 0xc0) === 0x80) {
            start--
        }
        const lead = data[start]
        const width = lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4
        return lead >= 0xc2 && lead <= 0xf4 && data.length - start < width ? start : 0
    }

    private write (data: Buffer, token: symbol | undefined): Promise<void> {
        this.history.outputToken = token
        return new Promise(resolve => this.terminal.write(data, resolve))
    }

    atSnapshotBoundary (): boolean {
        // The pinned xterm 5.5.0 serializer only captures terminal contents.
        // Like History, use the input handler to inspect state across writes.
        const { _parser, _utf8Decoder } = (this.terminal as unknown as {
            _core: { _inputHandler: { _parser: { currentState: number }, _utf8Decoder: { interim: Uint8Array } } }
        })._core._inputHandler
        return _parser.currentState === 0 /* GROUND */ && _utf8Decoder.interim[0] === 0
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
