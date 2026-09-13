import Lenis from 'lenis'
import GUI from 'lil-gui'
import type {
  AnySampler,
  GeometryOptions,
  SolverOptions,
  SizeClass,
} from '../particles/index'

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

// Everything three.js sits behind a dynamic import, so the WebGL chunk is a
// separate file that never blocks first paint. This is how the reference site
// ships too: a small app shell plus one lazily loaded scene chunk.
const P = await import('../particles/index')

// --- Smooth scroll -------------------------------------------------------
// Driven from the shared frame bus rather than its own rAF, so the whole page
// runs on exactly one loop and the WebGL motion reads the same eased scroll
// value the DOM is using.
if (!P.prefersReducedMotion) {
  const lenis = new Lenis({ autoRaf: false, smoothWheel: true })
  P.subscribe(() => lenis.raf(performance.now()))
  P.setScrollSource(() => lenis.scroll)
}

// --- Shapes --------------------------------------------------------------
const BOLT = 'M12 2 L4 13 H10 L9 22 L20 9 H13 L14 2 Z'
// Opposite winding on the inner circle punches a hole under the nonzero fill
// rule — a good check that the rasterising sampler handles subpaths.
const RING =
  'M10,50 a40,40 0 1,0 80,0 a40,40 0 1,0 -80,0 M25,50 a25,25 0 1,1 50,0 a25,25 0 1,1 -50,0'

type ShapeName =
  | 'Hannya mask (3D)'
  | 'Superellipse star'
  | 'Bolt (SVG)'
  | 'Ring (SVG, has a hole)'

const params = {
  shape: 'Hannya mask (3D)' as ShapeName,
  hornLength: 1,
  mouthOpen: 1,
  n: 3.7,
  aspect: 1.05,
  radius: 5.3,
  thickness: 0.09,
  count: 6000,
  rimFraction: 0.26,
  sizeMultiplier: 1,
  bigMix: 0.05,
  sway: 0.15,
  autoSpin: 0.18,
  holeRadius: 0.17,
  springIn: 0.22,
  springOut: 0.055,
}

function makeShape(): AnySampler {
  switch (params.shape) {
    case 'Hannya mask (3D)':
      return P.hannya({ hornLength: params.hornLength, mouthOpen: params.mouthOpen })
    case 'Bolt (SVG)':
      return P.svgPath(BOLT, { radius: params.radius })
    case 'Ring (SVG, has a hole)':
      return P.svgPath(RING, { radius: params.radius })
    default:
      return P.superellipse({ n: params.n, aspect: params.aspect, radius: params.radius })
  }
}

function makeClasses(): SizeClass[] {
  // Hold the medium share fixed and trade the crisp class against the bokeh
  // class, so the slider reads as "more glow" rather than "more particles".
  const big = params.bigMix
  const med = 0.25
  return [
    { mix: Math.max(0, 1 - med - big), size: [0.08, 0.135], soft: 0.1 },
    { mix: med, size: [0.16, 0.25], soft: 0.45 },
    { mix: big, size: [0.32, 0.58], soft: 1.0 },
  ]
}

const geometryOptions = (): GeometryOptions => ({
  count: params.count,
  rimFraction: params.rimFraction,
  thickness: params.thickness,
  classes: makeClasses(),
})

const solverOptions = (): SolverOptions => ({
  holeRadius: params.holeRadius,
  springIn: params.springIn,
  springOut: params.springOut,
})

// --- Field ---------------------------------------------------------------
const host = document.getElementById('field')!

const field = P.createParticleField(host, {
  shape: makeShape(),
  geometry: geometryOptions(),
  solver: solverOptions(),
  motion: { sway: params.sway, autoSpin: params.autoSpin },
  drive: (state) => {
    const max = document.documentElement.scrollHeight - state.H
    const t = max > 0 ? clamp01(state.y / max) : 0
    return {
      // Arrival occupies the first third; the dissolve, the last quarter.
      progress: clamp01(t / 0.34),
      burst: clamp01((t - 0.76) / 0.24),
    }
  },
})

