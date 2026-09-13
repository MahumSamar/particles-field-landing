/**
 * Model review harness — the rig the img2threejs gates run against.
 *
 * Deliberately plain: the factory's Group on the reference's own light-grey
 * seamless background, matte clay, even studio light. Rendering the model
 * inside the fire page would score a fire-lit, bloom-hazed mask against a clay
 * reference — every gate number would be noise.
 *
 * Deterministic camera from the query string:  ?az=90&el=0&fov=32&dist=2.6
 * Mesh export for the self-intersection gate:  window.dumpMeshes()
 */
import * as THREE from 'three'
import { createHannyaMaskModel } from '../fire/model/createHannyaMaskModel'

const params = new URLSearchParams(location.search)
const az = Number(params.get('az') ?? 0) * (Math.PI / 180)
const el = Number(params.get('el') ?? 0) * (Math.PI / 180)
const fov = Number(params.get('fov') ?? 32)
const dist = Number(params.get('dist') ?? 2.7)

// A hidden browser pane reports innerWidth/innerHeight as 0. Left unclamped that
// gives a zero-size drawing buffer, an aspect of NaN, and every readback throws —
// the same collapsed-viewport trap the particle page hit. Clamp once, here.
const viewW = () => Math.max(640, innerWidth || 0)
const viewH = () => Math.max(538, innerHeight || 0)

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(viewW(), viewH())
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0xe8e8e8)

// The reference sheet's own lighting: soft top-left key, high fill, faint rim.
const key = new THREE.DirectionalLight(0xffffff, 2.4)
key.position.set(-1.4, 3.0, 2.2)
const fill = new THREE.HemisphereLight(0xeaeaea, 0xb8b8b8, 1.1)
const rim = new THREE.DirectionalLight(0xf5f5f5, 0.5)
rim.position.set(0.8, 1.2, -3.6)
scene.add(key, fill, rim)

const model = createHannyaMaskModel()

// ?plain=1 — override every material with untextured matte grey. This is the
// map-stripped render the Tier 1 gate requires as evidence.
if (params.get('plain') === '1') {
  const plain = new THREE.MeshStandardMaterial({ color: 0xb9b6b2, roughness: 0.9, metalness: 0 })
  model.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.isMesh) mesh.material = plain
  })
}
scene.add(model)

// Normalise: fit the model into a ~1.5-unit box centred at the origin so every
// camera preset frames it identically whatever units the factory used.
{
  const box = new THREE.Box3().setFromObject(model)
  const size = new THREE.Vector3()
  const centre = new THREE.Vector3()
  box.getSize(size)
  box.getCenter(centre)
  const s = 1.5 / Math.max(size.x, size.y, size.z, 1e-6)
  model.scale.setScalar(s)
  model.position.sub(centre.multiplyScalar(s))
}

// The reference photographs the hollow mask with its cavity in shadow, so the
// through-cut eye/mouth apertures read DARK. Without this, the harness shows
// bright background through the same holes and every silhouette comparison
// counts the apertures against us. A lighting condition, not geometry.
// Placed INSIDE the shell cavity, so it can never extend past the mask
// silhouette — it is the shadowed interior, visible only through the cuts.
const backdrop = new THREE.Mesh(
  new THREE.CircleGeometry(0.42, 48),
  new THREE.MeshBasicMaterial({ color: 0x1c1a19 }),
)
backdrop.scale.y = 1.15
backdrop.position.set(0, -0.06, -0.10)
backdrop.name = '__cavity-backdrop'
model.add(backdrop)

const camera = new THREE.PerspectiveCamera(fov, viewW() / viewH(), 0.01, 50)
camera.position.set(
  Math.sin(az) * Math.cos(el) * dist,
  Math.sin(el) * dist,
  Math.cos(az) * Math.cos(el) * dist,
)
camera.lookAt(0, 0, 0)

// Frame the subject the way the reference sheet frames it. The Divine Eye
// gates `scaleDelta` — the subject's share of the frame — so a harness that
// frames differently reports a model defect that is really a camera defect.
// Measured on refs/views/front.png: the subject occupies 0.965 of frame height.
{
  const box = new THREE.Box3().setFromObject(model)
  const size = new THREE.Vector3(); box.getSize(size)
  const visibleHeightAtDist = 2 * Math.tan((fov / 2) * (Math.PI / 180)) * dist
  model.scale.multiplyScalar(visibleHeightAtDist / (size.y / 0.965))
  model.position.set(0, 0, 0)
  model.updateMatrixWorld(true)
  const b2 = new THREE.Box3().setFromObject(model)
  const c2 = new THREE.Vector3(); b2.getCenter(c2)
  model.position.set(-c2.x, -c2.y, -c2.z)
}

/** Measure the drawn silhouette and correct the framing to hit the target
 *  exactly. A 3D bbox is not the projected height under perspective, and the
 *  gate compares projected fractions — so calibrate on pixels, not on maths. */
