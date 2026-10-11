import { TitlePresetPicker } from './TitlePresetPicker'
import type { TitleOptions } from '../../shared/title'

export const titleInputClass = 'w-full rounded-lg border border-line bg-fill px-3 py-2 text-sm text-ink outline-none focus:border-line-strong'
export function TitleControls({ value, onChange, disabled = false }: { value: TitleOptions; onChange: (v: TitleOptions) => void; disabled?: boolean }): React.JSX.Element {
  const patch = (v: Partial<TitleOptions>): void => onChange({ ...value, ...v })
  return <fieldset disabled={disabled} className="space-y-3 rounded-xl border border-line p-4 disabled:opacity-60">
    <legend className="px-2 text-sm font-semibold text-ink">Tytuł na filmie</legend>
    <TitlePresetPicker value={value} onChange={onChange} disabled={disabled} />
    {value.enabled && <>
      <label className="block text-xs text-ink-muted">Czas wyświetlania
        <select aria-label="Czas wyświetlania" className={titleInputClass} value={value.mode} onChange={e => patch({ mode: e.target.value as TitleOptions['mode'] })}>
          <option value="intro">Na początku</option><option value="all">Cały klip</option><option value="range">Własny zakres</option>
        </select>
      </label>
      {value.mode !== 'all' && <div className="grid grid-cols-2 gap-3">
        {value.mode === 'range' && <label className="text-xs text-ink-muted">Od (sekundy)<input className={titleInputClass} aria-label="Od (sekundy)" type="number" min={0} max={21600} step={0.1} value={value.start} onChange={e => patch({ start: Number(e.target.value) })} /></label>}
        <label className="text-xs text-ink-muted">{value.mode === 'intro' ? 'Przez (sekundy)' : 'Do (sekundy)'}<input className={titleInputClass} aria-label={value.mode === 'intro' ? 'Przez (sekundy)' : 'Do (sekundy)'} type="number" min={0.1} max={21600} step={0.1} value={value.end} onChange={e => patch({ end: Number(e.target.value) })} /></label>
      </div>}
      <label className="block text-xs text-ink-muted">Styl
        <select aria-label="Styl" className={titleInputClass} value={value.style} onChange={e => {
          const style = e.target.value as TitleOptions['style']
          patch({ style, color: style === 'card' ? '#000000' : '#ffffff', background: style === 'card' ? '#ffffff' : '#000000' })
        }}><option value="card">Karta z tłem</option><option value="plain">Sam tekst</option><option value="outline">Tekst z obrysem</option></select>
      </label>
      <div className="flex flex-wrap gap-4">
        <label className="text-xs text-ink-muted">Tekst<input className="mt-1 block h-8 w-14" type="color" value={value.color} onChange={e => patch({ color: e.target.value })} /></label>
        {value.style !== 'plain' && <label className="text-xs text-ink-muted">{value.style === 'outline' ? 'Obrys' : 'Tło'}<input className="mt-1 block h-8 w-14" type="color" value={value.background} onChange={e => patch({ background: e.target.value })} /></label>}
        {value.style === 'card' && <label className="text-xs text-ink-muted">Krycie tła: {Math.round(value.opacity * 100)}%<input className="mt-2 block" type="range" min={0} max={1} step={0.05} value={value.opacity} onChange={e => patch({ opacity: Number(e.target.value) })} /></label>}
      </div>
      <label className="block text-xs text-ink-muted">Rozmiar: {value.size}<input className="mt-2 block w-full" type="range" min={20} max={100} step={1} value={value.size} onChange={e => patch({ size: Number(e.target.value) })} /></label>
      <label className="block text-xs text-ink-muted">Pozycja
        <select aria-label="Pozycja" className={titleInputClass} value={value.position} onChange={e => patch({ position: e.target.value as TitleOptions['position'] })}><option value="auto">U góry — automatyczny margines</option><option value="manual">Własna wysokość</option></select>
      </label>
      {value.position === 'manual' && <label className="block text-xs text-ink-muted">Od góry: {value.y}%<input className="mt-2 block w-full" type="range" min={0} max={90} value={value.y} onChange={e => patch({ y: Number(e.target.value) })} /></label>}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.fade} onChange={e => patch({ fade: e.target.checked })} />Łagodne wejście i wyjście</label>
    </>}
    <p className="text-xs text-ink-muted">Napisy dialogowe mają osobne ustawienia. Tekst tytułu możesz zmienić przy gotowym klipie.</p>
  </fieldset>
}
