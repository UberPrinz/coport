import { BrowserWindow, ipcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { SERIAL_BUDGET, SerialFailure } from './serialHub'
import { SessionManager, SerialSession, TerminalSize } from './sessionManager'

function terminalSize ({ cols, rows }: TerminalSize): TerminalSize {
    if (!Number.isInteger(cols) || cols < 2 || cols > 1000 ||
        !Number.isInteger(rows) || rows < 1 || rows > 1000) {
        throw new SerialFailure('invalid_argument', 'Invalid terminal dimensions')
    }
    return { cols, rows }
}

interface View {
    window: BrowserWindow
    sender: WebContents
    profileId?: string
    dispose: () => void
    attach: (size: TerminalSize, legacyDisplay?: boolean) => Promise<ReturnType<SerialSession['snapshot']>>
    resize: (size: TerminalSize) => Promise<void>
}

export function installSerialIpc (manager: SessionManager): void {
    const views = new Map<string, View>()

    function listen (action: string, handler: (event: IpcMainInvokeEvent, args: any) => unknown): void {
        ipcMain.handle(`coport-serial:${action}`, async (event, args) => {
            try {
                if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) {
                    throw new SerialFailure('invalid_argument', 'Serial IPC requires the main window frame')
                }
                return { ok: true, result: await handler(event, args ?? {}) }
            } catch (error) {
                if (error instanceof SerialFailure) {
                    return { ok: false, error: {
                        code: error.code, message: error.message,
                        retryable: ['port_busy', 'busy', 'queue_full', 'timeout'].includes(error.code),
                        ...(error.active ? { active: error.active } : {}),
                    } }
                }
                console.error('coport: serial IPC failed', error)
                return { ok: false, error: { code: 'channel_lost', message: error.message, retryable: false } }
            }
        })
    }

    function reserveView (session: SerialSession, sender: WebContents, window: BrowserWindow, profileId?: string): void {
        const generation = session.generation
        const pending = new Map<number, number>()
        let buffered = 0
        let sentSeq = -1
        let attachPromise: ReturnType<View['attach']> | undefined = undefined
        let attached = false
        let view: View | undefined = undefined
        const output = (event: { seq: number, bytes: Buffer }) => {
            if (!attached || sender.isDestroyed()) {
                return
            }
            buffered += event.bytes.length
            if (buffered > SERIAL_BUDGET) {
                sender.send('coport-serial:view-detached', { generation })
                view?.dispose()
                return
            }
            sentSeq = event.seq
            pending.set(event.seq, event.bytes.length)
            sender.send('coport-serial:output', event)
        }
        const ack = (seq: number) => {
            if (seq > sentSeq) {
                return
            }
            for (const [key, bytes] of pending) {
                if (key > seq) {
                    break
                }
                pending.delete(key)
                buffered -= bytes
            }
        }
        const ended = (event: object) => {
            if (!sender.isDestroyed()) {
                sender.send('coport-serial:ended', event)
            }
            view?.dispose()
        }
        const checkAttachedWindow = () => {
            if (views.get(generation) !== view || sender.isDestroyed()) {
                throw new SerialFailure('channel_lost', 'Serial view was detached')
            }
        }
        const onAck = (event: IpcMainEvent, data?: { generation: string, seq: number }) => {
            if (event.sender === sender && data?.generation === generation && Number.isSafeInteger(data.seq)) {
                ack(data.seq)
            }
        }
        const navigation = (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
            if (isMainFrame && !isInPlace) {
                view?.dispose()
            }
        }
        const dispose = () => {
            if (views.get(generation) === view) {
                views.delete(generation)
            }
            session.off('output', output)
            session.off('ended', ended)
            sender.off('destroyed', dispose)
            sender.off('render-process-gone', dispose)
            sender.off('did-start-navigation', navigation)
            ipcMain.off('coport-serial:ack', onAck)
        }
        view = {
            sender, window, profileId,
            dispose,
            attach: ({ cols, rows }, legacyDisplay) => attachPromise ??= session.afterOutput(() => {
                checkAttachedWindow()
                session.terminal.resize(cols, rows)
                const result = session.snapshot(legacyDisplay)
                attached = true
                return result
            }),
            resize: ({ cols, rows }) => session.afterOutput(() => {
                checkAttachedWindow()
                if (!attached) {
                    throw new SerialFailure('channel_lost', 'Serial view is not attached')
                }
                session.terminal.resize(cols, rows)
                sender.send('coport-serial:resized', { generation, cols, rows })
            }),
        }
        views.set(generation, view)
        session.on('output', output)
        session.on('ended', ended)
        sender.once('destroyed', dispose)
        sender.once('render-process-gone', dispose)
        sender.on('did-start-navigation', navigation)
        ipcMain.on('coport-serial:ack', onAck)
    }

    const ensureView = (terminalReplies: boolean) => async (
        { sender }: IpcMainInvokeEvent, { config, reveal, windowId, profileId, cols, rows },
    ) => {
        const window = BrowserWindow.fromWebContents(sender)!
        if (typeof reveal !== 'boolean' || (reveal && windowId !== window.id)) {
            throw new SerialFailure('invalid_argument', 'Reveal requires the caller window ID')
        }
        const savedProfile = reveal && typeof profileId === 'string' && profileId ? profileId : undefined
        const { session, reused } = await manager.ensure(config, terminalReplies, savedProfile, reveal ? terminalSize({ cols, rows }) : undefined)
        const generation = session.generation
        if (reveal && !sender.isDestroyed()) {
            const existing = views.get(generation)
            if (existing && !existing.window.isDestroyed()) {
                if (existing.window.isMinimized()) {
                    existing.window.restore()
                }
                existing.window.show()
                existing.window.focus()
                existing.sender.send('coport-serial:focus', { generation })
                return { generation, reused, focus: { windowId: existing.window.id, tabId: generation } }
            }
            session.setTerminalReplies(terminalReplies)
            reserveView(session, sender, window, savedProfile)
            return { generation, reused, activeBaudrate: session.config.baudrate }
        }
        return { generation, reused }
    }
    listen('ensure', ensureView(true))
    // Hex monitoring still parses authoritative history, without replying to bytes as terminal queries.
    listen('ensure-hex-view', ensureView(false))

    function ownedView (sender: WebContents, generation: string): View {
        manager.get(generation)
        const view = views.get(generation)
        if (view?.sender !== sender) {
            throw new SerialFailure('channel_lost', 'Serial view is not attached to this window')
        }
        return view
    }

    listen('attach', ({ sender }, args) => ownedView(sender, args.generation).attach(terminalSize(args)))
    // This private renderer path reuses the attach lifecycle for legacy output modes.
    listen('attach-display', ({ sender }, args) => ownedView(sender, args.generation).attach(terminalSize(args), true))
    listen('resize', ({ sender }, args) => ownedView(sender, args.generation).resize(terminalSize(args)))
    listen('input', ({ sender }, { generation, bytes }) => {
        ownedView(sender, generation)
        if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > SERIAL_BUDGET) {
            throw new SerialFailure('invalid_argument', 'Serial input must contain 1–65536 bytes')
        }
        return { queued: manager.get(generation).hub.enqueue(Buffer.from(bytes), 'human') }
    })
    listen('detach', ({ sender }, { generation }) => {
        const view = views.get(generation)
        if (view?.sender === sender) {
            view.dispose()
        }
    })
    listen('update-baudrate', ({ sender }, { generation, baudrate }) => {
        const view = ownedView(sender, generation)
        return manager.get(generation).changeBaudRate(baudrate, view.profileId)
    })
    listen('disconnect', ({ sender }, { generation }) => {
        ownedView(sender, generation)
        return manager.disconnect(generation)
    })
}
