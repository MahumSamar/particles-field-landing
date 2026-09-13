/**
 * The workshop film. Rises from the bottom over the air slide — already
 * playing — then holds pinned while the copy introducing the carver arrives.
 *
 * Two disciplines carried over from the costa-serenade archive:
 *
 *  - Playback flips on a scroll EDGE, never a per-frame poll: play()/pause()
 *    fire only when the wanted-state changes, a third branch resumes a video
 *    the browser paused itself (backgrounded tab) without rewinding, and every
 *    play() carries .catch(() => {}) because a rejected play promise is
 *    otherwise an unhandled rejection.
 *  - Nothing is lit before it has painted: the video fades in only after
 *    'loadeddata', so the section can never slide up as a black rectangle.
 */
import { subscribe, prefersReducedMotion } from '../particles/frameBus'
import { CRAFT_VIDEO } from './masks'
import { TIMELINE } from './sections'

/** Load the clip once the earth slide opens — ~300vh of scroll before use. */
const PRELOAD_AT_VH = TIMELINE.HERO_VH + 2 * TIMELINE.SLIDE_VH + TIMELINE.CUT_VH

export interface FilmHandle {
  dispose(): void
}

export function mountFilm(): FilmHandle {
  const film = document.getElementById('film')
  if (!film) throw new Error('film: #film missing')
  const { FILM_START, FILM_ENTER, FILM_HOLD, RUNWAY, COVER_MARGIN } = TIMELINE

  // --- DOM -----------------------------------------------------------------
  const video = document.createElement('video')
  video.className = 'film__video'
  video.muted = true
  video.loop = true
  video.playsInline = true
  video.preload = 'none' // src attaches at PRELOAD_AT_VH
  video.setAttribute('aria-hidden', 'true')
  video.addEventListener('loadeddata', () => { film.dataset.ready = '' })
  video.addEventListener('error', () => {
    const e = video.error
    console.info(`[film] media error${e ? ' code ' + e.code : ''}`)
  })

  const scrim = document.createElement('div')
  scrim.className = 'film__scrim'

  // Plain three-line heading, same scale as the slide screens' name —
  // clamp(34px, 3.4vw, 50px) — so this screen doesn't invent a new voice.
  const head = document.createElement('h2')
  head.className = 'film__head film__item'
  const lines = ['Kurihara Sōgen', 'forty-one years', 'one bench']
  for (const [i, line] of lines.entries()) {
    if (i) head.append(document.createElement('br'))
    const span = document.createElement('span')
    span.textContent = line
    head.append(span)
  }

  const desc = document.createElement('p')
  desc.className = 'film__desc film__item'
  desc.textContent =
    'Second-generation menuchi. He took the workshop from his father in 1998 ' +
    'and has cut every mask in the house since — hinoki from Kiso, gofun he ' +
    'grinds himself. The wave faces are his alone; nobody else is allowed to ' +
    'paint them.'

  film.append(video, scrim, head, desc)

  // --- Drive ---------------------------------------------------------------
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
  const last = ['', '', '', '']
  const put = (slot: number, name: string, value: string) => {
    if (last[slot] === value) return
    last[slot] = value
    if (name === 'visibility') film.style.visibility = value
    else film.style.setProperty(name, value)
  }

  let loadKicked = false
  let playWanted = false

  const unsubscribe = subscribe(({ y, H }) => {
    const vh = (y / Math.max(1, H)) * 100

    if (!loadKicked && vh >= PRELOAD_AT_VH) {
      loadKicked = true
      video.src = CRAFT_VIDEO
      video.preload = 'auto'
      video.load()
    }

    const enter = clamp01((vh - FILM_START) / FILM_ENTER)
    const holdStart = FILM_START + FILM_ENTER
    // The copy now owns the whole hold, which the outline used to share.
    const fcopy = clamp01((vh - holdStart) / (FILM_HOLD * 0.7))

    put(0, '--enter', enter.toFixed(4))
    put(2, '--fcopy', fcopy.toFixed(4))
    // The finale (in flow, starting at RUNWAY - 100) scrolls over this pinned
    // section; drop it from compositing once fully covered, with the same
    // margin discipline as the slides.
    const finaleCovers = RUNWAY + COVER_MARGIN
    put(3, 'visibility', vh > FILM_START - 20 && vh < finaleCovers ? 'visible' : 'hidden')

    // Playback edge — play() only when the section is (about to be) on
    // screen, so it is already running as it rises. Under reduced motion the
    // first frame stands; the outline still draws, scroll-driven as it is.
    const want =
      !prefersReducedMotion &&
      loadKicked &&
      vh >= FILM_START - 20 &&
      vh < RUNWAY - 15 // finale ~85% over the film: nothing of it left to see
    if (want !== playWanted) {
      playWanted = want
      if (want) video.play().catch(() => {})
      else video.pause()
    } else if (want && video.paused) {
      video.play().catch(() => {}) // tab was hidden — resume, do NOT rewind
    }
  })

  return {
    dispose() {
      unsubscribe()
      video.pause()
      video.removeAttribute('src')
      film.replaceChildren()
    },
  }
}
