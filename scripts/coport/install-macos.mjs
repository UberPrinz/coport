#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const expectedBundleId = 'local.coport.app'

function usage () {
    console.log(`Usage: node scripts/coport/install-macos.mjs [options]

Build, ad-hoc sign, and install Coport.app into /Applications/Coport.app.

Options:
  --skip-build       Skip build and install from existing build output
  --from <path>      Install an existing Coport.app bundle (implies --skip-build, keeps source)
  --dest <path>      Destination .app path (default: /Applications/Coport.app)
  --keep-dist-app    Keep staged Coport.app inside the build output directory
  --force-quit       Force-kill Coport processes under --dest if graceful quit times out
  -h, --help         Show this help message
`)
}

function parseArgs (argv) {
    const options = {
        skipBuild: false,
        from: null,
        dest: '/Applications/Coport.app',
        keepDistApp: false,
        forceQuit: false,
    }
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i]
        if (arg === '-h' || arg === '--help') {
            usage()
            process.exit(0)
        } else if (arg === '--skip-build') {
            options.skipBuild = true
        } else if (arg === '--keep-dist-app') {
            options.keepDistApp = true
        } else if (arg === '--force-quit') {
            options.forceQuit = true
        } else if (arg === '--from') {
            options.from = argv[++i]
            if (!options.from) throw new Error('--from requires a path')
            options.skipBuild = true
        } else if (arg === '--dest') {
            options.dest = argv[++i]
            if (!options.dest) throw new Error('--dest requires a path')
        } else {
            throw new Error(`Unknown argument: ${arg}`)
        }
    }
    if (!options.dest.endsWith('.app')) {
        throw new Error(`Destination must end with .app: ${options.dest}`)
    }
    return options
}

function run (cmd, args, opts = {}) {
    return execFileSync(cmd, args, { stdio: 'inherit', ...opts })
}

function readOutput (cmd, args, opts = {}) {
    return execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim()
}

function ensureNoSpotlightIndex (dir) {
    mkdirSync(dir, { recursive: true })
    const marker = join(dir, '.metadata_never_index')
    if (!existsSync(marker)) {
        writeFileSync(marker, '')
    }
}

function findRunningPidsForApp (appPath) {
    if (!existsSync(appPath)) return []
    const resolvedApp = realpathSync(appPath)
    const prefix = `${resolvedApp}/Contents/MacOS/`
    const output = readOutput('/bin/ps', ['-axo', 'pid=,command='])
    const pids = []
    for (const line of output.split('\n')) {
        const match = line.match(/^\s*(\d+)\s+(.*)$/)
        if (!match) continue
        const pid = Number(match[1])
        const command = match[2]
        if (pid !== process.pid && command.startsWith(prefix)) {
            pids.push(pid)
        }
    }
    return pids
}

