import type { Vector3 } from 'three'
import type { FieldGeometry } from './geometry'

export interface SolverOptions {
  /**
   * Radius of the disc the cursor evacuates, as a fraction of the shape's
   * largest half-extent.
   */
  holeRadius?: number
  /** Spring factor while a particle is being pushed *into* the rim. */
  springIn?: number
  /** Spring factor while it relaxes back. Deliberately much slower. */
  springOut?: number
  /** Below this total displacement energy the solver parks itself. */
  restEnergy?: number
  /** Smoothing applied to the underlying (non-cursor) motion. */
  driftLerp?: number
}

export interface SolveParams {
  time: number
  /** 0 = intact, 1 = fully dissolved. */
  burst: number
  /** Cursor in the field's **local** space, or null when it is not engaged. */
  cursorLocal: Vector3 | null
  /** Camera view axis in the field's local space. */
  viewAxisLocal: Vector3
  motion: boolean
}

/**
 * Owns the CPU-side position pass: idle wander, dissolve displacement, and the
 * cursor interaction.
 *
 * The cursor effect is a **hole punch**, not a repulsion field. Rather than
 * pushing particles away with a falloff, every particle inside the radius is
 * moved to sit *exactly on* the rim of the disc. That is why it reads as a
 * clean bite taken out of the cloud with a bright pile-up around it, instead of
 * the soft smear a force field gives you.
 *
 * Distance is measured **perpendicular to the view axis**, in local space, so
 * the hole stays a circle on screen no matter how far the field has rotated.
 */
export class FieldSolver {
  private readonly geo: FieldGeometry
  private readonly smoothed: Float32Array
  private readonly offsets: Float32Array

  private readonly holeRadius: number
  private readonly springIn: number
  private readonly springOut: number
  private readonly restEnergy: number
  private readonly driftLerp: number

  /** True while offsets are non-zero, so we keep solving as it relaxes back. */
  private settling = false

  /** Diagnostics, surfaced on the demo page. */
  energy = 0
  affected = 0

  constructor(geo: FieldGeometry, options: SolverOptions = {}) {
    this.geo = geo
    this.smoothed = new Float32Array(geo.base)
    this.offsets = new Float32Array(geo.base.length)

    const rMax = Math.max(geo.bounds.halfW, geo.bounds.halfH)
    this.holeRadius = (options.holeRadius ?? 0.17) * rMax
    this.springIn = options.springIn ?? 0.22
    this.springOut = options.springOut ?? 0.055
    this.restEnergy = options.restEnergy ?? 0.02
    this.driftLerp = options.driftLerp ?? 0.08
  }

  /** Advance one frame, writing into `geo.live`. Returns true if it changed. */
  update(params: SolveParams): boolean {
    const { time, burst, cursorLocal, viewAxisLocal, motion } = params
    const { base, live, burstDir, burstDist, cloudAmp, phase, holeJitter, holeAngle, count } = this.geo

    const smoothed = this.smoothed
    const offsets = this.offsets

    const lerp = motion ? this.driftLerp : 1
    const holeR = this.holeRadius
    const holeR2 = holeR * holeR

    // Orthonormal basis perpendicular to the view axis, for the degenerate
    // case of a particle sitting exactly under the cursor.
    const ax = viewAxisLocal.x
    const ay = viewAxisLocal.y
    const az = viewAxisLocal.z
    const useYZ = Math.abs(ax) < 0.9
    let t1x = useYZ ? 0 : -az
    let t1y = useYZ ? -az : 0
    let t1z = useYZ ? ay : ax
    const t1len = Math.hypot(t1x, t1y, t1z) || 1
    t1x /= t1len
    t1y /= t1len
    t1z /= t1len
    const t2x = ay * t1z - az * t1y
    const t2y = az * t1x - ax * t1z
    const t2z = ax * t1y - ay * t1x

    const interacting = cursorLocal !== null || this.settling
    let energy = 0
    let affected = 0

    for (let i = 0; i < count; i++) {
      const o = i * 3

      let tx = base[o]
      let ty = base[o + 1]
      let tz = base[o + 2]

      // Halo particles breathe slowly on their own.
      const amp = cloudAmp[i]
      if (amp > 0 && motion) {
        const ph = phase[i]
        tx += Math.sin(time * 0.13 + ph) * amp
        ty += Math.sin(time * 0.11 + ph * 1.7) * amp
        tz += Math.sin(time * 0.09 + ph * 2.3) * amp
      }

      // Dissolve: travel outward along a fixed random direction.
      if (burst > 0) {
        tx += burstDir[o] * burstDist[i] * burst
        ty += burstDir[o + 1] * burstDist[i] * burst
        tz += burstDir[o + 2] * burstDist[i] * burst
      }

      const sx = (smoothed[o] += (tx - smoothed[o]) * lerp)
      const sy = (smoothed[o + 1] += (ty - smoothed[o + 1]) * lerp)
      const sz = (smoothed[o + 2] += (tz - smoothed[o + 2]) * lerp)

      if (!interacting) {
        live[o] = sx
        live[o + 1] = sy
        live[o + 2] = sz
        continue
      }

      let wantX = 0
      let wantY = 0
      let wantZ = 0
      let inside = false

      if (cursorLocal) {
        const dx = sx - cursorLocal.x
        const dy = sy - cursorLocal.y
        const dz = sz - cursorLocal.z

        // Drop the component along the view axis: what remains is the true
        // on-screen distance, independent of depth.
        const along = dx * ax + dy * ay + dz * az
        const px = dx - along * ax
        const py = dy - along * ay
        const pz = dz - along * az
        const d2 = px * px + py * py + pz * pz

        if (d2 < holeR2) {
          inside = true
          affected++
          const target = holeR * holeJitter[i]
          if (d2 > 1e-6) {
            // Push out to land exactly on the rim.
            const k = target / Math.sqrt(d2) - 1
            wantX = px * k
            wantY = py * k
            wantZ = pz * k
          } else {
            // Dead centre — no direction to push along, so pick one.
            const a = holeAngle[i]
            const c = Math.cos(a)
            const s = Math.sin(a)
            wantX = (t1x * c + t2x * s) * target
            wantY = (t1y * c + t2y * s) * target
            wantZ = (t1z * c + t2z * s) * target
          }
        }
      }

      // Asymmetric spring: snap in ~4x faster than it relaxes out. This is
      // what gives the interaction its viscous, trailing feel.
      const k = inside ? this.springIn : this.springOut
      const ox = (offsets[o] += (wantX - offsets[o]) * k)
      const oy = (offsets[o + 1] += (wantY - offsets[o + 1]) * k)
      const oz = (offsets[o + 2] += (wantZ - offsets[o + 2]) * k)

      energy += ox * ox + oy * oy + oz * oz

      live[o] = sx + ox
      live[o + 1] = sy + oy
      live[o + 2] = sz + oz
    }

    this.energy = energy
    this.affected = affected

    if (interacting && !cursorLocal && energy < this.restEnergy) {
      // Fully relaxed: zero the offsets and stop solving the interaction until
      // the cursor comes back. A real idle path, not just a small number.
      offsets.fill(0)
      this.settling = false
    } else {
      this.settling = interacting
    }

    return true
  }
}
