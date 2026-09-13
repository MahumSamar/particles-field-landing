import { createFireScene, isWebGPUAvailable } from './scene'
import { createFireGui } from './gui'

// A blank canvas is the worst possible failure here, so say what is missing.
if (!isWebGPUAvailable()) {
  document.getElementById('unsupported')!.hidden = false
  throw new Error('WebGPU unavailable')
}

const statsEl = document.getElementById('stats')!
const VIEWS = ['Composite', 'Silhouette', 'Heat field', 'Flame only']

const fire = await createFireScene(document.getElementById('stage')!)
createFireGui(fire.flames, fire.controls, fire.camera)

fire.renderer.setAnimationLoop(() => {
  const fps = fire.step(performance.now())
  statsEl.textContent =
    `${fps.toFixed(0).padStart(3)} fps\n` +
    `${VIEWS[fire.flames.u.view.value] ?? 'Composite'}\n` +
    `burn ${fire.flames.u.burn.value.toFixed(2)}`
})

// Handy from the console and for headless checks.
Object.assign(window as unknown as Record<string, unknown>, {
  flames: fire.flames, controls: fire.controls, camera: fire.camera,
  renderer: fire.renderer, scene: fire.scene,
})
