import { Check } from 'lucide-react'
import { TITLE_PRESETS, applyTitlePreset, selectedTitlePreset } from '../../shared/title-presets'
import type { TitleOptions } from '../../shared/title'
import { cn } from '../lib/utils'
import { onRadioKeyDown } from './ui/Segmented'
import { Switch } from './ui/Switch'

export function TitlePresetPicker({ value, onChange, disabled = false, creation = false }: { creation?: boolean; value: TitleOptions; onChange: (v: TitleOptions) => void; disabled?: boolean }): React.JSX.Element {
  const selectedId = selectedTitlePreset(value)
  return <section className="space-y-3" aria-label="Gotowe style tytułu">
    <div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold">Tytuł na filmie</h3><p className="mt-1 text-xs text-ink-muted">Wybierz jeden z 10 gotowych stylów.</p></div><Switch label="Wyświetlaj tytuł" disabled={disabled} checked={value.enabled} onChange={enabled => onChange({ ...value, enabled })} /></div>
    <div role="radiogroup" aria-label="Styl tytułu" className={cn('grid gap-2', creation ? 'grid-cols-2 sm:grid-cols-5' : 'grid-cols-2 xl:grid-cols-3')}>
      {TITLE_PRESETS.map((preset, index) => {
        const selected = selectedId === preset.id
        const v = preset.visual
        const outline = v.style === 'outline' ? `1px 0 ${v.background}, -1px 0 ${v.background}, 0 1px ${v.background}, 0 -1px ${v.background}, 1px 1px ${v.background}, -1px -1px ${v.background}` : 'none'
        return <button type="button" key={preset.id} role="radio" aria-label={preset.name} aria-checked={selected} aria-description={preset.description}
          title={preset.description} tabIndex={selected || (!selectedId && index === 0) ? 0 : -1} disabled={disabled || !value.enabled} onKeyDown={onRadioKeyDown}
          onClick={() => onChange(applyTitlePreset(preset.id, value))}
          className={cn('glass-tile glass-tile-hover relative rounded-xl p-1 text-left hover:-translate-y-0.5 disabled:opacity-40', selected && 'glass-selected')}>
          <span className="flex h-20 items-center justify-center overflow-hidden rounded-lg px-2" style={{ background: 'linear-gradient(145deg, #23364a, #10141f)' }}>
            <span className="max-w-full px-2 py-1 text-center leading-tight" style={{ fontFamily: `Title${v.font[0].toUpperCase()}${v.font.slice(1)}`, fontSize: v.size * .29, color: v.color, background: v.style === 'card' ? `${v.background}${Math.round(v.opacity * 255).toString(16).padStart(2, '0')}` : 'transparent', borderRadius: v.radius * .29, textTransform: v.uppercase ? 'uppercase' : 'none', textShadow: outline }}>Twój tytuł</span>
            {selected && <span className="absolute right-2 top-2 rounded-full bg-accent p-0.5 text-accent-ink"><Check className="h-3 w-3" /></span>}
          </span><span className="block px-1.5 py-1.5 text-xs font-semibold">{preset.name}</span>
        </button>
      })}
    </div>
    {!selectedId && <p className="text-xs text-ink-muted">Obecny wygląd jest niestandardowy. Wybierz kafelek, aby zastosować gotowy styl.</p>}
    <p className="text-xs text-ink-muted">{creation ? 'Tekst, czas i pozycję zmienisz później przy gotowym klipie.' : 'Zmiana stylu zachowuje tekst, czas i pozycję tytułu.'}</p>
  </section>
}