// Handy in the console, and lets a headless check drive frames directly.
if (import.meta.env.DEV) (window as unknown as { field: typeof field }).field = field

const title = document.getElementById('title')
const lede = document.getElementById('lede')
if (title && lede) field.setCalmTargets([title, lede])

// --- Controls ------------------------------------------------------------
if (field.webgl) {
  const gui = new GUI({ title: 'Particle Field' })
  const rebuild = () => {
    field.setShape(makeShape(), geometryOptions(), solverOptions())
    // Continuous spin is safe only for shapes with real depth — a flat shape
    // collapses to a line edge-on, so switching back also switches motion.
    const volumetric = params.shape === 'Hannya mask (3D)'
    params.autoSpin = volumetric ? 0.18 : 0
    params.sway = volumetric ? 0.15 : 0.6
    field.motion.autoSpin = params.autoSpin
    field.motion.sway = params.sway
    gui.controllersRecursive().forEach((c) => c.updateDisplay())
  }

  const shapeFolder = gui.addFolder('Shape')
  shapeFolder
    .add(params, 'shape', [
      'Hannya mask (3D)',
      'Superellipse star',
      'Bolt (SVG)',
      'Ring (SVG, has a hole)',
    ])
    .name('silhouette')
    .onChange(rebuild)
  shapeFolder.add(params, 'hornLength', 0.5, 1.6, 0.05).name('horns (mask)').onFinishChange(rebuild)
  shapeFolder.add(params, 'mouthOpen', 0.6, 1.8, 0.05).name('grimace (mask)').onFinishChange(rebuild)
  shapeFolder.add(params, 'n', 2, 8, 0.05).name('exponent (star)').onFinishChange(rebuild)
  shapeFolder.add(params, 'aspect', 0.6, 1.6, 0.01).onFinishChange(rebuild)
  shapeFolder.add(params, 'thickness', 0, 0.6, 0.005).name('slab depth').onFinishChange(rebuild)
  shapeFolder.add(params, 'count', 1000, 20000, 500).onFinishChange(rebuild)
  shapeFolder.add(params, 'rimFraction', 0, 0.8, 0.01).name('outline share').onFinishChange(rebuild)

  const lookFolder = gui.addFolder('Look')
  lookFolder
    .add(params, 'sizeMultiplier', 0.2, 3, 0.05)
    .name('size')
    .onChange((v: number) => (field.material.uniforms.uSizeMul.value = v))
  lookFolder.add(params, 'bigMix', 0, 0.4, 0.005).name('bokeh share').onFinishChange(rebuild)

  const motionFolder = gui.addFolder('Motion')
  motionFolder
    .add(params, 'sway', 0, 1.5, 0.01)
    .name('yaw sway (rad)')
    .onChange((v: number) => (field.motion.sway = v))
  motionFolder
    .add(params, 'autoSpin', 0, 0.4, 0.005)
    .name('continuous spin')
    .onChange((v: number) => (field.motion.autoSpin = v))

  const cursorFolder = gui.addFolder('Cursor')
  cursorFolder.add(params, 'holeRadius', 0.02, 0.5, 0.005).name('hole radius').onFinishChange(rebuild)
  cursorFolder.add(params, 'springIn', 0.02, 1, 0.01).onFinishChange(rebuild)
  cursorFolder.add(params, 'springOut', 0.005, 0.5, 0.005).onFinishChange(rebuild)
  cursorFolder.close()
}

// --- Stats ---------------------------------------------------------------
const statsEl = document.getElementById('stats')!
let statClock = 0

P.subscribe((state) => {
  statClock += state.dt
  if (statClock < 0.25) return
  statClock = 0

  const s = field.stats()
  if (!s.webgl) {
    statsEl.textContent = 'WebGL unavailable — SVG fallback'
    return
  }
  statsEl.textContent =
    `${s.fps.toFixed(0).padStart(3)} fps\n` +
    `${s.count.toLocaleString()} particles\n` +
    `${s.affected.toString().padStart(4)} displaced\n` +
    `${s.energy.toFixed(2).padStart(6)} energy` +
    (s.energy === 0 ? '  (idle)' : '')
})
