import * as THREE from 'three/webgpu'
import { color, dot, float, mix, normalView, positionLocal, positionViewDirection, screenUV, smoothstep, vec2 } from 'three/tsl'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { createScreenFlames, type Flames } from './flames'
import { createHannyaMaskModel } from './model/createHannyaMaskModel'

/**
 * How far the cursor can pull the mask. Mutable so the tuning panel can bind
 * straight to it — amplitude is pure taste and gets adjusted by eye.
 */
export interface CursorMotion {
  /** Peak yaw, in radians. */
  yaw: number
  /** Peak pitch, in radians. */
  pitch: number
  /** Peak lateral drift, in model heights (the mask is normalised to 1). */
  shift: number
  /** Approach rate per 60th of a second. Lower is heavier. */
  ease: number
}

/**
 * The burning-mask scene, shared by the tuning sandbox and the hero page.
 * Only the surrounding chrome differs between them.
 */
export interface FireScene {
  renderer: THREE.WebGPURenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  model: THREE.Group
  flames: Flames
  /** Cursor-follow amplitudes. Only read while `pinned`. */
  motion: CursorMotion
  /** Drawing-buffer size after the last resize. */
  bufferSize(): THREE.Vector2
  resize(): void
  /** Advance one frame. Returns fps, sampled over half-second windows. */
  step(now: number): number
  dispose(): void
}

export interface FireSceneOptions {
  /** Vertical framing: >0 lifts the mask up the frame, leaving room below. */
  verticalOffset?: number
  /** Multiplier on the fitted camera distance. Larger pushes the mask away. */
  distanceScale?: number
  autoRotate?: boolean
  autoRotateSpeed?: number
  /**
   * Hero mode: the mask is pinned dead centre and never drifts. Orbit, wheel
   * dolly and auto-rotate are all off, the camera is placed explicitly each
   * frame, and motion comes only from the cursor and the scroll.
   */
  pinned?: boolean
  /** Peak yaw the cursor can turn the model to, in radians. */
  cursorYaw?: number
  /** Peak pitch, in radians. */
  cursorPitch?: number
  /** Peak drift toward the cursor, in model heights. 0 disables it. */
  cursorShift?: number
  /** How fast the model chases the cursor. Lower is heavier. */
  cursorEase?: number
  /** Scroll distance, in viewport heights, over which the mask grows to fill. */
  scrollRange?: number
  /** Camera-distance multiplier at full scroll. Below 1 dollies IN. */
  scrollZoom?: number
}

const SUBJECT_LAYER = 2
const OPAQUE_SCENE_LAYERS = new THREE.Layers()
OPAQUE_SCENE_LAYERS.set(0)
const FIRE_LIGHT_INTENSITY = 4

export function isWebGPUAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.gpu
}

