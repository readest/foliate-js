// Split one huge section into chunk documents that render on their own.
//
// A spine item holding a whole book (a 20 MB concordance, ~85k top-level
// elements) is too much for a browser to lay out and paint as one paginated
// document: pre-paint in a multi-column container walks every sibling once per
// column. Each chunk document keeps the section's <html>, <head> and <body>,
// carries the top-level children of its own range in full, and stands in for
// every other top-level child with an empty, hidden placeholder of the same
// tag. Element indices are therefore identical to the full section, so a CFI
// taken in a chunk is the section's CFI, and one resolved in the right chunk
// lands on the same node.

export const CHUNK_ATTRIBUTE = 'data-foliate-chunk'

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img',
    'input', 'link', 'meta', 'source', 'track', 'wbr'])

const escapeText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
const attrs = el => Array.from(el.attributes, a => ` ${a.name}="${escapeAttr(a.value)}"`).join('')

const placeholder = (el, chunk) => VOID_ELEMENTS.has(el.localName)
    ? `<${el.localName} ${CHUNK_ATTRIBUTE}="${chunk}">`
    : `<${el.localName} ${CHUNK_ATTRIBUTE}="${chunk}"></${el.localName}>`

const parse = html => new DOMParser().parseFromString(html, 'text/html')

const topLevel = (doc, node) => {
    let el = node?.nodeType === 1 ? node : node?.parentElement
    while (el && el.parentElement !== doc.body) el = el.parentElement
    return el
}

/**
 * Parse `html` the way an iframe's srcdoc does and cut its body into `count`
 * chunks of about equal size, between top-level children.
 * Returns `{ count, chunkOf, chunk, locate }`: the chunk of each top-level
 * element, the HTML of chunk `k` (built on demand), and the chunk holding the
 * target of an anchor function. The parsed section itself is not kept.
 */
export const splitSection = (html, count) => {
    const doc = parse(html)
    const { body } = doc
    const nodes = Array.from(body.childNodes)
        .filter(node => node.nodeType === 1 || node.nodeType === 3)
    const markup = nodes.map(node => node.nodeType === 1
        ? node.outerHTML : escapeText(node.textContent))
    const total = markup.reduce((sum, s) => sum + s.length, 0)

    // Chunk of every node, cut at about equal shares of the markup
    const nodeChunk = []
    let size = 0
    for (const s of markup) {
        nodeChunk.push(Math.min(count - 1, Math.floor(size / total * count)))
        size += s.length
    }
    const chunkOf = []
    nodes.forEach((node, i) => { if (node.nodeType === 1) chunkOf.push(nodeChunk[i]) })
    // Placeholders stand in for elements outside a chunk; text carries no
    // element index and is dropped there
    const holders = nodes.map((node, i) => node.nodeType === 1 ? placeholder(node, nodeChunk[i]) : '')

    // The top-level element holding each id, for anchors resolved by id
    const ids = new Map()
    const elements = Array.from(body.children)
    const indexOf = new Map(elements.map((el, i) => [el, i]))
    for (const el of body.querySelectorAll('[id]'))
        if (!ids.has(el.id)) ids.set(el.id, indexOf.get(topLevel(doc, el)))

    const style = doc.createElement('style')
    style.textContent = `[${CHUNK_ATTRIBUTE}] { display: none !important; }`
    doc.head.append(style)
    const prefix = `<!DOCTYPE html><html${attrs(doc.documentElement)}>`
        + `${doc.head.outerHTML}<body${attrs(body)}>`
    const suffix = '</body></html>'

    const chunk = k => prefix
        + nodes.map((_, i) => nodeChunk[i] === k ? markup[i] : holders[i]).join('')
        + suffix

    // Every top-level element as a placeholder: enough to tell which chunk an
    // anchor lands in, at a fraction of the section's nodes
    let skeleton
    const getSkeleton = () => {
        if (skeleton) return skeleton
        skeleton = parse(chunk(-1))
        skeleton.getElementById = id => skeleton.body.children[ids.get(id)] ?? null
        return skeleton
    }
    // The full section, parsed again only for anchors the skeleton can't place
    // (such as a CFI into another chunk's element); memory may reclaim it
    let full
    const getFull = () => {
        let doc = full?.deref()
        if (!doc) full = new WeakRef(doc = parse(html))
        return doc
    }
    const resolve = (doc, anchor) => {
        let target
        try { target = anchor(doc) } catch { return null }
        if (typeof target === 'number') {
            const k = Math.min(count - 1, Math.floor(target * count))
            return { chunk: k, anchor: target * count - k }
        }
        const el = topLevel(doc, target?.startContainer ?? target)
        return el ? { chunk: chunkOf[Array.prototype.indexOf.call(doc.body.children, el)] ?? 0 } : null
    }
    const locate = anchor => resolve(getSkeleton(), anchor)
        ?? resolve(getFull(), anchor) ?? { chunk: 0 }

    return { count, chunkOf, chunk, locate }
}

/**
 * In a chunk document, the index among the body's children of the element
 * where the next chunk (`direction` 1) starts or the previous one (-1) ends,
 * for reading on past the chunk; -1 at either end of the section, and in a
 * document that isn't a chunk.
 */
export const adjacentChunkElement = (doc, direction) => {
    const children = doc.body?.children ?? []
    const isPlaceholder = el => el.hasAttribute(CHUNK_ATTRIBUTE)
    if (direction > 0) {
        let last = children.length - 1
        while (last >= 0 && isPlaceholder(children[last])) last--
        return last >= 0 && last < children.length - 1 ? last + 1 : -1
    }
    let first = 0
    while (first < children.length && isPlaceholder(children[first])) first++
    return first > 0 && first < children.length ? first - 1 : -1
}
