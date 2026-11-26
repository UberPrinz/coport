import stripAnsi from 'strip-ansi'
import { ipcRenderer } from 'electron'
import { getCurrentWindow } from '@electron/remote'
import { LogService, NotificationsService } from 'tabby-core'
import { Subject, Observable } from 'rxjs'
import { Injector, NgZone } from '@angular/core'
import { BaseSession, ConnectableTerminalProfile, InputProcessingOptions, InputProcessor, LoginScriptsOptions, SessionMiddleware, StreamProcessingOptions, TerminalStreamProcessor, UTF8SplitterMiddleware, XTermFrontend } from 'tabby-terminal'
import { SerialService } from './services/serial.service'

export interface SerialProfile extends ConnectableTerminalProfile {
    options: SerialProfileOptions
}

export interface SerialProfileOptions extends StreamProcessingOptions, LoginScriptsOptions {
    port: string
    baudrate: number | null
    databits: 5 | 6 | 7 | 8
    stopbits: 1 | 1.5 | 2
    parity: string
    rtscts: boolean
    xon: boolean
    xoff: boolean
    xany: boolean
    slowSend: boolean
    input: InputProcessingOptions,
}

export const BAUD_RATES = [
    110, 150, 300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1500000,
]

export interface SerialPortInfo {
    name: string
    description?: string
}

class SlowFeedMiddleware extends SessionMiddleware {
    feedFromTerminal (data: Buffer): void {
        for (const byte of data) {
            this.outputToSession.next(Buffer.from([byte]))
        }
    }
}

export class SerialSession extends BaseSession {
    // coport: Only the main process opens or closes a physical device.
    focusedExisting = false
    private generation?: string
    private disposed = false
    private ready = false
    private replayingStartupInput = false
    private viewOutput: Promise<void> = Promise.resolve()
    private pending: { generation: string, seq: number, bytes: Uint8Array }[] = []
    private seq = -1
    private desiredSize?: XTermFrontend['terminalSize']

    get serviceMessage$ (): Observable<string> { return this.serviceMessage }
    private serviceMessage = new Subject<string>()
    private streamProcessor: TerminalStreamProcessor
    private zone: NgZone
    private notifications: NotificationsService
    private serialService: SerialService

    constructor (
        injector: Injector,
        public profile: SerialProfile,
        private view: { focus: () => void, replay: (snapshot: string) => Promise<void>, flush: () => Promise<void> },
        private frontend: XTermFrontend,
    ) {
        super(injector.get(LogService).create(`serial-${profile.options.port}`))
        this.serialService = injector.get(SerialService)

        this.zone = injector.get(NgZone)
        this.notifications = injector.get(NotificationsService)

        this.streamProcessor = new TerminalStreamProcessor(profile.options)
        this.middleware.push(this.streamProcessor)

        if (this.profile.options.slowSend) {
            this.middleware.unshift(new SlowFeedMiddleware())
        }

        this.middleware.push(new UTF8SplitterMiddleware())
        this.middleware.push(new InputProcessor(profile.options.input))
    }

    async start (): Promise<void> {
        const { port: configuredPort, baudrate, databits, stopbits, parity, rtscts, xon, xoff, xany } = this.profile.options
        const config = { port: configuredPort, baudrate: Number(baudrate), databits, stopbits, parity, rtscts, xon, xoff, xany }
        if (!config.port) {
            const port = (await this.serialService.listPorts()).at(0)
            if (!port) {
                throw new Error('No serial ports found')
            }
            this.profile.options.port = config.port = port.name
        }

        const ensure = this.profile.options.outputMode === 'hex' ? 'ensure-hex-view' : 'ensure'
        const result = await this.invoke<{ generation: string, reused: boolean, focus?: object, activeBaudrate?: number }>(ensure, {
            config, reveal: true, windowId: getCurrentWindow().id, profileId: this.profile.id, ...this.frontend.terminalSize,
        })
        if (result.focus) {
            this.focusedExisting = true
            return
        }
        this.generation = result.generation
        if (this.disposed) {
            await this.invoke('detach', { generation: result.generation })
            return
        }
        if (result.activeBaudrate) {
            this.profile.options.baudrate = result.activeBaudrate
        }

        ipcRenderer.on('coport-serial:focus', this.onFocus)
        ipcRenderer.on('coport-serial:output', this.onOutput)
        ipcRenderer.on('coport-serial:resized', this.onResized)
        ipcRenderer.on('coport-serial:ended', this.onEnd)
        ipcRenderer.on('coport-serial:view-detached', this.onEnd)
        try {
            const size = this.frontend.terminalSize
            this.desiredSize = size
            this.frontend.requestResize = this.requestResize
            const options: Partial<SerialProfileOptions> = this.profile.options
            const newLogin = !result.reused && Boolean(options.scripts?.length)
            const replayDeviceOutput = newLogin || Boolean(options.outputMode) || Boolean(options.outputNewlines)
            const { snapshot, seq, displayFrames } = await this.invoke<{
                snapshot: string, seq: number, displayFrames?: Uint8Array[],
            }>(replayDeviceOutput ? 'attach-display' : 'attach', { generation: this.generation, ...size })
            if (this.isDisposed()) {
                return
            }
            await this.view.replay(snapshot)
            if (this.isDisposed()) {
                return
            }
            // Only a new generation runs login scripts. A prompt that arrived
            // before attach is still part of that generation's startup.
            if (newLogin) {
                this.setLoginScriptsOptions(this.profile.options)
                this.replayingStartupInput = true
                this.loginScriptProcessor?.executeUnconditionalScripts()
            }
            try {
                for (const bytes of displayFrames ?? []) {
                    this.emitOutput(Buffer.from(bytes))
                }
            } finally {
                this.replayingStartupInput = false
            }
            this.releaseInitialDataBuffer()
            await this.view.flush()
            if (this.isDisposed()) {
                return
            }
            this.seq = seq
            this.ready = true
            this.open = true
            for (const event of this.pending.splice(0)) {
                this.onOutput(undefined, event)
            }
            if (this.desiredSize !== size) {
                this.sendResize(this.desiredSize)
            }
            setTimeout(() => this.streamProcessor.start())
        } catch (error) {
            await this.destroy()
            throw error
        }
    }

