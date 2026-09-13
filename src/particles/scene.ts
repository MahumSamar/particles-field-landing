import * as THREE from 'three'
import { buildGeometry, type FieldGeometry, type GeometryOptions } from './geometry'
import { createMaterial, type FieldMaterial, type MaterialOptions } from './material'
import { FieldSolver, type SolverOptions } from './interaction'
import { superellipse } from './shapes/superellipse'
import { isVolume, type AnySampler } from './shapes/index'
import { subscribe, prefersReducedMotion, hasFinePointer, type FrameState } from './frameBus'

export interface MotionOptions {
  /**
   * Continuous idle rotation, rad/s.
   *
   * Off by default, deliberately: the field is a thin slab, so a full
   * revolution passes through edge-on and momentarily collapses it to a line.
   * `sway` gives self-rotation that never does. Turn this on when the shape is
   * thick enough (or the collapse is wanted).
   */
  autoSpin?: number
  /** Amplitude of a slow yaw oscillation, in radians. The safe self-rotation. */
  sway?: number
  /** Frequency of that oscillation, rad/s. */
  swaySpeed?: number
  /**
   * Ceiling on parallax drift, as a multiple of the field's own half-extent.
   * Keeps a distant field from wandering across half the screen.
   */
  parallaxReach?: number
  /** Extra yaw accumulated across the full progress range, in radians. */
  scrollSpin?: number
  /** Constant tilt so the slab is never viewed edge-on and reads as 3D. */
  tilt?: number
  /** Amplitude of the slow tilt wobble, in radians. */
  wobble?: number
  /** Camera distance at progress 0 and 1. Interpolated exponentially. */
  dolly?: [number, number]
  /** Progress window over which the field materialises out of dust. */
  lifeRange?: [number, number]
  /** Progress window over which the parallax drift fades away. */
  driftFade?: [number, number]
  /** Amplitude of the autonomous sine wander, as a fraction of the safe span. */
  wander?: [number, number]
  /** Always-on oscillation layered on top of pointer or wander. */
  oscillation?: [number, number]
  /** Smoothing applied to the parallax target. */
  driftLerp?: number
}

export interface ParticleFieldOptions {
  shape?: AnySampler
  geometry?: GeometryOptions
  material?: MaterialOptions
  solver?: SolverOptions
  motion?: MotionOptions
  /** Background starfield. Pass false to omit it. */
  starfield?: boolean
  /** Device pixel ratio ceiling. */
  maxDpr?: number
  /** Viewport width below which the particle budget is cut. */
  mobileBreakpoint?: number
  /** Fraction of the particle budget kept on narrow viewports. */
  mobileCountScale?: number
  fov?: number
  cameraZ?: number
  /**
   * Maps each frame to the field's two drive values. Defaults to reading
   * document scroll. Keeping this a callback means the component holds no
   * knowledge of the page's section layout.
   */
  drive?: (state: FrameState) => { progress: number; burst: number }
}

export interface FieldStats {
  count: number
  fps: number
  energy: number
  affected: number
  webgl: boolean
}

export interface ParticleField {
  /** Escape hatches for hosts that want to add their own objects or effects. */
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly renderer: THREE.WebGLRenderer | null
  readonly group: THREE.Group
  readonly material: FieldMaterial
  readonly webgl: boolean
  /** Live motion config — mutate any field and it takes effect next frame. */
  readonly motion: Required<MotionOptions>
  /**
   * Advance and draw exactly one frame.
   *
   * The field drives itself from the shared frame bus by default. Call this
   * instead when the host already owns a loop (an existing three.js app, a
   * game loop), or to force a draw for an offscreen capture or a test.
   */
  step(state: FrameState): void
  /** Elements whose boxes dim the particles behind them. */
  setCalmTargets(elements: HTMLElement[]): void
  setShape(shape: AnySampler, geometry?: GeometryOptions, solver?: SolverOptions): void
  stats(): FieldStats
  destroy(): void
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const smoothstep = (t: number) => t * t * (3 - 2 * t)

/** Perceptually even dolly: interpolate distance in log space, not linearly. */
const dollyAt = (t: number, far: number, near: number) =>
  far * Math.pow(near / far, 0.7 * t + 0.3 * smoothstep(t))

function radialSprite(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.35, 'rgba(255,255,255,.8)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
}

function starLayer(
  count: number,
  rMin: number,
  rMax: number,
  size: number,
  accentChance: number,
  sprite: THREE.Texture,
): THREE.Points {
  const pos = new Float32Array(count * 3)
  const col = new Float32Array(count * 3)
  const dim = new THREE.Color('#dddddd')
  const accent = new THREE.Color('#2ee6a0')
  const grey = new THREE.Color('#888888')

  for (let i = 0; i < count; i++) {
    const r = rMin + Math.random() * (rMax - rMin)
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    pos[i * 3] = r * Math.sin(phi) * Math.cos(theta)
    pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.7
    // Pushed behind the field so it never intersects the star.
    pos[i * 3 + 2] = -Math.abs(r * Math.cos(phi)) * 0.6 - 4

    const c = Math.random() < accentChance ? accent : Math.random() < 0.5 ? dim : grey
    col[i * 3] = c.r
    col[i * 3 + 1] = c.g
    col[i * 3 + 2] = c.b
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))

