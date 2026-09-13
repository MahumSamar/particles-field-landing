import { useEffect, useRef } from 'react'
import { createParticleField, type ParticleField, type ParticleFieldOptions } from './scene'

export interface ParticleFieldViewProps extends ParticleFieldOptions {
  className?: string
  style?: React.CSSProperties
  /** Called once the field exists, so callers can reach `setShape`, `stats`, … */
  onReady?: (field: ParticleField) => void
}

/**
 * Thin React wrapper.
 *
 * The scene is created once in an effect and never touched by React again —
 * no state, no re-render per frame. React owns the host element; the field
 * owns everything inside it.
 *
 * In Next.js this must be loaded client-side only:
 *   const Field = dynamic(() => import('./ParticleFieldView'), { ssr: false })
 */
export function ParticleFieldView({ className, style, onReady, ...options }: ParticleFieldViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  // Kept in a ref so changing the callback never tears the scene down.
  const readyRef = useRef(onReady)
  readyRef.current = onReady

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const field = createParticleField(host, options)
    readyRef.current?.(field)
    return () => field.destroy()
    // Intentionally mount-once: rebuilding the scene on every prop change
    // would drop the GPU context. Use the `onReady` handle to mutate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div ref={hostRef} className={className} style={style} />
}
