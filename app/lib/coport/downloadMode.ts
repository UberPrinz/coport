export function resolveAtomicDownloadMode (
    mode: number | undefined,
    umask: number,
    existingMode: number | undefined,
    preserveExistingMode: boolean,
): number {
    if (preserveExistingMode) {
        return existingMode === undefined ? (mode ?? 0o666) & 0o777 & ~umask : existingMode & 0o7777
    }

    const requestedMode = ((mode ?? 0) & 0o777 || 0o666) & ~umask
    return existingMode === undefined ? requestedMode : (existingMode & 0o7000) | (existingMode & requestedMode)
}
