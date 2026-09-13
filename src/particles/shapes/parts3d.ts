/**
 * Reusable 3D sampling primitives for composing volumetric shapes.
 *
 * Everything here emits raw positions — 3 floats per point — and knows nothing
 * about particles, colours or shaders. A shape file (e.g. hannya.ts) composes
 * these into a VolumeSampler.
 *
 * Coordinate convention: y up, +z toward the viewer, origin at shape centre.
 */

export type Vec3 = [number, number, number]

const TAU = Math.PI * 2

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

/** Cubic Bézier evaluated at t. */
export function bezier3(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    a * p0[2] + b * p1[2] + c * p2[2] + d * p3[2],
  ]
}

export interface ArcCurve {
  /** Position at normalised arc length s ∈ [0, 1]. */
  at(s: number): Vec3
  /** Unit tangent at normalised arc length s. */
  tangent(s: number): Vec3
  length: number
}

/**
 * Wrap any parametric curve in an arc-length parameterisation.
 *
 * Identical discipline to the superellipse rim LUT: a cumulative-length table,
 * binary-searched and lerped. Sampling uniformly in `s` then spaces points
 * evenly along the curve no matter how unevenly `t` covers it — measured 4.3×
 * more even on the star's rim than naive parameter sampling.
 */
export function arcLengthCurve(fn: (t: number) => Vec3, steps = 256): ArcCurve {
  const pts: Vec3[] = []
  const cum = new Float64Array(steps + 1)
  let acc = 0
  for (let i = 0; i <= steps; i++) {
    const p = fn(i / steps)
    if (i > 0) {
      const q = pts[i - 1]
      acc += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
    }
    pts.push(p)
    cum[i] = acc
  }
  const total = acc || 1e-9

  function tAt(s: number): number {
    const target = Math.min(Math.max(s, 0), 1) * total
    let lo = 0
    let hi = steps
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid] < target) lo = mid + 1
      else hi = mid
    }
    const i = Math.max(1, lo)
    const prev = cum[i - 1]
    const next = cum[i]
    const frac = next > prev ? (target - prev) / (next - prev) : 0
    return (i - 1 + frac) / steps
  }

  return {
    length: total,
    at(s) {
      return fn(tAt(s))
    },
    tangent(s) {
      const t = tAt(s)
      const e = 1 / steps
      const a = fn(Math.max(0, t - e))
      const b = fn(Math.min(1, t + e))
      const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const len = Math.hypot(d[0], d[1], d[2]) || 1
      return [d[0] / len, d[1] / len, d[2] / len]
    },
  }
}

/** An orthonormal frame perpendicular to `t` (parallel-transport-lite). */
function frameFor(t: Vec3): { u: Vec3; v: Vec3 } {
  // Pick the world axis least aligned with the tangent to avoid degeneracy.
  const ref: Vec3 = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  let ux = t[1] * ref[2] - t[2] * ref[1]
  let uy = t[2] * ref[0] - t[0] * ref[2]
  let uz = t[0] * ref[1] - t[1] * ref[0]
  const ul = Math.hypot(ux, uy, uz) || 1
  ux /= ul
  uy /= ul
  uz /= ul
  return {
    u: [ux, uy, uz],
    v: [t[1] * uz - t[2] * uy, t[2] * ux - t[0] * uz, t[0] * uy - t[1] * ux],
  }
}

// ---------------------------------------------------------------------------
// Part interface
// ---------------------------------------------------------------------------

/**
 * A part emits surface points and knows its own approximate area, so a
 * composition can distribute a global point budget proportionally — the mask
 * looks uniformly dense instead of piling points onto small parts.
 */
