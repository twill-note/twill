import { useEffect, useState } from 'react'
import ByeoriPanel from './components/ByeoriPanel'
import DesktopTitleBar from './components/DesktopTitleBar'
import DesktopTooltip from './components/DesktopTooltip'
import DialogHost from './components/Dialog'
import { useAppStore } from './store'

/** Electron 전용 Twill AI 분리 창. 서버 세션을 공유하고 네이티브 작업은 preload 경계로만 요청한다. */
export default function ByeoriWindowApp() {
  const desktop = window.noteDesktop
  const loadWorkspace = useAppStore((state) => state.loadWorkspace)
  const refreshTree = useAppStore((state) => state.refreshTree)
  const [windowError, setWindowError] = useState<string | null>(null)

  useEffect(() => {
    document.title = 'Twill AI · Twill'
    Promise.all([loadWorkspace(), refreshTree()]).catch(() => {
      setWindowError('워크스페이스 정보를 불러오지 못했습니다. 기본 창과 백엔드 연결을 확인해주세요.')
    })
  }, [loadWorkspace, refreshTree])

  const openInMain = (kind: 'note' | 'erd', path: string) => {
    if (!desktop) return
    setWindowError(null)
    desktop.openDocumentInMain({ kind, path }).catch(() => {
      setWindowError('기본 창에서 문서를 열지 못했습니다.')
    })
  }

  const reattach = () => {
    if (!desktop) return
    setWindowError(null)
    desktop.reattachByeoriWindow().catch(() => {
      setWindowError('Twill AI를 기본 창에 다시 붙이지 못했습니다.')
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <DesktopTitleBar />
      {windowError && (
        <div role="alert" className="shrink-0 border-b border-[#fbcaca] bg-[#fdf2f2] px-3 py-1.5 text-[11px] text-[#c92a2a]">
          {windowError}
        </div>
      )}
      <main className="min-h-0 flex-1 overflow-hidden">
        <ByeoriPanel
          onOpenFile={desktop ? (path) => openInMain('note', path) : undefined}
          onOpenErdDesigner={desktop ? (path) => {
            if (path) openInMain('erd', path)
          } : undefined}
          onReattach={desktop ? reattach : undefined}
        />
      </main>
      <DialogHost />
      <DesktopTooltip />
    </div>
  )
}
