import { SessionManager, SerialSession, SerialConfig } from './sessionManager'
import { SerialFailure } from './serialHub'
import { ExecFailure } from './serialExec'
import { isAbsolute } from 'node:path'
import type { AdbService } from './adbService'

interface Tool {
    name: string
    description: string
    inputSchema: {
        type: 'object'
        properties: Record<string, object>
        required?: string[]
        additionalProperties: false
    }
}

const integer = (minimum: number, maximum?: number, fallback?: number) => ({
    type: 'integer', minimum, maximum, 'default': fallback,
})
const string = { type: 'string' }

function tool (name: string, description: string, properties = {}, required?: string[]): Tool {
    return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } }
}

export const tools = [
    tool('read_terminal', 'Read shared terminal committed lines and current line. History remains readable while disconnected. wait_ms waits for new lines only with after_line.', {
        after_line: integer(-1), max_lines: integer(1, 2000, 200), wait_ms: integer(0, 10000, 0),
    }),
    tool('write_serial', 'Queue raw bytes on the current serial port. Tabby shared sessions reject conflicting input. encoding is utf8 (default) or hex. 1...65536 encoded bytes.', {
        data: string, encoding: { ...string, 'enum': ['utf8', 'hex'], 'default': 'utf8' },
    }, ['data']),
    tool('exec', 'Execute a device sh command via ADB when available, otherwise the prepared idle serial shell. Serial timeout sends Ctrl+C; ADB timeout kills local adb only. Read terminal before prepare_shell if serial is not prepared.', {
        command: { ...string, minLength: 1 }, timeout_ms: integer(1000, 600000, 30000),
        max_output_bytes: integer(1024, 4194304, 262144),
    }, ['command']),
    tool('get_view_state', 'Get the currently viewed log snapshot: device_path, local_path, filter and search. log is null when no file is open. Local snapshot expires when Coport quits.'),
    tool('prepare_shell', 'Prepare serial shell markers. First read_terminal and confirm a shell prompt ending # or $. Rejects fullscreen, pending human input and continuation prompts. Never prepares automatically.'),
    tool('open_serial', 'Open or join a Coport shared serial profile in Tabby and bind this MCP connection to its session.', {
        path: string, baud: integer(1, 4294967295, 115200), dataBits: integer(5, 8, 8),
        parity: { ...string, 'enum': ['none', 'odd', 'even'], 'default': 'none' },
        stopBits: { type: 'integer', 'enum': [1, 2], 'default': 1 },
        flowControl: { ...string, 'enum': ['none', 'hardware', 'software'], 'default': 'none' },
    }, ['path']),
]

const argumentErrors = [
    'Expected after_line >= -1, max_lines 1...2000, wait_ms 0...10000, all integers',
    'Expected data string and optional encoding string',
    'Expected nonempty command, timeout_ms 1000...600000 and max_output_bytes 1024...4194304',
    'Expected empty arguments object',
    'Expected empty arguments object',
    'Invalid shared serial request',
]
const noSerial = 'Serial port is not connected'
const serialUnavailable = 'Serial connection is unavailable'
const channelLost = 'Tabby terminal is unavailable'
const queueFull = 'Shared serial queue is full'
const inputBusy = 'Another input source has an unsubmitted line'

function errorResult (code: string, message: string, retryable = false, details?: object): object {
    return { error: { code, message, retryable, ...(details ? { details } : {}) } }
}

function argsMatch (definition: Tool, args: Record<string, unknown>, enumCheck: boolean): boolean {
    const properties = definition.inputSchema.properties
    return (definition.inputSchema.required ?? []).every(key => Object.prototype.hasOwnProperty.call(args, key)) &&
        Object.entries(args).every(([key, value]) => {
            if (!Object.prototype.hasOwnProperty.call(properties, key)) {
                return false
            }
            const prop = properties[key] as { type: string, enum?: unknown[], minLength?: number, minimum?: number, maximum?: number }
            if (enumCheck && prop.enum && !prop.enum.includes(value)) {
                return false
            }
            return prop.type === 'string'
                ? typeof value === 'string' && value.length >= (prop.minLength ?? 0)
                : typeof value === 'number' && Number.isSafeInteger(value) &&
                    (prop.minimum === undefined || value >= prop.minimum) && (prop.maximum === undefined || value <= prop.maximum)
        })
}

function activeConflictMessage (active: SerialConfig): string {
    const flow = active.rtscts ? 'hardware' : active.xon || active.xoff || active.xany ? 'software' : 'none'
    return `Serial device is already using different parameters (${active.baudrate} baud, ${active.databits} data bits, parity ${active.parity}, ${active.stopbits} stop bits, flow control ${flow})`
}

export class McpConnection {
    private source = Symbol('mcp')
    private binding?: SerialSession
    private closed = false
    private abort = new AbortController()

    constructor (private sessions: SessionManager, private adb?: AdbService) {}

    close (): void {
        if (!this.closed) {
            this.closed = true
            this.abort.abort()
            this.sessions.clientDisconnected(this.source)
        }
    }

