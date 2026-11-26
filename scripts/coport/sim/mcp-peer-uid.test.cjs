const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { createConnection } = require('node:net')
const { join } = require('node:path')
const { test } = require('node:test')
const { McpHost } = require('../../../dist/coport-m1/compiled/mcpHost.js')

test('closes a foreign peer before MCP handling', { timeout: 3000 }, async t => {
    const directory = await mkdtemp('/tmp/cp-peer-')
    const endpoint = join(directory, 'mcp.sock')
    const peerUid = t.mock.fn(() => process.getuid() + 1)
    const host = new McpHost({}, endpoint, peerUid)
    const accept = t.mock.method(host, 'accept')
    try {
        await host.start()
        const socket = createConnection(endpoint)
        try {
            const reply = await new Promise((resolve, reject) => {
                const chunks = []
                socket.once('connect', () => {
                    socket.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n')
                })
                socket.on('data', chunk => chunks.push(chunk))
                socket.once('error', error => {
                    if (!['ECONNRESET', 'EPIPE'].includes(error.code)) {
                        reject(error)
                    }
                })
                socket.once('close', () => resolve(Buffer.concat(chunks)))
                socket.setTimeout(1500, () => reject(new Error('MCP peer stayed connected')))
            })
            assert.equal(peerUid.mock.callCount(), 1)
            assert.equal(reply.length, 0)
            assert.equal(accept.mock.callCount(), 0)
        } finally {
            socket.destroy()
        }
    } finally {
        await host.stop()
        await rm(directory, { recursive: true, force: true })
    }
})