  return new THREE.Points(
    g,
    new THREE.PointsMaterial({
      size,
      map: sprite,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    }),
  )
}

/** Last-resort static silhouette when WebGL is unavailable. */
function svgFallback(shape: AnySampler): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  const { halfW, halfH } = shape.bounds()
  svg.setAttribute('viewBox', `${-halfW * 1.2} ${-halfH * 1.2} ${halfW * 2.4} ${halfH * 2.4}`)
  svg.setAttribute('class', 'pf-fallback')
  svg.setAttribute('aria-hidden', 'true')

  const defs = document.createElementNS(NS, 'defs')
  const grad = document.createElementNS(NS, 'radialGradient')
  grad.setAttribute('id', 'pf-fb')
  for (const [offset, color] of [
    ['0%', '#0c4632'],
    ['45%', '#14805a'],
    ['82%', '#2ee6a0'],
    ['100%', '#9ff5d4'],
  ]) {
    const stop = document.createElementNS(NS, 'stop')
    stop.setAttribute('offset', offset)
    stop.setAttribute('stop-color', color)
    grad.appendChild(stop)
  }
  defs.appendChild(grad)
  svg.appendChild(defs)

  // Trace the outline from the sampler itself, so any shape gets a fallback.
  // A volume sampler has no single outline — flatten its feature curves to
  // dots instead of pretending they form one closed path.
  const stride = isVolume(shape) ? 3 : 2
  const pts = isVolume(shape) ? shape.edge(240) : shape.rim(240)
  const path = document.createElementNS(NS, 'path')
  if (isVolume(shape)) {
    let d = ''
    for (let i = 0; i < 240; i++) {
      const x = pts[i * stride].toFixed(2)
      const y = (-pts[i * stride + 1]).toFixed(2)
      d += `M${x} ${y}h0.06`
    }
    path.setAttribute('d', d)
    path.setAttribute('stroke-linecap', 'round')
  } else {
    let d = ''
    for (let i = 0; i < 240; i++) {
      d += (i ? 'L' : 'M') + pts[i * 2].toFixed(2) + ' ' + (-pts[i * 2 + 1]).toFixed(2)
    }
    path.setAttribute('d', d + 'Z')
  }
  path.setAttribute('fill', 'url(#pf-fb)')
  path.setAttribute('stroke', '#9ff5d4')
  path.setAttribute('stroke-width', '0.06')
  path.setAttribute('stroke-opacity', '0.8')
  svg.appendChild(path)
  return svg
}

