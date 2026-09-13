/**
 * Screen-space flames — a port of the "Screen flames" renderer from Body of Fire
 * (itself a port of onepiece-meramera's fire), driven by an arbitrary subject's
 * silhouette instead of a dancer's.
 *
 * Four passes per frame:
 *
 *   1. Silhouette — the subject drawn white-on-black through an override material.
 *   2. Heat       — a half-resolution ping-pong field. Semi-Lagrangian advection
 *                   (buoyancy: hotter parcels rise faster, plus curl-noise swirl),
 *                   exponential cooling, then re-ignition from the silhouette:
 *                   a hard band along its edge and moving patches across its interior.
 *   3. Flame      — the heat torn into tongues by fractal noise sampled in
 *                   flow-following coordinates, coloured through a blackbody ramp.
 *   4. Composite  — heat-haze refraction, fire-lit picture, warmed ember skin,
 *                   white-hot rim, bloom, sparks, vignette, one ACES transform.
 *
 * Nothing here needs compute shaders, an SDF or a skeleton: it is all screen-space
 * passes over render targets, which is why it ports to a static mesh unchanged.
 */
import * as THREE from 'three/webgpu'
import {
  Fn, abs, clamp, dot, exp, float, floor, fract, max, mix,
  mx_fractal_noise_float, mx_noise_float, pass, renderOutput, screenUV, sin,
  smoothstep, step, texture, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'

/**
 * Distances are in *height units* — the frame is 1 unit tall and `aspect` wide —
 * so the look is resolution independent. Speeds are height units per second.
 */
export const FLAME_LOOK = {
  rise: 0.38,
  riseHot: 0.5,
  swirl: 0.18,
  swirlScale: 4.2,
  cool: 3.8,
  coolFloor: 0.5,
  hazeCool: 1.6,
  edgeBand: 0.011,
  interiorFloor: 0.14,
  interiorPeak: 0.78,
  fireLight: 0.6,
  refract: 0.012,
  shimmer: 0.003,
  // meramera tone-maps through a plain ACES curve; three's ACESFilmic output runs
  // exposure/0.6, so the fire terms are scaled down to land on the same look.
  exposure: 0.5,
  bloom: 0.25,
  sparks: 1,
}

/**
 * The shipped look, dialled in the panel. This is the SINGLE source of the
 * defaults: the uniforms below seed from it and the GUI seeds its sliders from
 * the live uniforms, so the panel can never show a number the shader is not
 * using.
 */
export const FIRE_PRESET = {
  burn: 1,
  edge: 0.87,
  interior: 0.62,
  sparks: 2.01,
  rise: 0.76,
  swirl: 0.57,
  cool: 2.5,
  refract: 0.02,
  fireLight: 0.39,
  exposure: 0.5,
  bloom: 0.53,
  skinWarm: 0,
  maskBody: 0,
  rim: 0,
}

/** The heat field runs at half resolution — it is smooth, and this is the cost driver. */
export const FLAME_SIM_SCALE = 0.5

/** Fire-X's blackbody ramp: 720K deep red through orange and gold to pale white above 2600K. */
const blackbody = Fn(([temperature]: [any]) => {
  const t = clamp(temperature.sub(720).div(1900), 0, 1)
  const red = vec3(1.0, 0.035, 0.002)
  const orange = vec3(1.0, 0.24, 0.008)
  const gold = vec3(1.0, 0.68, 0.12)
  const white = vec3(1.0, 0.94, 0.72)
  return mix(
    mix(red, orange, smoothstep(0.0, 0.32, t)),
    mix(gold, white, smoothstep(0.58, 1.0, t)),
    smoothstep(0.26, 0.72, t),
  )
})

const hash2 = Fn(([cell, seed]: [any, any]) =>
  fract(sin(dot(cell, vec2(127.1, 311.7)).add(seed)).mul(43758.5453)))

/** Divergence-free 2D flow from a scalar noise potential: v = (∂ψ/∂y, -∂ψ/∂x). */
const curlNoise = Fn(([p, z, eps]: [any, any, any]) => {
  const dx = vec2(eps, 0.0)
  const dy = vec2(0.0, eps)
  const dpdx = mx_noise_float(vec3(p.add(dx), z)).sub(mx_noise_float(vec3(p.sub(dx), z)))
  const dpdy = mx_noise_float(vec3(p.add(dy), z)).sub(mx_noise_float(vec3(p.sub(dy), z)))
  return vec2(dpdy, dpdx.negate()).div(eps.mul(2.0))
})

export interface FlamesOptions {
  renderer: THREE.WebGPURenderer
  scene: THREE.Scene
  camera: THREE.Camera
  /** Layer holding the burning subject. Its meshes must also stay on layer 0. */
  subjectLayer: number
  /** Layer mask for the opaque scene pass. */
  sceneLayers: THREE.Layers
}

export interface Flames {
  /** Live uniforms — every one of these is safe to poke from a GUI each frame. */
  readonly u: {
    burn: any
    sparks: any
    edge: any
    interior: any
    rise: any
    swirl: any
    cool: any
    refract: any
    fireLight: any
    exposure: any
    skinWarm: any
    maskBody: any
    rim: any
    view: any
  }
  readonly bloomNode: { strength: any; radius: any; threshold: any }
  setSize(width: number, height: number): void
  /** Supply the hero title texture. Passing null hides the layer. */
  setTitleTexture(texture: THREE.Texture | null): void
  render(deltaSeconds: number): void
  dispose(): void
}

export function createScreenFlames(options: FlamesOptions): Flames {
  const { renderer, scene, camera, subjectLayer, sceneLayers } = options

  const uAspect = uniform(1)
  const uTime = uniform(0)
  const uDt = uniform(0)
  const uBurn = uniform(FIRE_PRESET.burn)
  const uSparks = uniform(FIRE_PRESET.sparks)
  // Where it burns. Promoted from constants to uniforms so "whole mask", "horns
  // only" and "aura around it" are all reachable from the GUI without a rebuild.
  const uEdge = uniform(FIRE_PRESET.edge)
  const uInterior = uniform(FIRE_PRESET.interior)
  const uRise = uniform(FIRE_PRESET.rise)
  const uSwirl = uniform(FIRE_PRESET.swirl)
  const uCool = uniform(FIRE_PRESET.cool)
  const uRefract = uniform(FIRE_PRESET.refract)
  const uFireLight = uniform(FIRE_PRESET.fireLight)
  const uExposure = uniform(FIRE_PRESET.exposure)
  const uSkinWarm = uniform(FIRE_PRESET.skinWarm)
  // How much of the mask's own lit geometry survives into the composite.
  // At 0 the body vanishes and only the fire, its glow and the burning rim
  // remain — the silhouette still drives the heat field, so the flames keep
  // the mask's shape without the mask being drawn.
  const uMaskBody = uniform(FIRE_PRESET.maskBody)
  // The white-hot burning edge, separated from the body so an invisible mask
  // can still be outlined in fire.
  const uRim = uniform(FIRE_PRESET.rim)
  // The hero title lives BEHIND the mask. It cannot be a DOM layer: the mask
  // and the stage are one render, so nothing can be stacked between them.
  // Mixing it in here instead means the silhouette occludes it exactly, and the
  // heat haze and fire light fall on the letters for free.
  const uTextOn = uniform(0)
  /** Engineering view: 0 composite, 1 silhouette, 2 heat field, 3 flame emission. */
  const uView = uniform(0)
  const uHeatTexel = uniform(new THREE.Vector2(1 / 640, 1 / 400), 'vec2')

  const makeTarget = (hdr: boolean) =>
    new THREE.RenderTarget(8, 8, {
      type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: !hdr,
      stencilBuffer: false,
    })

  const maskTarget = makeTarget(false)
  const heatTargets = [makeTarget(true), makeTarget(true)]
  const flameTarget = makeTarget(true)

  const maskNode = texture(maskTarget.texture)
  // 1x1 placeholder until a title texture is supplied, so the graph compiles
  // with or without one.
  const blankText = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1)
  blankText.needsUpdate = true
  const textNode = texture(blankText)
  const heatNode = texture(heatTargets[0].texture)
  const flameNode = texture(flameTarget.texture)

  // Screen position in height units, which is also exactly the coordinate every
  // target here is sampled with.
  const heightUnits = () => vec2(uv().x.mul(uAspect), uv().y).toVar()
  const toUV = (p: any) => vec2(p.x.div(uAspect), p.y)

  /** A band along the silhouette boundary: 1 on the edge, 0 inside and outside. */
  const edgeBand = (at: any, e: number) => {
    const dx = vec2(float(e).div(uAspect), 0.0)
    const dy = vec2(0.0, e)
    const around = maskNode.sample(at.add(dx)).r
      .add(maskNode.sample(at.sub(dx)).r)
      .add(maskNode.sample(at.add(dy)).r)
      .add(maskNode.sample(at.sub(dy)).r)
      .mul(0.25)
    return around.mul(around.oneMinus()).mul(4.0)
  }

  const fullscreen = () => {
    const material = new THREE.NodeMaterial()
    material.depthTest = false
    material.depthWrite = false
    return material
  }

  // The subject's silhouette: the scene drawn white on black through an override.
  const maskMaterial = new THREE.MeshBasicNodeMaterial({ color: 0xffffff })

  // --- Heat field ---------------------------------------------------------
  // Every texel fetches the parcel that flowed into it — carried up by buoyancy
  // (hotter rises faster) and stirred by curl noise — cools, and is re-lit by the
  // silhouette: hard along its edge, in moving patches across its interior.
  // r = heat, g = haze, b = per-parcel noise, a = age since injection.
  const simMaterial = fullscreen()
  simMaterial.fragmentNode = Fn(() => {
    const p = heightUnits()
    const t = uTime
    const dt = uDt
    const here = heatNode.sample(uv()).toVar()
    const swirl = curlNoise(p.mul(FLAME_LOOK.swirlScale), t.mul(0.45), float(0.02))
      .mul(uSwirl)
      .add(curlNoise(p.mul(FLAME_LOOK.swirlScale * 2.7).add(vec2(5.1, 2.3)), t.mul(1.1), float(0.015)).mul(uSwirl.mul(0.45)))
    const wander = mx_noise_float(vec3(p.mul(1.4), t.mul(0.25))).mul(0.16)
    const rise = uRise.add(clamp(here.r, 0.0, 1.0).mul(FLAME_LOOK.riseHot))
    const velocity = vec2(swirl.x.add(wander), swirl.y.sub(rise))
    // Where this texel's parcel came from (y runs down, so "below" is +y).
    const from = p.sub(velocity.mul(dt))
    const previous = heatNode.sample(toUV(from)).toVar()

    const cooled = max(previous.r.mul(exp(dt.mul(uCool.negate()))).sub(dt.mul(FLAME_LOOK.coolFloor)), 0.0)
    const haze = previous.g.mul(exp(dt.mul(-FLAME_LOOK.hazeCool)))
    const age = previous.a.add(dt).min(6.0)

    const sil = maskNode.sample(uv()).r
    const edge = edgeBand(uv(), FLAME_LOOK.edgeBand).mul(uBurn).mul(uEdge)
    const patches = mx_fractal_noise_float(vec3(p.x.mul(11.0), p.y.mul(13.0).add(t.mul(1.1)), t.mul(0.8)), 2, 2.2, 0.5)
    const interior = sil.mul(uBurn).mul(uInterior)
      .mul(float(FLAME_LOOK.interiorFloor).add(smoothstep(-0.05, 0.5, patches).mul(FLAME_LOOK.interiorPeak - FLAME_LOOK.interiorFloor)))
    const flicker = float(0.78).add(mx_noise_float(vec3(p.mul(18.0), t.mul(6.0))).mul(0.22))
    const inject = max(interior, edge).mul(flicker).toVar()

    const heat = max(cooled, inject)
    const fresh = smoothstep(0.15, 0.6, inject)
    const grain = mx_noise_float(vec3(p.mul(11.0), t.mul(1.6)))
    return vec4(
      heat,
      max(haze, inject.mul(0.85).min(1.0)),
      mix(previous.b, grain, fresh),
      mix(age, float(0.0), fresh),
    )
  })()

  // --- Flame --------------------------------------------------------------
  // rgb = HDR emission, a = how much it hides what is behind it.
  const flameMaterial = fullscreen()
  flameMaterial.fragmentNode = Fn(() => {
    const p = heightUnits()
    const t = uTime
    const field = heatNode.sample(uv()).toVar()
    const heat = field.r
    const age = field.a
    const grain = field.b.mul(0.5).add(0.5)
    // The big noise is sampled where the parcel started, so the pattern rides up
    // with the flame instead of scrolling through it.
    const flowY = p.y.add(age.mul(FLAME_LOOK.rise + FLAME_LOOK.riseHot * 0.5))
    const born = t.sub(age)
    const tongues = mx_fractal_noise_float(vec3(p.x.mul(7.5), flowY.mul(3.6), born.mul(0.55).add(2.7)), 3, 2.0, 0.55)
    const fibre = abs(mx_noise_float(vec3(p.x.mul(20.0), flowY.mul(13.0), born.mul(0.7).add(9.0))))
    const lick = mx_noise_float(vec3(p.x.mul(30.0), p.y.add(t.mul(1.6)).mul(22.0), t.mul(1.1)))
    const tear = float(1.0).add(smoothstep(0.0, 1.2, age).mul(0.5))
    const shape = heat
      .mul(float(1.0).add(tongues.mul(tear)).sub(fibre.mul(0.5)).add(lick.mul(0.15)))
      .mul(float(0.82).add(grain.mul(0.36)))
      .toVar()
    const fringe = smoothstep(0.26, 0.4, shape)
    const body = smoothstep(0.42, 0.62, shape)
    const core = smoothstep(0.62, 0.88, shape)
    const white = smoothstep(0.95, 1.3, shape)
    const temperature = float(760.0).add(fringe.mul(490.0)).add(body.mul(500.0)).add(core.mul(600.0)).add(white.mul(550.0))
    const emission = blackbody(temperature).mul(fringe.mul(0.7).add(body.mul(1.15)).add(core.mul(1.5)).add(white.mul(1.3)))
    const cover = fringe.mul(0.75).add(body.mul(0.2)).add(core.mul(0.05))
    return vec4(emission, cover)
  })()

  // --- Sparks -------------------------------------------------------------
  // Layers of tall cells, each with one ember born at the cell's foot that streaks
  // up swaying and dies at the top — lit only if there was fire where it was born.
  const sparks = (p: any, t: any) => {
    const glow = vec3(0.0).toVar()
    const layers: [number, number, number, number][] = [
      [0.055, 0.2, 0.0, 1.0],
      [0.07, 0.26, 0.37, 7.0],
      [0.045, 0.16, 0.71, 13.0],
    ]
    for (const [cellW, cellH, offset, seed] of layers) {
      const size = vec2(cellW, cellH)
      const q = p.div(size).add(offset)
      const cell = floor(q)
      const f = fract(q)
      const h1 = hash2(cell, seed)
      const h2 = hash2(cell, seed + 3.7)
      const h3 = hash2(cell, seed + 9.1)
      const life = float(1.1).add(h3.mul(0.9))
      const phase = fract(t.div(life).add(h1))
      const sway = sin(t.mul(2.4).add(h1.mul(25.0))).mul(0.09).mul(phase)
      const sx = float(0.5).add(h2.sub(0.5).mul(0.7)).add(sway)
      const sy = phase.oneMinus()
      const d = f.sub(vec2(sx, sy)).mul(size)
      const stretched = vec2(d.x, d.y.mul(0.45))
      const r2 = dot(stretched, stretched)
      const dotGlow = exp(r2.mul(-1.0 / (0.0026 * 0.0026)))
      // Each ember only exists inside its own cell, so the halo must die out well
      // within half a cell or it is clipped into a visible rectangle.
      const halo = exp(r2.mul(-1.0 / (0.006 * 0.006))).mul(0.06)
      const fade = smoothstep(0.0, 0.12, phase).mul(smoothstep(0.55, 1.0, phase).oneMinus())
      const flicker = float(0.7).add(sin(t.mul(17.0).add(h2.mul(50.0))).mul(0.3))
      const foot = cell.add(vec2(sx, 1.0)).sub(offset).mul(size)
      const fire = heatNode.sample(toUV(foot)).r
      const lit = smoothstep(0.25, 0.7, fire).mul(step(0.2, h3))
      const emberColor = blackbody(float(1500.0).add(h2.mul(900.0)))
      glow.addAssign(emberColor.mul(dotGlow.add(halo)).mul(fade.mul(flicker).mul(lit).mul(2.6)))
    }
    return glow
  }

  // --- Composite ----------------------------------------------------------
  const scenePass = pass(scene, camera)
  scenePass.setLayers(sceneLayers)
  const sceneNode = scenePass.getTextureNode('output')
  const bloomNode = bloom(flameNode, FIRE_PRESET.bloom, 0.5, 0.0)

  const composite = Fn(() => {
    const p = heightUnits()
    const t = uTime
    const field = heatNode.sample(uv()).toVar('flameField')
    const warmth = field.r.add(field.g)
    const gx = heatNode.sample(uv().add(vec2(uHeatTexel.x, 0.0))).r.sub(heatNode.sample(uv().sub(vec2(uHeatTexel.x, 0.0))).r)
    const gy = heatNode.sample(uv().add(vec2(0.0, uHeatTexel.y))).r.sub(heatNode.sample(uv().sub(vec2(0.0, uHeatTexel.y))).r)
    const shimmer = mx_noise_float(vec3(p.x.mul(22.0), p.y.add(t.mul(0.9)).mul(16.0), t.mul(1.7)))
    const haze = vec2(gx, gy)
      .mul(uRefract)
      .add(vec2(shimmer, shimmer.mul(0.6)).mul(field.g).mul(FLAME_LOOK.shimmer))
      .mul(smoothstep(0.0, 0.2, warmth))
    // Raw silhouette, deliberately NOT multiplied by uBurn: the body must be
    // dimmable whether or not it is currently alight.
    const silRaw = maskNode.sample(uv()).r.toVar('flameSilhouetteRaw')
    const stage = sceneNode.sample(uv().add(haze)).rgb
    // Same haze offset as the stage, so the type refracts with everything else.
    const title = textNode.sample(uv().add(haze))
    const picture = mix(stage, title.rgb, title.a.mul(uTextOn).mul(silRaw.oneMinus()))
      // Dim only where the mask is, so the stage behind it is left alone.
      .mul(float(1.0).sub(silRaw.mul(float(1.0).sub(uMaskBody))))

    const sil = silRaw.mul(uBurn).toVar('flameSilhouette')
    const rim = edgeBand(uv(), 0.007).mul(uBurn).mul(float(0.45).add(sil.mul(0.55)))
    const flame = flameNode.sample(uv()).toVar('flameSample')
    const glow = vec4(bloomNode).rgb.toVar('flameGlow')

    const lit = picture.mul(float(1.0).add(glow.mul(uFireLight))).toVar('flameLit')
    const ember = mx_fractal_noise_float(vec3(p.x.mul(24.0), p.y.mul(24.0).add(t.mul(1.1)), t.mul(2.0)), 2, 2.1, 0.5).mul(0.5).add(0.5)
    const hot = blackbody(float(1800.0).add(ember.mul(800.0)))
    const skin = lit.mul(vec3(1.25, 0.72, 0.42)).mul(float(1.1).add(ember.mul(0.5))).add(hot.mul(ember.mul(0.3).add(0.08)))
    lit.assign(mix(lit, skin, sil.mul(0.8).mul(uSkinWarm)))
    const rimFlicker = float(0.55).add(mx_noise_float(vec3(p.mul(44.0), t.mul(8.0))).mul(0.45))
    lit.addAssign(blackbody(float(2400.0)).mul(rim.mul(rimFlicker).mul(uRim)))
    lit.mulAssign(field.g.mul(0.22).mul(sil.oneMinus()).oneMinus())

    const fire = flame.rgb.add(glow).add(sparks(p, t).mul(uSparks)).mul(uExposure)
    const cover = clamp(flame.a.mul(sil.mul(0.45).oneMinus()), 0.0, 1.0)
    const colorOut = lit.mul(cover.oneMinus()).add(fire).toVar('flameComposite')
    const vignetteDistance = screenUV.sub(0.5).length()
    const vignette = float(1).sub(smoothstep(0.3, 0.74, vignetteDistance).mul(0.42))
    colorOut.mulAssign(vignette)
    // Engineering views, selected without branching the pipeline.
    colorOut.assign(mix(colorOut, vec3(maskNode.sample(uv()).r), step(0.5, uView).mul(step(uView, 1.5))))
    colorOut.assign(mix(colorOut, vec3(field.r, field.g, field.a.mul(0.2)), step(1.5, uView).mul(step(uView, 2.5))))
    colorOut.assign(mix(colorOut, flame.rgb, step(2.5, uView)))
    return vec4(colorOut, 1)
  })()

  const pipeline = new THREE.RenderPipeline(renderer)
  pipeline.outputColorTransform = false
  pipeline.outputNode = renderOutput(composite, THREE.ACESFilmicToneMapping) as any

  const simQuad = new THREE.QuadMesh(simMaterial)
  const flameQuad = new THREE.QuadMesh(flameMaterial)

  let heatIndex = 0
  let clock = 0

  function renderMask() {
    const previousTarget = renderer.getRenderTarget()
    const previousBackground = scene.backgroundNode
    const previousOverride = scene.overrideMaterial
    const previousLayerMask = camera.layers.mask
    scene.backgroundNode = null
    scene.overrideMaterial = maskMaterial
    camera.layers.set(subjectLayer)
    try {
      renderer.setRenderTarget(maskTarget)
      renderer.render(scene, camera)
    } finally {
      renderer.setRenderTarget(previousTarget)
      scene.backgroundNode = previousBackground
      scene.overrideMaterial = previousOverride
      camera.layers.mask = previousLayerMask
    }
  }

  function setSize(width: number, height: number) {
    const simWidth = Math.max(8, Math.round(width * FLAME_SIM_SCALE))
    const simHeight = Math.max(8, Math.round(height * FLAME_SIM_SCALE))
    maskTarget.setSize(simWidth, simHeight)
    for (const target of heatTargets) target.setSize(simWidth, simHeight)
    flameTarget.setSize(width, height)
    uAspect.value = width / height
    uHeatTexel.value.set(1.5 / simWidth, 1.5 / simHeight)
  }

  function render(deltaSeconds: number) {
    clock += deltaSeconds
    uTime.value = clock
    uDt.value = Math.min(0.05, Math.max(0, deltaSeconds))

    renderMask()

    // Heat: read the previous field, write the next one.
    const previous = heatTargets[heatIndex]
    const next = heatTargets[1 - heatIndex]
    heatNode.value = previous.texture
    renderer.setRenderTarget(next)
    simQuad.render(renderer)
    heatIndex = 1 - heatIndex
    heatNode.value = next.texture

    renderer.setRenderTarget(flameTarget)
    flameQuad.render(renderer)
    renderer.setRenderTarget(null)

    // The composite reads the scene pass through its texture node, which renders it first.
    pipeline.render()
  }

  return {
    u: {
      burn: uBurn, sparks: uSparks, edge: uEdge, interior: uInterior,
      rise: uRise, swirl: uSwirl, cool: uCool, refract: uRefract,
      fireLight: uFireLight, exposure: uExposure, skinWarm: uSkinWarm,
      maskBody: uMaskBody, rim: uRim, view: uView,
    },
    bloomNode,
    setTitleTexture(tex: THREE.Texture | null) {
      textNode.value = tex ?? blankText
      uTextOn.value = tex ? 1 : 0
    },
    setSize,
    render,
    dispose() {
      blankText.dispose()
      for (const target of [maskTarget, ...heatTargets, flameTarget]) target.dispose()
      pipeline.dispose()
      simMaterial.dispose()
      flameMaterial.dispose()
      maskMaterial.dispose()
    },
  }
}
