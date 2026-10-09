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

const isPlaceholder = el => el.hasAttribute(CHUNK_ATTRIBUTE)

// A copy of a wrapper cut across chunks: it holds placeholders among its children
const isCut = el => !isPlaceholder(el) && Array.prototype.some.call(el.children, isPlaceholder)

const topLevel = (doc, node) => {
    let el = node?.nodeType === 1 ? node : node?.parentElement
    while (el && el.parentElement !== doc.body) el = el.parentElement
    return el
}

const childIndex = (parent, node) => Array.prototype.indexOf.call(parent.children, node)

// The section's own children of an element: not the nodes a reader adds to a
// rendered document, which it marks cfi-inert as they are not in the book
const ownChildren = el => Array.prototype.filter.call(el.children,
    child => !child.hasAttribute('cfi-inert'))

// The element at a path of child indices from the body
const atPath = (doc, path) => path?.reduce((el, i) => el && ownChildren(el)[i], doc.body) ?? null

/**
 * Parse `html` the way an iframe's srcdoc does and cut its body into `count`
 * chunks of about equal size. The cuts fall between top-level children, and
 * between the children of a top-level element bigger than a chunk (a wrapper
 * around the text); a wrapper inside a wrapper stays whole, and the chunks it
 * spans are empty.
 * Returns `{ count, chunkOf, chunk, isEmpty, locate, fraction }`: the chunk of
 * each top-level element (an array over its children for a cut wrapper), the
 * HTML of chunk `k` (built on demand), whether chunk `k` holds nothing, the
 * chunk holding an anchor, and the section fraction of a fraction of a chunk.
 * The parsed section itself is not kept.
 */
