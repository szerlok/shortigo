import type { CSSProperties } from 'react'
import { Check } from 'lucide-react'
import { cn } from '../lib/utils'

/**
 * Mirrors the caption presets in engine/clip_engine/config.py closely
 * enough to preview them: typeface, colours, stroke, shadow, glow, pill,
 * plate and karaoke sweep. Shortigo engine renders with its bundled fonts; the preview
 * asks for the same family and falls back to a close system face.
 */
interface CaptionPreset {
  id: string
  name: string
  description: string
  font: string
  weight: number
  italic?: boolean
  size: number
  primary: string
  highlight: string
  stroke: number
  shadow: 'soft' | 'hard' | 'halo' | 'none'
  uppercase: boolean
  /** Rounded pill behind the active word. */
  pill?: string
  /** Blurred bloom around the active word. */
  glow?: string
  /** Translucent plate behind the whole line. */
  plate?: string
  karaoke?: boolean
  /** How unspoken words look. */
  future?: 'show' | 'dim' | 'hide'
  words: [string, string, string]
}

const PRESETS: CaptionPreset[] = [
  {
    id: 'pop',
    name: "Wyrazisty",
    description: "Uniwersalny i czytelny",
    font: '"Montserrat", "Montserrat Black", system-ui, sans-serif',
    weight: 900,
    size: 15,
    primary: '#FFFFFF',
    highlight: '#FFE234',
    stroke: 6,
    shadow: 'soft',
    uppercase: true,
    words: ['to', 'zmienia', 'wszystko']
  },
  {
    id: 'spotlight',
    name: "Reflektor",
    description: "Wyróżnione słowo na etykiecie",
    font: '"Poppins", "Poppins Black", system-ui, sans-serif',
    weight: 900,
    size: 14,
    primary: '#FFFFFF',
    highlight: '#FFFFFF',
    stroke: 5,
    shadow: 'soft',
    uppercase: true,
    pill: '#7C5CFF',
    words: ['oto', 'prawdziwy', 'sekret']
  },
  {
    id: 'impact',
    name: "Mocny",
    description: "Wysokie litery, po dwa słowa",
    font: '"Anton", "Impact", "Arial Narrow", sans-serif',
    weight: 400,
    size: 21,
    primary: '#FFFFFF',
    highlight: '#FFD60A',
    stroke: 7,
    shadow: 'hard',
    uppercase: true,
    future: 'hide',
    words: ['milion', 'nowych', 'wyświetleń']
  },
  {
    id: 'glow',
    name: "Blask",
    description: "Błękitna poświata, technologia i gry",
    font: '"Montserrat", "Montserrat ExtraBold", system-ui, sans-serif',
    weight: 800,
    size: 15,
    primary: '#FFFFFF',
    highlight: '#7DF9FF',
    stroke: 0,
    shadow: 'halo',
    uppercase: true,
    glow: '#00C8FF',
    words: ['czas', 'na', 'awans']
  },
  {
    id: 'boxed',
    name: "Ramka",
    description: "Czytelny na każdym tle",
    font: '"Archivo Black", "Arial Black", system-ui, sans-serif',
    weight: 400,
    size: 13,
    primary: '#FFFFFF',
    highlight: '#FFD23F',
    stroke: 0,
    shadow: 'none',
    uppercase: true,
    plate: 'rgb(0 0 0 / 0.62)',
    words: ['zrób to', 'szybciej', 'dzisiaj']
  },
  {
    id: 'sweep',
    name: "Karaoke",
    description: "Kolor podąża za głosem",
    font: '"Poppins", "Poppins ExtraBold", system-ui, sans-serif',
    weight: 800,
    size: 14,
    primary: '#FFFFFF',
    highlight: '#FF5FA2',
    stroke: 5,
    shadow: 'soft',
    uppercase: true,
    karaoke: true,
    words: ['śpiewaj', 'razem', 'z nami']
  },
  {
    id: 'editorial',
    name: "Opowieść",
    description: "Elegancka kursywa do opowieści",
    font: '"Instrument Serif", "Georgia", serif',
    weight: 400,
    italic: true,
    size: 20,
    primary: '#FFFFFF',
    highlight: '#FFE6B8',
    stroke: 0,
    shadow: 'halo',
    uppercase: false,
    future: 'dim',
    words: ['i właśnie', 'dlatego', 'to działa']
  },
  {
    id: 'hype',
    name: "Energia",
    description: "Mocny obrys i dużo energii",
    font: '"Montserrat", "Montserrat Black", system-ui, sans-serif',
    weight: 900,
    size: 16,
    primary: '#FFFFFF',
    highlight: '#39FF6A',
    stroke: 8,
    shadow: 'hard',
    uppercase: true,
    words: ['działaj', 'właśnie', 'teraz']
  },
  {
    id: 'punch',
    name: "Uderzenie",
    description: "Jedno wielkie słowo naraz",
    font: '"Anton", "Impact", "Arial Narrow", sans-serif',
    weight: 400,
    size: 28,
    primary: '#FFFFFF',
    highlight: '#FFFFFF',
    stroke: 8,
    shadow: 'hard',
    uppercase: true,
    words: ['', 'wow', '']
  },
  {
    id: 'neon',
    name: 'Neon',
    description: "Różowa poświata, muzyka i styl życia",
    font: '"Poppins", "Poppins ExtraBold", system-ui, sans-serif',
    weight: 800,
    size: 14,
    primary: '#FFFFFF',
    highlight: '#FF9CEB',
    stroke: 0,
    shadow: 'halo',
    uppercase: true,
    glow: '#FF2EC4',
    words: ['poczuj', 'ten', 'rytm']
  },
  {
    id: 'headline',
    name: "Wiadomości",
    description: "Słowo na czerwonym pasku",
    font: '"Archivo Black", "Arial Black", system-ui, sans-serif',
    weight: 400,
    size: 13,
    primary: '#FFFFFF',
    highlight: '#FFFFFF',
    stroke: 4,
    shadow: 'soft',
    uppercase: true,
    pill: '#E5202E',
    words: ['właśnie', 'to', 'odkryto']
  },
  {
    id: 'paper',
    name: "Papier",
    description: "Ciemny tekst na białej karcie",
    font: '"Poppins", "Poppins ExtraBold", system-ui, sans-serif',
    weight: 800,
    size: 13,
    primary: '#111111',
    highlight: '#6D28D9',
    stroke: 0,
    shadow: 'none',
    uppercase: false,
    plate: 'rgb(255 255 255 / 0.94)',
    words: ['zobacz', 'jak', 'to działa']
  },
  {
    id: 'subtle',
    name: "Subtelny",
    description: "Delikatny styl do wywiadów i vlogów",
    font: '"Montserrat", "Montserrat ExtraBold", system-ui, sans-serif',
    weight: 800,
    size: 13,
    primary: '#FFFFFF',
    highlight: '#C4F1FF',
    stroke: 0,
    shadow: 'halo',
    uppercase: false,
    future: 'dim',
    words: ['myślę', 'że to', 'uczciwe']
  }
]

