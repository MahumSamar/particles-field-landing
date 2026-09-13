/**
 * A single requestAnimationFrame loop shared by everything on the page.
 *
 * The original site does exactly this: one rAF, one Set of subscribers, and one
 * scroll read per frame. Every consumer (WebGL scene, DOM reveals, nav state)
 * gets the same `y` for the same frame, so nothing can drift out of phase, and
 * there is not a single `scroll` event listener anywhere.
 */

export interface FrameState {
  /** Smoothed scroll position, in px. */
  y: number
  /** Viewport height, in px. */
  H: number
  /** Seconds since the loop started. */
  time: number
  /** Seconds since the previous frame, clamped to avoid tab-switch spikes. */
  dt: number
}

type Subscriber = (state: FrameState) => void

const subscribers = new Set<Subscriber>()
let rafId = 0
let running = false
let startedAt = 0
let previous = 0

let readScroll: () => number = () => window.scrollY

/**
 * Point the bus at a smooth-scroll library (Lenis, ScrollSmoother, …) instead
 * of raw `window.scrollY`. This is the one hook that keeps WebGL motion locked
 * to the eased scroll position the user actually sees.
 */
export function setScrollSource(source: () => number): void {
  readScroll = source
}

export function resetScrollSource(): void {
  readScroll = () => window.scrollY
}

const state: FrameState = { y: 0, H: 0, time: 0, dt: 0 }

function tick(): void {
  const now = performance.now()

  state.y = readScroll()
  state.H = window.innerHeight
  state.time = (now - startedAt) / 1000
  state.dt = Math.min((now - previous) / 1000, 0.1)
  previous = now

  // Iterating the Set directly is safe: unsubscribing during a tick only
  // affects entries not yet visited, which is the behaviour we want.
  for (const fn of subscribers) fn(state)

  rafId = requestAnimationFrame(tick)
}

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn)

  if (!running) {
    running = true
    startedAt = previous = performance.now()
    rafId = requestAnimationFrame(tick)
  }

  return () => {
    subscribers.delete(fn)
    if (subscribers.size === 0 && running) {
      running = false
      cancelAnimationFrame(rafId)
    }
  }
}

export const prefersReducedMotion =
  typeof matchMedia !== 'undefined' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches

export const hasFinePointer =
  typeof matchMedia !== 'undefined' &&
  matchMedia('(hover: hover) and (pointer: fine)').matches
