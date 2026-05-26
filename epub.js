import * as CFI from './epubcfi.js'

const NS = {
    CONTAINER: 'urn:oasis:names:tc:opendocument:xmlns:container',
    XHTML: 'http://www.w3.org/1999/xhtml',
    OPF: 'http://www.idpf.org/2007/opf',
    EPUB: 'http://www.idpf.org/2007/ops',
    DC: 'http://purl.org/dc/elements/1.1/',
    DCTERMS: 'http://purl.org/dc/terms/',
    ENC: 'http://www.w3.org/2001/04/xmlenc#',
    NCX: 'http://www.daisy.org/z3986/2005/ncx/',
    XLINK: 'http://www.w3.org/1999/xlink',
    SMIL: 'http://www.w3.org/ns/SMIL',
}

const MIME = {
    XML: 'application/xml',
    NCX: 'application/x-dtbncx+xml',
    XHTML: 'application/xhtml+xml',
    HTML: 'text/html',
    CSS: 'text/css',
    SVG: 'image/svg+xml',
    JS: /\/(x-)?(javascript|ecmascript)/,
}

// https://www.w3.org/TR/epub-33/#sec-reserved-prefixes
const PREFIX = {
    a11y: 'http://www.idpf.org/epub/vocab/package/a11y/#',
    dcterms: 'http://purl.org/dc/terms/',
    marc: 'http://id.loc.gov/vocabulary/',
    media: 'http://www.idpf.org/epub/vocab/overlays/#',
    onix: 'http://www.editeur.org/ONIX/book/codelists/current.html#',
    rendition: 'http://www.idpf.org/vocab/rendition/#',
    schema: 'http://schema.org/',
    xsd: 'http://www.w3.org/2001/XMLSchema#',
    msv: 'http://www.idpf.org/epub/vocab/structure/magazine/#',
    prism: 'http://www.prismstandard.org/specifications/3.0/PRISM_CV_Spec_3.0.htm#',
}

const RELATORS = {
    art: 'artist',
    aut: 'author',
    clr: 'colorist',
    edt: 'editor',
    ill: 'illustrator',
    nrt: 'narrator',
    trl: 'translator',
    pbl: 'publisher',
}

const ONIX5 = {
    '02': 'isbn',
    '06': 'doi',
    '15': 'isbn',
    '26': 'doi',
    '34': 'issn',
}

// convert to camel case
const camel = x => x.toLowerCase().replace(/[-:](.)/g, (_, g) => g.toUpperCase())

// strip and collapse ASCII whitespace
// https://infra.spec.whatwg.org/#strip-and-collapse-ascii-whitespace
const normalizeWhitespace = str => str ? str
    .replace(/[\t\n\f\r ]+/g, ' ')
    .replace(/^[\t\n\f\r ]+/, '')
    .replace(/[\t\n\f\r ]+$/, '') : ''

const filterAttribute = (attr, value, isList) => isList
    ? el => el.getAttribute(attr)?.split(/\s/)?.includes(value)
    : typeof value === 'function'
        ? el => value(el.getAttribute(attr))
        : el => el.getAttribute(attr) === value

const getAttributes = (...xs) => el =>
    el ? Object.fromEntries(xs.map(x => [camel(x), el.getAttribute(x)])) : null

const getElementText = el => normalizeWhitespace(el?.textContent)

const childGetter = (doc, ns) => {
    // ignore the namespace if it doesn't appear in document at all
    const useNS = doc.lookupNamespaceURI(null) === ns || doc.lookupPrefix(ns)
    const f = useNS
        ? (el, name) => el => el.namespaceURI === ns && el.localName === name
        : (el, name) => el => el.localName === name
    return {
        $: (el, name) => [...el.children].find(f(el, name)),
        $$: (el, name) => [...el.children].filter(f(el, name)),
        $$$: useNS
            ? (el, name) => [...el.getElementsByTagNameNS(ns, name)]
            : (el, name) => [...el.getElementsByTagName(name)],
    }
}

const resolveURL = (url, relativeTo) => {
    try {
        // replace %2c in the url with a comma, this might be introduced by calibre
        url = url.replace(/%2c/gi, ',').replace(/%3a/gi, ':')
        if (relativeTo.includes(':') && !relativeTo.startsWith('OEBPS')) return new URL(url, relativeTo)
        // the base needs to be a valid URL, so set a base URL and then remove it
        const root = 'https://invalid.invalid/'
        const obj = new URL(url, root + relativeTo)
        obj.search = ''
        return decodeURI(obj.href.replace(root, ''))
    } catch(e) {
        console.warn(e)
        return url
    }
}

const isExternal = uri => /^(?!blob)\w+:/i.test(uri)

// like `path.relative()` in Node.js
const pathRelative = (from, to) => {
    if (!from) return to
    const as = from.replace(/\/$/, '').split('/')
    const bs = to.replace(/\/$/, '').split('/')
    const i = (as.length > bs.length ? as : bs).findIndex((_, i) => as[i] !== bs[i])
    return i < 0 ? '' : Array(as.length - i).fill('..').concat(bs.slice(i)).join('/')
}

const pathDirname = str => str.slice(0, str.lastIndexOf('/') + 1)

// replace asynchronously and sequentially
// same technique as https://stackoverflow.com/a/48032528
const replaceSeries = async (str, regex, f) => {
    const matches = []
    str.replace(regex, (...args) => (matches.push(args), null))
    const results = []
    for (const args of matches) results.push(await f(...args))
    return str.replace(regex, () => results.shift())
}

const regexEscape = str => str.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')

const tidy = obj => {
    for (const [key, val] of Object.entries(obj))
        if (val == null) delete obj[key]
        else if (Array.isArray(val)) {
            obj[key] = val.filter(x => x).map(x =>
                typeof x === 'object' && !Array.isArray(x) ? tidy(x) : x)
            if (!obj[key].length) delete obj[key]
            else if (obj[key].length === 1) obj[key] = obj[key][0]
        }
        else if (typeof val === 'object') {
            obj[key] = tidy(val)
            if (!Object.keys(val).length) delete obj[key]
        }
    const keys = Object.keys(obj)
    if (keys.length === 1 && keys[0] === 'name') return obj[keys[0]]
    return obj
}

// https://www.w3.org/TR/epub/#sec-prefix-attr
const getPrefixes = doc => {
    const map = new Map(Object.entries(PREFIX))
    const value = doc.documentElement.getAttributeNS(NS.EPUB, 'prefix')
        || doc.documentElement.getAttribute('prefix')
    if (value) for (const [, prefix, url] of value
        .matchAll(/(.+): +(.+)[ \t\r\n]*/g)) map.set(prefix, url)
    return map
}

// https://www.w3.org/TR/epub-rs/#sec-property-values
// but ignoring the case where the prefix is omitted
const getPropertyURL = (value, prefixes) => {
    if (!value) return null
    const [a, b] = value.split(':')
    const prefix = b ? a : null
    const reference = b ? b : a
    const baseURL = prefixes.get(prefix)
    return baseURL ? baseURL + reference : null
}

