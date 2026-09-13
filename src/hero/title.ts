import * as THREE from 'three/webgpu'

/**
 * The hero title, drawn to a canvas and handed to the fire composite as a
 * texture so the mask can occlude it.
 *
 * It is NOT a DOM layer: the mask and the stage are a single WebGPU render, so
 * nothing can be stacked between them. Living in the shader also means the heat
 * haze refracts the letters and the fire lights them.
 */
export interface TitleLayer {
  readonly texture: THREE.CanvasTexture
  /** Redraw at a new drawing-buffer size. Returns the fitted font size in px. */
  resize(width: number, height: number): number
  dispose(): void
}

export interface TitleOptions {
  text: string
  /** Font stack, matching what the page loads. */
  family?: string
  weight?: number
  color?: string
  letterSpacing?: string
  /** Left inset in CSS px at the reference width, scaled with the viewport. */
  margin?: number
  /** Reference frame the margin and crop were authored against. */
  baseWidth?: number
  /** How far the word's optical bottom sits BELOW the viewport edge, in px
   *  at the reference width. The supplied design crops it (`bottom: -27px`). */
  bleed?: number
  /** Never exceed this share of the viewport height. */
  maxHeightFraction?: number
}

export function createTitleLayer(options: TitleOptions): TitleLayer {
  const {
    text,
    family = "'Inter Tight', 'Inter', system-ui, sans-serif",
    weight = 400,
    color = '#F6EFDA',
    letterSpacing = '-0.03em',
    margin = 24,
    baseWidth = 1470,
    bleed = 27,
    maxHeightFraction = 0.42,
  } = options

  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 2
  const ctx = canvas.getContext('2d')!
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  // The composite samples this alongside render targets, which carry flipY
  // false. A CanvasTexture defaults to true, which lands the title upside down
  // at the top of the frame.
  texture.flipY = false
  // The composite samples this in screen UV; clamping avoids a wrapped edge
  // showing up when the haze offset pushes a sample past the border.
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
  texture.generateMipmaps = false
  texture.minFilter = THREE.LinearFilter

  function resize(width: number, height: number): number {
    const w = Math.max(2, Math.floor(width))
    const h = Math.max(2, Math.floor(height))
    canvas.width = w
    canvas.height = h
    ctx.clearRect(0, 0, w, h)

    const scale = w / baseWidth
    const inset = margin * scale
    const target = w - inset * 2

    // Solve the size that makes the word span the frame, rather than hardcoding
    // a px value that only holds at one viewport width.
    ctx.letterSpacing = letterSpacing
    let size = 100
    ctx.font = `${weight} ${size}px ${family}`
    const unitWidth = ctx.measureText(text).width / size
    size = unitWidth > 0 ? target / unitWidth : 100
    size = Math.min(size, h * maxHeightFraction / 0.72) // cap by height

    ctx.font = `${weight} ${size}px ${family}`
    ctx.letterSpacing = letterSpacing
    ctx.fillStyle = color
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'

    // Place the baseline so the glyphs' optical bottom lands `bleed` px below
    // the viewport edge — the crop the reference design uses.
    const m = ctx.measureText(text)
    const descent = m.actualBoundingBoxDescent || 0
    ctx.fillText(text, inset, h + bleed * scale - descent)

    texture.needsUpdate = true
    return size
  }

  return {
    texture,
    resize,
    dispose() {
      texture.dispose()
    },
  }
}

/** Resolve the exact faces before drawing: a webfont that lands after the
 *  canvas is painted leaves a fallback baked into the texture for good. */
export async function waitForFonts(specs: string[]): Promise<boolean> {
  if (!document.fonts) return false
  try {
    await Promise.all(specs.map((s) => document.fonts.load(s)))
    await document.fonts.ready
    return specs.every((s) => document.fonts.check(s))
  } catch {
    return false
  }
}
