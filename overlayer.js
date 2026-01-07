const createSVGElement = tag =>
    document.createElementNS('http://www.w3.org/2000/svg', tag)

export class Overlayer {
    #svg = createSVGElement('svg')
    #map = new Map()
    #doc = null
    constructor(doc) {
        this.#doc = doc
        Object.assign(this.#svg.style, {
            position: 'absolute', top: '0', left: '0',
            width: '100%', height: '100%',
            pointerEvents: 'none',
        })
    }
    get element() {
        return this.#svg
    }
    get #zoom() {
        // Safari does not zoom the client rects, while Chrome, Edge and Firefox does
        if (/^((?!chrome|android).)*AppleWebKit/i.test(navigator.userAgent) && !window.chrome) {
            return window.getComputedStyle(this.#doc.body).zoom || 1.0
        }
        return 1.0
    }
    #splitRangeByParagraph(range) {
        const ancestor = range.commonAncestorContainer
        const paragraphs = Array.from(ancestor.querySelectorAll?.('p, h1, h2, h3, h4') || [])

        const splitRanges = []
        paragraphs.forEach((p) => {
            const pRange = document.createRange()
            if (range.intersectsNode(p)) {
                pRange.selectNodeContents(p)
                if (pRange.compareBoundaryPoints(Range.START_TO_START, range) < 0) {
                    pRange.setStart(range.startContainer, range.startOffset)
                }
                if (pRange.compareBoundaryPoints(Range.END_TO_END, range) > 0) {
                    pRange.setEnd(range.endContainer, range.endOffset)
                }
                splitRanges.push(pRange)
            }
        })
        return splitRanges.length === 0 ? [range] : splitRanges
    }
    add(key, range, draw, options) {
        if (this.#map.has(key)) this.remove(key)
        if (typeof range === 'function') range = range(this.#svg.getRootNode())
        const zoom = this.#zoom
        let rects = []
        this.#splitRangeByParagraph(range).forEach((pRange) => {
            const pRects = Array.from(pRange.getClientRects()).map(rect => ({
                left: rect.left * zoom,
                top: rect.top * zoom,
                right: rect.right * zoom,
                bottom: rect.bottom * zoom,
                width: rect.width * zoom,
                height: rect.height * zoom,
            }))
            rects = rects.concat(pRects)
        })
        const element = draw(rects, options)
        this.#svg.append(element)
        this.#map.set(key, { range, draw, options, element, rects })
    }
    remove(key) {
        if (!this.#map.has(key)) return
        this.#svg.removeChild(this.#map.get(key).element)
        this.#map.delete(key)
    }
    redraw() {
        for (const obj of this.#map.values()) {
            const { range, draw, options, element } = obj
            this.#svg.removeChild(element)
            const zoom = this.#zoom
            let rects = []
            this.#splitRangeByParagraph(range).forEach((pRange) => {
                const pRects = Array.from(pRange.getClientRects()).map(rect => ({
                    left: rect.left * zoom,
                    top: rect.top * zoom,
                    right: rect.right * zoom,
                    bottom: rect.bottom * zoom,
                    width: rect.width * zoom,
                    height: rect.height * zoom,
                }))
                rects = rects.concat(pRects)
            })
            const el = draw(rects, options)
            this.#svg.append(el)
            obj.element = el
            obj.rects = rects
        }
    }
    hitTest({ x, y }) {
        const arr = Array.from(this.#map.entries())
        // loop in reverse to hit more recently added items first
        for (let i = arr.length - 1; i >= 0; i--) {
            const tolerance = 5
            const [key, obj] = arr[i]
            for (const { left, top, right, bottom } of obj.rects) {
                if (
                    top <= y + tolerance &&
                    left <= x + tolerance &&
                    bottom > y - tolerance &&
                    right > x - tolerance
                ) {
                    return [key, obj.range, { left, top, right, bottom }]
                }
            }
        }
        return []
    }
    static underline(rects, options = {}) {
        const { color = 'red', width: strokeWidth = 2, padding = 0, writingMode } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', color)
        if (writingMode === 'vertical-rl' || writingMode === 'vertical-lr')
            for (const { right, top, height } of rects) {
                const el = createSVGElement('rect')
                el.setAttribute('x', right - strokeWidth / 2 + padding)
                el.setAttribute('y', top)
                el.setAttribute('height', height)
                el.setAttribute('width', strokeWidth)
                g.append(el)
            }
        else for (const { left, bottom, width } of rects) {
            const el = createSVGElement('rect')
            el.setAttribute('x', left)
            el.setAttribute('y', bottom - strokeWidth / 2 + padding)
            el.setAttribute('height', strokeWidth)
            el.setAttribute('width', width)
            g.append(el)
        }
        return g
    }
    static strikethrough(rects, options = {}) {
        const { color = 'red', width: strokeWidth = 2, writingMode } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', color)
        if (writingMode === 'vertical-rl' || writingMode === 'vertical-lr')
            for (const { right, left, top, height } of rects) {
                const el = createSVGElement('rect')
                el.setAttribute('x', (right + left) / 2)
                el.setAttribute('y', top)
                el.setAttribute('height', height)
                el.setAttribute('width', strokeWidth)
                g.append(el)
            }
        else for (const { left, top, bottom, width } of rects) {
            const el = createSVGElement('rect')
            el.setAttribute('x', left)
            el.setAttribute('y', (top + bottom) / 2)
            el.setAttribute('height', strokeWidth)
            el.setAttribute('width', width)
            g.append(el)
        }
        return g
    }
    static squiggly(rects, options = {}) {
        const { color = 'red', width: strokeWidth = 2, padding = 0, writingMode } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', 'none')
        g.setAttribute('stroke', color)
        g.setAttribute('stroke-width', strokeWidth)
        const block = strokeWidth * 1.5
        if (writingMode === 'vertical-rl' || writingMode === 'vertical-lr')
            for (const { right, top, height } of rects) {
                const el = createSVGElement('path')
                const n = Math.round(height / block / 1.5)
                const inline = height / n
                const ls = Array.from({ length: n },
                    (_, i) => `l${i % 2 ? -block : block} ${inline}`).join('')
                el.setAttribute('d', `M${right - strokeWidth / 2 + padding} ${top}${ls}`)
                g.append(el)
            }
        else for (const { left, bottom, width } of rects) {
            const el = createSVGElement('path')
            const n = Math.round(width / block / 1.5)
            const inline = width / n
            const ls = Array.from({ length: n },
                (_, i) => `l${inline} ${i % 2 ? block : -block}`).join('')
            el.setAttribute('d', `M${left} ${bottom + strokeWidth / 2 + padding}${ls}`)
            g.append(el)
        }
        return g
    }
    static highlight(rects, options = {}) {
        const { color = 'red', padding = 0 } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', color)
        g.style.opacity = 'var(--overlayer-highlight-opacity, .3)'
        g.style.mixBlendMode = 'var(--overlayer-highlight-blend-mode, normal)'
        for (const { left, top, height, width } of rects) {
            const el = createSVGElement('rect')
            el.setAttribute('x', left - padding)
            el.setAttribute('y', top - padding)
            el.setAttribute('height', height + padding * 2)
            el.setAttribute('width', width + padding * 2)
            g.append(el)
        }
        return g
    }
    static outline(rects, options = {}) {
        const { color = 'red', width: strokeWidth = 3, padding = 0, radius = 3 } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', 'none')
        g.setAttribute('stroke', color)
        g.setAttribute('stroke-width', strokeWidth)
        for (const { left, top, height, width } of rects) {
            const el = createSVGElement('rect')
            el.setAttribute('x', left - padding)
            el.setAttribute('y', top - padding)
            el.setAttribute('height', height + padding * 2)
            el.setAttribute('width', width + padding * 2)
            el.setAttribute('rx', radius)
            g.append(el)
        }
        return g
    }
    static bubble(rects, options = {}) {
        const { color = '#fbbf24', writingMode, opacity = 0.85, size = 20, padding = 10 } = options
        const isVertical = writingMode === 'vertical-rl' || writingMode === 'vertical-lr'
        const g = createSVGElement('g')
        g.style.opacity = opacity
        if (rects.length === 0) return g
        rects.splice(1)
        const firstRect = rects[0]
        const x = isVertical ? firstRect.right - size + padding : firstRect.right - size + padding
        const y = isVertical ? firstRect.bottom - size + padding : firstRect.top - size + padding
        firstRect.top = y - padding
        firstRect.right = x + size + padding
        firstRect.bottom = y + size + padding
        firstRect.left = x - padding
        const bubble = createSVGElement('path')
        const s = size
        const r = s * 0.15
        // Speech bubble shape with a small tail
        // Main rounded rectangle body
        const d = `
            M ${x + r} ${y}
            h ${s - 2 * r}
            a ${r} ${r} 0 0 1 ${r} ${r}
            v ${s * 0.65 - 2 * r}
            a ${r} ${r} 0 0 1 ${-r} ${r}
            h ${-s * 0.3}
            l ${-s * 0.15} ${s * 0.2}
            l ${s * 0.05} ${-s * 0.2}
            h ${-s * 0.6 + 2 * r}
            a ${r} ${r} 0 0 1 ${-r} ${-r}
            v ${-s * 0.65 + 2 * r}
            a ${r} ${r} 0 0 1 ${r} ${-r}
            z
        `.replace(/\s+/g, ' ').trim()

        bubble.setAttribute('d', d)
        bubble.setAttribute('fill', color)
        bubble.setAttribute('stroke', 'rgba(0, 0, 0, 0.2)')
        bubble.setAttribute('stroke-width', '1')
        // Add horizontal lines inside to represent text
        const lineGroup = createSVGElement('g')
        lineGroup.setAttribute('stroke', 'rgba(0, 0, 0, 0.3)')
        lineGroup.setAttribute('stroke-width', '1.5')
        lineGroup.setAttribute('stroke-linecap', 'round')
        const lineY1 = y + s * 0.18
        const lineY2 = y + s * 0.33
        const lineY3 = y + s * 0.48
        const lineX1 = x + s * 0.2
        const lineX2 = x + s * 0.8
        const line1 = createSVGElement('line')
        line1.setAttribute('x1', lineX1)
        line1.setAttribute('y1', lineY1)
        line1.setAttribute('x2', lineX2)
        line1.setAttribute('y2', lineY1)
        const line2 = createSVGElement('line')
        line2.setAttribute('x1', lineX1)
        line2.setAttribute('y1', lineY2)
        line2.setAttribute('x2', lineX2)
        line2.setAttribute('y2', lineY2)
        const line3 = createSVGElement('line')
        line3.setAttribute('x1', lineX1)
        line3.setAttribute('y1', lineY3)
        line3.setAttribute('x2', x + s * 0.6)
        line3.setAttribute('y2', lineY3)
        lineGroup.append(line1, line2, line3)

        if (isVertical) {
            const centerX = x + s / 2
            const centerY = y + s / 2
            bubble.setAttribute('transform', `rotate(90 ${centerX} ${centerY})`)
            lineGroup.setAttribute('transform', `rotate(90 ${centerX} ${centerY})`)
        }

        g.append(bubble)
        g.append(lineGroup)
        return g
    }
    // make an exact copy of an image in the overlay
    // one can then apply filters to the entire element, without affecting them;
    // it's a bit silly and probably better to just invert images twice
    // (though the color will be off in that case if you do heu-rotate)
    static copyImage([rect], options = {}) {
        const { src } = options
        const image = createSVGElement('image')
        const { left, top, height, width } = rect
        image.setAttribute('href', src)
        image.setAttribute('x', left)
        image.setAttribute('y', top)
        image.setAttribute('height', height)
        image.setAttribute('width', width)
        return image
    }
}

