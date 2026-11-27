import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

export async function waitFor (callback, timeout = 12000) {
    const end = Date.now() + timeout
    let lastError
    while (Date.now() < end) {
        try {
            const result = await callback()
            if (result) return result
        } catch (error) {
            lastError = error
        }
        await delay(75)
    }
    throw new Error('Timed out waiting for the isolated Coport window', { cause: lastError })
}

export async function renderer (port) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    return targets.find(target => target.type === 'page' && target.url.startsWith('file:'))
}

export async function evaluate (target, expression, commandTimeout = 3000) {
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    let timeout
    try {
        await Promise.race([
            once(socket, 'open'),
            delay(2000).then(() => { throw new Error('Renderer connection timed out') }),
        ])
        const response = new Promise((resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('Renderer command timed out')), commandTimeout)
            socket.addEventListener('message', ({ data }) => {
                const message = JSON.parse(data)
                if (message.id === 1) {
                    if (message.error || message.result.exceptionDetails) {
                        reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)))
                    } else {
                        resolve(message.result.result.value)
                    }
                }
            })
            socket.addEventListener('error', reject, { once: true })
            socket.addEventListener('close', () => reject(new Error('Renderer connection closed')), { once: true })
        })
        socket.send(JSON.stringify({
            id: 1, method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
        }))
        return await response
    } finally {
        clearTimeout(timeout)
        socket.close()
    }
}
