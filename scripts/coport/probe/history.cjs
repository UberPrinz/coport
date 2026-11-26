const { performance } = require('node:perf_hooks')

const rows = 20000
const scrollback = 128
const numbered = Array.from({ length: rows }, (_, i) =>
    `ROW${String(i).padStart(5, '0')} ${'x'.repeat(48)}\r\n`)
const d = '\x1b]133;D;0\x07'
const a = '\x1b]133;A\x07'
const b = '\x1b]133;B\x07'

// From tabby_shared_serial.py (orphaned_half_line) and tabby_shared_history.py.
const samples = [
    [`\r\n${d}${a}$ ${b}`, 'fresh', true],
    [`\r\n${d.slice(0, 1)}`, 'old', false],
    [`\x00${d.slice(1)}${a}$ ${b}`, 'new', false],
    ['\r\n', 'c1-old', false],
    [Buffer.from([0xc2]), 'c1-old', false],
    [Buffer.concat([Buffer.from([0x9d]), Buffer.from(d.slice(2) + a + '$ ' + b)]), 'c1-new', false],
    [`\x1b[H\x1b[2J${a}$ ${b}`, 'redraw', false],
    [`\r\n${d}${a}$ ${b}half`, 'occupied', false],
    [`\r\n${d.slice(0, 5)}`, 'split', false],
    [d.slice(5) + a + '$ ', 'split', false],
    [b, 'split', true],
    ['\r\n\x1b[31mRED\x1b[0m normal\r\n', null, false],
]

function createTerminal(Terminal) {
    return new Terminal({ cols: 80, rows: 24, scrollback, allowProposedApi: true })
}

function write(terminal, data) {
    return new Promise(resolve => terminal.write(data, resolve))
}

function screen(terminal) {
    const buffer = terminal.buffer.active
    return Array.from({ length: buffer.length }, (_, i) => {
        const line = buffer.getLine(i)
        return {
            text: line.translateToString(true),
            colors: Array.from({ length: line.length }, (_, x) => {
                const cell = line.getCell(x)
                return [cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor()]
            }),
        }
    })
}

async function collect(Terminal, History, SerializeAddon) {
    const terminal = createTerminal(Terminal)
    const history = new History(terminal, rows + 100)
    const serialize = new SerializeAddon()
    terminal.loadAddon(serialize)

    const prompts = []
    for (const [input, token] of samples) {
        const data = Buffer.from(input)
        const stale = history.staleOSCPrefix(data, 0, data.length, token)
        if (stale) {
            history.outputToken = null
            await write(terminal, data.subarray(0, stale))
        }
        history.outputToken = token
        await write(terminal, data.subarray(stale))
        prompts.push({
            line: history.next,
            osc: history.oscToken ?? null,
            end: history.promptEndToken ?? null,
            empty: history.takeEmptyPrompt(token),
        })
    }

    // 20,000 rows from the sim fixture total 1,180,000 bytes on the wire.
    const bulk = Buffer.from(numbered.join(''))
    history.outputToken = null
    const start = performance.now()
    await write(terminal, bulk)
    const elapsed = performance.now() - start
    await write(terminal, '\x1b[31mRED\x1b[0m normal\r\n')

    const result = {
        prompts,
        expected: samples.map(([, , expected]) => expected),
        lines: history.lines.slice(history.head).map(({ line }) => line),
        screen: screen(terminal),
        bytes: bulk.length,
        elapsed,
    }
    result.snapshot = serialize.serialize()
    terminal.dispose()
    return result
}

async function replay(Terminal, snapshot) {
    const terminal = createTerminal(Terminal)
    await write(terminal, snapshot)
    const result = screen(terminal)
    terminal.dispose()
    return result
}

module.exports = { collect, replay }
