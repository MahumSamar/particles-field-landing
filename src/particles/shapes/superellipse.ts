import type { ShapeSampler } from './index'

export interface SuperellipseOptions {
  /**
   * Shape exponent. The curve is `(|x|/a)^(2/n) + (|y|/b)^(2/n) = 1`, so the
   * effective exponent is `2/n` and values of `n > 2` push it below 1, making
   * the curve *concave* — which is where the 4-pointed sparkle comes from.
   *
   *   n = 2.0  → rhombus
   *   n = 3.7  → the milancompain.com star
   *   n = 6.0  → sharp needles
   */
  n?: number
  /** Vertical stretch. 1.05 makes it slightly taller than wide. */
  aspect?: number
  /** Half-width in world units. */
  radius?: number
  /** Arc-length lookup table resolution. */
  lut?: number
}

const TAU = Math.PI * 2

/**
 * The 4-pointed star is one function — no model, no texture, no asset.
 * Polar form of the Lamé curve: r(θ) = [ (|cosθ|/a)^e + (|sinθ|/b)^e ]^(-1/e).
 */
function radiusAt(theta: number, a: number, b: number, e: number, invE: number): number {
  const c = Math.pow(Math.abs(Math.cos(theta)) / a, e)
  const s = Math.pow(Math.abs(Math.sin(theta)) / b, e)
  return Math.pow(c + s, invE)
}

export function superellipse(options: SuperellipseOptions = {}): ShapeSampler {
  const n = options.n ?? 3.7
  const aspect = options.aspect ?? 1.05
  const a = options.radius ?? 5.3
  const b = a * aspect
  const lutSize = options.lut ?? 1440

  const e = 2 / n
  const invE = -n / 2

  const r = (theta: number) => radiusAt(theta, a, b, e, invE)

  // --- Cumulative arc-length table, walked once at build time -------------
  // lut[i] is the distance travelled along the outline from θ=0 to θ=i/lutSize·2π.
  const lut = new Float32Array(lutSize + 1)
  {
    let travelled = 0
    let px = r(0)
    let py = 0
    for (let i = 0; i <= lutSize; i++) {
      const theta = (i / lutSize) * TAU
      const rad = r(theta)
      const x = Math.cos(theta) * rad
      const y = Math.sin(theta) * rad
      if (i > 0) travelled += Math.hypot(x - px, y - py)
      lut[i] = travelled
      px = x
      py = y
    }
  }
  const perimeter = lut[lutSize]

  /** Invert arc length → θ by binary-searching the table, then lerping. */
  function thetaAtLength(target: number): number {
    let lo = 0
    let hi = lutSize
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (lut[mid] < target) lo = mid + 1
      else hi = mid
    }
    const i = Math.max(1, lo)
    const prev = lut[i - 1]
    const next = lut[i]
    const frac = next > prev ? (target - prev) / (next - prev) : 0
    return ((i - 1 + frac) / lutSize) * TAU
  }

  const rMax = Math.max(a, b)

  return {
    bounds: () => ({ halfW: a, halfH: b }),

    rim(count) {
      const out = new Float32Array(count * 2)
      for (let i = 0; i < count; i++) {
        // Jitter within the slot so the outline never looks like a dotted line.
        const s = ((i + Math.random() * 0.7) / count) * perimeter
        const theta = thetaAtLength(s)
        const rad = r(theta) * (0.9 + Math.random() * 0.1)
        out[i * 2] = Math.cos(theta) * rad
        out[i * 2 + 1] = Math.sin(theta) * rad
      }
      return out
    },

    fill(count) {
      const out = new Float32Array(count * 2)
      let written = 0
      let guard = count * 64 // pathological-shape backstop

      while (written < count && guard-- > 0) {
        const theta = Math.random() * TAU
        const rad = r(theta)

        // Rejection-sample the *angle* weighted by radius², so wide sectors of
        // the star receive proportionally more points than the pinched ones.
        if (Math.random() > (rad / rMax) ** 2) continue

        // sqrt() of a uniform gives a radially uniform-in-area distribution;
        // without it everything piles into the centre.
        const t = Math.sqrt(Math.random()) * 0.93

        out[written * 2] = Math.cos(theta) * rad * t
        out[written * 2 + 1] = Math.sin(theta) * rad * t
        written++
      }

      // Guard tripped (degenerate shape): pad rather than hand back zeros,
      // which would stack a visible clump of particles at the origin.
      for (let i = written; i < count; i++) {
        const src = (i % Math.max(written, 1)) * 2
        out[i * 2] = out[src]
        out[i * 2 + 1] = out[src + 1]
      }
      return out
    },
  }
}