function calibrateFraming(targetHeightFraction = 0.965, passes = 3) {
  const probe = document.createElement('canvas')
  for (let i = 0; i < passes; i++) {
    renderer.render(scene, camera)
    // A hidden pane reports innerWidth/innerHeight 0, which would make this
    // probe a zero-size canvas and throw. Measure the drawing buffer, clamped.
    const buf = renderer.getDrawingBufferSize(new THREE.Vector2())
    const bw = Math.max(1, buf.x), bh = Math.max(1, buf.y)
    const w = 260, h = Math.max(2, Math.round(260 * bh / bw))
    probe.width = w; probe.height = h
    const ctx = probe.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(renderer.domElement, 0, 0, w, h)
    const px = ctx.getImageData(0, 0, w, h).data
    let y0 = h, y1 = -1, x0 = w, x1 = -1
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4] < 200) {
        if (y < y0) y0 = y; if (y > y1) y1 = y
        if (x < x0) x0 = x; if (x > x1) x1 = x
      }
    }
    if (y1 < 0) return
    const frac = (y1 - y0 + 1) / h
    const err = targetHeightFraction / frac
    if (Math.abs(err - 1) < 0.004) break
    model.scale.multiplyScalar(err)
    model.position.set(0, 0, 0)
    model.updateMatrixWorld(true)
    const b3 = new THREE.Box3().setFromObject(model)
    const c3 = new THREE.Vector3(); b3.getCenter(c3)
    model.position.set(-c3.x, -c3.y, -c3.z)
  }
}
calibrateFraming()

renderer.render(scene, camera)

declare global {
  interface Window {
    dumpMeshes: () => { id: string; name: string; vertices: number[][]; indices: number[]; normals: number[][] }[]
    renderAt: (azDeg: number, elDeg: number) => void
    __ready: boolean
  }
}

/** {vertices, indices} per mesh, world-space — feeds self_intersection.py. */
window.dumpMeshes = () => {
  const out: { id: string; name: string; vertices: number[][]; indices: number[]; normals: number[][] }[] = []
  model.updateWorldMatrix(true, true)
  model.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    if (mesh.name === '__cavity-backdrop') return // harness prop, not the model
    const geo = mesh.geometry as THREE.BufferGeometry
    const pos = geo.getAttribute('position')
    if (!pos) return
    const v = new THREE.Vector3()
    const vertices: number[][] = []
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
      vertices.push([v.x, v.y, v.z])
    }
    let indices: number[]
    if (geo.index) indices = Array.from(geo.index.array as ArrayLike<number>)
    else indices = Array.from({ length: pos.count }, (_, i) => i)
    // Real vertex normals, rotated into world space. Without them the
    // self-intersection gate falls back to centroid-outward, which is wrong
    // for every inner surface of a hollow shell or tube and floods the
    // report with false positives (measured: 618 phantom hits).
    if (!geo.getAttribute('normal')) geo.computeVertexNormals()
    const nrm = geo.getAttribute('normal')!
    const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)
    const n = new THREE.Vector3()
    const normals: number[][] = []
    for (let i = 0; i < nrm.count; i++) {
      n.fromBufferAttribute(nrm as THREE.BufferAttribute, i).applyMatrix3(nm).normalize()
      normals.push([n.x, n.y, n.z])
    }
    out.push({ id: mesh.name || mesh.uuid, name: mesh.name || mesh.uuid, vertices, indices, normals })
  })
  return out
}

window.renderAt = (azDeg: number, elDeg: number) => {
  const a = azDeg * (Math.PI / 180)
  const e = elDeg * (Math.PI / 180)
  camera.position.set(
    Math.sin(a) * Math.cos(e) * dist,
    Math.sin(e) * dist,
    Math.cos(a) * Math.cos(e) * dist,
  )
  camera.lookAt(0, 0, 0)
  renderer.render(scene, camera)
}

addEventListener('resize', () => {
  camera.aspect = viewW() / viewH()
  camera.updateProjectionMatrix()
  renderer.setSize(viewW(), viewH())
  renderer.render(scene, camera)
})

/** Render every review viewpoint and save it through the dev endpoint. */
;(window as unknown as { captureViews: (w?: number) => Promise<string[]> }).captureViews =
  async (w = 900) => {
    const views: [string, number, number][] = [
      ['front', 0, 0], ['three-quarter', 35, 6], ['profile', 90, 0],
      ['rear', 205, 4], ['below', 0, -28], ['top', 0, 62],
      ['right', 90, 0], ['rear180', 180, 0], ['left', 270, 0],
    ]
    const saved: string[] = []
    const prevW = viewW(), prevH = viewH()
    renderer.setSize(w, Math.round(w * 0.84))
    camera.aspect = w / Math.round(w * 0.84)
    camera.updateProjectionMatrix()
    for (const [name, a, e] of views) {
      window.renderAt(a, e)
      const dataURL = renderer.domElement.toDataURL('image/png')
      const res = await fetch('/__save', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, dataURL }),
      }).then((r) => r.json())
      if (res.ok) saved.push(name)
    }
    renderer.setSize(prevW, prevH)
    camera.aspect = prevW / prevH
    camera.updateProjectionMatrix()
    window.renderAt(0, 0)
    return saved
  }

window.__ready = true
