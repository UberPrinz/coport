import { EventEmitter } from 'node:events'
import { fstatSync, readSync, writeSync } from 'node:fs'
import type { SerialConfig } from './sessionManager'

interface DarwinPort {
    fd: number
    poller: EventEmitter & { poll: (mask: number) => void }
    close: () => Promise<void>
    update: (options: { baudRate: number }) => Promise<void>
}

export interface SerialDevice {
    queuedReadBytes: () => number
    read: (buffer: Buffer) => number
    write: (buffer: Buffer, offset: number) => number
    watch: (readable: boolean, writable: boolean) => void
    onReady: (readable: () => void, writable: () => void, lost: () => void) => void
    setBaudRate: (rate: number) => Promise<void>
    close: () => Promise<void>
}

export async function openDevice (path: string, identity: bigint, config: SerialConfig): Promise<SerialDevice> {
    const { SerialPort } = require('serialport')
    const { queuedReadBytes } = require('./coport-queued-read.node')
    const port: DarwinPort = await SerialPort.binding.open({
        path, baudRate: config.baudrate, dataBits: config.databits, stopBits: config.stopbits,
        parity: config.parity, rtscts: config.rtscts, xon: config.xon, xoff: config.xoff, xany: config.xany,
    })
    try {
        if (fstatSync(port.fd, { bigint: true }).rdev !== identity) {
            throw new Error('The serial device changed during open')
        }
    } catch (error) {
        await port.close()
        throw error
    }

    // The binding opens the descriptor O_NONBLOCK. Use its poller, but perform
    // I/O on the JS thread so driver watermarks and writes share one ordering.
    const nonBlocking = (action: () => number) => {
        try {
            return action()
        } catch (error) {
            if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK' || error.code === 'EINTR') {
                return -1
            }
            throw error
        }
    }
    return {
        queuedReadBytes: () => queuedReadBytes(port.fd),
        read: buffer => nonBlocking(() => readSync(port.fd, buffer)),
        write: (buffer, offset) => nonBlocking(() => writeSync(port.fd, buffer, offset, buffer.length - offset)),
        watch: (readable, writable) => port.poller.poll(4 | (readable ? 1 : 0) | (writable ? 2 : 0)),
        onReady: (readable, writable, lost) => {
            port.poller.on('readable', error => error ? lost() : readable())
            port.poller.on('writable', error => error ? lost() : writable())
            port.poller.on('disconnect', lost)
        },
        setBaudRate: baudRate => port.update({ baudRate }),
        close: async () => {
            port.poller.removeAllListeners()
            await port.close()
        },
    }
}