/** Display names by preset id, for summaries outside the picker. */
export const CAPTION_PRESET_NAMES: Record<string, string> = Object.fromEntries(PRESETS.map((preset) => [preset.id, preset.name]))

/**
 * Preset `size` and `stroke` are tuned for an 84px-tall preview. The compact
 * tile is 60px tall, so samples render at this fraction to keep the same fit.
 */
const SAMPLE_SCALE = 60 / 84

/** Stroke + shadow as stacked text-shadows, scaled to the tile. */
function textShadow(p: CaptionPreset): string {
  const layers: string[] = []
  const w = p.stroke * 0.28 * SAMPLE_SCALE
  if (w > 0) {
    for (let a = 0; a < 16; a++) {
      const r = (a / 16) * Math.PI * 2
      layers.push(`${(Math.cos(r) * w).toFixed(2)}px ${(Math.sin(r) * w).toFixed(2)}px 0 #000`)
    }
  }
  if (p.shadow === 'soft') layers.push(`0 ${(w + 1.5).toFixed(2)}px 4px rgb(0 0 0 / 0.6)`)
  if (p.shadow === 'hard') layers.push(`0 ${(w + 2.5).toFixed(2)}px 0 rgb(0 0 0 / 0.9)`)
  if (p.shadow === 'halo') layers.push('0 1px 6px rgb(0 0 0 / 0.85)', '0 0 3px rgb(0 0 0 / 0.6)')
  return layers.join(', ') || 'none'
}

