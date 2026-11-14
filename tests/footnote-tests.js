import '../view.js'
import { FootnoteHandler } from '../footnotes.js'

const parser = new DOMParser()
const run = async ({ reference, backlink, accepts }) => {
    const html = `<!doctype html><p>Chapter text ${reference}</p><hr>
        <p><a href="${backlink}"></a><a id="note">1.</a> Note: <em>first</em>, <em>second</em>, and <em>third</em>.</p>
        <p id="unrelated">Unrelated text</p>`
    const source = parser.parseFromString(html, 'text/html')
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
    const section = {
        id: 'chapter.html', linear: 'yes', size: html.length,
        load: () => url,
        loadContent: () => html,
        resolveHref: href => decodeURIComponent(`chapter.html${href}`),
    }
    const book = {
        dir: 'ltr', sections: [section],
        resolveHref(href) {
            const [path, fragment] = href.split('#')
            return path === section.id ? { index: 0, anchor: doc => doc.getElementById(fragment) } : null
        },
    }
    const handler = new FootnoteHandler()
    let popup
    let navigation
    handler.addEventListener('before-render', ({ detail: { view } }) => {
        popup = view
        Object.assign(view.style, { display: 'block', width: '400px', height: '300px' })
        document.body.append(view)
        const goTo = view.renderer.goTo.bind(view.renderer)
        view.renderer.goTo = target => (navigation = goTo(target))
    })
    const event = new CustomEvent('link', {
        cancelable: true,
        detail: { a: source.querySelector('a[href="#note"]'), href: 'chapter.html#note', check: true },
    })
    try {
        const result = await handler.handle(book, event).then(() => null, error => error)
        console.assert(event.defaultPrevented, 'The handler should defer navigation during validation')
        if (accepts) {
            console.assert(!result, `Reciprocal note should open: ${result?.message}`)
            const documentText = popup?.renderer.getContents()[0]?.doc.body.textContent
            console.assert(documentText?.trim() === '1. Note: first, second, and third.',
                'Only the corresponding note paragraph should be shown')
        } else {
            console.assert(result?.message === 'Failed to locate footnote content',
                'An unrelated backlink should preserve fallback navigation')
        }
    } finally {
        // The test owns the provisional view, including the rejection path.
        // Let the renderer finish the load callback before tearing down its DOM.
        await navigation?.catch(() => {})
        popup?.close()
        popup?.remove()
        URL.revokeObjectURL(url)
    }
}

await run({ reference: '<a id="ref"></a><!-- Return marker --> <a href="#note">1</a>', backlink: '#ref', accepts: true })
await run({ reference: '<a id="ref"></a>Unrelated text <a href="#note">1</a>', backlink: '#ref', accepts: false })
