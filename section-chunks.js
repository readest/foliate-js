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

/**
 * Parse `html` the way an iframe's srcdoc does and cut its body into `count`
 * chunks of about equal size, between top-level children.
 * Returns `{ doc, chunks, chunkOf }`: the parsed full document (for resolving
 * anchors), the chunk documents as HTML strings, and the chunk of each
 * top-level element.
 */
export const splitSection = (html, count) => {
    const doc = new DOMParser().parseFromString(html, 'text/html')
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

    const style = doc.createElement('style')
    style.textContent = `[${CHUNK_ATTRIBUTE}] { display: none !important; }`
    doc.head.append(style)
    const prefix = `<!DOCTYPE html><html${attrs(doc.documentElement)}>`
        + `${doc.head.outerHTML}<body${attrs(body)}>`
    style.remove()
    const suffix = '</body></html>'

    const chunks = []
    for (let chunk = 0; chunk < count; chunk++) {
        const parts = [prefix]
        nodes.forEach((node, i) => {
            if (nodeChunk[i] === chunk) parts.push(markup[i])
            // text outside the chunk carries no element index; drop it
            else if (node.nodeType === 1) parts.push(placeholder(node, nodeChunk[i]))
        })
        parts.push(suffix)
        chunks.push(parts.join(''))
    }
    return { doc, chunks, chunkOf }
}

/** The chunk holding `node` of the full document from `splitSection`. */
export const chunkOfNode = (doc, chunkOf, node) => {
    let el = node?.nodeType === 1 ? node : node?.parentElement
    while (el && el.parentElement !== doc.body) el = el.parentElement
    if (!el) return 0
    return chunkOf[Array.prototype.indexOf.call(doc.body.children, el)] ?? 0
}
