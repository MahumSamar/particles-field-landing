import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'

const css = readFileSync('src/hero/style.css', 'utf8')
const js = readFileSync('.tmp-menuchi-bundle.js', 'utf8').replace(/<\/script/gi, '<\\/script')

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>menuchi — 面打</title>
  <meta name="description" content="menuchi — a workshop carving masks in the old Japanese manner." />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@300;400&family=Noto+Serif+JP:wght@400;500&display=swap" rel="stylesheet" />
  <link rel="preload" as="image" href="https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd8j0ntlcm91z4.cloudfront.net%2Fuser_3GJaYKPxdnQG0Q9O26lu6DPmcHu%2Fhf_20260911_091755_d10337df-41a1-40eb-b426-ece300e6f5dd.png&w=1920&q=85" />
  <link rel="preload" as="image" href="https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd8j0ntlcm91z4.cloudfront.net%2Fuser_3GJaYKPxdnQG0Q9O26lu6DPmcHu%2Fhf_20260911_091841_01f0c297-6fca-42d6-87fe-da2865d9c364.png&w=1920&q=85" />
  <link rel="preload" as="image" href="https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd8j0ntlcm91z4.cloudfront.net%2Fuser_3GJaYKPxdnQG0Q9O26lu6DPmcHu%2Fhf_20260911_091846_72c99800-57a9-4d39-80c2-7768d8f4d556.png&w=1920&q=85" />
  <link rel="preload" as="image" href="https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd8j0ntlcm91z4.cloudfront.net%2Fuser_3GJaYKPxdnQG0Q9O26lu6DPmcHu%2Fhf_20260911_091854_76cd1a76-8b9d-4003-b289-ed39974c5a1e.png&w=1920&q=85" />
  <style>
${css}
  </style>
</head>
<body>
  <div id="stage" aria-hidden="true"></div>
  <h1 class="sr-only">menuchi — 面打</h1>
  <header class="hero-chrome">
    <button id="menu" class="menu" type="button" aria-label="Open menu" aria-expanded="false">
      <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="3" y="5" width="18" height="2" rx="1" />
        <rect x="3" y="11" width="14" height="2" rx="1" />
        <rect x="3" y="17" width="9" height="2" rx="1" />
      </svg>
    </button>
    <span class="mark" aria-hidden="true">面打</span>
  </header>
  <div id="slides"></div>
  <section id="film" class="film" aria-label="The workshop"></section>
  <p class="lede">
    menuchi carves noh and kagura masks the old way — one block of hinoki, hand
    tools, no moulds. Every face is cut once and never copied.
  </p>
  <div id="unsupported" hidden>
    <h2>WebGPU required</h2>
    <p>This page renders through <code>WebGPURenderer</code>. Your browser did not expose
      <code>navigator.gpu</code>.</p>
    <p class="muted">Chrome or Edge 113+, or Safari 18+ with WebGPU enabled.</p>
  </div>
  <div class="scroll-range" aria-hidden="true"></div>
  <footer id="finale" class="finale" aria-label="Closing"></footer>
  <div class="finale-runway" aria-hidden="true"></div>
  <script type="module">
${js}
  </script>
</body>
</html>
`

writeFileSync('menuchi-standalone.html', html)
try { unlinkSync('.tmp-menuchi-bundle.js') } catch {}
console.log('wrote menuchi-standalone.html', (html.length / 1024 / 1024).toFixed(2), 'MB')
