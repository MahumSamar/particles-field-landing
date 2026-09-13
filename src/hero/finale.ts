/**
 * The closing screen. Normal flow again — it scrolls up OVER the pinned stack
 * (position: relative, z-index above every fixed layer), so from here down the
 * page behaves like an ordinary document.
 *
 * The four masks hop over the headline the way masks twitch in old Japanese
 * ritual film — a short sharp rise, a slower settle, then a long uneven pause.
 * Each runs its own duration and delay, so they never phase-lock into a
 * carousel. Pure CSS keyframes; disabled under prefers-reduced-motion.
 */
import { subscribe } from '../particles/frameBus'
import { MASKS } from './masks'

export interface FinaleHandle {
  dispose(): void
}

export function mountFinale(): FinaleHandle {
  const finale = document.getElementById('finale')
  if (!finale) throw new Error('finale: #finale missing')

  // --- DOM -----------------------------------------------------------------
  const micro = document.createElement('p')
  micro.className = 'finale__micro finale__item'
  micro.textContent = 'Four elements. Four faces. One bench.'

  const head = document.createElement('h2')
  head.className = 'finale__head finale__item'
  for (const [i, line] of ['Commission', 'your own', 'omote'].entries()) {
    if (i) head.append(document.createElement('br'))
    head.append(line)
  }

  // Positions from the Figma lower band (1470×1116), as percentages, so the
  // arrangement survives any viewport. The masks reuse the slide images —
  // already in cache, zero extra transfer.
  const spots = [
    { key: 'water', left: 0.6, top: 39.3 },
    { key: 'fire', left: 25.3, top: 39.3 },
    { key: 'earth', left: 50.0, top: 52.0 },
    { key: 'air', left: 74.7, top: 52.0 },
  ]
  const masks = spots.map((spot, i) => {
    const mask = MASKS.find((m) => m.key === spot.key)!
    const img = document.createElement('img')
    img.className = `finale__mask finale__mask--${i + 1} finale__item`
    img.src = mask.maskUrl
    img.alt = ''
    img.loading = 'lazy'
    img.draggable = false
    img.style.left = `${spot.left}%`
    img.style.top = `${spot.top}%`
    return img
  })

  const label = document.createElement('p')
  label.className = 'finale__label finale__item'
  label.textContent = 'menuchi © 2026'

  const note = document.createElement('p')
  note.className = 'finale__note finale__item'
  note.textContent =
    'Commissions open twice a year, spring and autumn. Write with the ' +
    'element you keep returning to — letters are answered in order, by hand.'

  finale.append(micro, head, ...masks, label, note)

  // --- Drive ---------------------------------------------------------------
  // Each item reveals from ITS OWN position in the viewport, not from a
  // section-wide progress. The finale is in normal flow, so it rides up with
  // the page: a single progress tied to page scroll is spent before the item
  // is on screen (measured — the label and note reached 100% a full 34vh
  // before they cleared the fold, which is why nothing appeared to animate).
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
  const items = [...finale.querySelectorAll<HTMLElement>('.finale__item')]

  // Document offsets are measured on mount and on resize, never inside the
  // frame callback — reading layout per frame would force a reflow mid-render.
  let tops: number[] = []
  const measure = () => {
    const base = scrollY
    tops = items.map((el) => el.getBoundingClientRect().top + base)
  }
  measure()
  addEventListener('resize', measure)
  // Fonts and the lazy mask images shift the layout after first paint.
  if (document.fonts?.ready) document.fonts.ready.then(measure).catch(() => {})

  const lastNk: string[] = items.map(() => '')
  const unsubscribe = subscribe(({ y, H }) => {
    for (let i = 0; i < items.length; i++) {
      // Starts as the item crosses 95% of the viewport, completes over 22vh.
      // The trigger sits low deliberately: the bottom row comes to rest around
      // 87-90% of the viewport, so an earlier line would be one the page runs
      // out of scroll before reaching — which is exactly why the copyright and
      // the note used to sit at opacity 0 forever. The trailing .finale-runway
      // supplies the scroll this needs.
      // The small index term keeps co-located items (label and note share a
      // baseline) arriving in sequence rather than together.
      const trigger = y + H * (0.95 - i * 0.012)
      const nk = clamp01((trigger - tops[i]) / (H * 0.22)).toFixed(4)
      if (nk !== lastNk[i]) {
        lastNk[i] = nk
        items[i].style.setProperty('--nk', nk)
      }
    }
  })

  return {
    dispose() {
      unsubscribe()
      removeEventListener('resize', measure)
      finale.replaceChildren()
    },
  }
}
