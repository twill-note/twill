import { useCallback, useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react'

/**
 * A click that opened a modal can occasionally be followed by a synthetic or
 * hardware-generated repeat click on Windows. Once the modal covers the
 * opener, that repeat lands on the backdrop and immediately closes it.
 *
 * Keep backdrop dismissal unavailable for the first fraction of a second and
 * only accept clicks whose actual target is the backdrop itself.
 */
export function useBackdropDismiss<T extends HTMLElement>(
  onDismiss: () => void,
  activationKey: unknown = true,
  guardMs = 350,
) {
  const activatedAtRef = useRef(Date.now())

  useLayoutEffect(() => {
    activatedAtRef.current = Date.now()
  }, [activationKey])

  return useCallback(
    (event: ReactMouseEvent<T>) => {
      if (event.target !== event.currentTarget) return
      if (Date.now() - activatedAtRef.current < guardMs) return
      onDismiss()
    },
    [guardMs, onDismiss],
  )
}

/** A double-click emits two click events; toggle controls should act once. */
export function isRepeatedClick(event: ReactMouseEvent<HTMLElement>): boolean {
  return event.detail > 1
}
