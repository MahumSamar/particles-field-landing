import * as THREE from 'three'
import { isVolume, type AnySampler } from './shapes/index'

export interface SizeClass {
  /** Share of interior particles in this class (classes are normalised). */
  mix: number
  /** World-space size range. */
  size: [number, number]
  /**
   * 0 = crisp disc, 1 = wide quadratic glow.
   *
   * This single value is what produces the "blurred bokeh" look. There is no
   * blur pass anywhere; a small share of large, very soft, additively blended
   * points *is* the entire glow.
   */
  soft: number
}

export interface GeometryOptions {
  count?: number
  /** Share of the non-cloud budget placed on the outline. */
  rimFraction?: number
  /** Loose halo of particles orbiting outside the silhouette. */
  cloudCount?: number
  cloudSpread?: [number, number]
  cloudAmplitude?: number
  /**
   * Slab depth as a fraction of the shape's half-height.
   *
   * 0 is flat, 0.09 matches the reference (under 10% as deep as wide), higher
   * values give a genuinely volumetric cloud. Note that the *depth cueing* in
   * the colour grading and the shader does most of the 3D work — a flat cloud
   * with cueing still reads as 3D; a thick cloud without it reads as noise.
   */
  thickness?: number
  rimSize?: [number, number]
  rimSoft?: number
  classes?: SizeClass[]
  twinkle?: number
  drift?: number
  palette?: {
    pale?: string
    accent?: string
    deep?: string
    sparkle?: string
    sparkleChance?: number
  }
}

export interface FieldGeometry {
  geometry: THREE.BufferGeometry
  count: number
  /** Rest positions — the shape with no interaction applied. */
  base: Float32Array
  /** Positions actually uploaded each frame. */
  live: Float32Array
  /** Unit-sphere direction each particle takes when the field dissolves. */
  burstDir: Float32Array
  /** How far along that direction it travels. */
  burstDist: Float32Array
  /** Slow self-oscillation amplitude (non-zero for halo particles only). */
  cloudAmp: Float32Array
  phase: Float32Array
  /** Per-particle jitter so the cursor hole has a soft, uneven rim. */
  holeJitter: Float32Array
  /** Fallback angle for particles sitting exactly at the cursor. */
  holeAngle: Float32Array
  bounds: { halfW: number; halfH: number; halfD: number }
}

const DEFAULT_CLASSES: SizeClass[] = [
  { mix: 0.70, size: [0.08, 0.135], soft: 0.10 },
  { mix: 0.25, size: [0.16, 0.25], soft: 0.45 },
  { mix: 0.05, size: [0.32, 0.58], soft: 1.00 }, // the bokeh
]

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo)

