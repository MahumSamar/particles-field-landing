import * as THREE from 'three/webgpu'
import Lenis from 'lenis'
import { createFireScene, isWebGPUAvailable } from '../fire/scene'
import { createFireGui } from '../fire/gui'
import { createTitleLayer, waitForFonts } from './title'
import { setScrollSource, subscribe } from '../particles/frameBus'
import { mountSections } from './sections'
import { mountFilm } from './videoSection'
import { mountFinale } from './finale'

if (!isWebGPUAvailable()) {
  document.getElementById('unsupported')!.hidden = false
  throw new Error('WebGPU unavailable')
}

const TITLE = 'menuchi'
const TITLE_FACE = "'Inter Tight', Inter, system-ui, sans-serif"

// The mask sits high in the frame so its jaw crosses the title, and a little
// further back than in the sandbox so the type has room to run.
const fire = await createFireScene(document.getElementById('stage')!, {
  verticalOffset: 0.16,
  distanceScale: 1.72,
  // Pinned dead centre: motion comes from the cursor and the scroll only.
  pinned: true,
})

// --- Title behind the mask ------------------------------------------------
const title = createTitleLayer({ text: TITLE, family: TITLE_FACE })

/** Redraw at the current drawing-buffer size and hand the texture over. */
function paintTitle() {
  const buffer = fire.bufferSize()
  const size = title.resize(buffer.width, buffer.height)
  fire.flames.setTitleTexture(title.texture)
  return size
}

// Drawing before the webfont resolves would bake a fallback into the texture
// permanently, so wait for the exact faces first and paint twice: once for an
// immediate layout, once when the real font has landed.
const fontsReady = waitForFonts([`400 320px ${TITLE_FACE}`, '500 96px "Noto Serif JP"'])
paintTitle()
fontsReady.then((ok) => {
  paintTitle()
  Object.assign(window as unknown as Record<string, unknown>, { __fontsLoaded: ok })
})

const baseResize = fire.resize
addEventListener('resize', () => { baseResize(); paintTitle() })

// --- Chrome ---------------------------------------------------------------
const gui = createFireGui(fire.flames, fire.controls, fire.camera, fire.motion)
gui.domElement.classList.add('hidden')
gui.close()

// The burger doubles as the fire-panel toggle until real navigation exists —
// the panel is a dev control and does not deserve its own chrome.
const menu = document.getElementById('menu') as HTMLButtonElement
menu.addEventListener('click', () => {
  const showing = gui.domElement.classList.toggle('hidden')
  menu.setAttribute('aria-expanded', String(!showing))
  if (!showing) gui.open()
})

// --- Scroll + element slides ----------------------------------------------
// Lenis eases the native scroll itself (wheel → eased scrollTo), so the fire
// scene's raw scrollY listener and the frame bus read the SAME eased value —
// nothing under src/fire changes. Its raf rides the shared frame bus, which
// never pauses, unlike the WebGPU loop below.
const lenis = new Lenis()
setScrollSource(() => lenis.scroll)
subscribe((state) => lenis.raf(state.time * 1000))

// The fire keeps burning behind a fully opaque slide unless told to stop.
const stage = document.getElementById('stage')!
const heroLoop = () => { fire.step(performance.now()) }
let heroLive = false
function setHeroLive(on: boolean) {
  if (on === heroLive) return
  heroLive = on
  fire.renderer.setAnimationLoop(on ? heroLoop : null)
  stage.style.visibility = on ? 'visible' : 'hidden'
}
setHeroLive(true)
mountSections((covered) => setHeroLive(!covered))
mountFilm()
mountFinale()

Object.assign(window as unknown as Record<string, unknown>, {
  flames: fire.flames, controls: fire.controls, camera: fire.camera,
  renderer: fire.renderer, scene: fire.scene,
  model: fire.model, motion: fire.motion,
  paintTitle, titleTexture: title.texture, THREE,
})
