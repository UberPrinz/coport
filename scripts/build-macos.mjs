#!/usr/bin/env node
/* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
import { build as builder } from 'electron-builder'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as vars from './vars.mjs'

const isTag = (process.env.GITHUB_REF || '').startsWith('refs/tags/')

process.env.ARCH = process.env.ARCH || process.arch

// coport: This fork ships ad-hoc signed macOS packages, including PR builds.
for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME']) {
    delete process.env[name]
}
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
process.env.CSC_FOR_PULL_REQUEST = 'true'

const codesign = promisify(execFile)
async function signCoport ({ app }) {
    await codesign('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app])
    await codesign('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
}

builder({
    dir: true,
    mac: ['dmg', 'zip'],
    x64: process.env.ARCH === 'x86_64',
    arm64: process.env.ARCH === 'arm64',
    config: {
        extraMetadata: {
            version: vars.version,
        },
        forceCodeSigning: true,
        ...(process.env.COPORT_BUILD_OUTPUT ? { directories: { output: process.env.COPORT_BUILD_OUTPUT } } : {}),
        ...(process.env.COPORT_ELECTRON_DIST ? { electronDist: process.env.COPORT_ELECTRON_DIST } : {}),
        mac: {
            identity: '-',
            sign: signCoport,
            notarize: false,
        },
        npmRebuild: process.env.ARCH !== 'arm64',
        publish: process.env.KEYGEN_TOKEN ? [
            vars.keygenConfig,
            {
                provider: 'github',
                channel: `latest-${process.env.ARCH}`,
            },
        ] : undefined,
    },
    publish: (process.env.KEYGEN_TOKEN && isTag) ? 'always' : 'never',
}).catch(e => {
    console.error(e)
    process.exit(1)
})
