import { useEffect, useRef } from 'react'

type ResizeDirection = 'north' | 'south' | 'east' | 'west' |
  'north-east' | 'north-west' | 'south-east' | 'south-west'

const directions: ResizeDirection[] = [
  'north',
  'south',
  'east',
  'west',
  'north-east',
  'north-west',
  'south-east',
  'south-west',
]

export default function DesktopResizeHandles({ disabled }: { disabled: boolean }) {
  const desktop = window.noteDesktop
  const nativeResize = desktop?.platform === 'win32'
  const activePointerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!desktop || nativeResize || !disabled || activePointerRef.current === null) return
    activePointerRef.current = null
    desktop.windowControls.endResize()
  }, [desktop, disabled, nativeResize])

  useEffect(() => {
    if (!desktop || nativeResize) return
    const finish = (event: PointerEvent) => {
      if (activePointerRef.current === null) return
      activePointerRef.current = null
      desktop.windowControls.endResize({ x: event.clientX, y: event.clientY })
    }
    const cancel = () => {
      if (activePointerRef.current === null) return
      activePointerRef.current = null
      desktop.windowControls.endResize()
    }
    window.addEventListener('pointerup', finish, true)
    window.addEventListener('pointercancel', finish, true)
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('pointerup', finish, true)
      window.removeEventListener('pointercancel', finish, true)
      window.removeEventListener('blur', cancel)
      cancel()
    }
  }, [desktop, nativeResize])

  if (!desktop || nativeResize || disabled) return null

  return directions.map((direction) => (
    <div
      key={direction}
      className={`desktop-resize-handle desktop-resize-handle--${direction}`}
      data-desktop-resize-handle={direction}
      aria-hidden="true"
      onPointerDown={(event) => {
        if (event.button !== 0 || activePointerRef.current !== null) return
        event.preventDefault()
        event.stopPropagation()
        activePointerRef.current = event.pointerId
        event.currentTarget.setPointerCapture(event.pointerId)
        desktop.windowControls.beginResize(direction, { x: event.clientX, y: event.clientY })
      }}
      onPointerMove={(event) => {
        if (activePointerRef.current !== event.pointerId) return
        desktop.windowControls.updateResize({ x: event.clientX, y: event.clientY })
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
    />
  ))
}
