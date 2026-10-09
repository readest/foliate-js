const walkRange = (range, walker) => {
    const nodes = []
    for (let node = walker.currentNode; node; node = walker.nextNode()) {
        const compare = range.comparePoint(node, 0)
        if (compare === 0) nodes.push(node)
        else if (compare > 0) break
    }
    return nodes
}

const walkDocument = (_, walker) => {
    const nodes = []
    for (let node = walker.nextNode(); node; node = walker.nextNode())
        nodes.push(node)
    return nodes
}

const filter = NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
    | NodeFilter.SHOW_CDATA_SECTION

const acceptNode = node => {
    if (node.nodeType === 1) {
        const name = node.tagName.toLowerCase()
        if (name === 'script' || name === 'style') return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_SKIP
    }
    return NodeFilter.FILTER_ACCEPT
}

// Where to start walking a range: at its start, unless that lies in a subtree
// the filter rejects, which a walk from the root would never enter. Walking
// from the root instead revisits every node before the range, once per range:
// quadratic over the blocks of a flat document, such as a single-file book.
const rangeStart = (range, root, filterFunc) => {
    for (let node = range.startContainer; node && node !== root; node = node.parentNode)
        if (node.nodeType === 1 && filterFunc(node) === NodeFilter.FILTER_REJECT) return root
    return range.startContainer
}

export const textWalker = function* (x, func, filterFunc) {
    const root = x.commonAncestorContainer ?? x.body ?? x
    const walker = document.createTreeWalker(root, filter, { acceptNode: filterFunc || acceptNode })
    const walk = x.commonAncestorContainer ? walkRange : walkDocument
    if (x.commonAncestorContainer) walker.currentNode = rangeStart(x, root, filterFunc || acceptNode)
    const nodes = walk(x, walker)
    const strs = nodes.map(node => node.nodeValue ?? '')
    const makeRange = (startIndex, startOffset, endIndex, endOffset) => {
        const range = document.createRange()
        range.setStart(nodes[startIndex], startOffset)
        range.setEnd(nodes[endIndex], endOffset)
        return range
    }
    for (const match of func(strs, makeRange)) yield match
}