    private isDisposed (): boolean {
        return this.disposed
    }

    private async invoke<T = void> (action: string, args: object): Promise<T> {
        const response = await ipcRenderer.invoke(`coport-serial:${action}`, args)
        if (response.ok) {
            return response.result
        }
        const { code, message, active } = response.error
        throw new Error(active ? `${code}: ${message} (${JSON.stringify(active)})` : `${code}: ${message}`)
    }

    private onFocus = (_, { generation }) => {
        if (generation === this.generation) {
            this.zone.run(() => this.view.focus())
        }
    }

    private onOutput = (_, event: { generation: string, seq: number, bytes: Uint8Array }) => {
        if (event.generation !== this.generation || this.disposed) {
            return
        }
        if (!this.ready) {
            this.pending.push(event)
            return
        }
        if (event.seq <= this.seq) {
            return
        }
        this.seq = event.seq
        this.viewOutput = this.viewOutput.then(async () => {
            if (this.disposed) {
                return
            }
            this.zone.run(() => this.emitOutput(Buffer.from(event.bytes)))
            await this.view.flush()
            if (!this.isDisposed()) {
                ipcRenderer.send('coport-serial:ack', { generation: event.generation, seq: event.seq })
            }
        }).catch(error => {
            this.zone.run(() => this.notifications.error(error.message))
            void this.destroy()
        })
    }

    private requestResize = (cols: number, rows: number): void => {
        if (this.desiredSize?.cols === cols && this.desiredSize.rows === rows) {
            return
        }
        this.desiredSize = { cols, rows }
        if (this.ready) {
            this.sendResize(this.desiredSize)
        }
    }

    private sendResize (size: XTermFrontend['terminalSize']): void {
        void this.invoke('resize', { generation: this.generation, ...size }).catch(error => {
            if (!this.disposed) {
                this.zone.run(() => this.notifications.error(error.message))
                void this.destroy()
            }
        })
    }

    private onResized = (_, { generation, cols, rows }) => {
        if (generation !== this.generation || this.disposed) {
            return
        }
        this.viewOutput = this.viewOutput.then(() => {
            if (!this.disposed) {
                this.frontend.applyTerminalSize(cols, rows)
            }
        }).catch(error => {
            this.zone.run(() => this.notifications.error(error.message))
            void this.destroy()
        })
    }

    private onEnd = (_, { generation }) => {
        if (generation === this.generation) {
            this.zone.run(() => void this.destroy())
        }
    }

    write (data: Buffer): void {
        if ((!this.open && !this.replayingStartupInput) || !this.generation || !data.length) {
            return
        }
        void this.invoke('input', { generation: this.generation, bytes: Uint8Array.from(data) })
            .catch(error => this.zone.run(() => this.notifications.error(error.message)))
    }

    async changeBaudRate (baudrate: number): Promise<void> {
        if (this.open && this.generation) {
            await this.invoke('update-baudrate', { generation: this.generation, baudrate })
            this.profile.options.baudrate = baudrate
        }
    }

    async disconnect (): Promise<void> {
        if (this.generation && this.open) {
            try {
                await this.invoke('disconnect', { generation: this.generation })
            } finally {
                await this.destroy()
            }
        }
    }

    async destroy (): Promise<void> {
        if (this.disposed) {
            return
        }
        this.disposed = true
        this.pending.length = 0
        if (this.frontend.requestResize === this.requestResize) {
            this.frontend.requestResize = undefined
        }
        ipcRenderer.off('coport-serial:focus', this.onFocus)
        ipcRenderer.off('coport-serial:output', this.onOutput)
        ipcRenderer.off('coport-serial:resized', this.onResized)
        ipcRenderer.off('coport-serial:ended', this.onEnd)
        ipcRenderer.off('coport-serial:view-detached', this.onEnd)
        this.serviceMessage.complete()
        await super.destroy()
        if (this.generation) {
            await this.invoke('detach', { generation: this.generation }).catch(() => undefined)
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-empty-function, @typescript-eslint/explicit-module-boundary-types, @typescript-eslint/no-empty-function
    resize (_, __) {
        this.streamProcessor.resize()
    }

    kill (_?: string): void {
        void this.disconnect().catch(error => this.notifications.error(error.message))
    }

    emitServiceMessage (msg: string): void {
        this.serviceMessage.next(msg)
        this.logger.info(stripAnsi(msg))
    }

    async getChildProcesses (): Promise<any[]> {
        return []
    }

    async gracefullyKillProcess (): Promise<void> {
        // Destroying a tab detaches the view. Disconnect is explicit.
    }

    supportsWorkingDirectory (): boolean {
        return false
    }

    async getWorkingDirectory (): Promise<string|null> {
        return null
    }
}
