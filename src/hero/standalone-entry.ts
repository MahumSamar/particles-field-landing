import Lenis from 'lenis'
import { createFireScene, isWebGPUAvailable } from '../fire/scene'
import { createTitleLayer, waitForFonts } from './title'
import { setScrollSource, subscribe } from '../particles/frameBus'
import { mountSections } from './sections'
import { mountFilm } from './videoSection'
import { mountFinale } from './finale'

if (!isWebGPUAvailable()) {
  const el = document.getElementById('unsupported')
  if (el) el.hidden = false
  throw new Error('WebGPU unavailable')
}

const TITLE = 'menuchi'
const TITLE_FACE = "'Inter Tight', Inter, system-ui, sans-serif"

const fire = await createFireScene(document.getElementById('stage')!, {
  verticalOffset: 0.16,
  distanceScale: 1.72,
  pinned: true,
})

const title = createTitleLayer({ text: TITLE, family: TITLE_FACE })

function paintTitle() {
  const buffer = fire.bufferSize()
  title.resize(buffer.width, buffer.height)
  fire.flames.setTitleTexture(title.texture)
}

paintTitle()
waitForFonts([`400 320px ${TITLE_FACE}`, '500 96px "Noto Serif JP"']).then(() => paintTitle())

const baseResize = fire.resize
addEventListener('resize', () => { baseResize(); paintTitle() })

const menu = document.getElementById('menu') as HTMLButtonElement | null
menu?.addEventListener('click', () => {
  const expanded = menu.getAttribute('aria-expanded') === 'true'
  menu.setAttribute('aria-expanded', String(!expanded))
})

const lenis = new Lenis()
setScrollSource(() => lenis.scroll)
subscribe((state) => lenis.raf(state.time * 1000))

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