const getMetadata = opf => {
    const { $ } = childGetter(opf, NS.OPF)
    const $metadata = $(opf.documentElement, 'metadata')

    // first pass: convert to JS objects
    const els = Object.groupBy($metadata.children, el =>
        el.namespaceURI === NS.DC ? 'dc'
        : el.namespaceURI === NS.OPF && el.localName === 'meta' ?
            (el.hasAttribute('name') ? 'legacyMeta' : 'meta') : '')
    const baseLang = $metadata.getAttribute('xml:lang')
        ?? opf.documentElement.getAttribute('xml:lang') ?? 'und'
    const prefixes = getPrefixes(opf)
    const parse = el => {
        const property = el.getAttribute('property')
        const scheme = el.getAttribute('scheme')
        return {
            property: getPropertyURL(property, prefixes) ?? property,
            scheme: getPropertyURL(scheme, prefixes) ?? scheme,
            lang: el.getAttribute('xml:lang'),
            value: getElementText(el),
            props: getProperties(el),
            // `opf:` attributes from EPUB 2 & EPUB 3.1 (removed in EPUB 3.2)
            attrs: Object.fromEntries(Array.from(el.attributes)
                .filter(attr => attr.namespaceURI === NS.OPF)
                .map(attr => [attr.localName, attr.value])),
        }
    }
    const refines = Map.groupBy(els.meta ?? [], el => el.getAttribute('refines'))
    const getProperties = el => {
        const els = refines.get(el ? '#' + el.getAttribute('id') : null)
        if (!els) return null
        return Object.groupBy(els.map(parse), x => x.property)
    }
    const dc = Object.fromEntries(Object.entries(Object.groupBy(els.dc || [], el => el.localName))
        .map(([name, els]) => [name, els.map(parse)]))
    const properties = getProperties() ?? {}
    const legacyMeta = Object.fromEntries(els.legacyMeta?.map(el =>
        [el.getAttribute('name'), el.getAttribute('content')]) ?? [])

    // second pass: map to webpub
    const one = x => x?.[0]?.value
    const prop = (x, p) => one(x?.props?.[p])
    const makeLanguageMap = x => {
        if (!x) return null
        const alts = x.props?.['alternate-script'] ?? []
        const altRep = x.attrs['alt-rep']
        if (!alts.length && (!x.lang || x.lang === baseLang) && !altRep) return x.value
        const map = { [x.lang ?? baseLang]: x.value }
        if (altRep) map[x.attrs['alt-rep-lang']] = altRep
        for (const y of alts) map[y.lang] ??= y.value
        return map
    }
    const makeContributor = x => x ? ({
        name: makeLanguageMap(x),
        sortAs: makeLanguageMap(x.props?.['file-as']?.[0]) ?? x.attrs['file-as'],
        role: x.props?.role?.filter(x => x.scheme === PREFIX.marc + 'relators')
            ?.map(x => x.value) ?? [x.attrs.role],
        code: prop(x, 'term') ?? x.attrs.term,
        scheme: prop(x, 'authority') ?? x.attrs.authority,
    }) : null
    const makeCollection = x => ({
        name: makeLanguageMap(x),
        // NOTE: webpub requires number but EPUB allows values like "2.2.1"
        position: one(x.props?.['group-position']),
    })
    const makeSeries = x => ({
        name: x.value,
        position: one(x.props?.['group-position']),
    })
    const makeAltIdentifier = x => {
        const { value } = x
        if (/^urn:/i.test(value)) return value
        if (/^doi:/i.test(value)) return `urn:${value}`
        const type = x.props?.['identifier-type']
        if (!type) {
            const scheme = x.attrs.scheme
            if (!scheme) return value
            // https://idpf.github.io/epub-registries/identifiers/
            // but no "jdcn", which isn't a registered URN namespace
            if (/^(doi|isbn|uuid)$/i.test(scheme)) return `urn:${scheme}:${value}`
            // NOTE: webpub requires scheme to be a URI; EPUB allows anything
            return { scheme, value }
        }
        if (type.scheme === PREFIX.onix + 'codelist5') {
            const nid = ONIX5[type.value]
            if (nid) return `urn:${nid}:${value}`
        }
        return value
    }
    const belongsTo = Object.groupBy(properties['belongs-to-collection'] ?? [],
        x => prop(x, 'collection-type') === 'series' ? 'series' : 'collection')
    const mainTitle = dc.title?.find(x => prop(x, 'title-type') === 'main') ?? dc.title?.[0]
    const metadata = {
        identifier: getIdentifier(opf),
        title: makeLanguageMap(mainTitle),
        sortAs: makeLanguageMap(mainTitle?.props?.['file-as']?.[0])
            ?? mainTitle?.attrs?.['file-as']
            ?? legacyMeta?.['calibre:title_sort'],
        subtitle: dc.title?.find(x => prop(x, 'title-type') === 'subtitle')?.value,
        language: dc.language?.map(x => x.value),
        description: one(dc.description),
        publisher: makeContributor(dc.publisher?.[0]),
        published: dc.date?.find(x => x.attrs.event === 'publication')?.value
            ?? one(dc.date),
        modified: one(properties[PREFIX.dcterms + 'modified'])
            ?? dc.date?.find(x => x.attrs.event === 'modification')?.value,
        subject: dc.subject?.map(makeContributor),
        belongsTo: {
            collection: belongsTo.collection?.map(makeCollection),
            series: belongsTo.series?.map(makeSeries)
            ?? (legacyMeta?.['calibre:series'] ? {
                name: legacyMeta?.['calibre:series'],
                position: parseFloat(legacyMeta?.['calibre:series_index']),
            } : null),
        },
        altIdentifier: dc.identifier?.map(makeAltIdentifier),
        source: dc.source?.map(makeAltIdentifier), // NOTE: not in webpub schema
        rights: one(dc.rights), // NOTE: not in webpub schema
    }
    const remapContributor = defaultKey => x => {
        const keys = new Set(x.role?.map(role => RELATORS[role] ?? defaultKey))
        return [keys.size ? keys : [defaultKey], x]
    }
    for (const [keys, val] of [].concat(
        dc.creator?.map(makeContributor)?.map(remapContributor('author')) ?? [],
        dc.contributor?.map(makeContributor)?.map(remapContributor('contributor')) ?? []))
        for (const key of keys) {
            // if already parsed publisher don't remap it from author/contributor again
            if (key === 'publisher' && metadata.publisher) continue
            if (metadata[key]) metadata[key].push(val)
            else metadata[key] = [val]
        }
    tidy(metadata)
    if (metadata.altIdentifier === metadata.identifier)
        delete metadata.altIdentifier

    const rendition = {}
    const media = {}
    for (const [key, val] of Object.entries(properties)) {
        if (key.startsWith(PREFIX.rendition))
            rendition[camel(key.replace(PREFIX.rendition, ''))] = one(val)
        else if (key.startsWith(PREFIX.media))
            media[camel(key.replace(PREFIX.media, ''))] = one(val)
    }
    if (media.duration) media.duration = parseClock(media.duration)
    return { metadata, rendition, media }
}

const parseNav = (doc, resolve = f => f) => {
    const { $, $$, $$$ } = childGetter(doc, NS.XHTML)
    const resolveHref = href => href ? decodeURI(resolve(href)) : null
    const parseLI = getType => $li => {
        const $a = $($li, 'a') ?? $($li, 'span')
        const $ol = $($li, 'ol')
        const href = resolveHref($a?.getAttribute('href'))
        const label = getElementText($a) || $a?.getAttribute('title')
        // TODO: get and concat alt/title texts in content
        const result = { label, href, subitems: parseOL($ol) }
        if (getType) result.type = $a?.getAttributeNS(NS.EPUB, 'type')?.split(/\s/)
        return result
    }
    const parseOL = ($ol, getType) => $ol ? $$($ol, 'li').map(parseLI(getType)) : null
    const parseNav = ($nav, getType) => parseOL($($nav, 'ol'), getType)

    const $$nav = $$$(doc, 'nav')
    let toc = null, pageList = null, landmarks = null, others = []
    for (const $nav of $$nav) {
        const type = $nav.getAttributeNS(NS.EPUB, 'type')?.split(/\s/) ?? []
        if (type.includes('toc')) toc ??= parseNav($nav)
        else if (type.includes('page-list')) pageList ??= parseNav($nav)
        else if (type.includes('landmarks')) landmarks ??= parseNav($nav, true)
        else others.push({
            label: getElementText($nav.firstElementChild), type,
            list: parseNav($nav),
        })
    }
    return { toc, pageList, landmarks, others }
}

const parseNCX = (doc, resolve = f => f) => {
    const { $, $$ } = childGetter(doc, NS.NCX)
    const resolveHref = href => href ? decodeURI(resolve(href)) : null
    const parseItem = el => {
        const $label = $(el, 'navLabel')
        const $content = $(el, 'content')
        const label = getElementText($label)
        const href = resolveHref($content.getAttribute('src'))
        if (el.localName === 'navPoint') {
            const els = $$(el, 'navPoint')
            return { label, href, subitems: els.length ? els.map(parseItem) : null }
        }
        return { label, href }
    }
    const parseList = (el, itemName) => $$(el, itemName).map(parseItem)
    const getSingle = (container, itemName) => {
        const $container = $(doc.documentElement, container)
        return $container ? parseList($container, itemName) : null
    }
    return {
        toc: getSingle('navMap', 'navPoint'),
        pageList: getSingle('pageList', 'pageTarget'),
        others: $$(doc.documentElement, 'navList').map(el => ({
            label: getElementText($(el, 'navLabel')),
            list: parseList(el, 'navTarget'),
        })),
    }
}

const parseClock = str => {
    if (!str) return
    const parts = str.split(':').map(x => parseFloat(x))
    if (parts.length === 3) {
        const [h, m, s] = parts
        return h * 60 * 60 + m * 60 + s
    }
    if (parts.length === 2) {
        const [m, s] = parts
        return m * 60 + s
    }
    const [x, unit] = str.split(/(?=[^\d.])/)
    const n = parseFloat(x)
    const f = unit === 'h' ? 60 * 60
        : unit === 'min' ? 60
        : unit === 'ms' ? .001
        : 1
    return n * f
}

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp']
const FONT_EXTENSIONS = ['woff', 'woff2', 'ttf', 'otf']

const getImageMediaType = (path) => {
    const extension = path.toLowerCase().split('.').pop()
    const mediaTypeMap = {
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'webp': 'image/webp',
    }
    return mediaTypeMap[extension] || 'image/jpeg'
}

const getFontMediaType = (path) => {
    const extension = path.toLowerCase().split('.').pop()
    const mediaTypeMap = {
        'woff': 'font/woff',
        'woff2': 'font/woff2',
        'ttf': 'font/ttf',
        'otf': 'font/otf',
    }
    return mediaTypeMap[extension] || 'font/ttf'
}