function CaptionSample({ preset }: { preset: CaptionPreset }): React.JSX.Element {
  const [before, active, after] = preset.words
  const base: CSSProperties = {
    color: preset.primary,
    fontFamily: preset.font,
    fontWeight: preset.weight,
    fontStyle: preset.italic ? 'italic' : 'normal',
    fontSize: preset.size * SAMPLE_SCALE,
    textShadow: textShadow(preset),
    textTransform: preset.uppercase ? 'uppercase' : 'none'
  }

  let activeWord: React.JSX.Element
  if (preset.karaoke) {
    // Show the sweep mid-word; two spans rather than background-clip:text,
    // which the stroke shadow would paint over.
    const at = Math.ceil(active.length * 0.6)
    activeWord = (
      <span>
        <span style={{ color: preset.highlight }}>{active.slice(0, at)}</span>
        {active.slice(at)}
      </span>
    )
  } else if (preset.pill) {
    activeWord = (
      <span
        style={{ background: preset.pill, color: preset.highlight, textShadow: 'none', borderRadius: 4, padding: '1px 3px' }}
      >
        {active}
      </span>
    )
  } else {
    const bloom = preset.glow ? `, 0 0 4px ${preset.glow}, 0 0 10px ${preset.glow}` : ''
    activeWord = <span style={{ color: preset.highlight, textShadow: `${textShadow(preset)}${bloom}` }}>{active}</span>
  }

  const afterStyle: CSSProperties | undefined =
    preset.future === 'dim' ? { opacity: 0.6 } : preset.future === 'hide' ? { visibility: 'hidden' } : undefined
  // Karaoke: words already swept keep the highlight colour.
  const beforeStyle: CSSProperties | undefined = preset.karaoke ? { color: preset.highlight } : undefined

  const line = (
    <>
      {before && <span style={beforeStyle}>{before} </span>}
      {activeWord}
      {after && <span style={afterStyle}> {after}</span>}
    </>
  )

  return (
    <span className="relative block text-center leading-[1.1]" style={base}>
      {preset.plate ? (
        <span className="inline-block rounded px-1 py-px" style={{ background: preset.plate }}>
          {line}
        </span>
      ) : (
        line
      )}
    </span>
  )
}

/** A stand-in "frame" behind each sample: a flat, dim video-like tone. */
const SCENE = '#14161d'

interface CaptionPresetPickerProps {
  value: string
  onChange: (preset: string) => void
  disabled?: boolean
}

export function CaptionPresetPicker({ value, onChange, disabled }: CaptionPresetPickerProps): React.JSX.Element {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2" role="radiogroup" aria-label="Styl napisów">
      {PRESETS.map((preset) => {
        const selected = value === preset.id
        return (
          <button
            key={preset.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-description={preset.description}
            title={preset.description}
            disabled={disabled}
            onClick={() => onChange(preset.id)}
            className={cn(
              'glass-tile glass-tile-hover group relative rounded-xl p-1 text-left hover:-translate-y-0.5',
              selected && 'glass-selected',
              disabled && 'opacity-50'
            )}
          >
            <span
              className="relative flex h-[60px] items-end justify-center overflow-hidden rounded-lg px-1.5 pb-2.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]"
              style={{ background: SCENE }}
            >
              <CaptionSample preset={preset} />
              {selected && (
                <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-accent-ink shadow-[0_0_0_1px_rgb(var(--accent)/0.6)] animate-pop-in">
                  <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
                </span>
              )}
            </span>
            <span className={cn('block truncate px-1.5 pb-0.5 pt-1.5 text-xs font-semibold', selected ? 'text-ink' : 'text-ink/90')}>
              {preset.name}
            </span>
          </button>
        )
      })}
    </div>
  )
}
