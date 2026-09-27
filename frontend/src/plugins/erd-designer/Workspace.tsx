import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { useAiStore } from '../../aiStore'
import { dialog } from '../../dialog'
import { type DocTab, useAppStore } from '../../store'
import ErdDesigner from './Designer'
import { emptyDiagram, type ErdDiagram } from './types'
import {
  discardErdTabSession,
  getErdTabSession,
  registerErdTabCloseRequest,
  setErdTabDirty,
  setErdTabSession,
  type ErdTabSession,
} from './session'
import { tr } from '../../i18n'

function createNewDiagram(directory: string | null): ErdTabSession {
  const targetDir = directory?.replace(/\/+$/, '') ?? ''
  const title = '새 ERD 다이어그램'
  const diagram = emptyDiagram(title)

  return {
    instanceId: `new-${crypto.randomUUID?.() ?? Date.now()}`,
    filePath: null,
    // 서버는 저장 시 현재 제목으로 파일명을 다시 계산한다. 이 값은 첫 자동
    // 저장 전까지 사용할 폴더를 보존하기 위한 제안 경로일 뿐이다.
    initialPath: `${targetDir ? `${targetDir}/` : ''}${title}.erd.json`,
    diagram: { ...diagram, meta: { ...diagram.meta, filenameMode: 'title' } },
  }
}

/**
 * 코어 ERD 작업 화면.
 *
 * 저장 목록을 별도의 왼쪽 패널에 중복 표시하지 않는다. `.erd.json` 파일은 일반 문서와
 * 마찬가지로 파일 트리의 어느 폴더에나 저장하고 그 자리에서 연다.
 */
export default function ErdWorkspace({ tab }: { tab: DocTab }) {
  const closeTab = useAppStore((s) => s.closeTab)
  const updateErdTab = useAppStore((s) => s.updateErdTab)
  const refreshTree = useAppStore((s) => s.refreshTree)
  // 벼리가 파일 변경을 스트리밍하면, 현재 열린 ERD는 폴링을 기다리지 않고 즉시 확인한다.
  const changedPath = useAiStore((s) => s.runLogPath)
  const changedVersion = useAiStore((s) => s.runLogVersion)
  const defaultDirectory = tab.erdDirectory ?? ''
  const [active, setActive] = useState<ErdTabSession | null>(() => getErdTabSession(tab.id) ?? null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    const cached = getErdTabSession(tab.id)
    if (cached) {
      setActive(cached)
      setLoading(false)
      return () => { cancelled = true }
    }

    if (!tab.erdPath) {
      const created = createNewDiagram(defaultDirectory)
      setErdTabSession(tab.id, created)
      setActive(created)
      setLoading(false)
      return () => { cancelled = true }
    }

    setLoading(true)
    api.erdDesigner
      .get(tab.erdPath)
      .then((loaded) => {
        if (cancelled) return
        const next = {
          instanceId: `file-${loaded.path}-${Date.now()}`,
          filePath: loaded.path,
          diagram: loaded.diagram,
        }
        setErdTabSession(tab.id, next)
        setActive(next)
      })
      .catch((error) => {
        if (!cancelled) dialog.alert((error as Error).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [tab.id, tab.erdPath, defaultDirectory])

  const saveDiagram = useCallback(async (path: string, diagram: ErdDiagram, syncTitle: boolean) => {
    const saved = await api.erdDesigner.save(path, diagram, syncTitle)
    setActive((current) => {
      if (!current) return current
      const next = { ...current, filePath: saved.path, diagram: saved.diagram }
      setErdTabSession(tab.id, next)
      return next
    })
    updateErdTab(tab.id, saved.path)
    await refreshTree()
    return saved.path
  }, [refreshTree, tab.id, updateErdTab])

  // 디자이너는 이 함수를 통해 최신 파일만 읽고, 실제 화면 교체 여부(편집 중 충돌 포함)는
  // 자신이 판단한다. 따라서 다른 분할 패널의 탭 상태나 카메라 위치를 불필요하게 초기화하지 않는다.
  const loadDiagram = useCallback(async (path: string) => {
    const loaded = await api.erdDesigner.get(path)
    return loaded.diagram
  }, [])

  const updateDiagram = useCallback((diagram: ErdDiagram) => {
    setActive((current) => {
      if (!current) return current
      const next = { ...current, diagram }
      setErdTabSession(tab.id, next)
      return next
    })
  }, [tab.id])

  const updateDirty = useCallback((dirty: boolean) => {
    setErdTabDirty(tab.id, dirty)
  }, [tab.id])

  const registerCloseRequest = useCallback((request: (() => void) | null) => {
    registerErdTabCloseRequest(tab.id, request)
  }, [tab.id])

  const closeCurrentTab = useCallback(() => {
    discardErdTabSession(tab.id)
    closeTab(tab.id)
  }, [closeTab, tab.id])

  if (loading || !active) {
    return <div className="flex h-full items-center justify-center text-[13px] text-[#9b9a97]">{tr("ERD를 불러오는 중…")}</div>
  }

  return (
    <ErdDesigner
      key={active.instanceId}
      initial={active.diagram}
      filePath={active.filePath}
      initialPath={active.initialPath}
      onSave={saveDiagram}
      onReload={loadDiagram}
      externalChangeVersion={active.filePath && changedPath === active.filePath ? changedVersion : 0}
      onClose={closeCurrentTab}
      onDirtyChange={updateDirty}
      onDiagramChange={updateDiagram}
      registerCloseRequest={registerCloseRequest}
    />
  )
}
