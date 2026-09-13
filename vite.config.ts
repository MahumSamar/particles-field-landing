import { defineConfig, type Plugin } from 'vite'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'

const root = fileURLToPath(new URL('.', import.meta.url))

/**
 * Dev-only capture endpoint: the model harness POSTs canvas PNGs here so the
 * img2threejs review gates (turntable, diagnose, comparison sheets) can run on
 * real files. POST /__save {name, dataURL} → .img2threejs/renders/<name>.png
 */
function captureEndpoint(): Plugin {
  return {
    name: 'capture-endpoint',
    configureServer(server) {
      server.middlewares.use('/__save', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          try {
            const { name, dataURL } = JSON.parse(body)
            if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error('bad name')
            const dir = resolve(root, '.img2threejs/renders')
            mkdirSync(dir, { recursive: true })
            if (dataURL !== undefined) {
              const b64 = String(dataURL).replace(/^data:image\/png;base64,/, '')
              writeFileSync(resolve(dir, `${name}.png`), Buffer.from(b64, 'base64'))
            } else {
              // No dataURL: treat the body's `json` field as a payload to persist
              // (mesh dumps for the self-intersection gate).
              const { json } = JSON.parse(body)
              writeFileSync(resolve(dir, `${name}.json`), JSON.stringify(json))
            }
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: true, name }))
          } catch (e) {
            res.statusCode = 400
            res.end(JSON.stringify({ ok: false, error: String(e) }))
          }
        })
      })
    },
  }
}

export default defineConfig({
  server: { port: 5173, host: '127.0.0.1' },
  plugins: [captureEndpoint()],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        fire: resolve(root, 'fire.html'),
        model: resolve(root, 'model.html'),
        hero: resolve(root, 'hero.html'),
      },
    },
  },
})
