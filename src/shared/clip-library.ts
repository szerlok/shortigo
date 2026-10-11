import type { ClipArtifact } from './job-output'

export interface FavoriteClip {
  directory: string
  sourceTitle: string
  clip: ClipArtifact
  canEditRange: boolean
  vertical: boolean
}
