import type { VolumeSampler } from './index'
import {
  arcLengthCurve,
  bezier3,
  cone,
  ellipsoid,
  ribbon,
  samplePartsWithCuts,
  sampleCurves,
  sweptTube,
  wedge,
  type ArcCurve,
  type CutFn,
  type PartEntry,
  type Vec3,
} from './parts3d'

export interface HannyaOptions {
  /** Global size multiplier (0.72 sits well in the default camera rig). */
  scale?: number
  /** 1 = reference horns; stretch or shrink the sweep. */
  hornLength?: number
  /** 1 = reference grimace; widens the mouth cavity and drops the jaw. */
  mouthOpen?: number
}

/**
 * A hannya mask composed from ~14 parametric primitives, proportioned against
 * a 6-view generated reference sheet (front / three-quarter / profile /
 * top / low / blockout). Deliberately primitive: the identity lives in the
 * feature curves — horns, brow crests, eye rims, nose ridge, the grimace —
 * and in the cuts, not in surface detail.
 *
 * Source-space numbers below are measured off the front view (face half-height
 * = 5.0) and the profile (depth). A final shift recentres the whole mask so it
 * spins about its visual centre, then `scale` sizes it for the camera rig.
 */
export function hannya(options: HannyaOptions = {}): VolumeSampler {
  const SCALE = options.scale ?? 0.72
  const hornLen = options.hornLength ?? 1
  const open = options.mouthOpen ?? 1

  // Centre of the unshifted build, computed from the extents measured below.
  const YSHIFT = -1.68
  const ZSHIFT = -1.19

  // ---------------------------------------------------------------------
  // Shared curves
  // ---------------------------------------------------------------------

  /** The grimace: wide, corners pulled hard up, wrapped back around the face. */
  const mouthY = (x: number) => -2.35 + 0.75 * (x / 2.55) ** 2
  const mouthZ = (x: number) => 2.25 - 0.55 * (x / 2.55) ** 2

  const lipCurve = (offset: number): ArcCurve =>
    arcLengthCurve((t) => {
      const x = -2.55 + 5.1 * t
      return [x, mouthY(x) + offset, mouthZ(x)]
    })

  /** Horn spine; `s` = ±1 mirrors it. Up, outward, raked back, tip recovering. */
  const hornSpine = (s: number): ArcCurve => {
    const base: Vec3 = [s * 1.85, 4.15, 0.15]
    const stretch = (p: Vec3): Vec3 => [p[0], base[1] + (p[1] - base[1]) * hornLen, p[2]]
    const c1 = stretch([s * 3.15, 5.7, -0.5])
    const c2 = stretch([s * 3.5, 7.3, -1.0])
    const tip = stretch([s * 2.7, 8.55, -0.55])
    return arcLengthCurve((t) => bezier3(base, c1, c2, tip, t))
  }

  /** Front z of the face shell at (x, y) — used to seat curves ON the shell. */
  const shellZ = (x: number, y: number): number => {
    const q = 1 - (x / 3.6) ** 2 - ((y - 0.2) / 5.0) ** 2
    return -0.4 + 2.4 * Math.sqrt(Math.max(q, 0))
  }

  /** Chin taper: the face narrows toward the jaw. Applied to shell + border. */
  const taperX = (y: number): number =>
    y < 0.2 ? 1 - 0.42 * Math.pow((0.2 - y) / 5.2, 1.7) : 1

  // ---------------------------------------------------------------------
  // Cut volumes
  // ---------------------------------------------------------------------

  /** Tilted eye sockets: outer corners raised — the angry almond. */
  const eyeSocket = (s: number): CutFn => {
    const cx = s * 1.75
    const cy = 1.3
    const cz = 1.95
    const phi = s * (16 * Math.PI) / 180
    const cos = Math.cos(-phi)
    const sin = Math.sin(-phi)
    return (p) => {
      const dx0 = p[0] - cx
      const dy0 = p[1] - cy
      const dx = (dx0 * cos - dy0 * sin) / 1.08
      const dy = (dx0 * sin + dy0 * cos) / 0.62
      const dz = (p[2] - cz) / 1.3
      return dx * dx + dy * dy + dz * dz < 1
    }
  }

  const nostril = (s: number): CutFn => {
    const c: Vec3 = [s * 0.45, -0.62, 2.7]
    return (p) => {
      const dx = p[0] - c[0]
      const dy = p[1] - c[1]
      const dz = p[2] - c[2]
      return dx * dx + dy * dy + dz * dz < 0.3 * 0.3
    }
  }

  /** The dark opening between the lips. */
  const mouthCavity: CutFn = (p) => {
    if (Math.abs(p[0]) > 2.45 || p[2] < 0.6) return false
    return Math.abs(p[1] - mouthY(p[0])) < 0.52 * open
  }

  const faceCuts: CutFn[] = [eyeSocket(1), eyeSocket(-1), nostril(1), nostril(-1), mouthCavity]

  // ---------------------------------------------------------------------
  // Parts
  // ---------------------------------------------------------------------

  const lowerLipOffset = -0.62 - 0.5 * (open - 1)

  const entries: PartEntry[] = [
    {
      // The shell: an egg patch, open at the back, narrowed toward the chin.
      part: ellipsoid({
        center: [0, 0.2, -0.4],
        radii: [3.6, 5.0, 2.4],
        patch: (n) => n[2] > -0.12,
        warp: (p) => [p[0] * taperX(p[1]), p[1], p[2]],
      }),
      cuts: faceCuts,
    },
    { part: hornTube(hornSpine(1)) },
    { part: hornTube(hornSpine(-1)) },
    { part: browWedge(1), cuts: [eyeSocket(1)] },
    { part: browWedge(-1), cuts: [eyeSocket(-1)] },
    { part: cheek(1), cuts: [mouthCavity, eyeSocket(1)] },
    { part: cheek(-1), cuts: [mouthCavity, eyeSocket(-1)] },
    {
      // Chin knob under the grimace.
      part: ellipsoid({
        center: [0, -4.35, 0.75],
        radii: [1.05, 0.85, 0.75],
        patch: (n) => n[2] > 0.1,
      }),
      cuts: [mouthCavity],
    },
    {
      // Nose: a pyramid, wide at the nostrils, narrowing to the glabella.
      part: wedge({
        from: [0, -0.7, 2.85],
        to: [0, 1.75, 2.1],
        halfHeight: 0.55,
        halfDepth: 0.85,
      }),
      cuts: [nostril(1), nostril(-1)],
    },
    {
      part: ribbon({
        curve: lipCurve(0.46),
        halfWidth: (s) => 0.3 - 0.1 * Math.abs(2 * s - 1),
        across: () => [0, 1, 0.25],
        thickness: 0.45,
      }),
      cuts: [mouthCavity],
    },
    {
      part: ribbon({
        curve: lipCurve(lowerLipOffset),
        halfWidth: (s) => 0.27 - 0.09 * Math.abs(2 * s - 1),
        across: () => [0, 1, 0.25],
        thickness: 0.45,
      }),
      cuts: [mouthCavity],
    },
    // Fangs live INSIDE the mouth cavity — no cuts on purpose.
    { part: cone({ tip: [1.64, -3.35, 2.26], base: [1.7, -2.05, 2.2], baseRadius: 0.3 }) },
    { part: cone({ tip: [-1.64, -3.35, 2.26], base: [-1.7, -2.05, 2.2], baseRadius: 0.3 }) },
    { part: cone({ tip: [0.95, -2.25, 2.24], base: [0.9, -3.05, 2.2], baseRadius: 0.22 }) },
    { part: cone({ tip: [-0.95, -2.25, 2.24], base: [-0.9, -3.05, 2.2], baseRadius: 0.22 }) },
  ]

  function hornTube(spine: ArcCurve) {
    return sweptTube({ curve: spine, radius: (s) => 0.06 + 0.55 * Math.pow(1 - s, 0.85) })
  }

  function browWedge(s: number) {
    return wedge({
      from: [s * 0.5, 2.1, 2.3],
      to: [s * 2.9, 3.15, 0.95],
      halfHeight: 0.62,
      halfDepth: 0.5,
    })
  }

  function cheek(s: number) {
    const out: Vec3 = [s * 0.8, -0.1, 0.6]
    const len = Math.hypot(out[0], out[1], out[2])
    return ellipsoid({
      center: [s * 2.15, -0.55, 0.9],
      radii: [1.0, 1.15, 0.85],
      patch: (n) => (n[0] * out[0] + n[1] * out[1] + n[2] * out[2]) / len > 0.15,
    })
  }

  // ---------------------------------------------------------------------
  // Feature curves — the identity
  // ---------------------------------------------------------------------

  const deg = Math.PI / 180

  /** Eye rim: the socket ellipse at 1.06×, seated on the shell surface. */
  const eyeRim = (s: number): ArcCurve => {
    const phi = s * 16 * deg
    const cos = Math.cos(phi)
    const sin = Math.sin(phi)
    return arcLengthCurve((t) => {
      const a = t * Math.PI * 2
      const ex = 1.14 * Math.cos(a)
      const ey = 0.68 * Math.sin(a)
      const x = s * 1.75 + ex * cos - ey * sin
      const y = 1.3 + ex * sin + ey * cos
      return [x, y, shellZ(x, y) + 0.06]
    })
  }

  /** Nose ridge with the under-hook at the tip. */
  const noseRidge = arcLengthCurve((t) =>
    bezier3([0, 1.75, 2.2], [0, 0.4, 2.75], [0, -0.5, 3.2], [0, -0.95, 2.95], t),
  )

  /** Ring around each nostril hole. */
  const nostrilRing = (s: number): ArcCurve =>
    arcLengthCurve((t) => {
      const a = t * Math.PI * 2
      return [s * (0.45 + 0.4 * Math.cos(a)), -0.62 + 0.3 * Math.sin(a), 2.62 + 0.18 * Math.sin(a)]
    })

  /** Mask border: temple → jaw → chin → jaw → temple, with the chin taper. */
  const faceBorder = arcLengthCurve((t) => {
    const a = (30 - 240 * t) * deg
    const y = 0.2 + 5.0 * Math.sin(a)
    const x = 3.6 * Math.cos(a) * taperX(y)
    return [x, y, -0.25]
  })

  /** Skull dome between the horns. */
  const domeArc = arcLengthCurve((t) => {
    const a = (55 + 70 * t) * deg
    const y = 0.2 + 5.0 * Math.sin(a)
    const x = 3.6 * Math.cos(a)
    return [x, y, -0.25]
  })

  const browCrest = (s: number): ArcCurve =>
    arcLengthCurve((t) => [
      s * (0.45 + 2.5 * t),
      2.5 + 0.95 * t,
      2.35 - 1.45 * t,
    ])

  /** Straight helper line. */
  const line = (a: Vec3, b: Vec3): ArcCurve =>
    arcLengthCurve((t) => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ])

  /** Closed triangle outline — used to draw fangs legibly. */
  const tri = (a: Vec3, b: Vec3, c: Vec3): ArcCurve =>
    arcLengthCurve((t) => {
      const u = t * 3
      const seg = Math.min(2, Math.floor(u))
      const f = u - seg
      const [p0, p1] = seg === 0 ? [a, b] : seg === 1 ? [b, c] : [c, a]
      return [
        p0[0] + (p1[0] - p0[0]) * f,
        p0[1] + (p1[1] - p0[1]) * f,
        p0[2] + (p1[2] - p0[2]) * f,
      ]
    })

  const fangTri = (s: number, upper: boolean): ArcCurve =>
    upper
      ? tri([s * 1.42, -2.1, 2.24], [s * 1.98, -2.1, 2.24], [s * 1.64, -3.35, 2.26])
      : tri([s * 0.68, -3.0, 2.22], [s * 1.12, -3.0, 2.22], [s * 0.95, -2.25, 2.24])

  const edgeCurves: { curve: ArcCurve; scatter?: number }[] = [
    // The one mouth line: the upper lip edge, just clear of the cavity cut.
    { curve: lipCurve(0.58), scatter: 0.04 },
    { curve: fangTri(1, true), scatter: 0.03 },
    { curve: fangTri(-1, true), scatter: 0.03 },
    { curve: fangTri(1, false), scatter: 0.03 },
    { curve: fangTri(-1, false), scatter: 0.03 },
    // Nose side walls — turn the faint ridge into a readable wedge.
    { curve: line([0.3, 1.55, 2.3], [0.52, -0.35, 2.9]), scatter: 0.04 },
    { curve: line([-0.3, 1.55, 2.3], [-0.52, -0.35, 2.9]), scatter: 0.04 },
    { curve: hornSpine(1), scatter: 0.1 },
    { curve: hornSpine(-1), scatter: 0.1 },
    { curve: browCrest(1), scatter: 0.06 },
    { curve: browCrest(-1), scatter: 0.06 },
    { curve: eyeRim(1), scatter: 0.05 },
    { curve: eyeRim(-1), scatter: 0.05 },
    { curve: noseRidge, scatter: 0.05 },
    { curve: nostrilRing(1), scatter: 0.04 },
    { curve: nostrilRing(-1), scatter: 0.04 },
    { curve: faceBorder, scatter: 0.08 },
    { curve: domeArc, scatter: 0.08 },
  ]

  // Edge points trace cut boundaries at a safe offset, but scatter can still
  // push one inside — so edges are cut-checked too.
  const edgeCuts: CutFn[] = faceCuts

  // ---------------------------------------------------------------------
  // Assembly
  // ---------------------------------------------------------------------

  const place = (arr: Float32Array): Float32Array => {
    for (let i = 0; i < arr.length; i += 3) {
      arr[i] = arr[i] * SCALE
      arr[i + 1] = (arr[i + 1] + YSHIFT) * SCALE
      arr[i + 2] = (arr[i + 2] + ZSHIFT) * SCALE
    }
    return arr
  }

  // Extents measured from the source-space numbers above (horn tips, chin,
  // shell sides, nose tip, horn rake) — verified against actual samples in
  // the test pass.
  const halfW = 3.7 * SCALE
  const halfH = 6.95 * SCALE
  const halfD = 2.25 * SCALE

  return {
    is3D: true,
    bounds: () => ({ halfW, halfH }),
    bounds3: () => ({ halfW, halfH, halfD }),
    edge: (n) => place(sampleCurves(edgeCurves, n, edgeCuts)),
    surface: (n) => place(samplePartsWithCuts(entries, n)),
  }
}
