const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { createRequire } = require('node:module')
const requireProbe = createRequire(path.resolve('dist/coport-m0/probe-deps/package.json'))
const { app } = require('electron')
const { McpServer } = requireProbe('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = requireProbe('@modelcontextprotocol/sdk/server/stdio.js')
const { CallToolRequestSchema, ListToolsRequestSchema } = requireProbe('@modelcontextprotocol/sdk/types.js')

const dir = path.resolve(process.argv[2])
app.setPath('userData', path.join(dir, 'electron'))
const endpoint = path.join(dir, 'sdk.sock')
assert.ok(Buffer.byteLength(endpoint) < 104)
const fixture = JSON.parse(fs.readFileSync(path.join(dir, 'swift.json'), 'utf8'))

function toolResult(structuredContent) {
    return {
        content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
        structuredContent,
        isError: Object.hasOwn(structuredContent, 'error'),
    }
}

function serve() {
    let halfLineOwner
    let orphaned = false
    const listener = net.createServer({ allowHalfOpen: true }, socket => {
        const mcp = new McpServer({ name: 'Coport', version: '1.0.0' })
        // Reuse the SDK's newline framing on the Unix stream. Use low-level
        // handlers so the SDK does not translate Coport's exact tool schemas.
        const transport = new StdioServerTransport(socket, socket)
        mcp.server.registerCapabilities({ tools: {} })
        mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: fixture.tools }))
        mcp.server.setRequestHandler(CallToolRequestSchema, ({ params: { name, arguments: args = {} } }) => {
            if (name === 'write_serial' && args.data === 'half') {
                halfLineOwner = socket
                return toolResult({ bytes_queued: 4 })
            }
            if (name === 'write_serial' && args.data === 'do not append\r') {
                assert.ok(orphaned)
                return toolResult({ error: { code: 'busy', message: 'Unsubmitted input', retryable: true } })
            }
            const sample = fixture.calls.find(call => call.name === name)
            assert.ok(sample)
            return toolResult(sample.result.structuredContent)
        })
        const close = () => {
            if (socket === halfLineOwner) {
                orphaned = true
                halfLineOwner = undefined
                console.log('orphan protected')
            }
            void mcp.close()
        }
        socket.once('close', close)
        socket.once('end', () => socket.end())
        socket.on('error', error => console.error(error))
        mcp.connect(transport).catch(error => socket.destroy(error))
    })
    listener.on('error', error => {
        console.error(error)
        app.exit(1)
    })
    listener.listen(endpoint, () => fs.chmodSync(endpoint, 0o600))
}

app.whenReady().then(serve)
