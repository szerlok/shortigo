import type { TitleOptions } from '../../shared/title'
import { applyTitlePreset } from '../../shared/title-presets'
import { create } from 'zustand'

// Start with the requested enabled default, then remember subsequent opt-outs.
const HESITATIONS_STORAGE_KEY = 'bridgeclip.remove-hesitations.v2'
function savedHesitationPreference(): boolean {
  try { return localStorage.getItem(HESITATIONS_STORAGE_KEY) !== '0' }
  catch { return true }
}

/** The Create wizard's steps, in order. */
export type WizardStep = 'video' | 'format' | 'clips' | 'captions' | 'review'

/** The run the wizard just queued, shown as a confirmation until the next video. */
export interface StartedJob {
  jobId: string
  source: string
  /** True when every slot was busy and the job is waiting its turn. */
  queued: boolean
}

/**
 * The Create form, kept outside the component so the chosen video and options
 * survive navigating away (e.g. to Settings to add a key) and a failed run.
 */
export interface ClipDraft {
  source: string
  aspectRatio: '9:16' | '16:9'
  /** 9:16 framing: smart per-shot layouts, always full frame, or letterbox. */
  layoutStyle: 'auto' | 'fill' | 'fit'
  /** Paid vision verification for ambiguous shots in Smart framing. */
  layoutVision: boolean
  /** tight: cut dead air and filler words; natural: original timing. */
  pacing: 'tight' | 'natural'
  retainSource: boolean
  removeHesitations: boolean
  backgroundMusic: boolean
  strongerHook: boolean
  durations: string[]
  autoClipCount: boolean
  maxClips: number
  includeCaptions: boolean
  captionPreset: string
  titleOptions: TitleOptions
  trimOpen: boolean
  trimStart: string
  trimEnd: string
}

interface DraftState extends ClipDraft {
  step: WizardStep
  started: StartedJob | null
  update: (patch: Partial<ClipDraft>) => void
  setStep: (step: WizardStep) => void
  clearSource: () => void
  /** The job was queued: show the confirmation. */
  markStarted: (started: StartedJob) => void
  /** Back to the first step for the next video, keeping every other choice. */
  startAnother: () => void
}

export const useDraftStore = create<DraftState>((set) => ({
  source: '',
  aspectRatio: '9:16',
  layoutStyle: 'auto',
  layoutVision: true,
  pacing: 'tight',
  retainSource: true,
  removeHesitations: savedHesitationPreference(),
  backgroundMusic: false,
  strongerHook: true,
  durations: ['short'],
  autoClipCount: true,
  maxClips: 5,
  includeCaptions: true,
  captionPreset: 'spotlight',
  titleOptions: applyTitlePreset('violet'),
  trimOpen: true,
  trimStart: '',
  trimEnd: '',
  step: 'video',
  started: null,
  update: (patch) => {
    if (typeof patch.removeHesitations === 'boolean') {
      try { localStorage.setItem(HESITATIONS_STORAGE_KEY, patch.removeHesitations ? '1' : '0') }
      catch { /* The choice still applies to the current session. */ }
    }
    set(patch)
  },
  setStep: (step) => set({ step }),
  clearSource: () => set({ source: '', trimStart: '', trimEnd: '' }),
  markStarted: (started) => set({ started }),
  startAnother: () => set({ source: '', trimOpen: true, trimStart: '', trimEnd: '', step: 'video', started: null })
}))
