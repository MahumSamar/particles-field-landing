/**
 * The four element slides and the diagonal cut that joins them.
 *
 * The cut is ported from the costa-serenade archive: a fixed, overflow-hidden
 * box whose WIDTH grows while the box itself rotates toward 45°, with the
 * content inside counter-rotated so the picture stays upright. The seam is the
 * box's leading edge, and because the rotation ramps with the opening (13.5°
 * at 0.3, 27° at 0.6) the slice reads as "slightly turned", never as a static
 * wipe. Two load-bearing details from that build are kept verbatim:
 *
 *  - the span is 72vw + 72vh ≈ 0.707 × (100vw + 100vh), which is what makes
 *    the strip hit fullscreen EXACTLY at progress 1 — an eyeballed 220vmax
 *    closes the picture at ~0.53 and wastes half the move;
 *  - the inner box is locked to 100vw × 100vh and counter-rotates by reading
 *    the same custom property, so the two rotations cannot drift apart.
 *
 * Everything is scroll-linked: the driver subscribes to the shared frame bus,
 * converts scroll into per-slide progress values, and writes them as CSS
 * custom properties on the slide elements. CSS does the rest, which is why it
 * stays smooth on a throttled tab.
 */
import { subscribe } from '../particles/frameBus'
import { MASKS } from './masks'

/**
 * The one scroll map every pinned section reads. All values are in viewport
 * heights of scroll. The film and finale drivers import this rather than
 * keeping their own numbers, so the sections can never disagree about where
 * one hands over to the next.
 */
export const TIMELINE = {
  /** Scroll the hero's dolly owns before slide 1 starts cutting in. */
  HERO_VH: 100,
  /** Scroll one cut takes to open. */
  CUT_VH: 60,
  /** Scroll the copy stagger takes after the cut has opened. */
  COPY_VH: 45,
  /** Total scroll per slide: cut + copy + hold. */
  SLIDE_VH: 150,
  /** Film section: where it starts rising, how long the rise and the hold. */
  FILM_START: 0, // filled below
  FILM_ENTER: 80,
  FILM_HOLD: 140,
  /** Pinned runway total; the spacer is this tall and the finale flows after. */
  RUNWAY: 0, // filled below
  /**
   * Extra scroll a covered layer stays painted past full coverage. The corner
   * slack at reveal 1 is small (tens of px), and hiding the layer below at the
   * exact coverage threshold is what made the bottom-left corner flicker as
   * Lenis jittered across it. Symmetric on the way back.
   */
  COVER_MARGIN: 8,
}
TIMELINE.FILM_START = TIMELINE.HERO_VH + 4 * TIMELINE.SLIDE_VH
TIMELINE.RUNWAY =
  TIMELINE.FILM_START + TIMELINE.FILM_ENTER + TIMELINE.FILM_HOLD + 100
// How much the mask grows lives in CSS: .slide__mask scales by --zoom × 0.24.

export interface SectionsHandle {
  /** Pinned runway length, in viewport heights (spacer height). */
  totalVh: number
  dispose(): void
}

/**
 * Build the slides into `#slides`, size the scroll spacer, and start driving.
 * `onCover` fires on the EDGE where slide 1 fully covers (or uncovers) the
 * hero — the caller uses it to pause the WebGPU loop that would otherwise
 * keep burning GPU behind an opaque layer.
 */