export function createParticleField(
  host: HTMLElement,
  options: ParticleFieldOptions = {},
): ParticleField {
  const motionOn = !prefersReducedMotion
  // Mutable and exposed on the returned field, so motion can be retuned live
  // without rebuilding geometry or dropping the GL context.
  const motion: Required<MotionOptions> = {
    autoSpin: 0,
    sway: 0.6,
    swaySpeed: 0.16,
    parallaxReach: 0.9,
    scrollSpin: Math.PI * 1.15,
    tilt: 0.2,
    wobble: 0.07,
    dolly: [106, 16],
    lifeRange: [0.05, 0.75],
    driftFade: [0.1, 0.6],
    wander: [0.8, 0.55],
    oscillation: [0.08, 0.05],
    driftLerp: 0.05,
    ...options.motion,
  }

  const fov = options.fov ?? 50
  const cameraZ = options.cameraZ ?? 16
  const maxDpr = options.maxDpr ?? 2

  let shape: AnySampler = options.shape ?? superellipse()

  // --- WebGL, with a real fallback ---------------------------------------
  let renderer: THREE.WebGLRenderer | null = null
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    if (!renderer.getContext()) renderer = null
  } catch {
    renderer = null
  }

  if (!renderer) {
    const fb = svgFallback(shape)
    host.appendChild(fb)
    const noop = () => {}
    return {
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      renderer: null,
      group: new THREE.Group(),
      material: createMaterial(),
      webgl: false,
      motion,
      step: noop,
      setCalmTargets: noop,
      setShape: noop,
      stats: () => ({ count: 0, fps: 0, energy: 0, affected: 0, webgl: false }),
      destroy: () => fb.remove(),
    }
  }

  // A collapsed viewport is a real state — a hidden tab, a `display: none`
  // ancestor, a panel animating from zero height. Left unclamped it divides by
  // zero: the aspect becomes NaN, which poisons the projection matrix, and the
  // drawing buffer height becomes 0, which pins every point to the minimum
  // size permanently. Neither recovers on its own, so clamp at the source.
  const viewW = () => Math.max(1, innerWidth)
  const viewH = () => Math.max(1, innerHeight)

  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setPixelRatio(Math.min(devicePixelRatio, maxDpr))
  renderer.setSize(viewW(), viewH())
  host.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(fov, viewW() / viewH(), 0.1, 300)
  camera.position.z = cameraZ

  const sprite = radialSprite()
  let bgA: THREE.Points | null = null
  let bgB: THREE.Points | null = null
  if (options.starfield !== false) {
    bgA = starLayer(900, 30, 90, 0.5, 0.06, sprite)
    bgB = starLayer(700, 25, 80, 0.32, 0.1, sprite)
    scene.add(bgA, bgB)
  }

  const group = new THREE.Group()
  scene.add(group)

  const material = createMaterial({ motion: motionOn, ...options.material })

  let geometryDefaults = options.geometry
  let solverDefaults = options.solver

  // Phones are limited by fill rate and thermal budget long before the shader
  // gets interesting. Spend less by drawing fewer particles rather than by
  // degrading the effect — the look survives a smaller count, but not a
  // cheaper sprite.
  const isNarrow = () => innerWidth > 0 && innerWidth < (options.mobileBreakpoint ?? 768)
  const withMobileBudget = (g?: GeometryOptions): GeometryOptions | undefined => {
    if (!isNarrow()) return g
    const base = g ?? {}
    const k = options.mobileCountScale ?? 0.6
    return {
      ...base,
      count: Math.round((base.count ?? 6000) * k),
      cloudCount: Math.round((base.cloudCount ?? 260) * k),
    }
  }

  let geo: FieldGeometry = buildGeometry(shape, withMobileBudget(geometryDefaults))
  let solver = new FieldSolver(geo, solverDefaults)
  let points = new THREE.Points(geo.geometry, material)
  points.frustumCulled = false // positions are displaced every frame
  group.add(points)

  // --- Pointer ------------------------------------------------------------
  const ndc = new THREE.Vector2(99, 99)
  let pointerLive = false

  const onPointerMove = (e: PointerEvent) => {
    ndc.set((e.clientX / viewW()) * 2 - 1, -(e.clientY / viewH()) * 2 + 1)
    pointerLive = motionOn
  }
  const onPointerOut = (e: PointerEvent) => {
    if (!e.relatedTarget) pointerLive = false
  }
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  document.addEventListener('pointerout', onPointerOut)

  // --- Resize -------------------------------------------------------------
  const syncScale = () => {
    // Sizes are expressed against half the drawing-buffer height, so a point
    // occupies the same fraction of the screen at any resolution or DPR.
    material.uniforms.uScale.value = Math.max(1, renderer!.domElement.height) * 0.5
    material.uniforms.uAspect.value = camera.aspect
  }
  const onResize = () => {
    camera.aspect = viewW() / viewH()
    camera.updateProjectionMatrix()
    renderer!.setSize(viewW(), viewH())
    syncScale()
    measureCalm()
  }
  syncScale()
  window.addEventListener('resize', onResize)

  // --- Calm rects ---------------------------------------------------------
  let calmTargets: HTMLElement[] = []
  let calmBoxes: { cx: number; cy: number; hw: number; hh: number }[] = []

  function measureCalm() {
    // Measured on resize only — never inside the frame loop, so this can
    // never cause a forced reflow mid-render.
    calmBoxes = calmTargets.slice(0, 2).map((el) => {
      const r = el.getBoundingClientRect()
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, hw: r.width / 2, hh: r.height / 2 }
    })
  }

  const drive =
    options.drive ??
    ((s: FrameState) => {
      const max = document.documentElement.scrollHeight - s.H
      return { progress: max > 0 ? clamp01(s.y / max) : 0, burst: 0 }
    })

  // --- Frame --------------------------------------------------------------
  const viewAxis = new THREE.Vector3(0, 0, 1)
  const invRot = new THREE.Matrix4()
  const rayDir = new THREE.Vector3()
  const hit = new THREE.Vector3()
  const cursorLocal = new THREE.Vector3()

  let driftX = 0
  let driftY = 0
  let fps = 0
  let frames = 0
  let fpsClock = 0

  function step(state: FrameState) {
    const { time, dt } = state
    const { progress, burst } = drive(state)
    const p = clamp01(progress)
    const b = clamp01(burst)

    frames++
    fpsClock += dt
    if (fpsClock >= 0.5) {
      fps = frames / fpsClock
      frames = 0
      fpsClock = 0
    }

    const [dollyFar, dollyNear] = motion.dolly
    const [lifeFrom, lifeTo] = motion.lifeRange
    const [fadeFrom, fadeTo] = motion.driftFade

    // --- Dolly ---
    const distance = dollyAt(p, dollyFar, dollyNear)
    const groupZ = cameraZ - distance

    // --- Rotation ---
    group.rotation.y =
      (motionOn ? time * motion.autoSpin + Math.sin(time * motion.swaySpeed) * motion.sway : 0) +
      p * motion.scrollSpin
    group.rotation.x = motion.tilt + (motionOn ? Math.sin(time * 0.09) * motion.wobble : 0)

    // --- Parallax, clamped so the field can never leave the viewport ---
    const halfHWorld = Math.tan((fov / 2) * (Math.PI / 180)) * distance
    const halfWWorld = halfHWorld * camera.aspect
    // Bounded twice: it must not leave the viewport, and it must not drift
    // further than a fraction of its own size. Without the second bound a
    // distant field roams across half the screen and reads as unmoored.
    const spanX = Math.max(
      0, Math.min(halfWWorld - geo.bounds.halfW * 0.9, geo.bounds.halfW * motion.parallaxReach),
    )
    const spanY = Math.max(
      0, Math.min(halfHWorld - geo.bounds.halfH * 0.9, geo.bounds.halfH * motion.parallaxReach),
    )

    let wantX = 0
    let wantY = 0
    if (motionOn) {
      if (hasFinePointer && pointerLive && Math.abs(ndc.x) <= 1) {
        wantX = ndc.x * spanX
        wantY = ndc.y * spanY
      } else {
        // Layered sines at unrelated frequencies, so the path never visibly loops.
        wantX = (Math.sin(time * 0.26 + 2.4) * 0.68 + Math.sin(time * 0.071) * 0.32) * spanX * motion.wander[0]
        wantY = (Math.sin(time * 0.31 + 0.7) * 0.58 + Math.cos(time * 0.047) * 0.42) * spanY * motion.wander[1]
      }
      wantX += Math.sin(time * 0.5) * spanX * motion.oscillation[0]
      wantY += Math.cos(time * 0.37) * spanY * motion.oscillation[1]
      wantX = Math.max(-spanX, Math.min(spanX, wantX))
      wantY = Math.max(-spanY, Math.min(spanY, wantY))
    }
    driftX += (wantX - driftX) * motion.driftLerp
    driftY += (wantY - driftY) * motion.driftLerp

    const fade = 1 - smoothstep(clamp01((p - fadeFrom) / (fadeTo - fadeFrom || 1)))
    group.position.set(driftX * fade, driftY * fade, groupZ)
    group.updateMatrixWorld()

    // --- Materialise / dissolve ---
    const life = motionOn
      ? 0.18 + 0.82 * smoothstep(clamp01((p - lifeFrom) / (lifeTo - lifeFrom || 1)))
      : 1
    material.uniforms.uLife.value = life
    material.uniforms.uBurst.value = b
    material.uniforms.uTime.value = time
    material.uniforms.uOpacity.value = 0.95 - b * 0.6
    // A floor of ~1.4 device px keeps distant dust from flickering into nothing.
    material.uniforms.uMinPx.value = 1.4 * Math.min(devicePixelRatio, maxDpr)

    // --- Cursor into the field's local space ---
    let cursor: THREE.Vector3 | null = null
    if (motionOn && hasFinePointer && pointerLive && p >= 0.98 && b < 0.5 && Math.abs(ndc.x) <= 1) {
      rayDir.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(camera.position).normalize()
      if (Math.abs(rayDir.z) > 1e-5) {
        // Intersect the plane the field currently sits on.
        const t = (groupZ - camera.position.z) / rayDir.z
        if (t > 0) {
          hit.copy(camera.position).addScaledVector(rayDir, t)
          cursor = group.worldToLocal(cursorLocal.copy(hit))
        }
      }
    }
    invRot.makeRotationFromEuler(group.rotation).invert()
    viewAxis.set(0, 0, 1).applyMatrix4(invRot).normalize()

    solver.update({ time, burst: b, cursorLocal: cursor, viewAxisLocal: viewAxis, motion: motionOn })
    geo.geometry.attributes.position.needsUpdate = true

    // --- Calm rects → clip space ---
    if (calmBoxes.length > 0) {
      const w = viewW()
      const h = viewH()
      const k = 2 / h
      const a = calmBoxes[0]
      const bx = calmBoxes[1] ?? a
      material.uniforms.uCalmA.value.set(
        (a.cx - w / 2) * k, (h / 2 - a.cy) * k, a.hw * k, a.hh * k,
      )
      material.uniforms.uCalmB.value.set(
        (bx.cx - w / 2) * k, (h / 2 - bx.cy) * k, bx.hw * k, bx.hh * k,
      )
      material.uniforms.uCalmOn.value = 1 - clamp01((p - 0.35) / 0.2)
    } else {
      material.uniforms.uCalmOn.value = 0
    }

    if (motionOn) {
      if (bgA) bgA.rotation.y = time * 0.004
      if (bgB) bgB.rotation.y = -time * 0.006
      if (bgA) bgA.rotation.x = ndc.y * 0.02
      if (bgB) bgB.rotation.x = ndc.y * 0.03
    }

    renderer!.render(scene, camera)
  }

  const unsubscribe = subscribe(step)

  function setShape(
    next: AnySampler,
    geometryOptions?: GeometryOptions,
    solverOptions?: SolverOptions,
  ) {
    shape = next
    if (geometryOptions) geometryDefaults = geometryOptions
    if (solverOptions) solverDefaults = solverOptions

    group.remove(points)
    geo.geometry.dispose()

    geo = buildGeometry(shape, withMobileBudget(geometryDefaults))
    solver = new FieldSolver(geo, solverDefaults)
    points = new THREE.Points(geo.geometry, material)
    points.frustumCulled = false
    group.add(points)
  }

  return {
    scene,
    camera,
    renderer,
    group,
    material,
    motion,
    webgl: true,
    step,

    setCalmTargets(elements) {
      calmTargets = elements
      measureCalm()
    },

    setShape,

    stats: () => ({
      count: geo.count,
      fps,
      energy: solver.energy,
      affected: solver.affected,
      webgl: true,
    }),

    destroy() {
      unsubscribe()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerout', onPointerOut)
      geo.geometry.dispose()
      material.dispose()
      sprite.dispose()
      for (const bg of [bgA, bgB]) {
        if (!bg) continue
        bg.geometry.dispose()
        ;(bg.material as THREE.Material).dispose()
      }
      renderer!.domElement.remove()
      renderer!.dispose()
    },
  }
}