export function buildGeometry(sampler: AnySampler, options: GeometryOptions = {}): FieldGeometry {
  const volume = isVolume(sampler)
  const count = options.count ?? 6000
  const rimFraction = options.rimFraction ?? 0.26
  const cloudCount = Math.min(options.cloudCount ?? 260, count)
  const cloudSpread = options.cloudSpread ?? [1.15, 1.9]
  const cloudAmplitude = options.cloudAmplitude ?? 0.38
  const thicknessRatio = options.thickness ?? 0.09
  const rimSize = options.rimSize ?? [0.075, 0.13]
  const rimSoft = options.rimSoft ?? 0.08
  const classes = options.classes ?? DEFAULT_CLASSES
  const twinkle = options.twinkle ?? 0.38
  const driftBase = options.drift ?? 0.055

  const pal = options.palette ?? {}
  const pale = new THREE.Color(pal.pale ?? '#9FF5D4')
  const accent = new THREE.Color(pal.accent ?? '#2EE6A0')
  const deep = new THREE.Color(pal.deep ?? '#14805A')
  const sparkle = new THREE.Color(pal.sparkle ?? '#FFFFFF')
  const sparkleChance = pal.sparkleChance ?? 0.015

  const { halfW, halfH } = sampler.bounds()
  // 2D shapes fabricate depth as a thin slab; a volume sampler owns its own z
  // and `thickness` is ignored (2D-only by design).
  const halfD = volume ? sampler.bounds3().halfD : thicknessRatio * halfH
  const rMax = Math.max(halfW, halfH)

  const body = count - cloudCount
  const rimCount = Math.round(body * rimFraction)
  const fillCount = body - rimCount

  const position = new Float32Array(count * 3)
  const aCol = new Float32Array(count * 3)
  const aSize = new Float32Array(count)
  const aSoft = new Float32Array(count)
  const aPhase = new Float32Array(count)
  const aTw = new Float32Array(count)
  const aDrift = new Float32Array(count)

  const cloudAmp = new Float32Array(count)
  const burstDir = new Float32Array(count * 3)
  const burstDist = new Float32Array(count)
  const holeJitter = new Float32Array(count)
  const holeAngle = new Float32Array(count)

  // Normalised cumulative mix, so `classes` need not sum to exactly 1.
  const total = classes.reduce((s, c) => s + c.mix, 0) || 1
  const cumulative: number[] = []
  let acc = 0
  for (const c of classes) {
    acc += c.mix / total
    cumulative.push(acc)
  }
  function pickClass(): SizeClass {
    const r = Math.random()
    for (let i = 0; i < cumulative.length; i++) if (r <= cumulative[i]) return classes[i]
    return classes[classes.length - 1]
  }

  const tmp = new THREE.Color()
  let w = 0

  const writeCommon = (i: number, size: number, soft: number, tw: number, drift: number) => {
    aSize[i] = size
    aSoft[i] = soft
    aPhase[i] = Math.random() * Math.PI * 2
    aTw[i] = tw
    aDrift[i] = drift
    holeJitter[i] = 1 + (Math.random() * 2 - 1) * 0.08
    holeAngle[i] = Math.random() * Math.PI * 2
  }

  // --- 1. Outline / feature edges ----------------------------------------
  const rimPts = volume ? sampler.edge(rimCount) : sampler.rim(rimCount)
  const rimStride = volume ? 3 : 2
  for (let i = 0; i < rimCount; i++, w++) {
    const o = w * 3
    position[o] = rimPts[i * rimStride]
    position[o + 1] = rimPts[i * rimStride + 1]
    position[o + 2] = volume
      ? rimPts[i * rimStride + 2]
      : (Math.random() * 2 - 1) * halfD * 0.8

    // The rim is what defines the silhouette, so it stays bright and crisp.
    tmp.copy(Math.random() < 0.55 ? pale : accent)
    aCol[o] = tmp.r
    aCol[o + 1] = tmp.g
    aCol[o + 2] = tmp.b

    writeCommon(w, rand(rimSize[0], rimSize[1]), rimSoft, twinkle * 0.5, driftBase * 0.12)
  }

  // --- 2. Interior / surface ---------------------------------------------
  const fillPts = volume ? sampler.surface(fillCount) : sampler.fill(fillCount)
  const fillStride = volume ? 3 : 2
  for (let i = 0; i < fillCount; i++, w++) {
    const o = w * 3
    const x = fillPts[i * fillStride]
    const y = fillPts[i * fillStride + 1]
    const z = volume ? fillPts[i * fillStride + 2] : (Math.random() * 2 - 1) * halfD
    position[o] = x
    position[o + 1] = y
    position[o + 2] = z

    const q = Math.random()
    if (Math.random() < sparkleChance) tmp.copy(sparkle)
    else tmp.copy(q < 0.55 ? accent : q < 0.8 ? deep : pale)

    // Depth cueing, and the reason the cloud reads as volumetric: particles
    // are graded toward the pale shell colour. For the symmetric 2D slab the
    // cue is |z|; a volume has a FRONT, so the cue is signed frontness —
    // nose, brows and horn tips catch the light, the hollow back falls dark.
    const radial = Math.min(Math.hypot(x, y) / rMax, 1)
    let grade: number
    if (volume) {
      const front = Math.min(Math.max((z / halfD) * 0.5 + 0.5, 0), 1)
      grade = Math.min(radial * radial * 0.4 + Math.pow(front, 1.8) * 0.55, 1) * 0.4
    } else {
      const zn = halfD > 0 ? Math.abs(z) / halfD : 0
      grade = Math.min(radial * radial * 0.7 + zn * zn * zn * 0.45, 1) * 0.35
    }

    aCol[o] = tmp.r + (pale.r - tmp.r) * grade
    aCol[o + 1] = tmp.g + (pale.g - tmp.g) * grade
    aCol[o + 2] = tmp.b + (pale.b - tmp.b) * grade

    const cls = pickClass()
    writeCommon(
      w,
      rand(cls.size[0], cls.size[1]),
      cls.soft,
      twinkle * (0.6 + Math.random() * 0.8),
      driftBase * (0.4 + Math.random() * 0.6),
    )
  }

  // --- 3. Halo ----------------------------------------------------------
  for (let i = 0; i < cloudCount; i++, w++) {
    const o = w * 3
    const theta = Math.random() * Math.PI * 2
    const spread = rand(cloudSpread[0], cloudSpread[1])
    position[o] = Math.cos(theta) * halfW * spread + (Math.random() - 0.5) * 1.4
    position[o + 1] = Math.sin(theta) * halfH * spread + (Math.random() - 0.5) * 1.4
    position[o + 2] = (Math.random() * 2 - 1) * halfD * (volume ? 0.9 : 2.6)

    // Dimmed by baking brightness into the colour — with additive blending
    // that is equivalent to a per-particle alpha, minus one attribute.
    tmp.copy(Math.random() < 0.5 ? pale : accent).multiplyScalar(0.55 + Math.random() * 0.35)
    aCol[o] = tmp.r
    aCol[o + 1] = tmp.g
    aCol[o + 2] = tmp.b

    const cls = pickClass()
    writeCommon(w, rand(cls.size[0], cls.size[1]), cls.soft, twinkle * (0.8 + Math.random() * 0.8), 0)
    cloudAmp[w] = cloudAmplitude * (0.5 + Math.random())
  }

  // --- Dissolve targets --------------------------------------------------
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    burstDir[i * 3] = Math.sin(phi) * Math.cos(theta)
    burstDir[i * 3 + 1] = Math.sin(phi) * Math.sin(theta)
    burstDir[i * 3 + 2] = Math.cos(phi)
    burstDist[i] = rMax * (1.6 + Math.random() * 2.6)
    aPhase[i] = aPhase[i] || Math.random() * Math.PI * 2
  }

  const live = new Float32Array(position)

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(live, 3))
  geometry.setAttribute('aCol', new THREE.BufferAttribute(aCol, 3))
  geometry.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1))
  geometry.setAttribute('aSoft', new THREE.BufferAttribute(aSoft, 1))
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1))
  geometry.setAttribute('aTw', new THREE.BufferAttribute(aTw, 1))
  geometry.setAttribute('aDrift', new THREE.BufferAttribute(aDrift, 1))
  // Points are displaced by the cursor and the dissolve, so the bounding
  // sphere is never right. Frustum culling is disabled by the caller.
  geometry.computeBoundingSphere()

  return {
    geometry,
    count,
    base: position,
    live,
    burstDir,
    burstDist,
    cloudAmp,
    phase: aPhase,
    holeJitter,
    holeAngle,
    bounds: { halfW, halfH, halfD },
  }
}
