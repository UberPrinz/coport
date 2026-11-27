import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const output = 'dist/coport-m1/compiled'
const options = { cwd: repo, stdio: 'inherit' }
mkdirSync(join(repo, output), { recursive: true })
execFileSync(process.execPath, ['scripts/coport/build-native.mjs'], options)
execFileSync(process.execPath, [
    'node_modules/typescript/bin/tsc', '--target', 'es2022', '--module', 'commonjs', '--skipLibCheck',
    '--esModuleInterop', '--outDir', output, 'app/lib/coport/sessionManager.ts', 'app/lib/coport/mcpHost.ts',
], options)
for (const file of ['app/lib/coport/history.js', 'app/dist/coport-queued-read.node']) {
    copyFileSync(join(repo, file), join(repo, output, file.split('/').at(-1)))
}
writeFileSync(join(repo, output, 'package.json'), '{"type":"commonjs"}\n')
try {
    symlinkSync('../../../app/node_modules', join(repo, output, 'node_modules'))
} catch (error) {
    if (error.code !== 'EEXIST') throw error
}
execFileSync('clang', [
    'scripts/coport/sim/reopen.c', '-framework', 'ApplicationServices', '-o', 'dist/coport-m1/reopen',
], options)
