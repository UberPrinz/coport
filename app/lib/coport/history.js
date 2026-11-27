'use strict'

const perLine = 16384
const total = 4 * 1024 * 1024
const pageBudget = 384 * 1024 // MCP includes the result both as structured JSON and text.

class History {
    constructor(term, count) {
        this.term = term
        this.count = count
        this.lines = []
        this.next = 0
        this.head = 0
        this.bytes = 0
        this.waiters = new Set()
        // xterm fires onLineFeed after moving/scrolling the cursor. At the
        // bottom outside DECSTBM it does not move, and a scroll may evict cells.
        const input = term._core._inputHandler
        const lineFeed = input.lineFeed.bind(input)
        input.lineFeed = () => {
            const buffer = term.buffer.active
            if (buffer.type !== 'alternate') this.commit(this.lineAt(buffer, buffer.baseY + buffer.cursorY))
            return lineFeed()
        }
        // An OSC can span several writes. Capture the token where the parser
        // starts it, so an old partial marker cannot be completed as new.
        const osc = input._parser._oscParser
        const start = osc.start.bind(osc)
        osc.start = () => {
            this.oscToken = this.outputToken
            start()
        }
        term.parser.registerOscHandler(6973, () => true)
        term.parser.registerOscHandler(133, data => {
            const token = this.oscToken === this.outputToken ? this.outputToken : null
            if (/^D(?:;[0-9]+)?$/.test(data)) {
                this.commandEndToken = term.buffer.active.type === 'normal' ? token : null
                this.promptStartToken = null
                this.promptEndToken = null
            }
            if (data === 'A' || data === 'B') {
                this.marker?.dispose()
                this.marker = data === 'B' ? term.registerMarker(0) : null
                this.column = term.buffer.active.cursorX
                if (data === 'A') {
                    // Readline can replay A/B from PS1 during a redraw while
                    // retaining the old edit buffer. Require a shell boundary.
                    this.promptStartToken = token === this.commandEndToken &&
                        term.buffer.active.type === 'normal' ? token : null
                    this.commandEndToken = null
                    this.promptEndToken = null
                } else {
                    this.promptEndToken = token && token === this.promptStartToken ? token : null
                    this.promptStartToken = null
                }
            }
            return true
        })
    }

    staleOSCPrefix(data, offset, limit, token) {
        if (!token || token === this.outputToken) return 0
        const input = this.term._core._inputHandler
        // A UTF-8 C1 OSC introducer can also start in the previous write.
        if (input._utf8Decoder.interim[0] === 0xc2 && data[offset] === 0x9d) return 1
        // In this xterm version state 1 is ESCAPE. If an earlier ESC is
        // stale, qualify only bytes after its controls and possible OSC ']'.
        if (input._parser.currentState !== 1) return 0
        let end = offset
        while (end < limit) {
            const byte = data[end]
            if (!(byte <= 0x17 || byte === 0x19 || (byte >= 0x1c && byte <= 0x1f) || byte === 0x7f)) break
            end++
        }
        if (end < limit && data[end] === 0x5d) end++
        return end - offset
    }

    lineAt(buffer, y) {
        let text = ''
        let truncated = false
        for (let i = y; i >= 0; i--) {
            const line = buffer.getLine(i)
            if (!line) break
            const next = buffer.getLine(i + 1)
            const end = line.getCell(line.length - 1)
            // Drop padding inserted to wrap a double-width glyph.
            const pad = next?.isWrapped && next.getCell(0)?.getWidth() === 2 &&
                end?.getCode() === 0 && end.getWidth() === 1 ? 1 : 0
            text = line.translateToString(i === y, 0, line.length - pad) + text
            if (Buffer.byteLength(text) > perLine) { truncated = true; break }
            if (!line.isWrapped) break
            if (i === 0) truncated = true
        }
        if (truncated) {
            const suffix = Buffer.from(text).subarray(-perLine + 16)
            text = '…[truncated] ' + suffix.toString('utf8').replace(/^\uFFFD/, '')
        }
        return text.trimEnd()
    }

    commit(text) {
        const line = { n: this.next++, text }
        const bytes = Buffer.byteLength(JSON.stringify(line)) + 1
        this.lines.push({ line, bytes })
        this.bytes += bytes
        while (this.lines.length - this.head > this.count || this.bytes > total) {
            this.bytes -= this.lines[this.head].bytes
            this.lines[this.head++] = null
        }
        if (this.head >= this.lines.length / 2) {
            this.lines = this.lines.slice(this.head)
            this.head = 0
        }
        this.wake()
    }

    wake() { for (const wake of this.waiters) wake() }

    end() { this.ended = true; this.wake() }

    async read({ after_line: after, max_lines: max, wait_ms: wait }) {
        const end = Date.now() + wait
        while (after !== null && after >= this.next - 1 && !this.ended && Date.now() < end) {
            await new Promise(resolve => {
                const wake = () => { this.waiters.delete(wake); clearTimeout(timer); resolve() }
                const timer = setTimeout(wake, end - Date.now())
                this.waiters.add(wake)
            })
        }
        const first = this.lines[this.head]?.line.n ?? this.next
        let budget = pageBudget
        const selected = []
        const index = after === null
            ? Math.max(this.head, this.lines.length - max)
            : this.head + Math.max(0, Math.min(this.lines.length - this.head, after + 1 - first))
        if (after === null) {
            for (let i = this.lines.length - 1; i >= index; i--) {
                const { line, bytes } = this.lines[i]
                if (bytes > budget) break
                budget -= bytes
                selected.push(line)
            }
            selected.reverse()
        } else {
            for (let i = index; i < this.lines.length && selected.length < max; i++) {
                const { line, bytes } = this.lines[i]
                if (bytes > budget) break
                budget -= bytes
                selected.push(line)
            }
        }
        const buffer = this.term.buffer.active
        const fullscreen = buffer.type === 'alternate'
        return {
            lines: selected, first_available_line: first, last_line: this.next - 1,
            next_after_line: selected.at(-1)?.n ?? after ?? this.next - 1,
            current_line: fullscreen ? '' : this.lineAt(buffer, buffer.baseY + buffer.cursorY),
            fullscreen, gap: after !== null && after < first - 1,
        }
    }

    async prompt() {
        const buffer = this.term.buffer.active
        const y = buffer.baseY + buffer.cursorY
        const at = buffer.type !== 'alternate' && this.marker?.line === y
        return {
            at_prompt: at,
            text: at ? buffer.getLine(y)?.translateToString(true, this.column).trimEnd() ?? '' : '',
            current_line: buffer.type === 'alternate' ? '' : this.lineAt(buffer, y),
        }
    }

    takeEmptyPrompt(token) {
        const fresh = token && this.promptEndToken === token
        this.promptEndToken = null
        if (!fresh) return false
        const buffer = this.term.buffer.active
        const y = buffer.baseY + buffer.cursorY
        if (buffer.type !== 'normal' || this.marker?.line !== y || buffer.cursorX !== this.column ||
            buffer.getLine(y + 1)?.isWrapped) return false
        const line = buffer.getLine(y)
        if (!line) return false
        for (let x = this.column; x < line.length; x++) {
            if (line.getCell(x)?.getChars()) return false
        }
        return true
    }
}

module.exports = { History }