export const splitSection = (html, count) => {
    const doc = parse(html)
    const { body } = doc
    const kept = node => node.nodeType === 1 || node.nodeType === 3
    const markupOf = node => node.nodeType === 1
        ? node.outerHTML : escapeText(node.textContent)
    const top = Array.from(body.childNodes).filter(kept)
    const topMarkup = top.map(markupOf)
    const limit = topMarkup.reduce((sum, s) => sum + s.length, 0) / count

    // The pieces chunks are made of: top-level nodes, or for a cut wrapper,
    // its own children. Text goes with the piece before it, so a chunk never
    // holds text alone.
    const units = []
    const parts = top.map((node, i) => {
        if (node.nodeType === 1 && topMarkup[i].length > limit && node.firstElementChild) {
            const kids = Array.from(node.childNodes).filter(kept)
                .map(child => ({ node: child, markup: markupOf(child) }))
            units.push(...kids)
            return { node, kids,
                open: `<${node.localName}${attrs(node)}>`, close: `</${node.localName}>` }
        }
        const unit = { node, markup: topMarkup[i] }
        units.push(unit)
        return unit
    })
    const total = units.reduce((sum, unit) => sum + unit.markup.length, 0)
    const starts = [] // chunk -> offset of its first piece
    let size = 0, current = 0
    for (const unit of units) {
        if (unit.node.nodeType === 1) {
            current = Math.min(count - 1, Math.floor(size / total * count))
            starts[current] ??= size
        }
        unit.chunk = current
        size += unit.markup.length
    }
    // Placeholders stand in for elements outside a chunk; text carries no
    // element index and is dropped there
    const holderOf = (node, chunk) => node.nodeType === 1 ? placeholder(node, chunk) : ''
    for (const unit of units) unit.holder = holderOf(unit.node, unit.chunk)
    const chunkOf = []
    for (const part of parts) {
        if (part.kids) {
            const kids = part.kids.filter(kid => kid.node.nodeType === 1)
            part.chunks = new Set(kids.map(kid => kid.chunk))
            part.holder = holderOf(part.node, kids[0].chunk)
            chunkOf.push(kids.map(kid => kid.chunk))
        } else if (part.node.nodeType === 1) chunkOf.push(part.chunk)
    }

    // The path to the element holding each id, for anchors resolved by id
    const ids = new Map()
    const indexOf = new Map()
    Array.from(body.children, (el, t) => {
        indexOf.set(el, t)
        if (Array.isArray(chunkOf[t])) Array.from(el.children, (child, c) => indexOf.set(child, c))
    })
    for (const el of body.querySelectorAll('[id]')) {
        if (ids.has(el.id)) continue
        const t = topLevel(doc, el)
        const path = [indexOf.get(t)]
        if (Array.isArray(chunkOf[path[0]]) && el !== t) {
            let child = el
            while (child.parentElement !== t) child = child.parentElement
            path.push(indexOf.get(child))
        }
        ids.set(el.id, path)
    }

    const style = doc.createElement('style')
    style.textContent = `[${CHUNK_ATTRIBUTE}] { display: none !important; }`
    doc.head.append(style)
    const prefix = `<!DOCTYPE html><html${attrs(doc.documentElement)}>`
        + `${doc.head.outerHTML}<body${attrs(body)}>`
    const suffix = '</body></html>'
    // keep markup only, not the parsed section
    for (const unit of units) delete unit.node
    for (const part of parts) delete part.node

    const piece = (unit, k) => unit.chunk === k ? unit.markup : unit.holder
    const chunk = k => prefix + parts.map(part => !part.kids ? piece(part, k)
        // the skeleton (k = -1) keeps a cut wrapper's children as placeholders
        : k < 0 || part.chunks.has(k)
            ? part.open + part.kids.map(kid => piece(kid, k)).join('') + part.close
            : part.holder).join('') + suffix

    const isEmpty = k => starts[k] == null
    const bounds = k => {
        let end = k + 1
        while (end < count && isEmpty(end)) end++
        return [starts[k], starts[end] ?? total]
    }
    const atFraction = f => {
        const pos = f * total
        let k = Math.min(count - 1, Math.floor(f * count))
        while (k > 0 && (isEmpty(k) || starts[k] > pos)) k--
        const [start, end] = bounds(k)
        return { chunk: k, anchor: Math.max(0, Math.min(1, (pos - start) / (end - start))) }
    }
    const fraction = (k, f) => {
        if (isEmpty(k)) return k / count
        const [start, end] = bounds(k)
        return (start + f * (end - start)) / total
    }

    // Every top-level element as a placeholder, and the children of cut
    // wrappers: enough to tell which chunk an anchor lands in, at a fraction
    // of the section's nodes
    let skeleton
    const getSkeleton = () => {
        if (skeleton) return skeleton
        skeleton = parse(chunk(-1))
        skeleton.getElementById = id => atPath(skeleton, ids.get(id))
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
        if (typeof target === 'number') return atFraction(target)
        const container = target?.startContainer
        const node = container
            ? container.childNodes[target.startOffset] ?? container : target
        const el = topLevel(doc, node)
        if (!el) return null
        const chunks = chunkOf[childIndex(doc.body, el)]
        if (!Array.isArray(chunks)) return { chunk: chunks ?? 0 }
        // in a cut wrapper, the chunk of its element holding the target
        let child = node
        while (child && child.parentNode !== el) child = child.parentNode
        while (child && child.nodeType !== 1) child = child.previousSibling
        return { chunk: chunks[child ? childIndex(el, child) : 0] }
    }
    /** @type {(anchor: number | Function) => { chunk: number, anchor?: number }} */
    const locate = anchor => typeof anchor === 'number' ? atFraction(anchor)
        : resolve(getSkeleton(), anchor) ?? resolve(getFull(), anchor) ?? { chunk: 0 }

    return { count, chunkOf, chunk, isEmpty, locate, fraction }
}

/**
 * In a chunk document, an anchor at the element where the next chunk
 * (`direction` 1) starts or the previous one (-1) ends, for reading on past
 * the chunk; null at either end of the section, and in a document that isn't
 * a chunk.
 */
export const adjacentChunkAnchor = (doc, direction) => {
    // the chunk's pieces in order, with their paths
    const pieces = []
    if (doc.body) ownChildren(doc.body).forEach((el, t) => {
        if (isCut(el)) ownChildren(el).forEach((child, c) => pieces.push([child, [t, c]]))
        else pieces.push([el, [t]])
    })
    const own = ([el]) => !isPlaceholder(el)
    const edge = direction > 0 ? pieces.findLastIndex(own) : pieces.findIndex(own)
    const path = edge < 0 ? null : pieces[edge + direction]?.[1]
    if (!path) return null
    return doc => {
        let el = atPath(doc, path)
        // back into a wrapper cut across chunks: its last element
        if (direction < 0 && el && isCut(el)) el = ownChildren(el).at(-1)
        const range = doc.createRange()
        range.selectNodeContents(el)
        range.collapse(true)
        return range
    }
}