export async function createFireScene(
  host: HTMLElement,
  options: FireSceneOptions = {},
): Promise<FireScene> {
  const verticalOffset = options.verticalOffset ?? 0.02
  const distanceScale = options.distanceScale ?? 1.55

  // A hidden pane reports innerWidth/innerHeight as 0; an unclamped size gives a
  // zero drawing buffer and a NaN aspect that never recovers.
  const viewW = () => Math.max(1, innerWidth || 0)
  const viewH = () => Math.max(1, innerHeight || 0)

  const renderer = new THREE.WebGPURenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(viewW(), viewH())
  // The whole graph stays linear HDR; ACES runs once at the end of the composite.
  renderer.toneMapping = THREE.NoToneMapping
  renderer.domElement.setAttribute('role', 'img')
  renderer.domElement.setAttribute('aria-label', 'A hannya mask wrapped in simulated fire.')
  host.appendChild(renderer.domElement)
  await renderer.init()

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(40, viewW() / viewH(), 0.05, 100)

  // --- Stage ---
  const glowDistance = screenUV.sub(vec2(0.5, 0.45)).mul(vec2(0.9, 1.2)).length()
  scene.backgroundNode = mix(color(0x040304), color(0x1a110c),
    smoothstep(0.78, 0.05, glowDistance).pow(1.4).mul(0.7))

  const keyLight = new THREE.DirectionalLight(0xb9c8dd, 1.1)
  keyLight.position.set(-2.2, 4.5, 2.6)
  scene.add(keyLight, new THREE.HemisphereLight(0x2b3140, 0x0d0b0a, 0.5))

  const fireLight = new THREE.PointLight(0xff8a3c, FIRE_LIGHT_INTENSITY, 0, 2)
  fireLight.position.set(0, 0.1, 0.35)
  scene.add(fireLight)

  const floorMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0.04 })
  floorMaterial.colorNode = color(0x1a181f).mul(smoothstep(5, 1.2, positionLocal.xy.length()))
  const floor = new THREE.Mesh(new THREE.CircleGeometry(6, 64), floorMaterial)
  floor.rotation.x = -Math.PI * 0.5
  floor.position.y = -0.75
  scene.add(floor)

  // --- Subject ---
  const fresnel = (power: number, scale: number) =>
    float(1).sub(dot(normalView, positionViewDirection).abs()).pow(power).mul(scale)

  const model = createHannyaMaskModel()
  {
    const bounds = new THREE.Box3().setFromObject(model)
    const size = new THREE.Vector3()
    const center = new THREE.Vector3()
    bounds.getSize(size)
    bounds.getCenter(center)
    const s = 1 / Math.max(size.y, 1e-4)
    model.scale.setScalar(s)
    model.position.set(-center.x * s, -center.y * s, -center.z * s)
  }
  // The centring offset above is written once, not on resize, so this stays
  // valid for the life of the scene. Cursor drift is added to it each frame —
  // never assigned over it, or the mask jumps off centre on the first move.
  const basePosition = model.position.clone()

  const skin = new THREE.MeshPhysicalNodeMaterial({
    color: 0x100c0b, metalness: 0.1, roughness: 0.58, clearcoat: 0.35, clearcoatRoughness: 0.5,
  })
  skin.emissiveNode = color(0xff4a14).mul(fresnel(2.4, 1.3).mul(0.9).add(0.03))

  model.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.material = skin
    mesh.frustumCulled = false
    mesh.layers.enable(SUBJECT_LAYER)
  })
  scene.add(model)

  // --- Controls ---
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.target.set(0, verticalOffset, 0)
  controls.enableDamping = true
  controls.dampingFactor = 0.06
  controls.enablePan = false
  controls.minDistance = 0.7
  controls.maxDistance = 5
  camera.position.set(0, verticalOffset, 1.5)

  const pinned = options.pinned ?? false
  if (pinned) {
    // Nothing autonomous: no drift, and the wheel is the scroll's, not the
    // camera's — OrbitControls would otherwise dolly out on scroll-down, which
    // is the opposite of what the hero wants.
    controls.enabled = false
    controls.autoRotate = false
  } else {
    controls.autoRotate = options.autoRotate ?? true
    controls.autoRotateSpeed = options.autoRotateSpeed ?? 0.6
    renderer.domElement.addEventListener('pointerdown', () => { controls.autoRotate = false })
  }
  controls.update()

  // --- Cursor and scroll -------------------------------------------------
  const motion: CursorMotion = {
    yaw: options.cursorYaw ?? 0.6,
    pitch: options.cursorPitch ?? 0.34,
    shift: options.cursorShift ?? 0.07,
    ease: options.cursorEase ?? 0.05,
  }
  const scrollRange = options.scrollRange ?? 1
  const scrollZoom = options.scrollZoom ?? 0.34

  let targetYaw = 0
  let targetPitch = 0
  let currentYaw = 0
  let currentPitch = 0
  let targetProgress = 0
  let currentProgress = 0
  /** Distance that frames the mask at rest; scroll multiplies it. */
  let fittedDistance = 1.5

  const onPointerMove = (event: PointerEvent) => {
    const nx = (event.clientX / viewW()) * 2 - 1
    const ny = (event.clientY / viewH()) * 2 - 1
    // Signs are deliberate: ny is -1 at the TOP of the screen, and a negative
    // rotation.x tips the face up — i.e. toward the pointer. Same for yaw.
    targetYaw = nx * motion.yaw
    targetPitch = ny * motion.pitch
  }
  // Leaving the window eases back to centre rather than freezing mid-turn.
  const onPointerOut = (event: PointerEvent) => {
    if (!event.relatedTarget) { targetYaw = 0; targetPitch = 0 }
  }
  const onScroll = () => {
    const range = Math.max(1, scrollRange * viewH())
    targetProgress = Math.min(1, Math.max(0, scrollY / range))
  }
  if (pinned) {
    addEventListener('pointermove', onPointerMove, { passive: true })
    document.addEventListener('pointerout', onPointerOut)
    addEventListener('scroll', onScroll, { passive: true })
    onScroll()
  }

  const flames = createScreenFlames({
    renderer, scene, camera,
    subjectLayer: SUBJECT_LAYER,
    sceneLayers: OPAQUE_SCENE_LAYERS,
  })

  const buffer = new THREE.Vector2()

  function resize() {
    const width = viewW()
    const height = viewH()
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    // Frame by whichever axis is tighter: a portrait viewport shrinks the
    // horizontal field of view, and a distance chosen for landscape then crops
    // the horns off the sides.
    const vFit = 1.0 / (2 * Math.tan((camera.fov / 2) * (Math.PI / 180)))
    const hFit = vFit / Math.min(1, camera.aspect)
    // Stored rather than applied: the scroll owns the camera distance, and a
    // resize that also set it would fight the scroll for the same value.
    fittedDistance = Math.max(1.35, hFit * distanceScale)
    if (!pinned) camera.position.setLength(fittedDistance)
    camera.lookAt(controls.target)
    renderer.setSize(width, height)
    renderer.getDrawingBufferSize(buffer)
    flames.setSize(buffer.width, buffer.height)
  }
  resize()
  addEventListener('resize', resize)

  let previous = performance.now()
  let frames = 0
  let fpsClock = 0
  let fps = 0

  function step(now: number): number {
    const elapsed = (now - previous) / 1000
    // The fire sim needs a tight clamp so a tab-switch spike cannot blow the
    // advection up. The cursor/scroll smoothing does NOT: clamping it there
    // makes the response frame-rate dependent, and on a throttled tab the mask
    // crawls toward the cursor instead of following it.
    const delta = Math.min(elapsed, 0.05)
    const motionDelta = Math.min(Math.max(elapsed, 0), 0.25)
    previous = now
    frames++
    fpsClock += delta
    if (fpsClock >= 0.5) { fps = frames / fpsClock; frames = 0; fpsClock = 0 }

    if (pinned) {
      // Exponential approach, framerate-corrected: this lag is the inertia.
      const k = 1 - Math.pow(1 - motion.ease, motionDelta * 60)
      currentYaw += (targetYaw - currentYaw) * k
      currentPitch += (targetPitch - currentPitch) * k
      currentProgress += (targetProgress - currentProgress) * k
      model.rotation.set(currentPitch, currentYaw, 0)
      // Scrolling DOWN dollies IN, so the mask grows to cover the frame.
      const eased = currentProgress * currentProgress * (3 - 2 * currentProgress)
      const zoom = 1 + (scrollZoom - 1) * eased
      // Turning alone reads as "the mask rotates"; a little drift reads as "the
      // mask follows". It reuses the already-eased rotation instead of smoothing
      // a second pair of variables, so the two can never fall out of step.
      // Screen displacement is offset/distance, so scaling by zoom keeps the
      // drift visually constant as the camera dollies in.
      const drift = motion.shift * zoom
      const nx = motion.yaw > 0 ? currentYaw / motion.yaw : 0
      const ny = motion.pitch > 0 ? currentPitch / motion.pitch : 0
      model.position.set(
        basePosition.x + nx * drift,
        basePosition.y - ny * drift,
        basePosition.z,
      )
      camera.position.set(0, verticalOffset, fittedDistance * zoom)
      camera.lookAt(controls.target)
    } else {
      controls.update()
    }
    // The fire breathes: the warm light flickers with it.
    const t = now / 1000
    const flicker = 0.86 + 0.14 * (Math.sin(t * 17.3) * 0.5 + Math.sin(t * 29.1 + 1.7) * 0.3 + Math.sin(t * 7.7) * 0.2)
    fireLight.intensity = FIRE_LIGHT_INTENSITY * flicker * flames.u.burn.value

    flames.render(delta)
    return fps
  }

  return {
    renderer, scene, camera, controls, model, flames, motion,
    bufferSize: () => buffer.clone(),
    resize,
    step,
    dispose() {
      removeEventListener('resize', resize)
      removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerout', onPointerOut)
      removeEventListener('scroll', onScroll)
      renderer.setAnimationLoop(null)
      controls.dispose()
      flames.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}