class MediaOverlay extends EventTarget {
    #entries
    #lastMediaOverlayItem
    #sectionIndex
    #audioIndex
    #itemIndex
    #audio
    #volume = 1
    #rate = 1
    #state
    constructor(book, loadXML) {
        super()
        this.book = book
        this.loadXML = loadXML
    }
    async #loadSMIL(item) {
        if (this.#lastMediaOverlayItem === item) return
        const doc = await this.loadXML(item.href)
        const resolve = href => href ? resolveURL(href, item.href) : null
        const { $, $$$ } = childGetter(doc, NS.SMIL)
        this.#audioIndex = -1
        this.#itemIndex = -1
        this.#entries = $$$(doc, 'par').reduce((arr, $par) => {
            const text = resolve($($par, 'text')?.getAttribute('src'))
            const $audio = $($par, 'audio')
            if (!text || !$audio) return arr
            const src = resolve($audio.getAttribute('src'))
            const begin = parseClock($audio.getAttribute('clipBegin'))
            const end = parseClock($audio.getAttribute('clipEnd'))
            const last = arr.at(-1)
            if (last?.src === src) last.items.push({ text, begin, end })
            else arr.push({ src, items: [{ text, begin, end }] })
            return arr
        }, [])
        this.#lastMediaOverlayItem = item
    }
    get #activeAudio() {
        return this.#entries[this.#audioIndex]
    }
    get #activeItem() {
        return this.#activeAudio?.items?.[this.#itemIndex]
    }
    #error(e) {
        console.error(e)
        this.dispatchEvent(new CustomEvent('error', { detail: e }))
    }
    #highlight() {
        this.dispatchEvent(new CustomEvent('highlight', { detail: this.#activeItem }))
    }
    #unhighlight() {
        this.dispatchEvent(new CustomEvent('unhighlight', { detail: this.#activeItem }))
    }
    async #play(audioIndex, itemIndex) {
        this.#stop()
        this.#audioIndex = audioIndex
        this.#itemIndex = itemIndex
        const src = this.#activeAudio?.src
        if (!src || !this.#activeItem) return this.start(this.#sectionIndex + 1)

        const url = URL.createObjectURL(await this.book.loadBlob(src))
        const audio = new Audio(url)
        this.#audio = audio
        audio.volume = this.#volume
        audio.playbackRate = this.#rate
        audio.addEventListener('timeupdate', () => {
            if (audio.paused) return
            const t = audio.currentTime
            const { items } = this.#activeAudio
            if (t > this.#activeItem?.end) {
                this.#unhighlight()
                if (this.#itemIndex === items.length - 1) {
                    this.#play(this.#audioIndex + 1, 0).catch(e => this.#error(e))
                    return
                }
            }
            const oldIndex = this.#itemIndex
            while (items[this.#itemIndex + 1]?.begin <= t) this.#itemIndex++
            if (this.#itemIndex !== oldIndex) this.#highlight()
        })
        audio.addEventListener('error', () =>
            this.#error(new Error(`Failed to load ${src}`)))
        audio.addEventListener('playing', () => this.#highlight())
        audio.addEventListener('ended', () => {
            this.#unhighlight()
            URL.revokeObjectURL(url)
            this.#audio = null
            this.#play(audioIndex + 1, 0).catch(e => this.#error(e))
        })
        if (this.#state === 'paused') {
            this.#highlight()
            audio.currentTime = this.#activeItem.begin ?? 0
        }
        else audio.addEventListener('canplaythrough', () => {
            // for some reason need to seek in `canplaythrough`
            // or it won't play when skipping in WebKit
            audio.currentTime = this.#activeItem.begin ?? 0
            this.#state = 'playing'
            audio.play().catch(e => this.#error(e))
        }, { once: true })
    }
    async start(sectionIndex, filter = () => true) {
        this.#audio?.pause()
        const section = this.book.sections[sectionIndex]
        const href = section?.id
        if (!href) return

        const { mediaOverlay } = section
        if (!mediaOverlay) return this.start(sectionIndex + 1)
        this.#sectionIndex = sectionIndex
        await this.#loadSMIL(mediaOverlay)

        for (let i = 0; i < this.#entries.length; i++) {
            const { items } = this.#entries[i]
            for (let j = 0; j < items.length; j++) {
                if (items[j].text.split('#')[0] === href && filter(items[j], j, items))
                    return this.#play(i, j).catch(e => this.#error(e))
            }
        }
    }
    pause() {
        this.#state = 'paused'
        this.#audio?.pause()
    }
    resume() {
        this.#state = 'playing'
        this.#audio?.play().catch(e => this.#error(e))
    }
    #stop() {
        if (this.#audio) {
            this.#audio.pause()
            URL.revokeObjectURL(this.#audio.src)
            this.#audio = null
            this.#unhighlight()
        }
    }
    stop() {
        this.#state = 'stopped'
        this.#stop()
    }
    prev() {
        if (this.#itemIndex > 0) this.#play(this.#audioIndex, this.#itemIndex - 1)
        else if (this.#audioIndex > 0) this.#play(this.#audioIndex - 1,
            this.#entries[this.#audioIndex - 1].items.length - 1)
        else if (this.#sectionIndex > 0)
            this.start(this.#sectionIndex - 1, (_, i, items) => i === items.length - 1)
    }
    next() {
        this.#play(this.#audioIndex, this.#itemIndex + 1)
    }
    setVolume(volume) {
        this.#volume = volume
        if (this.#audio) this.#audio.volume = volume
    }
    setRate(rate) {
        this.#rate = rate
        if (this.#audio) this.#audio.playbackRate = rate
    }
}

const isUUID = /([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})/i

const getUUID = opf => {
    const extractUUID = el => {
        const text = getElementText(el)
        const id = text.split(':').slice(-1)[0]
        const match = isUUID.exec(id)
        return match ? match[0] : null
    }
    const identifiers = Array.from(opf.getElementsByTagNameNS(NS.DC, 'identifier'))
    // 1. Prefer the unique-identifier (used by Adobe font obfuscation)
    const uniqueIdAttr = opf.documentElement.getAttribute('unique-identifier')
    if (uniqueIdAttr) {
        const el = identifiers.find(el => el.getAttribute('id') === uniqueIdAttr)
        if (el) {
            const uuid = extractUUID(el)
            if (uuid) return uuid
        }
    }
    // 2. Prefer urn:uuid: identifiers (standard UUID URN per RFC 4122)
    for (const el of identifiers) {
        const text = getElementText(el)
        if (/^urn:uuid:/i.test(text)) {
            const uuid = extractUUID(el)
            if (uuid) return uuid
        }
    }
    // 3. Fall back to any identifier containing a UUID
    for (const el of identifiers) {
        const uuid = extractUUID(el)
        if (uuid) return uuid
    }
    return ''
}

const getIdentifier = opf => getElementText(
    opf.getElementById(opf.documentElement.getAttribute('unique-identifier'))
    ?? opf.getElementsByTagNameNS(NS.DC, 'identifier')[0])

// https://www.w3.org/publishing/epub32/epub-ocf.html#sec-resource-obfuscation
const deobfuscate = async (key, length, blob) => {
    const array = new Uint8Array(await blob.slice(0, length).arrayBuffer())
    length = Math.min(length, array.length)
    for (var i = 0; i < length; i++) array[i] = array[i] ^ key[i % key.length]
    return new Blob([array, blob.slice(length)], { type: blob.type })
}

const WebCryptoSHA1 = async str => {
    const data = new TextEncoder().encode(str)
    const buffer = await globalThis.crypto.subtle.digest('SHA-1', data)
    return new Uint8Array(buffer)
}

const deobfuscators = (sha1 = WebCryptoSHA1) => ({
    'http://www.idpf.org/2008/embedding': {
        key: opf => sha1(getIdentifier(opf)
            // eslint-disable-next-line no-control-regex
            .replaceAll(/[\u0020\u0009\u000d\u000a]/g, '')),
        decode: (key, blob) => deobfuscate(key, 1040, blob),
    },
    'http://ns.adobe.com/pdf/enc#RC': {
        key: opf => {
            const uuid = getUUID(opf).replaceAll('-', '')
            return Uint8Array.from({ length: 16 }, (_, i) =>
                parseInt(uuid.slice(i * 2, i * 2 + 2), 16))
        },
        decode: (key, blob) => deobfuscate(key, 1024, blob),
    },
})

class Encryption {
    #uris = new Map()
    #decoders = new Map()
    #algorithms
    constructor(algorithms) {
        this.#algorithms = algorithms
    }
    async init(encryption, opf) {
        if (!encryption) return
        const data = Array.from(
            encryption.getElementsByTagNameNS(NS.ENC, 'EncryptedData'), el => ({
                algorithm: el.getElementsByTagNameNS(NS.ENC, 'EncryptionMethod')[0]
                    ?.getAttribute('Algorithm'),
                uri: el.getElementsByTagNameNS(NS.ENC, 'CipherReference')[0]
                    ?.getAttribute('URI'),
            }))
        for (const { algorithm, uri } of data) {
            if (!this.#decoders.has(algorithm)) {
                const algo = this.#algorithms[algorithm]
                if (!algo) {
                    console.warn('Unknown encryption algorithm')
                    continue
                }
                const key = await algo.key(opf)
                this.#decoders.set(algorithm, blob => algo.decode(key, blob))
            }
            this.#uris.set(uri, algorithm)
        }
    }
    getDecoder(uri) {
        return this.#decoders.get(this.#uris.get(uri)) ?? (x => x)
    }
}

class Resources {
    constructor({ opf, resolveHref }) {
        this.opf = opf
        const { $, $$, $$$ } = childGetter(opf, NS.OPF)

        const $manifest = $(opf.documentElement, 'manifest')
        const $spine = $(opf.documentElement, 'spine')
        const $$itemref = $$($spine, 'itemref')

        this.manifest = $$($manifest, 'item')
            .map(getAttributes('href', 'id', 'media-type', 'properties', 'media-overlay'))
            .map(item => {
                item.href = resolveHref(item.href)
                item.properties = item.properties?.split(/\s/)
                return item
            })
        this.manifestById = new Map(this.manifest.map(item => [item.id, item]))
        this.spine = $$itemref
            .map(getAttributes('idref', 'id', 'linear', 'properties'))
            .map(item => (item.properties = item.properties?.split(/\s/), item))
        this.pageProgressionDirection = $spine
            .getAttribute('page-progression-direction')

        this.navPath = this.getItemByProperty('nav')?.href
        this.ncxPath = (this.getItemByID($spine.getAttribute('toc'))
            ?? this.manifest.find(item => item.mediaType === MIME.NCX))?.href

        const $guide = $(opf.documentElement, 'guide')
        if ($guide) this.guide = $$($guide, 'reference')
            .map(getAttributes('type', 'title', 'href'))
            .map(({ type, title, href }) => ({
                label: title,
                type: type.split(/\s/),
                href: resolveHref(href),
            }))

        this.cover = this.getItemByProperty('cover-image')
            // EPUB 2 compat
            ?? this.getItemByID($$$(opf, 'meta')
                .find(filterAttribute('name', 'cover'))
                ?.getAttribute('content'))
            ?? this.manifest.find(item => item.id === 'cover'
                && item.mediaType.startsWith('image'))
            ?? this.manifest.find(item => item.href.includes('cover')
                && item.mediaType.startsWith('image'))
            ?? this.getItemByHref(this.guide
                ?.find(ref => ref.type.includes('cover'))?.href)
            // last resort: first image in manifest
            ?? this.manifest.find(item => item.mediaType.startsWith('image'))

        this.cfis = CFI.fromElements($$itemref)
    }
    getItemByID(id) {
        return this.manifestById.get(id)
    }
    getItemByHref(href) {
        return this.manifest.find(item => item.href === href)
    }
    getItemByProperty(prop) {
        return this.manifest.find(item => item.properties?.includes(prop))
    }
    resolveCFI(cfi) {
        const parts = CFI.parse(cfi)
        const top = (parts.parent ?? parts).shift()
        let $itemref = CFI.toElement(this.opf, top)
        // make sure it's an idref; if not, try again without the ID assertion
        // mainly because Epub.js used to generate wrong ID assertions
        // https://github.com/futurepress/epub.js/issues/1236
        if ($itemref && $itemref.nodeName !== 'idref') {
            top.at(-1).id = null
            $itemref = CFI.toElement(this.opf, top)
        }
        const idref = $itemref?.getAttribute('idref')
        const index = this.spine.findIndex(item => item.idref === idref)
        const anchor = doc => CFI.toRange(doc, parts)
        return { index, anchor }
    }
}

class Loader {
    #cache = new Map()
    #cacheXHTMLContent = new Map()
    #children = new Map()
    #refCount = new Map()
    eventTarget = new EventTarget()
    constructor({ loadText, loadBlob, resources, entries }) {
        this.loadText = loadText
        this.loadBlob = loadBlob
        this.manifest = resources.manifest
        this.assets = resources.manifest
        this.entries = entries
        // needed only when replacing in (X)HTML w/o parsing (see below)
        //.filter(({ mediaType }) => ![MIME.XHTML, MIME.HTML].includes(mediaType))
    }
    async createURL(href, data, type, parent) {
        if (!data) return ''
        const detail = { data, type }
        Object.defineProperty(detail, 'name', { value: href }) // readonly
        const event = new CustomEvent('data', { detail })
        this.eventTarget.dispatchEvent(event)
        const newData = await event.detail.data
        const newType = await event.detail.type
        const url = URL.createObjectURL(new Blob([newData], { type: newType }))
        this.#cache.set(href, url)
        this.#refCount.set(href, 1)
        if (newType === MIME.XHTML || newType === MIME.HTML) {
            this.#cacheXHTMLContent.set(url, {href, type: newType, data: newData})
        }
        if (parent) {
            const childList = this.#children.get(parent)
            if (childList) childList.push(href)
            else this.#children.set(parent, [href])
        }
        return url
    }
    ref(href, parent) {
        const childList = this.#children.get(parent)
        if (!childList?.includes(href)) {
            this.#refCount.set(href, this.#refCount.get(href) + 1)
            //console.log(`referencing ${href}, now ${this.#refCount.get(href)}`)
            if (childList) childList.push(href)
            else this.#children.set(parent, [href])
        }
        return this.#cache.get(href)
    }
    unref(href) {
        if (!this.#refCount.has(href)) return
        const count = this.#refCount.get(href) - 1
        //console.log(`unreferencing ${href}, now ${count}`)
        if (count < 1) {
            //console.log(`unloading ${href}`)
            const url = this.#cache.get(href)
            URL.revokeObjectURL(url)
            this.#cache.delete(href)
            this.#cacheXHTMLContent.delete(url)
            this.#refCount.delete(href)
            // unref children
            const childList = this.#children.get(href)
            if (childList) while (childList.length) this.unref(childList.pop())
            this.#children.delete(href)
        } else this.#refCount.set(href, count)
    }
    // load manifest item, recursively loading all resources as needed
    async loadItem(item, parents = []) {
        if (!item) return null
        const { href, mediaType } = item

        const isScript = MIME.JS.test(item.mediaType)
        const detail = { type: mediaType, href, isScript, allow: true}
        const event = new CustomEvent('load', { detail })
        this.eventTarget.dispatchEvent(event)
        const { allow, url } = await event.detail
        if (!allow) return null
        if (url !== undefined) return url

        const parent = parents.at(-1)
        if (this.#cache.has(href)) return this.ref(href, parent)

        const shouldReplace =
            (isScript || [MIME.XHTML, MIME.HTML, MIME.CSS, MIME.SVG].includes(mediaType))
            // prevent circular references
            && parents.every(p => p !== href)
        if (shouldReplace) return this.loadReplaced(item, parents)
        // NOTE: this can be replaced with `Promise.try()`
        const tryLoadBlob = Promise.resolve().then(() => this.loadBlob(href))
        return this.createURL(href, tryLoadBlob, mediaType, parent)
    }
    async loadItemXHTMLContent(item, parents = []) {
        const url = await this.loadItem(item, parents)
        if (url) return this.#cacheXHTMLContent.get(url)?.data
    }
    // Load an XHTML/HTML spine item, perform resource replacement, and return
    // BOTH the parsed DOM doc and a callback that registers a Blob URL for a
    // serialized variant. Used by the virtual-splitting path so we can carve
    // a huge spine doc into smaller slices without re-running expensive
    // resource replacement for every slice.
    async loadReplacedDoc(item) {
        const { href, mediaType } = item
        if (![MIME.XHTML, MIME.HTML, MIME.SVG].includes(mediaType)) return null
        let str = ''
        try {
            str = await this.loadText(href)
        } catch {
            return null
        }
        if (!str) return null
        let doc = new DOMParser().parseFromString(str, mediaType)
        let actualMediaType = mediaType
        if (mediaType === MIME.XHTML && (doc.querySelector('parsererror')
            || !doc.documentElement?.namespaceURI)) {
            actualMediaType = MIME.HTML
            item.mediaType = MIME.HTML
            doc = new DOMParser().parseFromString(str, item.mediaType)
        }
        if ([MIME.XHTML, MIME.SVG].includes(actualMediaType)) {
            let child = doc.firstChild
            while (child instanceof ProcessingInstruction) {
                if (child.data) {
                    const replacedData = await replaceSeries(child.data,
                        /(?:^|\s*)(href\s*=\s*['"])([^'"]*)(['"])/i,
                        (_, p1, p2, p3) => this.loadHref(p2, href, [])
                            .then(p2 => `${p1}${p2}${p3}`))
                    child.replaceWith(doc.createProcessingInstruction(
                        child.target, replacedData))
                }
                child = child.nextSibling
            }
        }
        const replace = async (el, attr) => el.setAttribute(attr,
            await this.loadHref(el.getAttribute(attr), href, []))
        for (const el of doc.querySelectorAll('link[href]')) await replace(el, 'href')
        for (const el of doc.querySelectorAll('[src]')) await replace(el, 'src')
        for (const el of doc.querySelectorAll('[poster]')) await replace(el, 'poster')
        for (const el of doc.querySelectorAll('object[data]')) await replace(el, 'data')
        for (const el of doc.querySelectorAll('[*|href]:not([href])'))
            el.setAttributeNS(NS.XLINK, 'href', await this.loadHref(
                el.getAttributeNS(NS.XLINK, 'href'), href, []))
        for (const el of doc.querySelectorAll('[srcset]'))
            el.setAttribute('srcset', await replaceSeries(el.getAttribute('srcset'),
                /(\s*)(.+?)\s*((?:\s[\d.]+[wx])+\s*(?:,|$)|,\s+|$)/g,
                (_, p1, p2, p3) => this.loadHref(p2, href, [])
                    .then(p2 => `${p1}${p2}${p3}`)))
        for (const el of doc.querySelectorAll('style'))
            if (el.textContent) el.textContent =
                await this.replaceCSS(el.textContent, href, [])
        for (const el of doc.querySelectorAll('[style]'))
            el.setAttribute('style',
                await this.replaceCSS(el.getAttribute('style'), href, []))
        return { doc, mediaType: actualMediaType }
    }
    // Register a serialized slice as a virtual cache entry. Returns a Blob URL.
    // The slice URL is NOT ref-counted against the parent item — callers are
    // responsible for revoking via unloadVirtualSlice when done.
    createVirtualSliceURL(parentHref, sliceIdx, data, mediaType) {
        const key = `${parentHref}#__slice_${sliceIdx}__`
        const existing = this.#cache.get(key)
        if (existing) return existing
        const url = URL.createObjectURL(new Blob([data], { type: mediaType }))
        this.#cache.set(key, url)
        this.#cacheXHTMLContent.set(url, { href: parentHref, type: mediaType, data })
        this.#refCount.set(key, 1)
        return url
    }
    unloadVirtualSlice(parentHref, sliceIdx) {
        const key = `${parentHref}#__slice_${sliceIdx}__`
        const url = this.#cache.get(key)
        if (!url) return
        URL.revokeObjectURL(url)
        this.#cache.delete(key)
        this.#cacheXHTMLContent.delete(url)
        this.#refCount.delete(key)
    }
    tryImageEntryItem(path) {
        if (!IMAGE_EXTENSIONS.some(ext => path.toLowerCase().endsWith(`.${ext}`))) {
            return null
        }
        if (!this.entries.get(path)) {
            return null
        }
        return {
            href: path,
            mediaType: getImageMediaType(path),
        }
    }
    tryFontEntryItem(path) {
        if (!FONT_EXTENSIONS.some(ext => path.toLowerCase().endsWith(`.${ext}`))) {
            return null
        }
        if (this.entries.get(path)) {
            return {
                href: path,
                mediaType: getFontMediaType(path),
            }
        }
        return {
            href: `fonts/${path.split('/').pop()}`,
            mediaType: getFontMediaType(path),
        }
    }
    async loadHref(href, base, parents = []) {
        if (isExternal(href)) return href
        const path = resolveURL(href, base)
        let item = this.manifest.find(item => item.href === path)
        if (!item) {
            item = this.tryImageEntryItem(path) ?? this.tryFontEntryItem(path)
            if (!item) {
                return href
            }
        }
        return this.loadItem(item, parents.concat(base))
    }
    async loadReplaced(item, parents = []) {
        const { href, mediaType } = item
        const parent = parents.at(-1)
        let str = ''
        try {
            str = await this.loadText(href)
        } catch (e) {
            return this.createURL(href, Promise.reject(e), mediaType, parent)
        }
        if (!str) return null

        // note that one can also just use `replaceString` for everything:
        // ```
        // const replaced = await this.replaceString(str, href, parents)
        // return this.createURL(href, replaced, mediaType, parent)
        // ```
        // which is basically what Epub.js does, which is simpler, but will
        // break things like iframes (because you don't want to replace links)
        // or text that just happen to be paths

        // parse and replace in HTML
        if ([MIME.XHTML, MIME.HTML, MIME.SVG].includes(mediaType)) {
            let doc = new DOMParser().parseFromString(str, mediaType)
            // change to HTML if it's not valid XHTML
            if (mediaType === MIME.XHTML && (doc.querySelector('parsererror')
            || !doc.documentElement?.namespaceURI)) {
                console.warn(doc.querySelector('parsererror')?.innerText ?? 'Invalid XHTML')
                item.mediaType = MIME.HTML
                doc = new DOMParser().parseFromString(str, item.mediaType)
            }
            // replace hrefs in XML processing instructions
            // this is mainly for SVGs that use xml-stylesheet
            if ([MIME.XHTML, MIME.SVG].includes(item.mediaType)) {
                let child = doc.firstChild
                while (child instanceof ProcessingInstruction) {
                    if (child.data) {
                        const replacedData = await replaceSeries(child.data,
                            /(?:^|\s*)(href\s*=\s*['"])([^'"]*)(['"])/i,
                            (_, p1, p2, p3) => this.loadHref(p2, href, parents)
                                .then(p2 => `${p1}${p2}${p3}`))
                        child.replaceWith(doc.createProcessingInstruction(
                            child.target, replacedData))
                    }
                    child = child.nextSibling
                }
            }
            // replace hrefs (excluding anchors)
            const replace = async (el, attr) => el.setAttribute(attr,
                await this.loadHref(el.getAttribute(attr), href, parents))
            for (const el of doc.querySelectorAll('link[href]')) await replace(el, 'href')
            for (const el of doc.querySelectorAll('[src]')) await replace(el, 'src')
            for (const el of doc.querySelectorAll('[poster]')) await replace(el, 'poster')
            for (const el of doc.querySelectorAll('object[data]')) await replace(el, 'data')
            for (const el of doc.querySelectorAll('[*|href]:not([href])'))
                el.setAttributeNS(NS.XLINK, 'href', await this.loadHref(
                    el.getAttributeNS(NS.XLINK, 'href'), href, parents))
            for (const el of doc.querySelectorAll('[srcset]'))
                el.setAttribute('srcset', await replaceSeries(el.getAttribute('srcset'),
                    /(\s*)(.+?)\s*((?:\s[\d.]+[wx])+\s*(?:,|$)|,\s+|$)/g,
                    (_, p1, p2, p3) => this.loadHref(p2, href, parents)
                        .then(p2 => `${p1}${p2}${p3}`)))
            // replace inline styles
            for (const el of doc.querySelectorAll('style'))
                if (el.textContent) el.textContent =
                    await this.replaceCSS(el.textContent, href, parents)
            for (const el of doc.querySelectorAll('[style]'))
                el.setAttribute('style',
                    await this.replaceCSS(el.getAttribute('style'), href, parents))
            // TODO: replace inline scripts? probably not worth the trouble
            const result = new XMLSerializer().serializeToString(doc)
            return this.createURL(href, result, item.mediaType, parent)
        }

        const result = mediaType === MIME.CSS
            ? await this.replaceCSS(str, href, parents)
            : await this.replaceString(str, href, parents)
        return this.createURL(href, result, mediaType, parent)
    }
    async replaceCSS(str, href, parents = []) {
        const replacedUrls = await replaceSeries(str,
            /url\(\s*["']?([^'"\n]*?)\s*["']?\s*\)/gi,
            (_, url) => this.loadHref(url, href, parents)
                .then(url => `url("${url}")`))
        // apart from `url()`, strings can be used for `@import` (but why?!)
        return replaceSeries(replacedUrls,
            /@import\s*["']([^"'\n]*?)["']/gi,
            (_, url) => this.loadHref(url, href, parents)
                .then(url => `@import "${url}"`))
    }
    // find & replace all possible relative paths for all assets without parsing
    replaceString(str, href, parents = []) {
        const assetMap = new Map()
        const urls = this.assets.map(asset => {
            // do not replace references to the file itself
            if (asset.href === href) return
            // href was decoded and resolved when parsing the manifest
            const relative = pathRelative(pathDirname(href), asset.href)
            const relativeEnc = encodeURI(relative)
            const rootRelative = '/' + asset.href
            const rootRelativeEnc = encodeURI(rootRelative)
            const set = new Set([relative, relativeEnc, rootRelative, rootRelativeEnc])
            for (const url of set) assetMap.set(url, asset)
            return Array.from(set)
        }).flat().filter(x => x)
        if (!urls.length) return str
        const regex = new RegExp(urls.map(regexEscape).join('|'), 'g')
        return replaceSeries(str, regex, async match =>
            this.loadItem(assetMap.get(match.replace(/^\//, '')),
                parents.concat(href)))
    }
    unloadItem(item) {
        this.unref(item?.href)
    }
    destroy() {
        for (const url of this.#cache.values()) URL.revokeObjectURL(url)
    }
}

const getHTMLFragment = (doc, id) => doc.getElementById(id)
    ?? doc.querySelector(`[name="${CSS.escape(id)}"]`)

// --- Large-spine virtual splitting -------------------------------------------
// Some EPUBs (notably full-book single-file editions like Project Gutenberg's
// "War and Peace") pack the entire text into one ~3-4MB XHTML file. WebView
// parse + CSS multi-column layout on that scale freezes the UI for tens of
// seconds (or hangs on mobile). We mitigate by splitting such items into
// several smaller virtual sections sharing the original spine item identity
// (idref / cfi prefix), so existing bookmarks and TOC anchors keep working.
//
// Threshold tuned to leave normal chaptered EPUBs untouched while catching
// the pathological single-file case.
const SPLIT_MIN_BYTES = 1280 * 1024           // only split items >= 1.2 MB
const SPLIT_TARGET_BYTES = 512 * 1024         // aim for slices around 512 KB
const SPLIT_MAX_SLICES = 64                   // hard cap to bound work

// Build a split plan for a spine document. Returns an array of slice
// descriptors `{ start, end, anchorIds }` indexing into the split container's
// children. The plan also carries `.container` and `.wrapperChain` so the
// serializer can rebuild the original DOM context. We try to break on heading
// boundaries (<h1>..<h6>) first; fall back to size-based slicing.
//
// `findSplitContainer` walks down a chain of single/dominant wrapper elements
// until we find a container that has enough children to split on. Some
// single-file EPUBs (e.g. Project Gutenberg's "War and Peace") wrap the entire
// book in one or two `<div>`s under <body>, so body.children.length is tiny
// (<8) even though there are thousands of splittable elements inside. We
// follow the "only child that's a block container" or "dominant text-bearing
// child" down to the real content layer, while recording the wrapper chain so
// serializeSlice can rebuild the same DOM context (preserves CSS that targets
// `.chapter p` etc.).
const findSplitContainer = (body) => {
    const wrapperChain = [] // elements between body (exclusive) and container (inclusive)
    let container = body
    const BLOCK_RE = /^(DIV|SECTION|ARTICLE|MAIN|NAV|ASIDE)$/i
    // Bound the descent to avoid pathological infinite loops.
    for (let depth = 0; depth < 6; depth++) {
        const kids = Array.from(container.children)
        if (kids.length >= 8) break
        if (kids.length === 0) break
        let next = null
        if (kids.length === 1 && BLOCK_RE.test(kids[0].tagName)) {
            next = kids[0]
        } else {
            // Pick the child that carries the overwhelming majority of text.
            const totalText = kids.reduce((a, b) => a + (b.textContent?.length ?? 0), 0) || 1
            const biggest = kids.reduce((a, b) =>
                (b.textContent?.length ?? 0) > (a.textContent?.length ?? 0) ? b : a)
            const biggestLen = biggest.textContent?.length ?? 0
            if (BLOCK_RE.test(biggest.tagName) && biggestLen / totalText > 0.85) {
                next = biggest
            }
        }
        if (!next) break
        wrapperChain.push(next)
        container = next
    }
    return { container, wrapperChain }
}

const buildSplitPlan = (doc, textSize) => {
    const body = doc?.body
    if (!body) return null
    const { container, wrapperChain } = findSplitContainer(body)
    const topLevel = Array.from(container.children)
    if (topLevel.length < 8) return null
    // Approximate per-child size proportional to its serialized length.
    // Counting outerHTML length on every node is expensive on huge docs, so
    // approximate with textContent length + an HTML overhead factor.
    const sizes = topLevel.map(el => (el.textContent?.length ?? 0) + 64)
    const totalApprox = sizes.reduce((a, b) => a + b, 0) || 1
    const scale = textSize / totalApprox   // map approx to actual bytes
    const targetSize = SPLIT_TARGET_BYTES
    const maxSize = SPLIT_TARGET_BYTES * 2

    // Collect heading boundaries (preferred split points)
    const isHeading = el => /^H[1-6]$/i.test(el.tagName)
    const headingIdx = new Set()
    topLevel.forEach((el, i) => { if (isHeading(el)) headingIdx.add(i) })

    const plan = []
    let cur = { start: 0, bytes: 0 }
    for (let i = 0; i < topLevel.length; i++) {
        const b = sizes[i] * scale
        // Prefer to break right BEFORE a heading when current slice has
        // accumulated something substantial.
        if (i > cur.start && headingIdx.has(i) && cur.bytes >= targetSize * 0.6) {
            plan.push({ start: cur.start, end: i })
            cur = { start: i, bytes: 0 }
        }
        cur.bytes += b
        // Hard cut if this slice has grown beyond max even without a heading
        if (cur.bytes >= maxSize && i + 1 < topLevel.length) {
            plan.push({ start: cur.start, end: i + 1 })
            cur = { start: i + 1, bytes: 0 }
        }
    }
    if (cur.start < topLevel.length) {
        plan.push({ start: cur.start, end: topLevel.length })
    }
    if (plan.length <= 1) return null
    if (plan.length > SPLIT_MAX_SLICES) {
        // too many slices means our heuristic produced something pathological,
        // collapse evenly into SPLIT_MAX_SLICES buckets
        const buckets = []
        const per = Math.ceil(topLevel.length / SPLIT_MAX_SLICES)
        for (let i = 0; i < topLevel.length; i += per) {
            buckets.push({ start: i, end: Math.min(i + per, topLevel.length) })
        }
        plan.splice(0, plan.length, ...buckets)
    }
    // Collect anchor id sets per slice — used for href routing.
    for (const slice of plan) {
        const ids = new Set()
        for (let i = slice.start; i < slice.end; i++) {
            const el = topLevel[i]
            if (el.id) ids.add(el.id)
            for (const child of el.querySelectorAll('[id]')) ids.add(child.id)
            // legacy <a name="..."> anchors
            for (const a of el.querySelectorAll('a[name]')) ids.add(a.getAttribute('name'))
        }
        slice.anchorIds = ids
    }
    // Stash the wrapper context so serializeSlice can rebuild the same DOM
    // hierarchy around each slice's children.
    plan.wrapperChain = wrapperChain
    plan.container = container
    return plan
}

// Serialize a slice of a parsed XHTML/HTML doc into a standalone string,
// preserving <html>/<head> wrappers (and their namespaces) so styles and
// metadata still apply.
//
// IMPORTANT: we must not use doc.implementation.createHTMLDocument() and
// then bolt an XHTML <html> element onto it — the resulting document has the
// wrong namespace context, and XMLSerializer produces a string that DOMParser
// then refuses to parse (or parses with an empty <body>). That in turn makes
// the iframe document essentially blank, and paginator's getVisibleRange
// returns a range whose containers are detached / unreachable from
// documentElement, which crashes nodeToParts in epubcfi.js.
//
// The safe approach is to clone the *original* document (shallow), clone its
// <html> shallowly, copy <head> verbatim, then build a fresh <body> that only
// holds the children for this slice. All nodes are created from the original
// doc, so they share its namespace and document type.
const serializeSlice = (doc, plan, sliceIdx) => {
    const slice = plan[sliceIdx]
    const body = doc.body
    // When buildSplitPlan descended into a wrapper chain, slice.start/end
    // index into plan.container.children, not body.children. We then need to
    // re-wrap the slice in the same wrapper hierarchy so CSS selectors that
    // target ancestors (e.g. ".chapter p { ... }") still apply.
    const container = plan.container || body
    const wrapperChain = plan.wrapperChain || []
    const topLevel = Array.from(container.children)

    // Shallow clone of the document itself (preserves doctype / contentType)
    const clone = doc.cloneNode(false)

    // Re-create <html> with original attributes & namespaces preserved
    const newHtml = doc.documentElement.cloneNode(false)

    // <head> verbatim — needed for <link rel=stylesheet>, <style>, <meta>
    if (doc.head) newHtml.appendChild(doc.head.cloneNode(true))

    // Fresh <body> in the original namespace, with original attrs
    const NS = body.namespaceURI || 'http://www.w3.org/1999/xhtml'
    const newBody = doc.createElementNS(NS, 'body')
    for (const attr of Array.from(body.attributes)) {
        newBody.setAttribute(attr.name, attr.value)
    }

    // Rebuild the wrapper chain (shallow clones preserve class/id/style) and
    // descend into the innermost wrapper before appending the slice's children.
    // Each link is cloned shallowly so the rebuilt subtree mirrors the path
    // body -> wrapper1 -> wrapper2 -> ... -> container -> [slice children].
    let mountPoint = newBody
    for (const wrapper of wrapperChain) {
        const cloned = wrapper.cloneNode(false)
        mountPoint.appendChild(cloned)
        mountPoint = cloned
    }
    for (let i = slice.start; i < slice.end; i++) {
        mountPoint.appendChild(topLevel[i].cloneNode(true))
    }
    newHtml.appendChild(newBody)

    // Attach doctype if the original had one
    if (doc.doctype) clone.appendChild(doc.doctype.cloneNode(true))
    clone.appendChild(newHtml)

    // NOTE: previously we did a synchronous round-trip parse here to verify
    // the slice survived. That was the single biggest CPU hog on huge spine
    // items (War and Peace ~3MB → 10 slices × 512KB reparse each = several
    // seconds of main-thread freeze). Removed. The cloning approach above is
    // the safe path; if XMLSerializer itself throws, fall back to a minimal
    // wrapper string.
    let str
    try {
        str = new XMLSerializer().serializeToString(clone)
    } catch {
        const headHTML = doc.head ? doc.head.innerHTML : ''
        // For the fallback, approximate the wrapper chain via outerHTML of
        // each shallow wrapper (manually closed in reverse).
        const openTags = wrapperChain.map(w => {
            const attrs = Array.from(w.attributes)
                .map(a => `${a.name}="${a.value.replace(/"/g, '&quot;')}"`).join(' ')
            return `<${w.tagName.toLowerCase()}${attrs ? ' ' + attrs : ''}>`
        }).join('')
        const closeTags = wrapperChain.slice().reverse()
            .map(w => `</${w.tagName.toLowerCase()}>`).join('')
        const partHTML = topLevel.slice(slice.start, slice.end)
            .map(el => el.outerHTML).join('\n')
        str = '<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml">'
            + `<head>${headHTML}</head><body>${openTags}${partHTML}${closeTags}</body></html>`
    }
    return str
}

const getPageSpread = properties => {
    for (const p of properties) {
        if (p === 'page-spread-left' || p === 'rendition:page-spread-left')
            return 'left'
        if (p === 'page-spread-right' || p === 'rendition:page-spread-right')
            return 'right'
        if (p === 'rendition:page-spread-center') return 'center'
    }
}

const getDisplayOptions = doc => {
    if (!doc) return null
    return {
        fixedLayout: getElementText(doc.querySelector('option[name="fixed-layout"]')),
        openToSpread: getElementText(doc.querySelector('option[name="open-to-spread"]')),
    }
}

export class EPUB {
    parser = new DOMParser()
    #loader
    #encryption
    #splitState
    #virtualSectionMap
    #splitSectionsByHref
    constructor({ entries, loadText, loadBlob, getSize, sha1 }) {
        this.entries = entries.reduce((map, entry) => {
            map.set(entry.filename, entry)
            return map
        }, new Map())
        this.loadText = loadText
        this.loadBlob = loadBlob
        this.getSize = getSize
        this.#encryption = new Encryption(deobfuscators(sha1))
    }
    #sanitizeXMLEntities(str) {
        // Common HTML entities that aren't valid in XML
        const entityMap = {
            'nbsp': '&#160;',
            'mdash': '&#8212;',
            'ndash': '&#8211;',
            'ldquo': '&#8220;',
            'rdquo': '&#8221;',
            'lsquo': '&#8216;',
            'rsquo': '&#8217;',
            'hellip': '&#8230;',
            'copy': '&#169;',
            'reg': '&#174;',
            'trade': '&#8482;',
            'bull': '&#8226;',
            'middot': '&#183;',
        }
        return str.replace(/&([a-z]+);/gi, (match, entity) => {
            return entityMap[entity.toLowerCase()] || match
        })
    }
    async #loadXML(uri) {
        const str = await this.loadText(uri)
        if (!str) return null
        const sanitized = this.#sanitizeXMLEntities(str)
        const doc = this.parser.parseFromString(sanitized, MIME.XML)
        if (doc.querySelector('parsererror'))
            throw new Error(`XML parsing error: ${uri}
${doc.querySelector('parsererror').innerText}`)
        return doc
    }
    async init() {
        const $container = await this.#loadXML('META-INF/container.xml')
        if (!$container) throw new Error('Failed to load container file')

        const opfs = Array.from(
            $container.getElementsByTagNameNS(NS.CONTAINER, 'rootfile'),
            getAttributes('full-path', 'media-type'))
            .filter(file => file.mediaType === 'application/oebps-package+xml')

        if (!opfs.length) throw new Error('No package document defined in container')
        const opfPath = opfs[0].fullPath
        const opf = await this.#loadXML(opfPath)
        if (!opf) throw new Error('Failed to load package document')

        const $encryption = await this.#loadXML('META-INF/encryption.xml')
        await this.#encryption.init($encryption, opf)

        this.resources = new Resources({
            opf,
            resolveHref: url => resolveURL(url, opfPath),
        })
        this.#loader = new Loader({
            loadText: this.loadText,
            loadBlob: uri => Promise.resolve(this.loadBlob(uri))
                .then(this.#encryption.getDecoder(uri)),
            resources: this.resources,
            entries: this.entries,
        })
        this.transformTarget = this.#loader.eventTarget
        // Per-item virtual split state. Map<item.href, {
        //   plan: SplitPlan[], replacedDoc: Doc, mediaType: string,
        //   docPromise: Promise<{doc, mediaType}>, sliceUrls: Map<idx, url>,
        // }>. Populated lazily when a large item is loaded the first time.
        this.#splitState = new Map()
        // Reverse map: virtual section index -> { parentItem, sliceIdx, planLen }
        // Filled by #buildSpineWithSplits below.
        this.#virtualSectionMap = new Map()
        // Map<parent item.href, [sectionIndex,...]> for href routing.
        this.#splitSectionsByHref = new Map()

        const rawSpineSections = this.resources.spine.map((spineItem, index) => {
            const { idref, linear, properties = [] } = spineItem
            const item = this.resources.getItemByID(idref)
            if (!item) {
                console.warn(`Could not find item with ID "${idref}" in manifest`)
                return null
            }
            return {
                item,
                idref,
                linear,
                properties,
                spineIndex: index,
                cfi: this.resources.cfis[index],
            }
        }).filter(s => s)

        this.sections = await this.#buildSpineWithSplits(rawSpineSections)

        const { navPath, ncxPath } = this.resources
        if (navPath) try {
            const resolve = url => resolveURL(url, navPath)
            const nav = parseNav(await this.#loadXML(navPath), resolve)
            this.toc = nav.toc
            this.pageList = nav.pageList
            this.landmarks = nav.landmarks
        } catch(e) {
            console.warn(e)
        }
        // Some publishers ship an EPUB3 nav doc whose <li>s contain only
        // plain text (no <a href>). parseNav returns a non-empty array, so
        // the original check `if (!this.toc)` would skip the NCX fallback
        // and the reader ends up with an unusable empty TOC. Detect this
        // case by recursively checking whether any item has a real href.
        const hasNavigableHref = items => Array.isArray(items) && items.some(
            it => (it && (it.href || hasNavigableHref(it.subitems))))
        if (!hasNavigableHref(this.toc) && ncxPath) try {
            const resolve = url => resolveURL(url, ncxPath)
            const ncx = parseNCX(await this.#loadXML(ncxPath), resolve)
            this.toc = ncx.toc
            this.pageList = ncx.pageList
        } catch(e) {
            console.warn(e)
        }

        this.landmarks ??= this.resources.guide

        const { metadata, rendition, media } = getMetadata(opf)
        this.metadata = metadata
        this.rendition = rendition
        this.media = media
        this.dir = this.resources.pageProgressionDirection
        const displayOptions = getDisplayOptions(
            await this.#loadXML('META-INF/com.apple.ibooks.display-options.xml')
            ?? await this.#loadXML('META-INF/com.kobobooks.display-options.xml'))
        if (displayOptions) {
            if (displayOptions.fixedLayout === 'true')
                this.rendition.layout ??= 'pre-paginated'
            if (displayOptions.openToSpread === 'false') this.sections
                .find(section => section.linear !== 'no').pageSpread ??=
                    this.dir === 'rtl' ? 'left' : 'right'
        }
        return this
    }
    // ---- Virtual splitting for huge single-file spine items ---------------
    async #buildSpineWithSplits(rawSections) {
        const built = []
        for (const raw of rawSections) {
            const { item, linear } = raw
            const size = this.getSize(item.href)
            const isHTMLish = item.mediaType === MIME.XHTML || item.mediaType === MIME.HTML
            // Only consider splitting linear, large HTML/XHTML items.
            const shouldConsider = isHTMLish && linear !== 'no' && size >= SPLIT_MIN_BYTES
            if (!shouldConsider) {
                built.push(this.#makeSimpleSection(raw, size))
                continue
            }
            // Build the plan. We need the parsed (resource-replaced) doc to
            // both detect heading boundaries and to later serve slices, so
            // do it now and cache.
            let plan = null
            let prepared = null
            try {
                prepared = await this.#loader.loadReplacedDoc(item)
                if (prepared?.doc) plan = buildSplitPlan(prepared.doc, size)
            } catch (e) {
                console.warn('buildSplitPlan failed for', item.href, e)
                plan = null
            }
            if (!plan) {
                built.push(this.#makeSimpleSection(raw, size))
                continue
            }
            // Stash state for lazy slice serving.
            // totalTextLen is computed ONCE here — calling textContent on the
            // entire 3MB doc is itself a several-hundred-ms operation and we
            // used to do it inside #makeVirtualSection per slice (10× cost).
            const totalTextLen = prepared.doc?.body?.textContent?.length || 1
            this.#splitState.set(item.href, {
                plan,
                doc: prepared.doc,
                mediaType: prepared.mediaType,
                sliceUrls: new Map(),
                serializedCache: new Map(),  // sliceIdx -> serialized string
                totalTextLen,
            })
            const sectionIndices = []
            for (let i = 0; i < plan.length; i++) {
                const startIdx = built.length
                built.push(this.#makeVirtualSection(raw, plan, i))
                this.#virtualSectionMap.set(startIdx, {
                    parentHref: item.href,
                    parentItem: item,
                    sliceIdx: i,
                    planLen: plan.length,
                })
                sectionIndices.push(startIdx)
            }
            this.#splitSectionsByHref.set(item.href, sectionIndices)
        }
        return built
    }
    #makeSimpleSection(raw, size) {
        const { item, linear, properties, cfi } = raw
        return {
            id: item.href,
            load: () => this.#loader.loadItem(item),
            unload: () => this.#loader.unloadItem(item),
            loadText: () => this.#loader.loadText(item.href),
            loadContent: () => this.#loader.loadItemXHTMLContent(item),
            createDocument: () => this.loadDocument(item),
            size,
            cfi,
            linear,
            spineProperties: properties,
            pageSpread: getPageSpread(properties),
            resolveHref: href => resolveURL(href, item.href),
            mediaOverlay: item.mediaOverlay
                ? this.resources.getItemByID(item.mediaOverlay) : null,
        }
    }
    #makeVirtualSection(raw, plan, sliceIdx) {
        const { item, linear, properties } = raw
        const slice = plan[sliceIdx]
        const state = this.#splitState.get(item.href)
        // crude proportional sizing using text-length ratio of the slice.
        // Only walks the slice's children, not the entire doc — totalTextLen
        // is precomputed once in #buildSpineWithSplits.
        const sliceTextLen = (() => {
            try {
                // slice.start/end index into plan.container.children, which
                // may be a descendant wrapper rather than body itself (see
                // findSplitContainer).
                const container = plan.container || state?.doc?.body
                if (!container) return 0
                const children = Array.from(container.children)
                let n = 0
                for (let i = slice.start; i < slice.end; i++) {
                    n += children[i]?.textContent?.length ?? 0
                }
                return n
            } catch { return 0 }
        })()
        const totalTextLen = state?.totalTextLen || 1
        const realTotal = this.getSize(item.href) || 0
        const approxSize = Math.max(1, Math.round(realTotal * sliceTextLen / totalTextLen))
        // Cached serializer — serializeSlice on a 512KB slice + 3MB head clone
        // costs tens of ms; load/loadText/loadContent/createDocument all want
        // the same string, so cache per (href, sliceIdx).
        const getStr = () => {
            const s = this.#splitState.get(item.href)
            if (!s) return ''
            const cached = s.serializedCache.get(sliceIdx)
            if (cached != null) return cached
            const str = serializeSlice(s.doc, s.plan, sliceIdx)
            s.serializedCache.set(sliceIdx, str)
            return str
        }
        return {
            id: `${item.href}#__slice_${sliceIdx}__`,
            load: () => this.#loadSlice(item, sliceIdx),
            unload: () => this.#unloadSlice(item, sliceIdx),
            loadText: async () => getStr(),
            loadContent: async () => getStr(),
            createDocument: async () => {
                const s = this.#splitState.get(item.href)
                if (!s) return null
                const str = getStr()
                return this.parser.parseFromString(str, s.mediaType)
            },
            size: approxSize,
            // Intentionally null: makes view.js generate a fake CFI keyed on
            // the flat virtual-section index, so the user's progress CFI
            // round-trips back to the exact slice they were reading.
            cfi: null,
            linear,
            spineProperties: properties,
            pageSpread: sliceIdx === 0 ? getPageSpread(properties) : undefined,
            resolveHref: href => resolveURL(href, item.href),
            mediaOverlay: item.mediaOverlay
                ? this.resources.getItemByID(item.mediaOverlay) : null,
            // Mark for debugging / external introspection
            _virtual: { parentHref: item.href, sliceIdx, total: plan.length },
        }
    }
    async #loadSlice(item, sliceIdx) {
        const state = this.#splitState.get(item.href)
        if (!state) return null
        const existing = state.sliceUrls.get(sliceIdx)
        if (existing) return existing
        let str = state.serializedCache.get(sliceIdx)
        if (str == null) {
            str = serializeSlice(state.doc, state.plan, sliceIdx)
            state.serializedCache.set(sliceIdx, str)
        }
        const url = this.#loader.createVirtualSliceURL(
            item.href, sliceIdx, str, state.mediaType)
        state.sliceUrls.set(sliceIdx, url)
        return url
    }
    #unloadSlice(item, sliceIdx) {
        const state = this.#splitState.get(item.href)
        if (!state) return
        // Drop the cached string so memory isn't held while the slice isn't
        // mounted. The blob URL is the heavy resource and is freed below.
        state.serializedCache.delete(sliceIdx)
        if (!state.sliceUrls.has(sliceIdx)) return
        this.#loader.unloadVirtualSlice(item.href, sliceIdx)
        state.sliceUrls.delete(sliceIdx)
    }
    // Find the virtual section index whose slice contains the given anchor id.
    // Returns null when href has no hash or item isn't split.
    #findSliceForAnchor(item, hash) {
        if (!hash) {
            const indices = this.#splitSectionsByHref.get(item.href)
            return indices ? indices[0] : null
        }
        const state = this.#splitState.get(item.href)
        if (!state) return null
        const indices = this.#splitSectionsByHref.get(item.href)
        if (!indices) return null
        for (let i = 0; i < state.plan.length; i++) {
            if (state.plan[i].anchorIds.has(hash)) return indices[i]
        }
        return null
    }
    async loadDocument(item) {
        const str = await this.loadText(item.href)
        return this.parser.parseFromString(str, item.mediaType)
    }
    getMediaOverlay() {
        return new MediaOverlay(this, this.#loadXML.bind(this))
    }
    resolveCFI(cfi) {
        // Fake CFIs (used by view.js when section.cfi is null) directly
        // encode the section index. Virtual slices intentionally set cfi=null
        // so newly-generated progress CFIs round-trip back to the exact
        // slice the user was on.
        let parts
        try { parts = CFI.parse(cfi) } catch { parts = null }
        if (parts) {
            const top = (parts.parent ?? parts)[0]
            if (top && Array.isArray(top) && top.length === 1
                && top[0].index != null && !top[0].id) {
                // Looks like a fake CFI prefix: /6/N with no idref assertion.
                // Verify the spine path doesn't actually resolve in the OPF.
                let resolvedFromOpf = null
                try { resolvedFromOpf = this.resources.resolveCFI(cfi) } catch { /* ignore */ }
                if (!resolvedFromOpf || resolvedFromOpf.index < 0
                    || resolvedFromOpf.index >= this.resources.spine.length) {
                    const flatIdx = CFI.fake.toIndex((parts.parent ?? parts).shift())
                    if (flatIdx >= 0 && flatIdx < this.sections.length) {
                        const anchor = doc => CFI.toRange(doc, parts)
                        return { index: flatIdx, anchor }
                    }
                }
            }
        }
        const resolved = this.resources.resolveCFI(cfi)
        if (!resolved) return resolved
        // resolved.index is the opf-spine index. If that spine item was
        // virtually split, the actual reader sections array uses different
        // indices — remap to the first slice (legacy CFIs cannot pinpoint
        // which slice they belong to, so we default to slice 0; the user's
        // position is still close enough and they can navigate from there).
        const spineItem = this.resources.spine[resolved.index]
        if (!spineItem) return resolved
        const item = this.resources.getItemByID(spineItem.idref)
        if (!item) return resolved
        const indices = this.#splitSectionsByHref.get(item.href)
        if (indices && indices.length) {
            return { index: indices[0], anchor: resolved.anchor }
        }
        // Not split — translate opf-spine index into our flat sections index.
        const sectionIdx = this.sections.findIndex(s => s.id === item.href)
        return { index: sectionIdx >= 0 ? sectionIdx : resolved.index, anchor: resolved.anchor }
    }
    resolveHref(href) {
        const [path, hash] = href.split('#')
        const item = this.resources.getItemByHref(decodeURI(path))
        if (!item) return null
        // If this item is virtually split, route to the slice that contains
        // the anchor (or the first slice when no anchor was given).
        const sliceIndex = this.#findSliceForAnchor(item, hash)
        if (sliceIndex != null) {
            const anchor = hash ? doc => getHTMLFragment(doc, hash) : () => 0
            return { index: sliceIndex, anchor }
        }
        // Default: locate by section.id in the flat sections array. We can't
        // use resources.spine index directly because splits make them diverge.
        const index = this.sections.findIndex(s => s.id === item.href)
        const anchor = hash ? doc => getHTMLFragment(doc, hash) : () => 0
        return { index: index >= 0 ? index : 0, anchor }
    }
    splitTOCHref(href) {
        return href?.split('#') ?? []
    }
    getTOCFragment(doc, id) {
        return doc.getElementById(id)
            ?? doc.querySelector(`[name="${CSS.escape(id)}"]`)
    }
    isExternal(uri) {
        return isExternal(uri)
    }
    async getCover() {
        const cover = this.resources?.cover
        return cover?.href
            ? new Blob([await this.loadBlob(cover.href)], { type: cover.mediaType })
            : null
    }
    async getCalibreBookmarks() {
        const txt = await this.loadText('META-INF/calibre_bookmarks.txt')
        const magic = 'encoding=json+base64:'
        if (txt?.startsWith(magic)) {
            const json = atob(txt.slice(magic.length))
            return JSON.parse(json)
        }
    }
    destroy() {
        this.#loader?.destroy()
    }
}
