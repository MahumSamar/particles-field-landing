/**
 * A ShapeSampler turns *some* 2D silhouette into point clouds.
 *
 * Everything downstream (geometry, material, interaction) only ever sees a flat
 * array of numbers, so the shape is a swappable strategy: superellipse today,
 * an SVG logo or rasterised text tomorrow, with no core changes.
 *
 * All returned arrays are **2 floats per point** — `[x0, y0, x1, y1, ...]` — in
 * a y-up coordinate system centred on the origin. Extrusion into a 3D slab is
 * geometry.ts's job, not the sampler's.
 */
export interface ShapeSampler {
  /**
   * `n` points along the outline, spaced uniformly by **arc length**.
   *
   * This distinction matters: sampling uniformly in the shape's parameter
   * (angle, path `t`) clumps points wherever the curve is tightly turning —
   * for a 4-pointed star, right at the tips. Arc-length spacing is what makes
   * an outline read as evenly dense.
   */
  rim(n: number): Float32Array

  /** `n` points across the interior, uniform per unit **area**. */
  fill(n: number): Float32Array

  /** Half-extents of the shape, used to normalise sizes and interaction radii. */
  bounds(): { halfW: number; halfH: number }
}

/** Largest distance from the origin to the outline. */
export function maxRadius(sampler: ShapeSampler): number {
  const { halfW, halfH } = sampler.bounds()
  return Math.max(halfW, halfH)
}

/**
 * A ShapeSampler that owns its own depth: positions come back as 3 floats per
 * point, and geometry.ts skips the slab extrusion entirely.
 *
 * `edge` replaces `rim`: instead of one outline, a set of feature curves —
 * horn ridges, eye rims, a grimace — sampled by arc length. These curves are
 * where the recognisability of a volumetric shape lives; the surface is body.
 */
export interface VolumeSampler {
  readonly is3D: true
  /** Feature-curve points. 3 floats per point. */
  edge(n: number): Float32Array
  /** Shell/volume points. 3 floats per point. */
  surface(n: number): Float32Array
  /** x-y extents, for parallax clamping and hole-radius scaling. */
  bounds(): { halfW: number; halfH: number }
  bounds3(): { halfW: number; halfH: number; halfD: number }
}

export type AnySampler = ShapeSampler | VolumeSampler

export const isVolume = (s: AnySampler): s is VolumeSampler =>
  (s as VolumeSampler).is3D === true
