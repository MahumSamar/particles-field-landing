import * as THREE from 'three'

/**
 * Screen-space "calm" rectangles.
 *
 * Two rounded-box SDFs, evaluated *after* projection, that dim particles
 * sitting behind text. This is the trick that lets type stay legible on top of
 * a live additive particle field without a scrim or a backdrop blur.
 */
const CALM_CHUNK = /* glsl */ `
uniform vec4  uCalmA;
uniform vec4  uCalmB;
uniform float uCalmOn;
uniform float uAspect;
`

const CALM_APPLY = /* glsl */ `
  vec2 sp = gl_Position.xy / max(gl_Position.w, 1e-4);
  sp.x *= uAspect;
  float dCalm = min(
    length(max(abs(sp - uCalmA.xy) - uCalmA.zw, vec2(0.0))),
    length(max(abs(sp - uCalmB.xy) - uCalmB.zw, vec2(0.0)))
  );
  vA *= 1.0 - uCalmOn * 0.7 * (1.0 - smoothstep(0.0, 0.45, dCalm));
`

const VERTEX = /* glsl */ `
attribute vec3  aCol;
attribute float aSize;
attribute float aSoft;
attribute float aPhase;
attribute float aTw;
attribute float aDrift;

uniform float uScale;    // renderer height * 0.5 — keeps sizes resolution-independent
uniform float uTime;
uniform float uMotion;   // 0 kills all idle animation (reduced motion)
uniform float uSizeMul;
uniform float uMinPx;
uniform float uLife;     // 0 = uniform dust, 1 = fully materialised
uniform float uSeedSize; // the size every particle starts at when uLife = 0
uniform float uBurst;    // 0 = intact, 1 = fully dissolved

${CALM_CHUNK}

varying vec3  vCol;
varying float vSoft;
varying float vA;

void main() {
  vCol = aCol;

  // Turbulent wander. Three different frequencies keep it from looking like
  // every particle is riding the same wave.
  vec3 p = position;
  float dr = aDrift * uLife * uMotion;
  p.x += sin(uTime * 0.73 + aPhase) * dr;
  p.y += sin(uTime * 0.61 + aPhase * 1.7) * dr;
  p.z += sin(uTime * 0.51 + aPhase * 2.3) * dr;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float depth = max(-mv.z, 0.1);

  // Materialise: every particle starts as identical fine dust and grows into
  // its own size class. Dissolving grows and softens it further, so the cloud
  // evaporates rather than merely flying apart.
  float size = mix(uSeedSize, aSize, uLife) * (1.0 + uBurst * 0.6);
  vSoft = clamp(mix(aSoft * uLife, 1.0, uBurst * 0.85), 0.0, 1.0);

  // Manual perspective attenuation, clamped so particles never vanish and
  // never blow up into screen-filling quads.
  gl_PointSize = clamp(size * uSizeMul * uScale / depth, uMinPx, uScale * 0.05);

  float tw = 1.0 - aTw * uMotion *
    (0.5 + 0.5 * sin(uTime * (1.4 + fract(aPhase) * 1.3) + aPhase * 6.283));

  float dAtt = clamp((depth - 16.0) / 8.0, 0.0, 1.0);
  vA = tw * mix(1.0, 0.55, dAtt) * smoothstep(0.12, 1.1, depth);

  gl_Position = projectionMatrix * mv;
${CALM_APPLY}
}
`

const FRAGMENT = /* glsl */ `
uniform float uOpacity;

varying vec3  vCol;
varying float vSoft;
varying float vA;

void main() {
  // Procedural sprite — no texture is loaded anywhere in this component.
  vec2 q = gl_PointCoord - vec2(0.5);
  float d2 = dot(q, q) * 4.0;
  if (d2 >= 1.0) discard;

  float inv   = 1.0 - d2;
  float tight = min(1.0, inv * 1.9); // crisp disc with a soft edge
  float soft  = inv * inv;           // wide quadratic glow

  // The whole "blur / bloom" look is this mix, stacked additively. No post pass.
  float a = mix(tight, soft * 0.55, vSoft) * vA * uOpacity;
  if (a < 0.004) discard;

  gl_FragColor = vec4(vCol, a);
}
`

export interface MaterialOptions {
  motion?: boolean
  seedSize?: number
  sizeMultiplier?: number
}

export type FieldMaterial = THREE.ShaderMaterial & {
  uniforms: {
    uScale: { value: number }
    uTime: { value: number }
    uMotion: { value: number }
    uSizeMul: { value: number }
    uMinPx: { value: number }
    uLife: { value: number }
    uSeedSize: { value: number }
    uBurst: { value: number }
    uOpacity: { value: number }
    uAspect: { value: number }
    uCalmA: { value: THREE.Vector4 }
    uCalmB: { value: THREE.Vector4 }
    uCalmOn: { value: number }
  }
}

export function createMaterial(options: MaterialOptions = {}): FieldMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    // Additive blending assumes a dark background. On a light background this
    // needs NormalBlending and a re-thought palette — see the README.
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      uScale: { value: 1 },
      uTime: { value: 0 },
      uMotion: { value: options.motion === false ? 0 : 1 },
      uSizeMul: { value: options.sizeMultiplier ?? 1 },
      uMinPx: { value: 0 },
      uLife: { value: 1 },
      uSeedSize: { value: options.seedSize ?? 0.115 },
      uBurst: { value: 0 },
      uOpacity: { value: 1 },
      uAspect: { value: 1 },
      // Parked far off-screen so the SDF is inert until real rects arrive.
      uCalmA: { value: new THREE.Vector4(99, 99, 0, 0) },
      uCalmB: { value: new THREE.Vector4(99, 99, 0, 0) },
      uCalmOn: { value: 0 },
    },
  }) as FieldMaterial
}