function sleep (ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function stopRunningApp (destPath, forceQuit) {
    let pids = findRunningPidsForApp(destPath)
    if (!pids.length) return

    console.log(`Stopping running Coport at ${destPath} (PIDs: ${pids.join(', ')})...`)
    let sentAppleScriptQuit = false
    if (destPath === '/Applications/Coport.app') {
        try {
            execFileSync('/usr/bin/osascript', ['-e', `tell application id "${expectedBundleId}" to quit`], {
                stdio: 'ignore',
            })
            sentAppleScriptQuit = true
        } catch {
            // Fall through to SIGTERM below if AppleScript is unavailable.
        }
    }

    const graceDeadline = Date.now() + (sentAppleScriptQuit ? 3_000 : 0)
    while (Date.now() < graceDeadline) {
        pids = findRunningPidsForApp(destPath)
        if (!pids.length) return
        sleep(250)
    }

    pids = findRunningPidsForApp(destPath)
    if (!pids.length) return
    for (const pid of pids) {
        try {
            process.kill(pid, 'SIGTERM')
        } catch {
            // Process may have exited already.
        }
    }

    const deadline = Date.now() + 7_000
    while (Date.now() < deadline) {
        pids = findRunningPidsForApp(destPath)
        if (!pids.length) return
        sleep(250)
    }

    if (!forceQuit) {
        throw new Error(
            `Coport at ${destPath} did not exit within 10s (PIDs: ${pids.join(', ')}). ` +
            'Close it manually and re-run, or pass --force-quit.',
        )
    }

    console.log(`Force-killing remaining PIDs: ${pids.join(', ')}...`)
    for (const pid of pids) {
        try {
            process.kill(pid, 'SIGKILL')
        } catch {
            // Ignore already exited processes.
        }
    }
    const killDeadline = Date.now() + 3_000
    while (Date.now() < killDeadline) {
        pids = findRunningPidsForApp(destPath)
        if (!pids.length) return
        sleep(200)
    }
    throw new Error(`Failed to stop Coport processes: ${pids.join(', ')}`)
}

function verifyBundle (appPath) {
    if (!existsSync(appPath)) {
        throw new Error(`Bundle not found: ${appPath}`)
    }
    const bundleId = readOutput('/usr/bin/defaults', ['read', join(appPath, 'Contents/Info.plist'), 'CFBundleIdentifier'])
    if (bundleId !== expectedBundleId) {
        throw new Error(`Unexpected CFBundleIdentifier "${bundleId}" (expected "${expectedBundleId}") in ${appPath}`)
    }
    const version = readOutput('/usr/bin/defaults', ['read', join(appPath, 'Contents/Info.plist'), 'CFBundleShortVersionString'])
    const shimPath = join(appPath, 'Contents/MacOS/coport-mcp')
    if (!existsSync(shimPath)) {
        throw new Error(`Missing coport-mcp shim inside bundle: ${shimPath}`)
    }
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
    run('/usr/bin/codesign', ['--verify', '--strict', shimPath])
    return { bundleId, version, shimPath }
}

function registerLaunchServices (flag, appPath) {
    if (!existsSync(lsregister)) return
    try {
        execFileSync(lsregister, [flag, appPath], { stdio: 'ignore' })
    } catch {
        // Non-fatal; LaunchServices refreshes asynchronously.
    }
}

function shouldRegisterDest (destPath) {
    const dir = resolve(dirname(destPath))
    return dir === '/Applications' || dir === resolve(homedir(), 'Applications')
}

function atomicInstall (sourceApp, destApp) {
    const destDir = resolve(dirname(destApp))
    const destName = basename(destApp)
    mkdirSync(destDir, { recursive: true })
    const staged = join(destDir, `.${destName}.installing.${process.pid}`)
    const backup = join(destDir, `.${destName}.backup.${process.pid}`)
    rmSync(staged, { recursive: true, force: true })
    rmSync(backup, { recursive: true, force: true })

    let movedExisting = false
    try {
        run('/usr/bin/ditto', [sourceApp, staged])
        verifyBundle(staged)
        if (existsSync(destApp)) {
            renameSync(destApp, backup)
            movedExisting = true
        }
        renameSync(staged, destApp)
        if (movedExisting) {
            rmSync(backup, { recursive: true, force: true })
            movedExisting = false
        }
    } catch (error) {
        rmSync(staged, { recursive: true, force: true })
        if (movedExisting && !existsSync(destApp) && existsSync(backup)) {
            renameSync(backup, destApp)
        }
        throw error
    }
}

function main () {
    if (process.platform !== 'darwin') {
        throw new Error('scripts/coport/install-macos.mjs only supports macOS.')
    }

    const options = parseArgs(process.argv.slice(2))
    const arch = process.env.ARCH || process.arch
    const distRoot = resolve(root, 'dist')
    const buildOutput = resolve(root, process.env.COPORT_BUILD_OUTPUT || 'dist/coport-install')
    const defaultSourceApp = join(buildOutput, `mac-${arch}`, 'Coport.app')
    const sourceApp = options.from ? resolve(options.from) : defaultSourceApp
    const destApp = resolve(options.dest)

    ensureNoSpotlightIndex(distRoot)

    if (!options.skipBuild) {
        if (buildOutput !== distRoot && buildOutput.startsWith(`${distRoot}/`)) {
            rmSync(buildOutput, { recursive: true, force: true })
        }
        const buildEnv = {
            ...process.env,
            ARCH: arch,
            COPORT_BUILD_OUTPUT: buildOutput,
        }
        console.log(`Building Coport for macOS (${arch}) into ${buildOutput}...`)
        run('npm', ['run', 'build'], { cwd: root, env: buildEnv })
        run(process.execPath, ['scripts/prepackage-plugins.mjs'], { cwd: root, env: buildEnv })
        run(process.execPath, ['scripts/build-macos.mjs'], { cwd: root, env: buildEnv })
    }

    console.log(`Verifying source bundle: ${sourceApp}`)
    verifyBundle(sourceApp)

    stopRunningApp(destApp, options.forceQuit)

    console.log(`Installing to ${destApp}...`)
    atomicInstall(sourceApp, destApp)
    const installed = verifyBundle(destApp)

    if (!options.from && !options.keepDistApp && existsSync(sourceApp)) {
        registerLaunchServices('-u', sourceApp)
        rmSync(sourceApp, { recursive: true, force: true })
    }
    if (shouldRegisterDest(destApp)) {
        registerLaunchServices('-f', destApp)
    }

    console.log('')
    console.log(`Installed Coport ${installed.version} (${installed.bundleId})`)
    console.log(`  App:        ${destApp}`)
    console.log(`  coport-mcp: ${installed.shimPath}`)
    if (!options.from && existsSync(buildOutput)) {
        const archives = readdirSync(buildOutput)
            .filter(name => name.endsWith('.dmg') || name.endsWith('.zip'))
            .sort()
            .map(name => join(buildOutput, name))
        if (archives.length) {
            console.log(`  Archives:   ${archives.join(', ')}`)
        }
    }
}

main()
