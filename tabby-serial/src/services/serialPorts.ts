const wchNode = /^\/dev\/cu\.wchusbserial(.+)$/

interface ListedPort {
    path: string
    manufacturer?: string
    serialNumber?: string
}

export function serialPortWeight (path: string): number {
    return wchNode.test(path) ? 1.9 : 2
}

// coport: Keep all upstream-listed ports while preferring the WCH driver.
export function formatSerialPorts (ports: ListedPort[]): { name: string, description?: string }[] {
    const adapters = new Set(ports.map(port => wchNode.exec(port.path)?.[1]).filter(Boolean))
    return ports.map(port => {
        const appleSuffix = /^\/dev\/cu\.usbserial-(.+)$/.exec(port.path)?.[1]
        const name = `${port.manufacturer ?? ''} ${port.serialNumber ?? ''}`.trim()
        const description = [name, appleSuffix && adapters.has(appleSuffix) && '苹果驱动，高波特率可能失真'].filter(Boolean).join(' · ')
        return { name: port.path, description: description || undefined }
    }).sort((a, b) => serialPortWeight(a.name) - serialPortWeight(b.name))
}
