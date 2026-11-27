import { execFile, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createWriteStream, constants } from 'node:fs'
import { access, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join, posix } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { ExecFailure, OutputWindow } from './serialExec'

const run = promisify(execFile)

export interface AdbDevice {
    serial: string
    status: string
}

export interface AdbEntry {
    name: string
    fullPath: string
    isDirectory: boolean
    isSymlink: boolean
    mode: number
    size: number
    modified: number
}

export class AdbFailure extends Error {
    constructor (message: string, public readonly stderr = '', public readonly reason = 'adb_error') {
        super(message)
    }
}

function fileEntry (fullPath: string, mode: number, size: number, modified: number, name = posix.basename(fullPath)): AdbEntry {
    return {
        name, fullPath, mode, size, modified,
        isDirectory: (mode & 0o170000) === 0o040000,
        isSymlink: (mode & 0o170000) === 0o120000,
    }
}

function quote (value: string): string {
    return '\'' + value.replace(/'/g, '\'\\\'\'') + '\''
}

function remotePath (value: string): string {
    if (typeof value !== 'string' || !posix.isAbsolute(value) || value.includes('\0')) {
        throw new AdbFailure('Expected an absolute Android path')
    }
    return posix.normalize(value)
}

function serialArg (value: string): string {
    if (typeof value !== 'string' || !value || /\s/.test(value) || value.includes('\0')) {
        throw new AdbFailure('Invalid Android device serial')
    }
    return value
}

interface AdbSelection {
    path: string
    device: AdbDevice
    serverArgs: string[]
}

export class AdbService {
    private recent?: string
    private serverArgs: string[]

    constructor (private override?: string, terminalEnvironment?: Record<string, string>) {
        const value = (key: string) => terminalEnvironment?.[key] ?? process.env[key]
        const socket = value('ADB_SERVER_SOCKET')
        const host = value('ANDROID_ADB_SERVER_ADDRESS')
        const configuredPort = value('ANDROID_ADB_SERVER_PORT')
        const port = configuredPort?.length ? configuredPort : '5037'
        this.serverArgs = socket ? ['-L', socket] : host ? ['-H', host, '-P', port] : ['-L', `tcp:${port}`]
    }

