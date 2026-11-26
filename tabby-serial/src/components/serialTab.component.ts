/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import colors from 'ansi-colors'
import { Component, Injector } from '@angular/core'
import { AppService, Platform, RecoveryToken, SelectorService, SplitTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent, ConnectableTerminalTabComponent, XTermFrontend } from 'tabby-terminal'
import { SerialSession, BAUD_RATES, SerialProfile } from '../api'

/** @hidden */
@Component({
    selector: 'serial-tab',
    template: `${BaseTerminalTabComponent.template} ${require('./serialTab.component.pug')}`,
    styleUrls: ['./serialTab.component.scss', ...BaseTerminalTabComponent.styles],
    animations: BaseTerminalTabComponent.animations,
})
export class SerialTabComponent extends ConnectableTerminalTabComponent<SerialProfile> {
    session: SerialSession|null = null
    Platform = Platform
    private lastWrite: Promise<void> = Promise.resolve()
    private closing = false

    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor (
        injector: Injector,
        private selector: SelectorService,
    ) {
        super(injector)
        this.enableToolbar = true
    }

    ngOnInit () {
        this.subscribeUntilDestroyed(this.hotkeys.hotkey$, hotkey => {
            if (!this.hasFocus) {
                return
            }
            switch (hotkey) {
                case 'home':
                    this.sendInput('\x1b[H' )
                    break
                case 'end':
                    this.sendInput('\x1b[F' )
                    break
                case 'restart-serial-session':
                    this.reconnect()
                    break
            }
        })

        super.ngOnInit()

        // coport: The main-process xterm is the sole producer of device replies.
        this.frontend!.suppressDeviceReports = true
        setImmediate(() => {
            this.setTitle(this.profile.name)
        })
    }

    protected clearServiceMessagesOnConnect (): void {
        // coport: The view was already reset before snapshot replay.
    }

    async write (text: string): Promise<void> {
        this.lastWrite = super.write(text)
        await this.lastWrite
    }

    async initializeSession () {
        await super.initializeSession()
        const baudrate = Number(this.profile.options.baudrate)
        if (baudrate && !BAUD_RATES.includes(baudrate)) {
            const response = await this.platform.showMessageBox({
                type: 'warning',
                message: this.translate.instant(_('Use non-standard baud rate {baudrate}?'), { baudrate }),
                buttons: [this.translate.instant(_('Connect')), this.translate.instant(_('Cancel'))],
                defaultId: 1,
                cancelId: 1,
            })
            if (response.response !== 0 || this.closing) {
                return
            }
        }

        const session = new SerialSession(this.injector, this.profile, {
            focus: () => this.focusSerialTab(),
            replay: snapshot => {
                // coport: The spinner clears the cursor line when stopped.
                this.stopSpinner()
                return this.write('\x1bc' + snapshot)
            },
            flush: () => this.lastWrite,
        }, this.frontend as XTermFrontend)
        this.setSession(session)

        this.startSpinner(this.translate.instant(_('Connecting')))

        try {
            await session.start()
            if (this.closing) {
                return
            }
            this.stopSpinner()
            if (session.focusedExisting) {
                this.destroy()
                return
            }
            if (!session.open) {
                return
            }
        } catch (e) {
            this.stopSpinner()
            if (e.message.startsWith('config_conflict:')) {
                this.notifications.error(e.message)
                this.destroy()
            } else if (!this.closing) {
                this.write(colors.black.bgRed(' X ') + ' ' + colors.red(e.message) + '\r\n')
            }
            return
        }
        session.resize(this.size.columns, this.size.rows)
    }

    protected attachSessionHandlers () {
        this.attachSessionHandler(this.session!.serviceMessage$, msg => {
            this.write(`\r\n${colors.black.bgWhite(' Serial ')} ${msg}\r\n`)
            this.session?.resize(this.size.columns, this.size.rows)
        })
        super.attachSessionHandlers()
    }

    protected onSessionDestroyed (): void {
        if (this.frontend) {
            // Session was closed abruptly
            this.write('\r\n' + colors.black.bgWhite(' SERIAL ') + ` session closed\r\n`)

            super.onSessionDestroyed()
        }
    }

    async changeBaudRate () {
        const rate = await this.selector.show(
            this.translate.instant(_('Baud rate')),
            BAUD_RATES.map(x => ({
                name: x.toString(), result: x, weight: x,
            })),
        )
        if (rate !== this.profile.options.baudrate) {
            await this.session?.changeBaudRate(rate).catch(error => this.notifications.error(error.message))
        }
    }

    private focusSerialTab (): void {
        let root = this.parent
        while (root?.parent) {
            root = root.parent
        }
        this.injector.get(AppService).selectTab(root ?? this)
        if (root instanceof SplitTabComponent) {
            root.focus(this)
        }
    }

    async getRecoveryToken (): Promise<RecoveryToken | null> {
        return null
    }

    async disconnect (): Promise<void> {
        this.isDisconnectedByHand = true
        await this.session?.disconnect().catch(error => this.notifications.error(error.message))
    }

    async reconnect (): Promise<void> {
        await this.disconnect()
        await super.reconnect()
    }

    ngOnDestroy (): void {
        this.closing = true
        this.detachSessionHandlers()
        void this.session?.destroy()
        super.ngOnDestroy()
    }

    protected isSessionExplicitlyTerminated (): boolean {
        return super.isSessionExplicitlyTerminated() ||
        this.recentInputs.endsWith('close\r') ||
        this.recentInputs.endsWith('quit\r')
    }
}
