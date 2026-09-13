import GUI from 'lil-gui'
import * as THREE from 'three/webgpu'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { type Flames } from './flames'
import { type CursorMotion } from './scene'

/**
 * The tuning panel. One definition, used by both the sandbox (always open) and
 * the hero (hidden behind a button), so the two can never drift apart.
 *
 * Pass `cursorMotion` on a pinned scene to get the cursor-follow dials. Its
 * presence also means the camera belongs to the scene, so the orbit controls
 * that would do nothing there are left out rather than shown dead.
 */
export function createFireGui(
  flames: Flames,
  controls: OrbitControls,
  camera: THREE.PerspectiveCamera,
  cursorMotion?: CursorMotion,
): GUI {
  const CAMERA_POSITION = camera.position.clone()
  const CAMERA_TARGET = controls.target.clone()
  // Seeded from the LIVE uniforms, never from literals: a second copy of the
  // defaults here would let the panel display numbers the shader is not using.
  const params = {
    fire: flames.u.burn.value,
    edge: flames.u.edge.value,
    interior: flames.u.interior.value,
    sparks: flames.u.sparks.value,
    rise: flames.u.rise.value,
    swirl: flames.u.swirl.value,
    cool: flames.u.cool.value,
    refract: flames.u.refract.value,
    fireLight: flames.u.fireLight.value,
    exposure: flames.u.exposure.value,
    skinWarm: flames.u.skinWarm.value,
    maskBody: flames.u.maskBody.value,
    rim: flames.u.rim.value,
    bloom: flames.bloomNode.strength.value,
    view: 'Composite' as 'Composite' | 'Silhouette' | 'Heat field' | 'Flame only',
    autoRotate: controls.autoRotate,
  }
  const VIEWS = { Composite: 0, Silhouette: 1, 'Heat field': 2, 'Flame only': 3 }

  const gui = new GUI({ title: 'Fire Mask' })
  if (innerWidth < 512) gui.close()

  const fire = gui.addFolder('Fire')
  fire.add(params, 'fire', 0, 1, 0.01).name('burn').onChange((v: number) => (flames.u.burn.value = v))
  fire.add(params, 'edge', 0, 2, 0.01).name('edge ignition').onChange((v: number) => (flames.u.edge.value = v))
  fire.add(params, 'interior', 0, 2, 0.01).name('interior ignition').onChange((v: number) => (flames.u.interior.value = v))
  fire.add(params, 'sparks', 0, 3, 0.01).onChange((v: number) => (flames.u.sparks.value = v))

  const motion = gui.addFolder('Motion')
  motion.add(params, 'rise', 0, 1.2, 0.01).onChange((v: number) => (flames.u.rise.value = v))
  motion.add(params, 'swirl', 0, 0.6, 0.005).onChange((v: number) => (flames.u.swirl.value = v))
  motion.add(params, 'cool', 0.5, 10, 0.05).onChange((v: number) => (flames.u.cool.value = v))

  const look = gui.addFolder('Look')
  look.add(params, 'exposure', 0, 1.5, 0.01).onChange((v: number) => (flames.u.exposure.value = v))
  look.add(params, 'bloom', 0, 1.5, 0.01).onChange((v: number) => (flames.bloomNode.strength.value = v))
  look.add(params, 'fireLight', 0, 2, 0.01).name('fire lights scene').onChange((v: number) => (flames.u.fireLight.value = v))
  look.add(params, 'refract', 0, 0.05, 0.001).name('heat haze').onChange((v: number) => (flames.u.refract.value = v))
  look.add(params, 'skinWarm', 0, 1, 0.01).name('warm skin').onChange((v: number) => (flames.u.skinWarm.value = v))

  // Hiding the mask itself: the silhouette still drives the heat field, so the
  // flames keep their shape while the body behind them fades out.
  const bodyFolder = gui.addFolder('Mask body')
  bodyFolder
    .add(params, 'maskBody', 0, 1, 0.01)
    .name('mask visibility')
    .onChange((v: number) => (flames.u.maskBody.value = v))
  bodyFolder
    .add(params, 'rim', 0, 2, 0.01)
    .name('burning rim')
    .onChange((v: number) => (flames.u.rim.value = v))
  bodyFolder
    .add({ fireOnly: () => {
      params.maskBody = 0; params.skinWarm = 0; params.rim = 1.0
      flames.u.maskBody.value = 0; flames.u.skinWarm.value = 0; flames.u.rim.value = 1.0
      gui.controllersRecursive().forEach((c) => c.updateDisplay())
    } }, 'fireOnly')
    .name('fire only')
  bodyFolder
    .add({ showMask: () => {
      params.maskBody = 1; params.skinWarm = 1; params.rim = 0.7
      flames.u.maskBody.value = 1; flames.u.skinWarm.value = 1; flames.u.rim.value = 0.7
      gui.controllersRecursive().forEach((c) => c.updateDisplay())
    } }, 'showMask')
    .name('show mask')

  // Bound straight to the live object, so these need no copy to fall out of
  // sync with — the scene reads the same fields every frame.
  if (cursorMotion) {
    const follow = gui.addFolder('Cursor follow')
    follow.add(cursorMotion, 'yaw', 0, 1.2, 0.01).name('turn L/R')
    follow.add(cursorMotion, 'pitch', 0, 1.2, 0.01).name('turn up/down')
    follow.add(cursorMotion, 'shift', 0, 0.3, 0.005).name('drift')
    follow.add(cursorMotion, 'ease', 0.01, 0.3, 0.005).name('weight (low = heavy)')
  }

  gui.add(params, 'view', Object.keys(VIEWS)).name('debug view')
    .onChange((v: keyof typeof VIEWS) => (flames.u.view.value = VIEWS[v]))
  // Both are inert on a pinned scene: orbit is disabled and the camera is
  // placed explicitly every frame, so showing them would be a lie.
  if (!cursorMotion) {
    gui.add(params, 'autoRotate').name('auto rotate').onChange((v: boolean) => (controls.autoRotate = v)).listen()
    gui.add({ reset: () => { camera.position.copy(CAMERA_POSITION); controls.target.copy(CAMERA_TARGET); controls.update() } }, 'reset').name('reset view')
  }
  return gui
}