    async call (name: string, args: Record<string, any>): Promise<object> {
        const index = tools.findIndex(definition => definition.name === name)
        if (index < 0) {
            return errorResult('invalid_argument', 'Unknown tool')
        }
        if (!argsMatch(tools[index], args, name !== 'write_serial')) {
            return errorResult('invalid_argument', argumentErrors[index])
        }
        let adbFallback: { reason: string, message?: string } | undefined = undefined
        try {
            switch (name) {
                case 'open_serial': {
                    const { path, baud = 115200, dataBits = 8, parity = 'none', stopBits = 1, flowControl = 'none' } = args
                    if (!isAbsolute(path) || path.includes('\0')) {
                        return errorResult('invalid_argument', argumentErrors[index])
                    }
                    const config = {
                        port: path, baudrate: baud, databits: dataBits, parity, stopbits: stopBits,
                        rtscts: flowControl === 'hardware', xon: flowControl === 'software', xoff: flowControl === 'software',
                    }
                    const { session, reused } = await this.sessions.ensure(config)
                    if (this.closed || !session.hub.connected) {
                        return errorResult('channel_lost', channelLost, true)
                    }
                    this.binding = session
                    return { session_id: session.generation.toUpperCase(), path: session.path, reused }
                }
                case 'read_terminal': {
                    const { after_line = null, max_lines = 200, wait_ms = 0 } = args
                    return this.binding?.terminal.history.read({ after_line, max_lines, wait_ms }) ?? {
                        lines: [], first_available_line: 0, last_line: -1, next_after_line: after_line ?? -1,
                        current_line: '', fullscreen: false, gap: false,
                    }
                }
                case 'write_serial': {
                    const { data, encoding = 'utf8' } = args
                    if (encoding !== 'hex' && encoding !== 'utf8') {
                        return errorResult('invalid_argument', 'Encoding must be utf8 or hex')
                    }
                    if (encoding === 'hex' && (!data.length || data.length > 131072 || data.length % 2 !== 0 || /[^0-9a-f]/i.test(data))) {
                        return errorResult('invalid_argument', 'Hex data must contain an even number of hexadecimal digits')
                    }
                    if (encoding === 'utf8' && (Buffer.byteLength(data) < 1 || Buffer.byteLength(data) > 65536)) {
                        return errorResult('invalid_argument', 'Encoded data must contain 1...65536 bytes')
                    }
                    if (!this.binding) {
                        return errorResult('no_serial', noSerial, true)
                    }
                    if (this.closed || !this.binding.hub.connected) {
                        return errorResult('channel_lost', channelLost, true)
                    }
                    return { bytes_queued: this.binding.hub.enqueue(Buffer.from(data, encoding), this.source) }
                }
                case 'get_view_state':
                    return { log: null }
                case 'prepare_shell':
                    if (!this.binding) {
                        return errorResult('no_serial', serialUnavailable, true)
                    }
                    return { prepared: true, already: await this.binding.exec.prepare(() => this.closed) }
                case 'exec': {
                    const { command, timeout_ms = 30000, max_output_bytes = 262144 } = args
                    if (command.includes('\0')) {
                        return errorResult('invalid_argument', argumentErrors[index])
                    }
                    const route = await this.adb?.selectForExec(this.abort.signal)
                    if (this.closed) {
                        return errorResult('channel_lost', channelLost, true)
                    }
                    if (route?.selection) {
                        return await this.adb!.exec(route.selection, command, timeout_ms, max_output_bytes, this.abort.signal)
                    }
                    if (route?.reason) {
                        adbFallback = { reason: route.reason, message: route.message }
                    }
                    if (!this.binding) {
                        return errorResult('no_device', 'No device connected', true, adbFallback && { adb_fallback: adbFallback })
                    }
                    const result = await this.binding.exec.run(command, timeout_ms, max_output_bytes, () => this.closed)
                    return adbFallback ? { ...result, adb_fallback: adbFallback } : result
                }
                default:
                    return errorResult('invalid_argument', 'Unknown tool')
            }
        } catch (error) {
            if (error instanceof ExecFailure) {
                const details = error.details ?? (error.code === 'channel_lost' && name === 'exec'
                    ? { channel: 'serial', partial_output: '' }
                    : undefined)
                return errorResult(error.code, error.message, !['timeout', 'command_too_long'].includes(error.code),
                    adbFallback ? { ...details, adb_fallback: adbFallback } : details)
            }
            if (error instanceof SerialFailure) {
                switch (error.code) {
                    case 'config_conflict':
                        return errorResult(error.code, activeConflictMessage(error.active as SerialConfig))
                    case 'port_busy':
                        return errorResult(error.code, 'Serial port is occupied or inaccessible', true)
                    case 'timeout':
                        return errorResult(error.code, error.message, true)
                    case 'busy':
                        return errorResult(error.code, inputBusy, true)
                    case 'queue_full':
                        return errorResult(error.code, queueFull, true)
                    case 'invalid_argument':
                        return errorResult(error.code, argumentErrors[index])
                }
            }
            if (name === 'open_serial' && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) {
                return errorResult('invalid_argument', argumentErrors[index])
            }
            if (name === 'open_serial' && ['EBUSY', 'EACCES', 'EWOULDBLOCK'].includes(error.code)) {
                return errorResult('port_busy', 'Serial port is occupied or inaccessible', true)
            }
            if (name === 'open_serial' && !(error instanceof SerialFailure)) {
                return errorResult('port_unavailable', 'Serial port could not be opened', true)
            }
            return errorResult('channel_lost', channelLost, true)
        }
    }
}