    private async executable (): Promise<string> {
        const paths = this.override !== undefined ? [this.override] : [
            ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, 'adb')),
            '/opt/homebrew/bin/adb',
            join(homedir(), 'Library/Android/sdk/platform-tools/adb'),
        ]
        for (const path of paths) {
            if (path && await access(path, constants.X_OK).then(() => true, () => false)) {
                return path
            }
        }
        throw new AdbFailure('ADB executable was not found', '', 'adb_unavailable')
    }

    async devices (signal?: AbortSignal): Promise<{ path: string, devices: AdbDevice[] }> {
        const path = await this.executable()
        try {
            const { stdout } = await run(path, [...this.serverArgs, 'devices'], {
                timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024, signal,
            })
            if (!stdout.split(/\r?\n/).includes('List of devices attached')) {
                throw new Error('Invalid adb devices response')
            }
            const devices = stdout.split(/\r?\n/).flatMap(line => {
                const [serial, status] = line.split('\t')
                return serial && status ? [{ serial, status: status.trim() }] : []
            })
            return { path, devices }
        } catch (error) {
            throw new AdbFailure('ADB device discovery failed', String(error.stderr || error.message), 'adb_unavailable')
        }
    }

    async select (serial: string, signal?: AbortSignal): Promise<AdbSelection> {
        const { path, devices } = await this.devices(signal)
        const device = devices.find(item => item.serial === serialArg(serial))
        if (!device || device.status !== 'device') {
            throw new AdbFailure(device ? `ADB device ${serial} is ${device.status}` : `ADB device ${serial} is unavailable`)
        }
        this.recent = device.serial
        return { path, device, serverArgs: this.serverArgs }
    }

    async selectForExec (signal: AbortSignal): Promise<{ selection?: AdbSelection, reason?: string, message?: string }> {
        try {
            const { path, devices } = await this.devices(signal)
            const authorized = devices.filter(device => device.status === 'device')
            if (authorized.length) {
                const device = authorized.find(item => item.serial === this.recent) ?? authorized[0]
                this.recent = device.serial
                return { selection: { path, device, serverArgs: this.serverArgs } }
            }
            if (devices.length) {
                return { reason: 'adb_unavailable', message: devices.map(item => `${item.serial}: ${item.status}`).join(', ') }
            }
            return {}
        } catch (error) {
            return { reason: 'adb_unavailable', message: error.message }
        }
    }

    async exec (selection: AdbSelection, command: string, timeout: number, limit: number, signal: AbortSignal): Promise<object> {
        const token = randomBytes(4).toString('hex')
        const marker = Buffer.from(`\x1b]6973;E;${token};`)
        const wrapped = `sh -c ${quote(command)} 2>&1; __rc=$?; printf '\\033]6973;E;%s;%d\\007' ${token} "$__rc"`
        const started = performance.now()
        const output = new OutputWindow(limit)
        const stderr = new OutputWindow(65536)
        let tail = Buffer.alloc(0)
        const state: { status?: number, timedOut: boolean } = { timedOut: false }
        const child = spawn(selection.path, [...selection.serverArgs, '-s', selection.device.serial, 'shell', wrapped], {
            stdio: ['ignore', 'pipe', 'pipe'], signal, killSignal: 'SIGKILL',
        })
        const timer = setTimeout(() => {
            state.timedOut = true
            child.kill('SIGKILL')
        }, timeout)
        child.stdout.on('data', chunk => {
            if (state.status !== undefined) {
                return
            }
            tail = Buffer.concat([tail, chunk])
            const at = tail.lastIndexOf(marker)
            if (at !== -1 && tail.at(-1) === 7) {
                const value = tail.subarray(at + marker.length, -1).toString()
                if (/^\d{1,3}$/.test(value) && Number(value) <= 255) {
                    state.status = Number(value)
                    output.append(tail.subarray(0, at))
                    tail = Buffer.alloc(0)
                    child.kill('SIGKILL')
                    return
                }
            }
            if (tail.length > 128) {
                output.append(tail.subarray(0, -128))
                tail = tail.subarray(-128)
            }
        })
        child.stderr.on('data', chunk => stderr.append(chunk))
        try {
            const exit = await new Promise<number | null>((resolve, reject) => {
                child.once('error', reject)
                child.once('close', resolve)
            })
            if (state.status !== undefined) {
                return {
                    channel: 'adb', exit_code: state.status, success: state.status === 0,
                    ...output.text(), duration_ms: Math.round(performance.now() - started),
                }
            }
            output.append(tail)
            const partial_output = output.text().output
            if (state.timedOut) {
                throw new ExecFailure('timeout', 'Local adb process killed; device command state is unknown',
                    { channel: 'adb', partial_output, interrupt: 'local_adb_killed' })
            }
            const error = stderr.text().output
            if (exit !== 0 && error) {
                throw new ExecFailure('adb_error', 'ADB command failed', { stderr: error })
            }
            throw new ExecFailure('channel_lost', 'ADB exited without command end marker', { channel: 'adb', partial_output })
        } catch (error) {
            if (error instanceof ExecFailure) {
                throw error
            }
            throw new ExecFailure('adb_error', 'Unable to launch adb', { stderr: error.message })
        } finally {
            clearTimeout(timer)
        }
    }

    private async command (serial: string, args: string[], signal?: AbortSignal, timeout = 30000): Promise<string> {
        const path = await this.executable()
        try {
            signal?.throwIfAborted()
            const { stdout } = await run(path, [...this.serverArgs, '-s', serialArg(serial), ...args], {
                timeout, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, signal,
            })
            return stdout
        } catch (error) {
            throw new AdbFailure('ADB file operation failed', String(error.stderr || error.message))
        }
    }

    private async shell (serial: string, command: string, signal?: AbortSignal): Promise<string> {
        const token = `COPORT_ADB_${randomUUID()}`
        const suffix = `\n${token}`
        const output = await this.command(serial, ['shell', `${command} && printf '\\n%s' ${quote(token)}`], signal)
        if (!output.endsWith(suffix)) {
            throw new AdbFailure('ADB shell command did not complete successfully', output)
        }
        return output.slice(0, -suffix.length).replace(/\r$/, '')
    }

    async list (serial: string, path: string): Promise<AdbEntry[]> {
        const remote = remotePath(path)
        const stdout = await this.command(serial, ['ls', remote])
        let directory: AdbEntry | undefined = undefined
        const entries: AdbEntry[] = []
        for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
            const match = /^([0-9a-f]+) ([0-9a-f]+) ([0-9a-f]+) (.+)$/i.exec(line)
            if (!match || match[4].includes('/') || match[4].includes('\0')) {
                throw new AdbFailure('Invalid adb ls response', line)
            }
            const [, mode, size, modified, name] = match
            const entry = fileEntry(posix.join(remote, name), parseInt(mode, 16), parseInt(size, 16), parseInt(modified, 16), name)
            if (name === '.') {
                directory = entry
            } else if (name !== '..') {
                entries.push(entry)
            }
        }
        if (!directory?.isDirectory) {
            throw new AdbFailure('Unable to list directory', `Directory does not exist or cannot be read: ${remote}`, 'unreadable_directory')
        }
        return entries
    }

    async stat (serial: string, path: string): Promise<AdbEntry> {
        const remote = remotePath(path)
        try {
            const output = await this.shell(serial, `stat -L -c '%f %s %Y' -- ${quote(remote)}`)
            const match = /^([0-9a-f]+) (\d+) (-?\d+)$/i.exec(output.trim())
            if (!match) {
                throw new AdbFailure('Invalid adb stat response', output)
            }
            return fileEntry(remote, parseInt(match[1], 16), Number(match[2]), Number(match[3]))
        } catch (error) {
            const listed = await this.list(serial, posix.dirname(remote)).catch((): AdbEntry[] => [])
            const entry = listed.find(item => item.name === posix.basename(remote))
            if (!entry) {
                throw error
            }
            return entry.isSymlink ? { ...entry, isSymlink: false, mode: (entry.mode & 0o7777) | 0o100000 } : entry
        }
    }

    async readlink (serial: string, path: string): Promise<string> {
        return (await this.shell(serial, `readlink -- ${quote(remotePath(path))}`)).replace(/\r?\n$/, '')
    }

    async mutate (serial: string, operation: 'mkdir' | 'rmdir' | 'unlink', path: string): Promise<void> {
        const shellCommand = operation === 'unlink' ? 'rm -f' : operation
        await this.shell(serial, `${shellCommand} -- ${quote(remotePath(path))}`)
    }

    async upload (serial: string, path: string, local: string, signal: AbortSignal): Promise<void> {
        const target = remotePath(path)
        const temporary = posix.join(posix.dirname(target), `.coport-upload-${randomUUID()}`)
        try {
            await this.command(serial, ['push', local, temporary], signal, 0)
            await this.shell(serial, `test ! -d ${quote(target)} && mv -f -- ${quote(temporary)} ${quote(target)}`, signal)
        } catch (error) {
            await this.mutate(serial, 'unlink', temporary).catch(() => null)
            throw error
        }
    }

    async download (serial: string, path: string, local: string, signal: AbortSignal): Promise<void> {
        const remote = remotePath(path)
        const binary = await this.executable()
        const token = `COPORT_ADB_${randomUUID()}`
        const trailer = Buffer.from(token)
        const cat = `cat -- ${quote(remote)} && printf '%s' ${quote(token)}`
        const child = spawn(binary, [...this.serverArgs, '-s', serialArg(serial), 'exec-out', cat], {
            stdio: ['ignore', 'pipe', 'pipe'], signal, killSignal: 'SIGKILL',
        })
        const stderr = new OutputWindow(65536)
        child.stderr.on('data', chunk => stderr.append(chunk))
        try {
            const results = await Promise.allSettled([
                pipeline(child.stdout, createWriteStream(local, { mode: 0o600 }), { signal }),
                new Promise<void>((resolve, reject) => {
                    child.once('error', reject)
                    child.once('close', code => code === 0 ? resolve() : reject(new AdbFailure('ADB cat failed', stderr.text().output)))
                }),
            ])
            for (const result of results) {
                if (result.status === 'rejected') {
                    throw result.reason
                }
            }
            // exec-out does not report the remote command's status. Only a
            // verified trailing marker proves that cat reached its success path.
            const staged = await open(local, 'r+')
            try {
                const { size } = await staged.stat()
                const offset = size - trailer.length
                const tail = Buffer.alloc(trailer.length)
                if (offset < 0 || (await staged.read(tail, 0, tail.length, offset)).bytesRead !== tail.length ||
                    !tail.equals(trailer)) {
                    throw new AdbFailure('ADB cat ended without a completion marker')
                }
                await staged.truncate(offset)
            } finally {
                await staged.close()
            }
        } catch (error) {
            child.kill('SIGKILL')
            if (signal.aborted) {
                throw error
            }
            await this.command(serial, ['pull', remote, local], signal, 0)
        }
    }
}
