export interface SelectorOption<T> {
    name: string
    description?: string
    group?: string
    result?: T
    icon?: string
    freeInputPattern?: string
    freeInputEquivalent?: string
    color?: string
    weight?: number
    searchOrderGroup?: string // coport: Preserve rank among matched sibling entries.
    searchOrderPriority?: number
    callback?: (string?) => void
}

// coport: Reorder matched siblings without moving unrelated search results.
export function orderMatchedSiblings<T> (options: SelectorOption<T>[]): void {
    const siblingIndexes = new Map<string, number[]>()
    options.forEach((option, index) => {
        if (option.searchOrderGroup) {
            const indexes = siblingIndexes.get(option.searchOrderGroup) ?? []
            indexes.push(index)
            siblingIndexes.set(option.searchOrderGroup, indexes)
        }
    })
    for (const indexes of siblingIndexes.values()) {
        const siblings = indexes.map(index => options[index])
            .sort((a, b) => (a.searchOrderPriority ?? 0) - (b.searchOrderPriority ?? 0))
        indexes.forEach((index, position) => { options[index] = siblings[position] })
    }
}
