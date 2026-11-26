import type { Terminal } from '@xterm/headless'

const ansi = [
    0x2e3436, 0xcc0000, 0x4e9a06, 0xc4a000, 0x3465a4, 0x75507b, 0x06989a, 0xd3d7cf,
    0x555753, 0xef2929, 0x8ae234, 0xfce94f, 0x729fcf, 0xad7fa8, 0x34e2e2, 0xeeeeec,
]
const levels = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff]

function defaultColor (index: number): number {
    if (index < 16) {
        return ansi[index]
    }
    if (index < 232) {
        const offset = index - 16
        return (levels[Math.floor(offset / 36)] << 16) | (levels[Math.floor(offset / 6) % 6] << 8) | levels[offset % 6]
    }
    if (index < 256) {
        return (8 + (index - 232) * 10) * 0x010101
    }
    return index === 257 ? 0x000000 : 0xffffff
}

enum ColorRequest {
    Report = 0,
    Set = 1,
    Restore = 2,
}

interface ColorEvent {
    type: ColorRequest
    index?: number
    color?: [number, number, number]
}

export function installTerminalReplies (terminal: Terminal, reply: (bytes: Buffer) => void): void {
    // The former renderer advertised VT220 attributes. The headless 5.5
    // parser defaults to VT100 attributes for CSI Ps c.
    terminal.parser.registerCsiHandler({ 'final': 'c' }, ([param]) => {
        if (param === 0) {
            reply(Buffer.from('\x1b[?62;4;9;22c'))
        }
        return true
    })
    // Unlike browser xterm, the headless build has no ThemeService to answer
    // the shared parser's OSC color queries. Use its default xterm palette.
    const overrides = new Map<number, number>()
    const core = (terminal as unknown as { _core: { _inputHandler: { onColor: (handler: (events: ColorEvent[]) => void) => void } } })._core
    core._inputHandler.onColor(requests => {
        for (const { type, index, color } of requests) {
            if (type === ColorRequest.Restore) {
                if (index === undefined) {
                    for (const slot of overrides.keys()) {
                        if (slot < 256) {
                            overrides.delete(slot)
                        }
                    }
                } else {
                    overrides.delete(index)
                }
            } else if (index !== undefined && type === ColorRequest.Set && color) {
                const [r, g, b] = color
                overrides.set(index, (r << 16) | (g << 8) | b)
            } else if (index !== undefined && type === ColorRequest.Report) {
                const value = overrides.get(index) ?? defaultColor(index)
                const rgb = [16, 8, 0].map(shift => (((value >> shift) & 0xff) * 257).toString(16).padStart(4, '0')).join('/')
                const ident = index < 256 ? `4;${index}` : String(index - 246)
                reply(Buffer.from(`\x1b]${ident};rgb:${rgb}\x1b\\`))
            }
        }
    })
}
