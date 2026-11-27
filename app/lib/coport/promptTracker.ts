// Swift PromptTracker port. Emit events in stream order across serial reads.
type Event =
    | { type: 'bytes', data: Buffer }
    | { type: 'promptA' | 'promptB' }
    | { type: 'fullscreen', enabled: boolean }
    | { type: 'start', id: string }
    | { type: 'end', id: string, status: number }

export class PromptTracker {
    private escape: number[] = []
    private mode: 'plain' | 'escape' | 'osc' | 'csi' = 'plain'
    private kernel: number[] = []
    private kernelHeader = false

    feed (data: Buffer, emit: (event: Event) => void): void {
        let ordinary: number[] = []
        const flush = () => {
            this.parse(ordinary, emit)
            ordinary = []
        }
        for (const byte of data) {
            if (!this.kernel.length) {
                if (byte === 60 || byte === 91) {
                    flush()
                    this.kernel.push(byte)
                } else {
                    ordinary.push(byte)
                }
                continue
            }
            if (this.kernelHeader && byte === 27) {
                ordinary.push(...this.kernel, byte)
                this.kernel = []
                this.kernelHeader = false
                continue
            }
            this.kernel.push(byte)
            if (!this.kernelHeader) {
                const text = Buffer.from(this.kernel).toString()
                if (/^(?:<[0-7]>|\[ *[0-9]+\.[0-9]+\])$/.test(text)) {
                    this.kernelHeader = true
                } else if (this.kernel.length > 64 || !/^(?:<[0-7]?|\[ *[0-9]*(?:\.[0-9]*)?)$/.test(text)) {
                    ordinary.push(...this.kernel)
                    this.kernel = []
                }
            }
            if (this.kernelHeader && (byte === 10 || this.kernel.length > 16384)) {
                flush()
                emit({ type: 'bytes', data: Buffer.from(this.kernel) })
                this.kernel = []
                this.kernelHeader = false
            }
        }
        flush()
    }

    private parse (data: number[], emit: (event: Event) => void): void {
        let plain: number[] = []
        const flush = () => {
            if (plain.length) {
                emit({ type: 'bytes', data: Buffer.from(plain) })
                plain = []
            }
        }
        for (const byte of data) {
            if (this.mode === 'plain') {
                if (byte === 27) {
                    flush()
                    this.escape = [byte]
                    this.mode = 'escape'
                } else {
                    plain.push(byte)
                }
                continue
            }
            if (byte === 27 && this.mode !== 'osc') {
                plain.push(...this.escape)
                this.escape = [27]
                this.mode = 'escape'
                continue
            }
            if (this.mode === 'osc' && this.escape.at(-1) === 27 && byte !== 92) {
                this.escape.pop()
                plain.push(...this.escape)
                this.escape = [27]
                this.mode = 'escape'
            }
            this.escape.push(byte)
            if (this.mode === 'escape') {
                if (byte === 93 || byte === 91) {
                    this.mode = byte === 93 ? 'osc' : 'csi'
                    continue
                }
            } else if (this.mode === 'osc' && (byte === 7 ||
                (byte === 92 && this.escape.length > 2 && this.escape.at(-2) === 27))) {
                flush()
                this.osc(emit)
                this.finishEscape()
                continue
            } else if (this.mode === 'csi' && byte >= 64 && byte <= 126) {
                flush()
                const bytes = Buffer.from(this.escape)
                if (/^\x1b\[\?(?:1049|1047|47)[hl]$/.test(bytes.toString())) {
                    emit({ type: 'fullscreen', enabled: byte === 104 })
                }
                emit({ type: 'bytes', data: bytes })
                this.finishEscape()
                continue
            } else if (this.escape.length <= 16384) {
                continue
            }
            plain.push(...this.escape)
            this.finishEscape()
        }
        flush()
    }

    private finishEscape (): void {
        this.escape = []
        this.mode = 'plain'
    }

    private osc (emit: (event: Event) => void): void {
        const text = Buffer.from(this.escape.slice(2, this.escape.at(-1) === 7 ? -1 : -2)).toString()
        // Console records can interrupt the payload. Strip only for marker parsing.
        const noise = /(?:<[0-7]>|\[ *[0-9]+\.[0-9]+\])[^\r\n]*(?:\r\n|\n|\r)/g
        const cleaned = text.replace(noise, '')
        const fields = cleaned.split(';')
        let event: Event | undefined = undefined
        if (cleaned === '133;A' || cleaned === '133;B') {
            event = { type: cleaned === '133;A' ? 'promptA' : 'promptB' }
        } else if (fields.length === 3 && fields[0] === '6973' && fields[1] === 'S') {
            event = { type: 'start', id: fields[2] }
        } else if (fields.length === 4 && fields[0] === '6973' && fields[1] === 'E' &&
            /^[+-]?\d+$/.test(fields[3]) && Number(fields[3]) >= 0 && Number(fields[3]) <= 255) {
            event = { type: 'end', id: fields[2], status: Number(fields[3]) }
        }
        if (event) {
            for (const match of text.matchAll(noise)) {
                emit({ type: 'bytes', data: Buffer.from(match[0]) })
            }
            emit(event)
        } else {
            emit({ type: 'bytes', data: Buffer.from(this.escape) })
        }
    }
}