export interface Part3D {
  area: number
  sample(out: Float32Array, offset: number, count: number): void
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export interface EllipsoidOptions {
  center: Vec3
  radii: Vec3
  /**
   * Keep only points whose unit-sphere normal passes this test — how a *patch*
   * (an open shell, a face mask rather than a closed head) is cut. Return true
   * to keep. Receives the unit-sphere normal BEFORE radii scaling.
   */
  patch?: (n: Vec3) => boolean
  /** Optional per-point displacement of the emitted position. */
  warp?: (p: Vec3, n: Vec3) => Vec3
}

/**
 * Area-uniform sampling on an ellipsoid surface.
 *
 * Uniform-on-sphere scaled by (rx, ry, rz) is NOT area-uniform — scaling
 * compresses area unevenly, over-sampling the flattened regions. Accepting
 * with probability ∝ the local area element J restores uniformity:
 *
 *   J = |(ry·rz·nx, rx·rz·ny, rx·ry·nz)|,  n = unit-sphere normal
 */
export function ellipsoid(opts: EllipsoidOptions): Part3D {
  const [cx, cy, cz] = opts.center
  const [rx, ry, rz] = opts.radii
  const jMax = Math.max(ry * rz, rx * rz, rx * ry)

  // Thomsen's approximation for ellipsoid area (±1%), scaled by the accepted
  // patch fraction estimated with a quick Monte Carlo pass.
  const p = 1.6075
  const fullArea =
    4 *
    Math.PI *
    Math.pow(
      (Math.pow(rx * ry, p) + Math.pow(rx * rz, p) + Math.pow(ry * rz, p)) / 3,
      1 / p,
    )
  let patchFraction = 1
  if (opts.patch) {
    let kept = 0
    const N = 2048
    for (let i = 0; i < N; i++) {
      const n = sphereNormal()
      if (opts.patch(n)) kept++
    }
    patchFraction = kept / N
  }

  function sphereNormal(): Vec3 {
    const theta = Math.random() * TAU
    const cosPhi = 2 * Math.random() - 1
    const sinPhi = Math.sqrt(1 - cosPhi * cosPhi)
    return [sinPhi * Math.cos(theta), cosPhi, sinPhi * Math.sin(theta)]
  }

  return {
    area: fullArea * patchFraction,
    sample(out, offset, count) {
      let written = 0
      let guard = count * 200
      while (written < count && guard-- > 0) {
        const n = sphereNormal()
        if (opts.patch && !opts.patch(n)) continue
        const j = Math.hypot(ry * rz * n[0], rx * rz * n[1], rx * ry * n[2])
        if (Math.random() > j / jMax) continue
        let p: Vec3 = [cx + rx * n[0], cy + ry * n[1], cz + rz * n[2]]
        if (opts.warp) p = opts.warp(p, n)
        const o = (offset + written) * 3
        out[o] = p[0]
        out[o + 1] = p[1]
        out[o + 2] = p[2]
        written++
      }
      padShortfall(out, offset, written, count)
    },
  }
}

export interface TubeOptions {
  curve: ArcCurve
  /** Radius along the tube, s ∈ [0, 1]. */
  radius: (s: number) => number
}

/**
 * A tube swept along a curve — horns. Area-uniform along the length because
 * the curve is arc-length parameterised and the radius is importance-sampled:
 * a section's area is proportional to its circumference.
 */
export function sweptTube(opts: TubeOptions): Part3D {
  const { curve, radius } = opts

  // Average radius for area estimate + the importance envelope.
  const S = 64
  let rSum = 0
  let rMax = 1e-9
  for (let i = 0; i <= S; i++) {
    const r = radius(i / S)
    rSum += r
    rMax = Math.max(rMax, r)
  }
  const rMean = rSum / (S + 1)

  return {
    area: TAU * rMean * curve.length,
    sample(out, offset, count) {
      let written = 0
      let guard = count * 100
      while (written < count && guard-- > 0) {
        const s = Math.random()
        const r = radius(s)
        // Importance-sample s by circumference so thick sections get more points.
        if (Math.random() > r / rMax) continue
        const c = curve.at(s)
        const { u, v } = frameFor(curve.tangent(s))
        const a = Math.random() * TAU
        const ca = Math.cos(a) * r
        const sa = Math.sin(a) * r
        const o = (offset + written) * 3
        out[o] = c[0] + u[0] * ca + v[0] * sa
        out[o + 1] = c[1] + u[1] * ca + v[1] * sa
        out[o + 2] = c[2] + u[2] * ca + v[2] * sa
        written++
      }
      padShortfall(out, offset, written, count)
    },
  }
}

export interface RibbonOptions {
  curve: ArcCurve
  /** Half-width of the ribbon at s. */
  halfWidth: (s: number) => number
  /** Direction the width extends in, at s. Normalised internally. */
  across: (s: number) => Vec3
  /** Thickness (full depth) of the slab, world units. */
  thickness?: number
}

/** A flat band following a curve — lips, brow underside. */
export function ribbon(opts: RibbonOptions): Part3D {
  const { curve, halfWidth, across } = opts
  const thick = opts.thickness ?? 0.12

  const S = 64
  let wSum = 0
  let wMax = 1e-9
  for (let i = 0; i <= S; i++) {
    const w = halfWidth(i / S)
    wSum += w
    wMax = Math.max(wMax, w)
  }

  return {
    area: 2 * (wSum / (S + 1)) * curve.length,
    sample(out, offset, count) {
      let written = 0
      let guard = count * 100
      while (written < count && guard-- > 0) {
        const s = Math.random()
        const w = halfWidth(s)
        if (Math.random() > w / wMax) continue
        const c = curve.at(s)
        const d = across(s)
        const dl = Math.hypot(d[0], d[1], d[2]) || 1
        const t = (Math.random() * 2 - 1) * w
        const n = (Math.random() * 2 - 1) * thick * 0.5
        // Normal direction: perpendicular to both tangent and across.
        const tg = curve.tangent(s)
        const nx = tg[1] * d[2] - tg[2] * d[1]
        const ny = tg[2] * d[0] - tg[0] * d[2]
        const nz = tg[0] * d[1] - tg[1] * d[0]
        const nl = Math.hypot(nx, ny, nz) || 1
        const o = (offset + written) * 3
        out[o] = c[0] + (d[0] / dl) * t + (nx / nl) * n
        out[o + 1] = c[1] + (d[1] / dl) * t + (ny / nl) * n
        out[o + 2] = c[2] + (d[2] / dl) * t + (nz / nl) * n
        written++
      }
      padShortfall(out, offset, written, count)
    },
  }
}

export interface ConeOptions {
  /** Tip of the cone. */
  tip: Vec3
  /** Centre of the base disc. */
  base: Vec3
  baseRadius: number
}

/** Lateral surface of a cone — fangs. Points sampled ∝ local circumference. */
export function cone(opts: ConeOptions): Part3D {
  const { tip, base, baseRadius } = opts
  const axis: Vec3 = [tip[0] - base[0], tip[1] - base[1], tip[2] - base[2]]
  const height = Math.hypot(axis[0], axis[1], axis[2]) || 1e-9
  const dir: Vec3 = [axis[0] / height, axis[1] / height, axis[2] / height]
  const { u, v } = frameFor(dir)
  const slant = Math.hypot(height, baseRadius)

  return {
    area: Math.PI * baseRadius * slant,
    sample(out, offset, count) {
      for (let i = 0; i < count; i++) {
        // Radius ∝ sqrt(u) gives area-uniform sampling on the unrolled disc.
        const t = Math.sqrt(Math.random()) // 0 at tip, 1 at base
        const r = baseRadius * t
        const a = Math.random() * TAU
        const ca = Math.cos(a) * r
        const sa = Math.sin(a) * r
        const o = (offset + i) * 3
        out[o] = tip[0] - dir[0] * height * t + u[0] * ca + v[0] * sa
        out[o + 1] = tip[1] - dir[1] * height * t + u[1] * ca + v[1] * sa
        out[o + 2] = tip[2] - dir[2] * height * t + u[2] * ca + v[2] * sa
      }
    },
  }
}

export interface WedgeOptions {
  /** Inner (thick) end centre. */
  from: Vec3
  /** Outer (thin) end centre. */
  to: Vec3
  /** Half-height at the inner end (tapers to ~20% at the outer). */
  halfHeight: number
  /** Half-depth (z-ish) at the inner end. */
  halfDepth: number
}

/** A tapered box volume — brow ridges. Volumetric fill, not just the shell. */
export function wedge(opts: WedgeOptions): Part3D {
  const { from, to, halfHeight, halfDepth } = opts
  const axis: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]]
  const len = Math.hypot(axis[0], axis[1], axis[2]) || 1e-9
  const dir: Vec3 = [axis[0] / len, axis[1] / len, axis[2] / len]
  const { u, v } = frameFor(dir)

  return {
    // Rough lateral area of the tapering box.
    area: 2 * len * (halfHeight + halfDepth) * 0.6,
    sample(out, offset, count) {
      for (let i = 0; i < count; i++) {
        const t = Math.random()
        const taper = 1 - 0.8 * t
        const h = (Math.random() * 2 - 1) * halfHeight * taper
        const d = (Math.random() * 2 - 1) * halfDepth * taper
        const o = (offset + i) * 3
        out[o] = from[0] + dir[0] * len * t + u[0] * h + v[0] * d
        out[o + 1] = from[1] + dir[1] * len * t + u[1] * h + v[1] * d
        out[o + 2] = from[2] + dir[2] * len * t + u[2] * h + v[2] * d
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Cut volumes (rejection)
// ---------------------------------------------------------------------------

/** True if p is inside the ellipsoid at center with radii. */
export function insideEllipsoid(p: Vec3, center: Vec3, radii: Vec3): boolean {
  const dx = (p[0] - center[0]) / radii[0]
  const dy = (p[1] - center[1]) / radii[1]
  const dz = (p[2] - center[2]) / radii[2]
  return dx * dx + dy * dy + dz * dz < 1
}

export type CutFn = (p: Vec3) => boolean

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface PartEntry {
  part: Part3D
  /**
   * Cut volumes applied to THIS part only. Per-part rather than global,
   * because some parts deliberately live inside a cut — the fangs sit inside
   * the mouth cavity that carves everything else.
   */
  cuts?: CutFn[]
}

/**
 * Distribute a point budget across parts proportionally to area, sample each,
 * and reject points falling inside that part's cut volumes. Rejected points
 * are resampled from the same part so the budget is met exactly.
 */
export function samplePartsWithCuts(entries: PartEntry[], count: number): Float32Array {
  const parts = entries.map((e) => e.part)
  const totalArea = parts.reduce((s, p) => s + p.area, 0) || 1
  const out = new Float32Array(count * 3)
  const tmp: Vec3 = [0, 0, 0]

  let written = 0
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi]
    const cuts = entries[pi].cuts ?? []
    const quota =
      pi === parts.length - 1
        ? count - written
        : Math.round((part.area / totalArea) * count)
    if (quota <= 0) continue

    // Sample into a scratch block, then filter through the cuts, resampling
    // the shortfall in progressively smaller blocks.
    let need = quota
    let guard = 40
    while (need > 0 && guard-- > 0) {
      const block = new Float32Array(need * 3)
      part.sample(block, 0, need)
      for (let i = 0; i < need; i++) {
        tmp[0] = block[i * 3]
        tmp[1] = block[i * 3 + 1]
        tmp[2] = block[i * 3 + 2]
        let cut = false
        for (const c of cuts) {
          if (c(tmp)) {
            cut = true
            break
          }
        }
        if (!cut) {
          const o = written * 3
          out[o] = tmp[0]
          out[o + 1] = tmp[1]
          out[o + 2] = tmp[2]
          written++
          if (--need === 0) break
        }
      }
      // If a part is entirely inside a cut, the guard expires and we move on.
    }
    // Any expired-guard shortfall is topped up from what we already have.
    if (need > 0) {
      padShortfall(out, 0, written, written + need)
      written += need
    }
  }
  return out
}

/**
 * Fill an unmet quota by duplicating already-written points, rather than
 * leaving zeros that would stack a visible clump of particles at the origin.
 */
function padShortfall(out: Float32Array, offset: number, written: number, count: number): void {
  if (written >= count) return
  const have = Math.max(written, 1)
  for (let i = written; i < count; i++) {
    const src = (offset + (i % have)) * 3
    const dst = (offset + i) * 3
    out[dst] = out[src]
    out[dst + 1] = out[src + 1]
    out[dst + 2] = out[src + 2]
  }
}

/**
 * Sample a set of feature curves evenly: the point budget is split across
 * curves ∝ length, and each curve is sampled uniformly in arc length with
 * slot jitter (never a dotted line), with an optional radial scatter.
 */
export function sampleCurves(
  curves: { curve: ArcCurve; scatter?: number }[],
  count: number,
  cuts: CutFn[] = [],
): Float32Array {
  const total = curves.reduce((s, c) => s + c.curve.length, 0) || 1
  const out = new Float32Array(count * 3)
  let written = 0

  for (let ci = 0; ci < curves.length; ci++) {
    const { curve, scatter = 0 } = curves[ci]
    const quota =
      ci === curves.length - 1
        ? count - written
        : Math.round((curve.length / total) * count)

    let placed = 0
    let attempt = 0
    const maxAttempts = quota * 30
    while (placed < quota && attempt++ < maxAttempts) {
      const s = (placed + Math.random() * 0.7) / quota
      const p = curve.at(s)
      const px = p[0] + (Math.random() * 2 - 1) * scatter
      const py = p[1] + (Math.random() * 2 - 1) * scatter
      const pz = p[2] + (Math.random() * 2 - 1) * scatter
      let cut = false
      for (const c of cuts) {
        if (c([px, py, pz])) {
          cut = true
          break
        }
      }
      if (cut) continue
      const o = written * 3
      out[o] = px
      out[o + 1] = py
      out[o + 2] = pz
      written++
      placed++
    }
    if (placed < quota) {
      padShortfall(out, 0, written, written + (quota - placed))
      written += quota - placed
    }
  }
  return out
}
