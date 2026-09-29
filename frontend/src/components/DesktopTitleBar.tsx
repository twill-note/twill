import { useEffect, useRef, useState } from 'react'
import DesktopResizeHandles from './DesktopResizeHandles'
import { tr } from '../i18n'

export default function DesktopTitleBar() {
  const desktop = window.noteDesktop
  const isMac = desktop?.platform === 'darwin'
  const nativeDrag = desktop?.platform === 'win32'
  const [maximized, setMaximized] = useState(false)
  const dragPointerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!desktop) return
    desktop.windowControls.isMaximized().then(setMaximized).catch(() => {})
    return desktop.windowControls.onMaximizedChange(setMaximized)
  }, [desktop])

  useEffect(() => () => {
    desktop?.windowControls.endMove()
  }, [desktop])

  if (!desktop) return null

  return (
    <>
      <DesktopResizeHandles disabled={maximized || isMac || nativeDrag} />
      <header
        className={`desktop-titlebar flex h-9 shrink-0 items-center border-b border-[#e9e9e7] bg-[#f7f7f5] text-[#5f5e5b] ${
          isMac ? 'desktop-titlebar--mac' : ''
        }`}
      >
        {isMac && <div className="h-full w-[78px] shrink-0" aria-hidden="true" />}
        <div
          className={`desktop-titlebar__drag-area h-full min-w-0 flex-1 ${nativeDrag ? 'desktop-titlebar__drag-area--native' : ''}`}
          onPointerDown={(event) => {
            if (nativeDrag) return
            if (event.button !== 0 || dragPointerRef.current !== null) return
            dragPointerRef.current = event.pointerId
            event.currentTarget.setPointerCapture(event.pointerId)
            desktop.windowControls.beginMove()
          }}
          onPointerUp={(event) => {
            if (dragPointerRef.current !== event.pointerId) return
            dragPointerRef.current = null
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
            desktop.windowControls.endMove()
          }}
          onPointerCancel={() => {
            dragPointerRef.current = null
            desktop.windowControls.endMove()
          }}
          onLostPointerCapture={() => {
            dragPointerRef.current = null
            desktop.windowControls.endMove()
          }}
          onDoubleClick={() => {
            if (nativeDrag) return
            dragPointerRef.current = null
            desktop.windowControls.endMove()
            void desktop.windowControls.toggleMaximize()
          }}
        />

        {!isMac && <div className="desktop-titlebar__controls flex h-full shrink-0">
          <button
            type="button"
            className="desktop-titlebar__control flex h-full w-12 items-center justify-center hover:bg-[#ececea]"
            title={tr("최소화")}
            aria-label={tr("창 최소화")}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={() => void desktop.windowControls.minimize()}
          >
            <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
              <path d="M2 8.5h8" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
          <button
            type="button"
            className="desktop-titlebar__control flex h-full w-12 items-center justify-center hover:bg-[#ececea]"
            title={maximized ? tr("이전 크기로 복원") : tr("최대화")}
            aria-label={maximized ? tr("창 이전 크기로 복원") : tr("창 최대화")}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={() => void desktop.windowControls.toggleMaximize()}
          >
            {maximized ? (
              <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
                <path d="M4 3h5v5M3 4h5v5H3z" fill="none" stroke="currentColor" strokeWidth="1" />
              </svg>
            ) : (
              <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
                <rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="desktop-titlebar__control flex h-full w-12 items-center justify-center hover:bg-[#c42b1c] hover:text-white"
            title={tr("닫기")}
            aria-label={tr("창 닫기")}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={() => void desktop.windowControls.close()}
          >
            <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
              <path d="m3 3 6 6m0-6L3 9" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
        </div>}
      </header>
    </>
  )
}
