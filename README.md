# Particle Field

A reusable particle-cloud component: one `THREE.Points` cloud, a procedural sprite, and a CPU
solver. **No post-processing, no textures, no models.** Reverse-engineered from the technique on
[milancompain.com](https://milancompain.com), then rebuilt as a framework-agnostic module.

```bash
npm install
npm run dev      # demo at http://127.0.0.1:5173
npm run build
```

## Use it

```ts
import { createParticleField, superellipse } from './particles'

const field = createParticleField(document.getElementById('field')!, {
  shape: superellipse({ n: 3.7, aspect: 1.05, radius: 5.3 }),
  geometry: { count: 6000, thickness: 0.09 },
  drive: (state) => ({ progress: state.y / 2000, burst: 0 }),
})
```

`drive` maps each frame to two values: `progress` (0→1 drives the dolly, materialisation, spin
and parallax fade) and `burst` (0→1 dissolves the cloud). Keeping it a callback means the
component holds no knowledge of your page's section layout.

React:

```tsx
import { ParticleFieldView } from './particles/react'
<ParticleFieldView geometry={{ count: 6000 }} onReady={(f) => (f.motion.sway = 0.4)} />
```

In Next.js load it with `dynamic(..., { ssr: false })` — it touches `window` on construction.

## How it works

**The shape is one function.** A superellipse `(|x|/a)^n + (|y|/b)^n = 1`. With the effective
exponent below 1 the curve turns concave and you get the 4-pointed sparkle. `n = 2` gives a
rhombus, `3.7` the reference star, `6` sharp needles. No asset is loaded.

**Points are placed in three populations.** The outline is sampled by **arc length** (via a
1440-entry cumulative table, binary-searched) rather than by angle — angle-uniform sampling
clumps points at the star's tips, and measurably so: arc-length spacing is 4.3× more even, with
worst-case clumping of 5.9× the mean instead of 19.8×. The interior is rejection-sampled with
the angle weighted by radius² and the radius by `sqrt(u)`, which together give density that is
uniform per unit *area* (measured CV 0.013). A loose halo orbits outside the silhouette.

**The blur is not a blur.** Every particle is drawn procedurally from `gl_PointCoord`, and each
carries a softness attribute that mixes a crisp disc against a wide quadratic glow. About 5% of
particles are large and fully soft; stacked additively, *that* is the entire bokeh-and-glow
look. There is no bloom pass and no depth of field.

**Volume comes from cueing, not thickness.** The cloud is a slab under 10% as deep as it is
wide. It reads as 3D because of four things: colour graded toward the pale shell by radius and
|z|, true perspective size attenuation, distance-based alpha falloff, and a permanent tilt so
it is never seen edge-on. A flat cloud with those cues still looks 3D; a thick cloud without
them looks like noise.

**The cursor punches a hole.** Particles inside the radius are not pushed away with a falloff —
they are relocated to sit *exactly on* the rim of a disc, so you get a clean bite with a bright
pile-up rather than a soft smear. Distance is measured perpendicular to the view axis in local
space, so the hole stays circular however far the field has rotated. The offset springs in
about 4× faster than it relaxes out, which is what gives it a viscous, trailing feel. Below a
threshold of total displacement the solver zeroes its offsets and parks — a real idle path.

**One rAF for the whole page.** `frameBus` owns a single loop with a `Set` of subscribers and
one scroll read per frame. Point it at a smooth-scroll library with `setScrollSource`; the demo
drives Lenis from the same loop, so nothing can drift out of phase and there is not one
`scroll` listener anywhere.

## Any shape

Two sampler families, both swappable strategies:

**2D — `ShapeSampler`** (`rim(n)`, `fill(n)`): flat silhouettes extruded into a thin slab.

- `superellipse()` — the star family.
- `svgPath(d)` — any logo or icon. The outline uses the browser's own
  `getPointAtLength()`; the interior rasterises the filled path once and samples opaque pixels,
  which handles holes and multiple subpaths under the nonzero fill rule for free.

**3D — `VolumeSampler`** (`edge(n)`, `surface(n)`, `bounds3()`): shapes that own their depth.
`geometry.ts` skips the slab extrusion, and the depth grading flips from |z| to **signed
frontness** — the front of the shape catches the light, the hollow back falls dark.

- `hannya()` — a Japanese hannya mask composed from ~14 parametric primitives
  (`parts3d.ts`: area-uniform ellipsoid patches, swept tubes, cones, ribbons, wedges), with eye
  sockets, nostrils and the mouth cavity carved by rejection. Its identity lives in arc-length
  feature curves — horn spines, brow crests, eye rims, the grin, fang triangles — proportioned
  against a 6-view generated reference sheet. `hornLength` and `mouthOpen` are live options.
  A real volume also spins safely: the demo enables `autoSpin` for the mask and disables it
  for flat shapes (which collapse to a line edge-on).

Text and meshes fit the same interfaces without core changes.

## Two things to know before shipping

**Additive blending assumes a dark background.** The whole palette does. On a light background
you need `NormalBlending` and a rethought palette — the technique does not transfer unchanged.

**A thin slab collapses at 90° of yaw.** Continuous full rotation therefore makes the field
vanish to a line roughly twice a minute. `autoSpin` is off by default for that reason; `sway`
gives self-rotation that never reaches edge-on. Turn `autoSpin` on only when the shape is thick
enough, or when you want the collapse.

## Options worth knowing

| Option | Default | Notes |
|---|---|---|
| `geometry.count` | 6000 | Cut to 60% automatically below 768 px |
| `geometry.thickness` | 0.09 | Slab depth as a fraction of half-height; 0 is flat |
| `geometry.rimFraction` | 0.26 | Share of the budget on the outline |
| `geometry.classes` | 70/25/5 | Size + softness mix; the 5% soft class is the glow |
| `solver.holeRadius` | 0.17 | Fraction of the largest half-extent |
| `solver.springIn` / `springOut` | 0.22 / 0.055 | Asymmetry is the point |
| `motion.sway` | 0.6 | Yaw oscillation, radians |
| `motion.autoSpin` | 0 | Continuous yaw, rad/s — see the caveat above |
| `motion.dolly` | `[106, 16]` | Camera distance at progress 0 → 1, log-interpolated |
| `maxDpr` | 2 | Point sizes are resolution-independent regardless |

`field.motion` is live — mutate any value and it applies next frame, no rebuild.

## Accessibility and failure

`prefers-reduced-motion` is honoured throughout: twinkle, drift, wander and halo oscillation
all stop, and the demo never constructs Lenis. If WebGL fails to initialise, the field renders
a static SVG silhouette traced from the same sampler, so *any* shape gets a fallback. A
collapsed (0×0) viewport is clamped rather than allowed to poison the projection matrix.

## API surface

`createParticleField()` returns `{ scene, camera, renderer, group, material, motion, webgl,
setShape(), setCalmTargets(), step(), stats(), destroy() }`.

- `setCalmTargets(elements)` dims particles behind up to two DOM boxes, so type stays legible
  over the live field without a scrim.
- `step(state)` advances and draws one frame — for hosts that already own a loop, or for
  offscreen capture and tests.
- `stats()` reports `fps`, `count`, and how many particles the cursor is currently displacing.
