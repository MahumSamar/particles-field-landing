/**
 * The four element masks, one per slide. This is the single place content
 * lives: swap `textureUrl` here when the real texture renders arrive — nothing
 * else needs touching.
 *
 * `background` colours are sampled from the design frames in
 * higg-assets/фреймы (218/218 edge samples agreed on each); fire matches the
 * #910A0A in the Figma CSS, which is what validates the sampling.
 */
export interface MaskSlide {
  key: 'fire' | 'water' | 'earth' | 'air'
  /** Heading, line one — the mask's name. */
  name: string
  /** Heading, line two — the element, in plain words. */
  epithet: string
  /** Catalogue number, mid-left. */
  id: string
  /** Bottom-left description. */
  description: string
  /** Solid colour field behind the mask. */
  background: string
  /** Transparent PNG, 2048×1143, loaded straight from the CDN. */
  maskUrl: string
  /** Bottom-right chip: the element's texture render. */
  textureUrl: string
}

const CDN = 'https://d8j0ntlcm91z4.cloudfront.net/user_3GJaYKPxdnQG0Q9O26lu6DPmcHu'

/**
 * Everything goes through the resizing proxy as webp. It preserves the alpha
 * channel the cut-outs depend on, and the saving is not marginal: the fire mask
 * is 1.44 MB as raw PNG and 115 KB at w=1920. Four masks go from 6.4 MB to
 * about half a megabyte — which matters now that a 15 MB video shares the page.
 */
export const cdnImage = (file: string, w = 1920) =>
  `https://images.higgs.ai/?default=1&output=webp&url=${encodeURIComponent(`${CDN}/${file}`)}&w=${w}&q=85`

const FIRE_MASK = cdnImage('hf_20260911_091755_d10337df-41a1-40eb-b426-ece300e6f5dd.png')
const WATER_MASK = cdnImage('hf_20260911_091841_01f0c297-6fca-42d6-87fe-da2865d9c364.png')
const EARTH_MASK = cdnImage('hf_20260911_091846_72c99800-57a9-4d39-80c2-7768d8f4d556.png')
const AIR_MASK = cdnImage('hf_20260911_091854_76cd1a76-8b9d-4003-b289-ed39974c5a1e.png')

/** The bottom-right chips are 229×128 on screen; they never need 1920px. */
const FIRE_TEX = cdnImage('hf_20260911_125735_c678d64c-22c1-4154-9500-412db0c453d8.png', 720)
const WATER_TEX = cdnImage('hf_20260911_125838_cc288409-3b05-40ad-9466-3c207a38a9f7.png', 720)
const EARTH_TEX = cdnImage('hf_20260911_130330_8d67c81e-7527-494e-87fc-cc9b6cdaac3a.png', 720)
const AIR_TEX = cdnImage('hf_20260911_130337_c65bbd62-a91b-4cbd-b9ea-1ab4a4ec969b.png', 720)

/** The craftsman clip behind the video section. 8.0s, h264, no audio track. */
export const CRAFT_VIDEO = `${CDN}/hf_20260911_125451_34d10d8e-e829-4dde-84bd-fd77156a4005.mp4`

export const MASKS: MaskSlide[] = [
  {
    key: 'fire',
    name: 'Homura',
    epithet: 'mask of fire',
    id: '131-234-2',
    description:
      'Black hinoki under red urushi. The burn lines are carved first, gilded, ' +
      'then lacquered over — the glow sits under the skin, not on it. Danced ' +
      'once a year, at the closing of the summer fire rite.',
    background: '#910A0A',
    maskUrl: FIRE_MASK,
    textureUrl: FIRE_TEX,
  },
  {
    key: 'water',
    name: 'Ōnami',
    epithet: 'mask of water',
    id: '131-234-3',
    description:
      'The Great Wave runs horn to jaw, brushed in gosu blue under a clear ' +
      'porcelain glaze. Gold marks where the crest breaks. Cold to the touch, ' +
      'even in July.',
    background: '#0B142D',
    maskUrl: WATER_MASK,
    textureUrl: WATER_TEX,
  },
  {
    key: 'earth',
    name: 'Yamahada',
    epithet: 'mask of earth',
    id: '131-234-4',
    description:
      'No lacquer. The grain stays open, mountain ridges cut into the brow, ' +
      'copper seams set the kintsugi way. Moss takes root where the horns meet ' +
      'the skull. Meant to age, not to shine.',
    background: '#403C1A',
    maskUrl: EARTH_MASK,
    textureUrl: EARTH_TEX,
  },
  {
    key: 'air',
    name: 'Shirakumo',
    epithet: 'mask of air',
    id: '131-234-5',
    description:
      'Bleached hinoki polished down to bone. Cloud spirals chased in silver, ' +
      'a breath of gold on lips and lids. The lightest mask in the set — it ' +
      'moves before the dancer does.',
    background: '#070707',
    maskUrl: AIR_MASK,
    textureUrl: AIR_TEX,
  },
]