export function mountSections(onCover: (covered: boolean) => void): SectionsHandle {
  const host = document.getElementById('slides')
  const spacer = document.querySelector<HTMLElement>('.scroll-range')
  if (!host || !spacer) throw new Error('sections: #slides or .scroll-range missing')

  const { HERO_VH, CUT_VH, COPY_VH, SLIDE_VH, FILM_START, FILM_ENTER, COVER_MARGIN } = TIMELINE
  const totalVh = TIMELINE.RUNWAY
  spacer.style.height = `${totalVh}vh`

  // --- DOM -----------------------------------------------------------------
  const slides = MASKS.map((mask, i) => {
    const slide = document.createElement('section')
    slide.className = 'slide'
    slide.dataset.element = mask.key
    slide.style.zIndex = String(10 + i * 10)
    slide.style.setProperty('--slide-bg', mask.background)

    const inner = document.createElement('div')
    inner.className = 'slide__inner'

    const head = document.createElement('h2')
    head.className = 'slide__head slide__item'
    const nameLine = document.createElement('span')
    nameLine.textContent = mask.name
    const epithetLine = document.createElement('span')
    epithetLine.textContent = mask.epithet
    head.append(nameLine, document.createElement('br'), epithetLine)

    const id = document.createElement('p')
    id.className = 'slide__id slide__item'
    id.textContent = mask.id

    const desc = document.createElement('p')
    desc.className = 'slide__desc slide__item'
    desc.textContent = mask.description

    const chip = document.createElement('figure')
    chip.className = 'slide__chip slide__item'
    const chipImg = document.createElement('img')
    chipImg.src = mask.textureUrl
    chipImg.alt = ''
    chipImg.loading = 'eager'
    chip.append(chipImg)

    const img = document.createElement('img')
    img.className = 'slide__mask'
    img.src = mask.maskUrl
    img.alt = `${mask.name} — hannya ${mask.epithet}`
    img.loading = 'eager'
    img.draggable = false

    // Paint order is DOM order: colour field, copy, then the mask over them.
    // The logotype is not here — it lives once in the fixed header, above
    // every section.
    inner.append(head, id, desc, chip, img)
    slide.append(inner)
    return slide
  })
  host.append(...slides)

  // A cut that opens onto an undecoded 1.6 MB image shows a bare colour field,
  // so start every decode now, during the hero, not when the seam appears.
  for (const mask of MASKS) {
    const img = new Image()
    img.src = mask.maskUrl
    img.decode().catch(() => {})
  }

  // --- Drive ---------------------------------------------------------------
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
  let covered = false

  // Cache writes: per-slide vars touched only when the value moves.
  const last: string[][] = slides.map(() => ['', '', '', '', ''])
  const put = (i: number, slot: number, name: string, value: string) => {
    if (last[i][slot] === value) return
    last[i][slot] = value
    if (name === 'visibility') slides[i].style.visibility = value
    else slides[i].style.setProperty(name, value)
  }

  const unsubscribe = subscribe(({ y, H }) => {
    const vh = (y / Math.max(1, H)) * 100
    for (let i = 0; i < MASKS.length; i++) {
      const start = HERO_VH + i * SLIDE_VH
      const reveal = clamp01((vh - start) / CUT_VH)
      const copy = clamp01((vh - start - CUT_VH) / COPY_VH)
      // The mask keeps growing from the moment its cut finishes until the NEXT
      // layer has fully covered it — that continuing growth is the parallax
      // you see behind the next seam. For the last slide the next layer is the
      // film section rising from the bottom.
      const zoomSpan =
        i < MASKS.length - 1 ? SLIDE_VH : FILM_START + FILM_ENTER - (start + CUT_VH)
      const zoom = clamp01((vh - start - CUT_VH) / zoomSpan)

      put(i, 0, '--reveal', reveal.toFixed(4))
      put(i, 1, '--copy', copy.toFixed(4))
      put(i, 2, '--zoom', zoom.toFixed(4))

      // Skip compositing slides that contribute no pixels: not yet cut in, or
      // fully hidden behind the next layer. COVER_MARGIN keeps the slide
      // painted a little past full coverage — hiding it at the exact coverage
      // threshold is what flickered the bottom-left corner, where the wedge's
      // slack is only a few pixels.
      const coveredAtVh =
        i < MASKS.length - 1
          ? HERO_VH + (i + 1) * SLIDE_VH + CUT_VH
          : FILM_START + FILM_ENTER
      put(i, 3, 'visibility', reveal > 0 && vh < coveredAtVh + COVER_MARGIN ? 'visible' : 'hidden')
    }

    // The air slide backs out as the film rises: copy leaves in reverse
    // stagger, the mask shrinks and darkens under the incoming section.
    const exit = clamp01((vh - FILM_START) / FILM_ENTER)
    put(MASKS.length - 1, 4, '--exit', exit.toFixed(4))

    const nowCovered = vh >= HERO_VH + CUT_VH + COVER_MARGIN
    if (nowCovered !== covered) {
      covered = nowCovered
      onCover(covered)
    }
  })

  return {
    totalVh,
    dispose() {
      unsubscribe()
      for (const slide of slides) slide.remove()
    },
  }
}
