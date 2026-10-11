import logoUrl from '../../../../resources/logoshortigo.png'
import { APP_NAME } from '../../../shared/brand'
import { cn } from '../../lib/utils'

interface ShortigoLogoProps {
  variant?: 'lockup' | 'icon' | 'mark'
  /** Size by height (e.g. "h-6"); width follows the artwork. */
  className?: string
  alt?: string
}

export function ShortigoLogo({ variant = 'lockup', className, alt = APP_NAME }: ShortigoLogoProps): React.JSX.Element {
  if (variant === 'lockup') return (
    <span role="img" aria-label={alt} className={cn('inline-flex w-auto shrink-0 select-none items-center gap-1.5', className)}>
      <img src={logoUrl} alt="" draggable={false} className="h-full w-auto object-contain" />
      <span aria-hidden="true" className="text-lg font-semibold tracking-tight text-ink">{APP_NAME}</span>
    </span>
  )
  return (
    <img
      src={logoUrl}
      alt={alt}
      draggable={false}
      className={cn('w-auto shrink-0 select-none', className)}
    />
  )
}
