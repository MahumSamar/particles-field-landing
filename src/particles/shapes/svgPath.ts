import type { ShapeSampler } from './index'

export interface SvgPathOptions {
  /** Target half-extent of the longer axis, in world units. */
  radius?: number
  /** Raster resolution used for interior sampling. */
  resolution?: number
}

/**
 * Samples any SVG path — a logo, an icon, a glyph outline — into point clouds.
 *
 * Two different mechanisms, each picked because it is the robust one for its job:
 *
 *  - **Outline** uses `SVGGeometryElement.getPointAtLength()`. The browser's own
 *    path arc-length parameterisation is exact and replaces the hand-built LUT
 *    the superellipse needs.
 *  - **Interior** rasterises the filled path once and samples opaque pixels.
 *    This sidesteps the murky coordinate-space semantics of `isPointInPath`,
 *    handles holes and multiple subpaths for free (the fill rule is applied by
 *    the rasteriser), and is the same machinery a text sampler would want.
 */
export function svgPath(d: string, options: SvgPathOptions = {}): ShapeSampler {
  const radius = options.radius ?? 5.3
  const resolution = options.resolution ?? 512

  // --- Measure via a detached-but-rendered SVG ---------------------------
  // getBBox() needs a rendered element in some engines, so mount it hidden
  // rather than measuring a fully detached node.
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.cssText =
    'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;visibility:hidden'
  const path = document.createElementNS(NS, 'path')
  path.setAttribute('d', d)
  svg.appendChild(path)
  document.body.appendChild(svg)

  let box: { x: number; y: number; width: number; height: number }
  let totalLength = 0
  try {
    box = path.getBBox()
    totalLength = path.getTotalLength()
  } catch {
    box = { x: 0, y: 0, width: 1, height: 1 }
  }

  if (!(box.width > 0) || !(box.height > 0)) {
    document.body.removeChild(svg)
    throw new Error('svgPath: path has an empty bounding box — check the `d` string')
  }

  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  // Normalise so the *longer* axis spans 2 × radius; the shape keeps its proportions.
  const scale = (radius * 2) / Math.max(box.width, box.height)

  const halfW = (box.width / 2) * scale
  const halfH = (box.height / 2) * scale

  // SVG's y axis points down, WebGL's points up.
  const toWorldX = (px: number) => (px - cx) * scale
  const toWorldY = (py: number) => -(py - cy) * scale

  // --- Rasterise once for interior sampling -------------------------------
  const rw = Math.max(2, Math.round((box.width / Math.max(box.width, box.height)) * resolution))
  const rh = Math.max(2, Math.round((box.height / Math.max(box.width, box.height)) * resolution))

  const canvas = document.createElement('canvas')
  canvas.width = rw
  canvas.height = rh
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.setTransform(rw / box.width, 0, 0, rh / box.height, (-box.x * rw) / box.width, (-box.y * rh) / box.height)
  ctx.fillStyle = '#fff'
  ctx.fill(new Path2D(d))

  const pixels = ctx.getImageData(0, 0, rw, rh).data
  const inside: number[] = []
  for (let i = 0; i < rw * rh; i++) {
    if (pixels[i * 4 + 3] > 127) inside.push(i)
  }

  document.body.removeChild(svg)

  if (inside.length === 0) {
    throw new Error('svgPath: path rasterised to nothing — is it stroke-only, with no fill area?')
  }

  return {
    bounds: () => ({ halfW, halfH }),

    rim(count) {
      const out = new Float32Array(count * 2)
      if (totalLength <= 0) return out
      for (let i = 0; i < count; i++) {
        const at = ((i + Math.random() * 0.7) / count) * totalLength
        const p = path.getPointAtLength(at % totalLength)
        out[i * 2] = toWorldX(p.x)
        out[i * 2 + 1] = toWorldY(p.y)
      }
      return out
    },

    fill(count) {
      const out = new Float32Array(count * 2)
      for (let i = 0; i < count; i++) {
        const idx = inside[(Math.random() * inside.length) | 0]
        // Jitter inside the pixel so the cloud does not betray the raster grid.
        const px = box.x + ((idx % rw) + Math.random()) * (box.width / rw)
        const py = box.y + (((idx / rw) | 0) + Math.random()) * (box.height / rh)
        out[i * 2] = toWorldX(px)
        out[i * 2 + 1] = toWorldY(py)
      }
      return out
    },
  }
}
