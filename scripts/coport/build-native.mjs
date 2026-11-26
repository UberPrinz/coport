import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform === 'darwin') {
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const { electronVersion } = await import('../vars.mjs')
    const headers = [
        process.env.npm_config_nodedir && resolve(process.env.npm_config_nodedir, 'include/node'),
        resolve(dirname(realpathSync(process.execPath)), '../include/node'),
        resolve(homedir(), '.electron-gyp', electronVersion, 'include/node'),
    ].find(path => path && existsSync(resolve(path, 'node_api.h')))
    if (!headers) {
        throw new Error('Node-API headers unavailable. Set npm_config_nodedir to the Node or Electron headers directory.')
    }
    const output = resolve(root, 'app/dist/coport-queued-read.node')
    mkdirSync(dirname(output), { recursive: true })
    execFileSync('clang', [
        '-bundle', '-undefined', 'dynamic_lookup', '-arch', process.env.ARCH ?? process.arch,
        '-I', headers, '-o', output, resolve(root, 'app/lib/coport/queuedRead.c'),
    ], { stdio: 'inherit' })
    const shim = resolve(root, 'dist/coport-mcp')
    mkdirSync(dirname(shim), { recursive: true })
    const arch = process.env.ARCH ?? process.arch
    execFileSync('swiftc', [
        '-O', '-target', `${arch === 'x64' ? 'x86_64' : arch}-apple-macosx12.0`,
        '-o', shim, 'extras/coport-mcp/main.swift', 'extras/coport-mcp/UnixSocket.swift',
    ], { cwd: root, stdio: 'inherit' })
    execFileSync('codesign', ['--force', '--sign', '-', shim], { stdio: 'inherit' })
}
