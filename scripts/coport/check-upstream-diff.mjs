#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const baseline = process.argv[2] ?? '54869e1'
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
const revision = git('rev-parse', '--verify', '--end-of-options', `${baseline}^{commit}`).trim()
const paths = value => value.split('\0').filter(Boolean)
const upstream = new Set(paths(git('ls-tree', '-r', '--name-only', '-z', revision)))
const changed = new Set([
    ...paths(git('diff', '--name-only', '--no-renames', '-z', revision, '--')),
    ...paths(git('ls-files', '--others', '--exclude-standard', '-z')),
])
const register = readFileSync(new URL('../../docs/coport/upstream-changes.md', import.meta.url), 'utf8')
const rows = register.split('\n').filter(line => line.startsWith('|')).map(line => line.split('|')[1])
const rules = rows.flatMap(cell => [...cell.matchAll(/`([^`]+)`/g)].map(match => match[1]))
const names = new Set(rules.filter(rule => !rule.endsWith('*')))
const newPaths = rules.filter(rule => rule.endsWith('*')).map(rule => rule.slice(0, -1))

const unexpected = [...changed].filter(path => !names.has(path) &&
    (upstream.has(path) || !newPaths.some(prefix => path.startsWith(prefix))))
if (unexpected.length) {
    console.error(`Unregistered Coport changes against ${revision.slice(0, 8)}:\n${unexpected.sort().join('\n')}`)
    process.exitCode = 1
} else {
    console.log(`Coport upstream diff passed against ${revision.slice(0, 8)} (${changed.size} registered paths)`)
}
