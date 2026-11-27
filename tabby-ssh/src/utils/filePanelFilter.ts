export interface FilterableFileEntry {
    name: string
    isDirectory: boolean
}

export interface TextHighlightSegment {
    text: string
    highlighted: boolean
}

export interface FileMatchResult {
    tier: 0 | 1 | 2 | 3
    ranges: (readonly [number, number])[]
}

export interface FilteredFileEntry<T extends FilterableFileEntry> {
    item: T
    tier: 0 | 1 | 2 | 3
    ranges: (readonly [number, number])[]
    segments: TextHighlightSegment[]
}

const nameCollator = typeof Intl !== 'undefined' && typeof Intl.Collator === 'function'
    ? new Intl.Collator()
    : null

export function compareFileNames (a: string, b: string): number {
    if (nameCollator) {
        return nameCollator.compare(a, b)
    }
    return a.localeCompare(b)
}

export function sortFileEntries<T extends FilterableFileEntry> (entries: readonly T[]): T[] {
    return [...entries].sort((a, b) => {
        const dirDiff = (b.isDirectory ? 1 : 0) - (a.isDirectory ? 1 : 0)
        if (dirDiff !== 0) {
            return dirDiff
        }
        return compareFileNames(a.name, b.name)
    })
}

export function mergeHighlightRanges (indices: readonly number[]): (readonly [number, number])[] {
    if (indices.length === 0) {
        return []
    }
    const ranges: (readonly [number, number])[] = []
    let start = indices[0]
    let end = start + 1
    for (let i = 1; i < indices.length; i++) {
        const idx = indices[i]
        if (idx <= end) {
            if (idx + 1 > end) {
                end = idx + 1
            }
        } else {
            ranges.push([start, end])
            start = idx
            end = idx + 1
        }
    }
    ranges.push([start, end])
    return ranges
}

export function splitTextByHighlights (text: string, ranges: readonly (readonly [number, number])[]): TextHighlightSegment[] {
    if (!text) {
        return []
    }
    if (ranges.length === 0) {
        return [{ text, highlighted: false }]
    }
    const segments: TextHighlightSegment[] = []
    let cursor = 0
    for (const [rawStart, rawEnd] of ranges) {
        const start = Math.max(cursor, Math.min(rawStart, text.length))
        const end = Math.max(start, Math.min(rawEnd, text.length))
        if (start > cursor) {
            segments.push({ text: text.slice(cursor, start), highlighted: false })
        }
        if (end > start) {
            segments.push({ text: text.slice(start, end), highlighted: true })
        }
        cursor = end
    }
    if (cursor < text.length) {
        segments.push({ text: text.slice(cursor), highlighted: false })
    }
    return segments
}

function buildLowerToOrigMap (name: string, fullLower: string): number[] {
    const map: number[] = []
    let prevLowerLen = 0
    for (let i = 0; i < name.length; ) {
        const code = name.charCodeAt(i)
        const step = code >= 0xD800 && code <= 0xDBFF && i + 1 < name.length ? 2 : 1
        const nextLowerLen = name.slice(0, i + step).toLowerCase().length
        const delta = nextLowerLen - prevLowerLen
        for (let j = 0; j < delta; j++) {
            map.push(i + Math.min(j, step - 1))
        }
        prevLowerLen = nextLowerLen
        i += step
    }
    while (map.length < fullLower.length) {
        map.push(Math.max(0, name.length - 1))
    }
    return map
}

function mapLowerSpanToRanges (
    start: number,
    end: number,
    map: readonly number[] | null,
    nameLength: number,
): (readonly [number, number])[] {
    if (!map) {
        return [[start, Math.min(end, nameLength)]]
    }
    const indices: number[] = []
    for (let i = start; i < end && i < map.length; i++) {
        indices.push(map[i])
    }
    return mergeHighlightRanges(indices)
}

export function matchFileName (name: string, query: string): FileMatchResult | null {
    const lowerQuery = query.toLowerCase()
    if (!lowerQuery) {
        return { tier: 0, ranges: [] }
    }
    const lowerName = name.toLowerCase()
    const lowerToOrig = lowerName.length === name.length ? null : buildLowerToOrigMap(name, lowerName)
    const queryLen = lowerQuery.length
    const nameLen = lowerName.length

    if (queryLen > nameLen) {
        return null
    }

    if (lowerName === lowerQuery) {
        return {
            tier: 0,
            ranges: [[0, name.length]],
        }
    }

    if (lowerName.startsWith(lowerQuery)) {
        return {
            tier: 1,
            ranges: mapLowerSpanToRanges(0, queryLen, lowerToOrig, name.length),
        }
    }

    const substringIndex = lowerName.indexOf(lowerQuery)
    if (substringIndex !== -1) {
        return {
            tier: 2,
            ranges: mapLowerSpanToRanges(substringIndex, substringIndex + queryLen, lowerToOrig, name.length),
        }
    }

    const matchedIndices: number[] = []
    let queryPos = 0
    for (let namePos = 0; namePos < nameLen && queryPos < queryLen; namePos++) {
        if (lowerName.charCodeAt(namePos) === lowerQuery.charCodeAt(queryPos)) {
            matchedIndices.push(lowerToOrig ? lowerToOrig[namePos] : namePos)
            queryPos++
        }
    }

    if (queryPos !== queryLen) {
        return null
    }

    return {
        tier: 3,
        ranges: mergeHighlightRanges(matchedIndices),
    }
}

export function filterAndSortEntries<T extends FilterableFileEntry> (
    entries: readonly T[],
    rawQuery: string,
): FilteredFileEntry<T>[] {
    if (!rawQuery || rawQuery.trim() === '') {
        return sortFileEntries(entries).map(item => ({
            item,
            tier: 0,
            ranges: [],
            segments: [{ text: item.name, highlighted: false }],
        }))
    }

    const matched: FilteredFileEntry<T>[] = []
    for (const item of entries) {
        const result = matchFileName(item.name, rawQuery)
        if (!result) {
            continue
        }
        matched.push({
            item,
            tier: result.tier,
            ranges: result.ranges,
            segments: splitTextByHighlights(item.name, result.ranges),
        })
    }

    matched.sort((a, b) => {
        if (a.tier !== b.tier) {
            return a.tier - b.tier
        }
        const dirDiff = (b.item.isDirectory ? 1 : 0) - (a.item.isDirectory ? 1 : 0)
        if (dirDiff !== 0) {
            return dirDiff
        }
        return compareFileNames(a.item.name, b.item.name)
    })

    return matched
}
