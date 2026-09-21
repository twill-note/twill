import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { dialog } from '../../dialog'
import { displayCombo } from '../../shortcuts'
import { useBackdropDismiss } from '../../useBackdropDismiss'
import { toSql } from './exporter'
import { parseSqlDdl } from './importer'
import TableBox from './TableBox'
import {
  DEFAULT_TABLE_COLOR,
  TABLE_COLORS,
  TYPE_SUGGESTIONS,
  normalizeMariaDbDiagram,
  uid,
  type Cardinality,
  type ErdColumn,
  type ErdDiagram,
  type ErdRelation,
  type ErdTable,
} from './types'

interface Props {
  initial: ErdDiagram
  /** 이미 저장된 워크스페이스 상대 경로. null 이면 아직 새 다이어그램이다. */
  filePath: string | null
  /** 새 다이어그램에 미리 제안할 저장 위치. 아직 저장된 경로로 취급하지 않는다. */
  initialPath?: string
  onSave: (path: string, diagram: ErdDiagram, syncTitle: boolean) => Promise<string>  // 저장 후 실제 경로 반환
  /** 저장된 파일을 다시 읽는다. 화면 반영 여부는 디자이너가 편집 상태를 고려해 결정한다. */
  onReload?: (path: string) => Promise<ErdDiagram>
  /** 벼리가 현재 ERD 파일을 수정했다는 즉시 갱신 신호. */
  externalChangeVersion?: number
  onClose: () => void
  /** 상위 프로젝트 목록에서 전환 전, 저장되지 않은 변경을 확인할 때 사용한다. */
  onDirtyChange?: (dirty: boolean) => void
  /** 탭을 다른 분할 패널로 옮겨도 편집 상태를 보존할 수 있도록 최신 다이어그램을 알린다. */
  onDiagramChange?: (diagram: ErdDiagram) => void
  /** 탭의 닫기 버튼도 디자이너의 저장 확인 절차를 거치게 한다. */
  registerCloseRequest?: (request: (() => void) | null) => void
}

/** 화면 좌표계 컨트롤 — 팬(offset)과 줌(scale). */
interface Camera { x: number; y: number; scale: number }
type CanvasTool = 'select' | 'relation'

type ErdSaveStatus = 'idle' | 'saving' | 'saved' | 'error'
type SaveMode = 'manual' | 'auto'
type FilenameMode = 'title' | 'manual'

const AUTO_SAVE_DELAY_MS = 1500
const EXTERNAL_CHECK_INTERVAL_MS = 5000

function isLegacyGeneratedPath(path: string | null): boolean {
  return Boolean(path && /(?:^|\/)diagram-\d{8}-\d{6}-\d{3}\.erd\.json$/.test(path))
}

function titleFilenameStem(title: string): string {
  return title
    .normalize('NFC')
    .trim()
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .replace(/\.erd\.json$/i, '')
    .replace(/[. ]+$/, '')
}

function inferFilenameMode(diagram: ErdDiagram, path: string | null): FilenameMode {
  if (diagram.meta.filenameMode === 'manual') return 'manual'
  if (diagram.meta.filenameMode === 'title' || !path || isLegacyGeneratedPath(path)) return 'title'
  const stem = path.split('/').pop()?.replace(/\.erd\.json$/, '') ?? ''
  // Files created before this setting existed are treated as manual unless
  // their old name was already the title (or the legacy generated name).
  return stem === titleFilenameStem(diagram.meta.title) ? 'title' : 'manual'
}

export default function ErdDesigner({
  initial,
  filePath,
  initialPath,
  onSave,
  onReload,
  externalChangeVersion = 0,
  onClose,
  onDirtyChange,
  onDiagramChange,
  registerCloseRequest,
}: Props) {
  const [diagram, setDiagram] = useState<ErdDiagram>(() => normalizeMariaDbDiagram(initial))
  const [filenameMode] = useState<FilenameMode>(() => inferFilenameMode(normalizeMariaDbDiagram(initial), filePath))
  const [originalSnapshot, setOriginalSnapshot] = useState<string>(() => JSON.stringify(normalizeMariaDbDiagram(initial)))
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null)
  const [selectedRelId, setSelectedRelId] = useState<string | null>(null)
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 })
  const [savedPath, setSavedPath] = useState(filePath)
  const [pathInput, setPathInput] = useState(initialPath ?? filePath ?? '')
  const [pathEditing, setPathEditing] = useState(!filePath)
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState(diagram.meta.title)
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<ErdSaveStatus>('idle')
  const [refreshing, setRefreshing] = useState(false)
  const [externalChangeAvailable, setExternalChangeAvailable] = useState(false)
  const [sqlOpen, setSqlOpen] = useState(false)
  const [ddlImportOpen, setDdlImportOpen] = useState(false)
  const [linking, setLinking] = useState<{ fromTable: string; fromColumn: string; x: number; y: number } | null>(null)
  const [canvasTool, setCanvasTool] = useState<CanvasTool>('select')

  const canvasRef = useRef<HTMLDivElement>(null)
  const dragCanvasRef = useRef<{ startX: number; startY: number; camStart: Camera } | null>(null)
  // native wheel 이벤트 핸들러에서도 최신 카메라 값을 사용할 수 있도록 유지한다.
  const cameraRef = useRef<Camera>(camera)
  const savingRef = useRef(false)
  const externalCheckRef = useRef(false)
  const snapshotRef = useRef(originalSnapshot)
  const dirtyRef = useRef(false)

  useEffect(() => {
    cameraRef.current = camera
  }, [camera])

  const dirty = useMemo(
    () => JSON.stringify(diagram) !== originalSnapshot,
    [diagram, originalSnapshot],
  )
  // 제목 동기화 문서는 서버가 파일명을 계산한다. 직접 경로 모드만 사용자가
  // 입력을 마친 뒤에 자동 저장해 중간 경로에 쓰는 일을 막는다.
  const autoSavePathReady =
    filenameMode === 'title'
      ? Boolean(pathInput)
      : ((!pathEditing && Boolean(savedPath)) || (!savedPath && Boolean(initialPath) && pathInput === initialPath))
  const selectedRel = diagram.relations.find((r) => r.id === selectedRelId) ?? null

  useEffect(() => {
    snapshotRef.current = originalSnapshot
  }, [originalSnapshot])

  useEffect(() => {
    dirtyRef.current = dirty
    // 마지막 저장 결과를 보여 주되, 다음 변경부터는 아직 저장되지 않았음을 명확히 한다.
    if (dirty) setSaveStatus((status) => (status === 'saved' ? 'idle' : status))
  }, [dirty])

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  useEffect(() => {
    onDiagramChange?.(diagram)
  }, [diagram, onDiagramChange])

  useEffect(() => {
    if (!titleEditing) setTitleDraft(diagram.meta.title)
  }, [diagram.meta.title, titleEditing])

  const beginTitleEditing = () => {
    setTitleDraft(diagram.meta.title)
    setTitleEditing(true)
  }

  const commitTitle = () => {
    const title = titleDraft.trim()
    if (title && title !== diagram.meta.title) {
      setDiagram((current) => ({ ...current, meta: { ...current.meta, title } }))
    } else {
      setTitleDraft(diagram.meta.title)
    }
    setTitleEditing(false)
  }

  const cancelTitleEditing = () => {
    setTitleDraft(diagram.meta.title)
    setTitleEditing(false)
  }

  const applyLoadedDiagram = useCallback((loaded: ErdDiagram) => {
    const normalized = normalizeMariaDbDiagram(loaded)
    const snapshot = JSON.stringify(normalized)
    snapshotRef.current = snapshot
    setDiagram(normalized)
    setOriginalSnapshot(snapshot)
    setSelectedTableId(null)
    setSelectedRelId(null)
    setLinking(null)
    setCanvasTool('select')
    setExternalChangeAvailable(false)
  }, [])

  // 저장 — 수동 저장과 자동 저장이 같은 경로를 쓰므로, 저장 중복과 외부 변경 덮어쓰기를 함께 막는다.
  const save = useCallback(async (mode: SaveMode = 'manual'): Promise<boolean> => {
    if (savingRef.current) return false
    if (mode === 'auto' && (!autoSavePathReady || externalChangeAvailable)) return false
    const trimmed = pathInput.trim()
    if (!trimmed) {
      if (mode === 'manual') dialog.alert('저장 경로를 입력하세요 (예: db/user_service.erd.json)')
      return false
    }
    if (mode === 'manual' && externalChangeAvailable) {
      const overwrite = await dialog.confirm('파일이 외부에서 변경되었습니다', {
        detail: '현재 편집 내용을 저장하면 외부 변경을 덮어씁니다.',
        danger: true,
        confirmLabel: '내 변경으로 저장',
      })
      if (!overwrite) return false
    }
    const path = trimmed.endsWith('.erd.json') ? trimmed : `${trimmed}.erd.json`
    savingRef.current = true
    setSaving(true)
    setSaveStatus('saving')
    try {
      const now = Math.floor(Date.now() / 1000)
      const toSave: ErdDiagram = {
        ...diagram,
        meta: { ...diagram.meta, dialect: 'mariadb', updated: now, filenameMode },
      }
      const saved = await onSave(path, toSave, filenameMode === 'title')
      const snapshot = JSON.stringify(toSave)
      snapshotRef.current = snapshot
      setDiagram(toSave)
      setOriginalSnapshot(snapshot)
      setSavedPath(saved)
      setPathInput(saved)
      setPathEditing(false)
      setExternalChangeAvailable(false)
      setSaveStatus('saved')
      return true
    } catch (e) {
      setSaveStatus('error')
      if (mode === 'manual') dialog.alert((e as Error).message)
      return false
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [autoSavePathReady, diagram, externalChangeAvailable, filenameMode, onSave, pathInput])

  const refreshFromDisk = useCallback(async () => {
    if (!savedPath || !onReload || refreshing) return
    if (dirty) {
      const ok = await dialog.confirm('저장하지 않은 변경사항이 있습니다', {
        detail: '파일의 최신 내용으로 다시 불러오면 현재 변경사항은 사라집니다.',
        danger: true,
        confirmLabel: '다시 불러오기',
      })
      if (!ok) return
    }
    setRefreshing(true)
    try {
      applyLoadedDiagram(await onReload(savedPath))
      setSaveStatus('saved')
    } catch (e) {
      setSaveStatus('error')
      dialog.alert((e as Error).message)
    } finally {
      setRefreshing(false)
    }
  }, [applyLoadedDiagram, dirty, onReload, refreshing, savedPath])

  const checkForExternalChange = useCallback(async () => {
    if (!savedPath || !onReload || savingRef.current || externalCheckRef.current) return
    externalCheckRef.current = true
    try {
      const loaded = await onReload(savedPath)
      const incomingSnapshot = JSON.stringify(loaded)
      if (incomingSnapshot === snapshotRef.current) return
      if (dirtyRef.current) {
        setExternalChangeAvailable(true)
        return
      }
      applyLoadedDiagram(loaded)
      setSaveStatus('saved')
    } catch {
      // 자동 확인은 네트워크 일시 오류를 사용자 작업을 방해하는 알림으로 만들지 않는다.
    } finally {
      externalCheckRef.current = false
    }
  }, [applyLoadedDiagram, onReload, savedPath])

  // 벼리의 file_change 신호는 즉시 반영하고, 외부 도구 편집은 짧은 주기 확인으로 보완한다.
  useEffect(() => {
    if (externalChangeVersion > 0) void checkForExternalChange()
  }, [checkForExternalChange, externalChangeVersion])

  useEffect(() => {
    if (!savedPath) return
    const timer = window.setInterval(() => void checkForExternalChange(), EXTERNAL_CHECK_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [checkForExternalChange, savedPath])

  // 마지막 편집 후 잠시 멈추면 자동 저장한다. 새 문서는 기본 제안 경로를 그대로 쓸 때부터 적용한다.
  useEffect(() => {
    if (!dirty || !autoSavePathReady || saving || externalChangeAvailable) return
    const timer = window.setTimeout(() => { void save('auto') }, AUTO_SAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [autoSavePathReady, diagram, dirty, externalChangeAvailable, save, saving])

  // 키보드 단축
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inEditableField =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement)?.isContentEditable
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        save()
      }
      if (e.key === 'Escape' && !inEditableField) {
        if (linking) {
          cancelLink()
          setCanvasTool('select')
          return
        }
        if (dirty) tryClose()
        else onClose()
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !inEditableField) {
        if (selectedTableId) removeTable(selectedTableId)
        else if (selectedRelId) removeRelation(selectedRelId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTableId, selectedRelId, dirty, linking, save])

  const tryClose = useCallback(async () => {
    if (dirty) {
      const ok = await dialog.confirm('저장하지 않은 변경사항이 있습니다', {
        detail: '정말로 닫을까요?',
        danger: true,
        confirmLabel: '변경 버리기',
      })
      if (!ok) return
    }
    onClose()
  }, [dirty, onClose])

  useEffect(() => {
    if (!registerCloseRequest) return
    registerCloseRequest(() => { void tryClose() })
    return () => registerCloseRequest(null)
  }, [registerCloseRequest, tryClose])

  // ─── 테이블 CRUD ─────────────────────────
  const addTable = () => {
    const rect = canvasRef.current?.getBoundingClientRect()
    const cx = rect ? (rect.width / 2 - camera.x) / camera.scale : 200
    const cy = rect ? (rect.height / 2 - camera.y) / camera.scale : 200
    const idx = diagram.tables.length
    const table: ErdTable = {
      id: uid('t_'),
      name: `table_${idx + 1}`,
      x: cx - 300,
      y: cy - 60,
      width: 600,
      color: TABLE_COLORS[idx % TABLE_COLORS.length] ?? DEFAULT_TABLE_COLOR,
      columns: [
        { id: uid('c_'), name: 'id', type: 'INT', isPK: true, isFK: false, nullable: false, unique: false },
        { id: uid('c_'), name: 'created_at', type: 'TIMESTAMP', isPK: false, isFK: false, nullable: false, unique: false, defaultVal: 'CURRENT_TIMESTAMP' },
      ],
    }
    setDiagram((d) => ({ ...d, tables: [...d.tables, table] }))
    setSelectedTableId(table.id)
    setSelectedRelId(null)
  }

  const updateTable = (id: string, patch: Partial<ErdTable>) => {
    setDiagram((d) => ({ ...d, tables: d.tables.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
  }

  const removeTable = async (id: string) => {
    const t = diagram.tables.find((x) => x.id === id)
    if (!t) return
    const ok = await dialog.confirm(`테이블 "${t.name}" 삭제`, {
      detail: '이 테이블과 관련된 관계선도 함께 사라집니다.',
      danger: true,
      confirmLabel: '삭제',
    })
    if (!ok) return
    setDiagram((d) => ({
      ...d,
      tables: d.tables.filter((x) => x.id !== id),
      relations: d.relations.filter((r) => r.fromTable !== id && r.toTable !== id),
    }))
    if (selectedTableId === id) setSelectedTableId(null)
  }

  const duplicateTable = (id: string) => {
    const t = diagram.tables.find((x) => x.id === id)
    if (!t) return
    const copy: ErdTable = {
      ...t,
      id: uid('t_'),
      name: `${t.name}_copy`,
      x: t.x + 40,
      y: t.y + 40,
      columns: t.columns.map((c) => ({ ...c, id: uid('c_') })),
    }
    setDiagram((d) => ({ ...d, tables: [...d.tables, copy] }))
    setSelectedTableId(copy.id)
  }

  // ─── 컬럼 CRUD ─────────────────────────
  const addColumn = (tableId: string) => {
    const table = diagram.tables.find((t) => t.id === tableId)
    if (!table) return
    const nextName = `col_${table.columns.length + 1}`
    const col: ErdColumn = {
      id: uid('c_'),
      name: nextName,
      type: 'VARCHAR(255)',
      isPK: false,
      isFK: false,
      nullable: true,
      unique: false,
    }
    updateTable(tableId, { columns: [...table.columns, col] })
  }

  const updateColumn = (tableId: string, colId: string, patch: Partial<ErdColumn>) => {
    setDiagram((d) => ({
      ...d,
      tables: d.tables.map((t) =>
        t.id === tableId
          ? { ...t, columns: t.columns.map((c) => (c.id === colId ? { ...c, ...patch } : c)) }
          : t,
      ),
    }))
  }

  const removeColumn = (tableId: string, colId: string) => {
    setDiagram((d) => ({
      ...d,
      tables: d.tables.map((t) =>
        t.id === tableId ? { ...t, columns: t.columns.filter((c) => c.id !== colId) } : t,
      ),
      relations: d.relations.filter(
        (r) =>
          !(r.fromTable === tableId && r.fromColumn === colId) &&
          !(r.toTable === tableId && r.toColumn === colId),
      ),
    }))
  }

  const moveColumn = (tableId: string, colId: string, dir: -1 | 1) => {
    const t = diagram.tables.find((x) => x.id === tableId)
    if (!t) return
    const idx = t.columns.findIndex((c) => c.id === colId)
    if (idx < 0) return
    const next = idx + dir
    if (next < 0 || next >= t.columns.length) return
    const cols = [...t.columns]
    ;[cols[idx], cols[next]] = [cols[next], cols[idx]]
    updateTable(tableId, { columns: cols })
  }

  const reorderColumn = (tableId: string, colId: string, targetColId: string, position: 'before' | 'after') => {
    if (colId === targetColId) return
    setDiagram((current) => ({
      ...current,
      tables: current.tables.map((table) => {
        if (table.id !== tableId) return table
        const fromIndex = table.columns.findIndex((column) => column.id === colId)
        if (fromIndex < 0) return table
        const columns = [...table.columns]
        const [moved] = columns.splice(fromIndex, 1)
        const targetIndex = columns.findIndex((column) => column.id === targetColId)
        if (!moved || targetIndex < 0) return table
        columns.splice(targetIndex + (position === 'after' ? 1 : 0), 0, moved)
        return { ...table, columns }
      }),
    }))
  }

  // ─── 관계 CRUD ─────────────────────────
  const startLink = (tableId: string, columnId: string, e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    setLinking({
      fromTable: tableId,
      fromColumn: columnId,
      x: (e.clientX - rect.left - camera.x) / camera.scale,
      y: (e.clientY - rect.top - camera.y) / camera.scale,
    })
  }

  const updateLinkPointer = (e: React.MouseEvent) => {
    if (!linking) return
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    setLinking({
      ...linking,
      x: (e.clientX - rect.left - camera.x) / camera.scale,
      y: (e.clientY - rect.top - camera.y) / camera.scale,
    })
  }

  const finishLink = (toTableId: string, toColumnId: string) => {
    if (!linking) return
    if (linking.fromTable === toTableId && linking.fromColumn === toColumnId) {
      setLinking(null)
      setCanvasTool('select')
      return
    }
    const rel: ErdRelation = {
      id: uid('r_'),
      fromTable: linking.fromTable,
      fromColumn: linking.fromColumn,
      toTable: toTableId,
      toColumn: toColumnId,
      cardinality: '1:N',
      optional: false,
    }
    // 자동으로 FK 마크
    setDiagram((d) => ({
      ...d,
      relations: [...d.relations, rel],
      tables: d.tables.map((t) => {
        if (t.id !== toTableId) return t
        return {
          ...t,
          columns: t.columns.map((c) => (c.id === toColumnId ? { ...c, isFK: true } : c)),
        }
      }),
    }))
    setLinking(null)
    setCanvasTool('select')
    setSelectedRelId(rel.id)
    setSelectedTableId(null)
  }

  const cancelLink = () => setLinking(null)

  const pickRelationColumn = (tableId: string, columnId: string, event: React.MouseEvent<HTMLElement>) => {
    if (canvasTool !== 'relation') return
    if (linking) finishLink(tableId, columnId)
    else startLink(tableId, columnId, event)
  }

  const importDdl = (source: string): boolean => {
    const imported = parseSqlDdl(source, diagram.tables)
    if (imported.tables.length === 0) {
      dialog.alert('CREATE TABLE 문을 찾지 못했습니다', {
        detail: 'MariaDB를 비롯한 일반적인 CREATE TABLE DDL을 입력하세요.',
      })
      return false
    }
    const importedTables = placeImportedTables(diagram.tables, imported.tables)
    setDiagram((current) => ({
      ...current,
      tables: [...current.tables, ...importedTables],
      relations: [...current.relations, ...imported.relations],
    }))
    setSelectedTableId(importedTables[0]?.id ?? null)
    setSelectedRelId(null)
    if (imported.warnings.length > 0) {
      dialog.alert('DDL을 가져왔지만 일부 관계는 연결하지 못했습니다', {
        detail: imported.warnings.slice(0, 5).join('\n'),
      })
    }
    return true
  }

  const updateRelation = (id: string, patch: Partial<ErdRelation>) => {
    setDiagram((d) => ({
      ...d,
      relations: d.relations.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }))
  }

  const removeRelation = (id: string) => {
    setDiagram((d) => ({ ...d, relations: d.relations.filter((r) => r.id !== id) }))
    if (selectedRelId === id) setSelectedRelId(null)
  }

  // ─── 캔버스 팬 · 줌 ─────────────────────────
  const onCanvasMouseDown = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains('erd-bg')) return
    // 빈 공간 클릭 → 선택 해제 + 팬 시작
    setSelectedTableId(null)
    setSelectedRelId(null)
    if (linking) {
      cancelLink()
      setCanvasTool('select')
      return
    }
    if (canvasTool === 'relation') {
      setCanvasTool('select')
      return
    }
    dragCanvasRef.current = { startX: e.clientX, startY: e.clientY, camStart: camera }
  }
  const onCanvasMouseMove = (e: React.MouseEvent) => {
    if (linking) updateLinkPointer(e)
    if (dragCanvasRef.current) {
      const { startX, startY, camStart } = dragCanvasRef.current
      setCamera({ ...camStart, x: camStart.x + (e.clientX - startX), y: camStart.y + (e.clientY - startY) })
    }
  }
  const onCanvasMouseUp = () => {
    dragCanvasRef.current = null
  }
  const zoomCanvasAt = useCallback((clientX: number, clientY: number, deltaY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const mouseX = clientX - rect.left
    const mouseY = clientY - rect.top
    const current = cameraRef.current
    const oldScale = current.scale
    const factor = deltaY < 0 ? 1.1 : 1 / 1.1
    const newScale = Math.max(0.25, Math.min(3, oldScale * factor))
    // 마우스 지점 기준으로 확대되도록 카메라 재계산
    const wx = (mouseX - current.x) / oldScale
    const wy = (mouseY - current.y) / oldScale
    setCamera({ scale: newScale, x: mouseX - wx * newScale, y: mouseY - wy * newScale })
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // React synthetic wheel 이벤트는 브라우저에 따라 passive로 처리될 수 있다. native
    // non-passive 리스너로 휠 이동과 Ctrl/⌘+휠 확대를 캔버스에 안정적으로 적용한다.
    const onNativeWheel = (event: WheelEvent) => {
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) {
        zoomCanvasAt(event.clientX, event.clientY, event.deltaY)
        return
      }
      const current = cameraRef.current
      const scrollX = event.shiftKey ? event.deltaY : event.deltaX
      const scrollY = event.shiftKey ? 0 : event.deltaY
      setCamera({
        ...current,
        x: current.x - scrollX,
        y: current.y - scrollY,
      })
    }
    canvas.addEventListener('wheel', onNativeWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onNativeWheel)
  }, [zoomCanvasAt])

  const resetView = () => setCamera({ x: 0, y: 0, scale: 1 })

  // 관계선 앵커 계산 (테이블 좌우 가장자리에 붙임)
  const anchors = useMemo(() => {
    const m = new Map<string, { x: number; y: number; rowY: number }>()
    for (const t of diagram.tables) {
      const HEADER_H = 36 + 32 + 28
      const ROW_H = 36
      for (let i = 0; i < t.columns.length; i++) {
        const c = t.columns[i]
        const rowY = t.y + HEADER_H + i * ROW_H + ROW_H / 2
        m.set(`${t.id}:${c.id}`, { x: t.x, y: rowY, rowY })  // 기본 왼쪽 앵커 — 실제 렌더 시 방향 결정
      }
    }
    return m
  }, [diagram.tables])

  const relLine = (rel: ErdRelation) => {
    const from = anchors.get(`${rel.fromTable}:${rel.fromColumn}`)
    const to = anchors.get(`${rel.toTable}:${rel.toColumn}`)
    if (!from || !to) return null
    const fromTable = diagram.tables.find((t) => t.id === rel.fromTable)
    const toTable = diagram.tables.find((t) => t.id === rel.toTable)
    if (!fromTable || !toTable) return null
    // 두 테이블 x 위치 비교 → 오른쪽/왼쪽 결정
    const fromRight = fromTable.x + fromTable.width
    const toRight = toTable.x + toTable.width
    const fromAnchorX = fromTable.x + fromTable.width / 2 < toTable.x + toTable.width / 2 ? fromRight : fromTable.x
    const toAnchorX = fromTable.x + fromTable.width / 2 < toTable.x + toTable.width / 2 ? toTable.x : toRight

    const dx = Math.abs(toAnchorX - fromAnchorX)
    const c1x = fromAnchorX + (toAnchorX > fromAnchorX ? 1 : -1) * dx * 0.4
    const c2x = toAnchorX - (toAnchorX > fromAnchorX ? 1 : -1) * dx * 0.4
    const path = `M ${fromAnchorX} ${from.rowY} C ${c1x} ${from.rowY}, ${c2x} ${to.rowY}, ${toAnchorX} ${to.rowY}`
    const isSelected = selectedRelId === rel.id
    return { path, from: { x: fromAnchorX, y: from.rowY }, to: { x: toAnchorX, y: to.rowY }, rel, isSelected }
  }
  const selectedRelLine = selectedRel ? relLine(selectedRel) : null

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white">
      {/* 헤더 */}
      <div className="flex min-h-14 items-center gap-3 border-b border-[#efefed] px-5 py-2.5">
        <span className="shrink-0 text-[20px]" aria-hidden="true">🗺️</span>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {titleEditing ? (
            <input
              className="w-[320px] max-w-[40vw] rounded border border-[#d3d1cb] bg-white px-2 py-1 text-[16px] font-semibold text-[#37352f] outline-none focus:border-[#9b9a97]"
              value={titleDraft}
              placeholder="ERD 제목"
              aria-label="ERD 제목"
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  cancelTitleEditing()
                }
              }}
            />
          ) : (
            <>
              <span
                className="max-w-[min(420px,40vw)] truncate text-[16px] font-semibold text-[#37352f]"
                title={diagram.meta.title}
              >
                {diagram.meta.title || '제목 없는 ERD'}
              </span>
              <button
                type="button"
                className="grid h-7 w-7 shrink-0 place-items-center rounded text-[#9b9a97] hover:bg-[#f1f1ef] hover:text-[#37352f]"
                onClick={beginTitleEditing}
                title="ERD 제목 수정"
                aria-label="ERD 제목 수정"
              >
                <EditIcon />
              </button>
            </>
          )}
          <span className="shrink-0 text-[11px] text-[#9b9a97]">
            {diagram.tables.length} 테이블 · {diagram.relations.length} 관계
          </span>
          {dirty && <span className="shrink-0 text-[11px] text-orange-600">● 저장 안 됨</span>}
        </div>
        {externalChangeAvailable ? (
          <button
            type="button"
            className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700 hover:bg-amber-100"
            onClick={() => void refreshFromDisk()}
            title="다시 불러오기"
          >
            외부 변경됨
          </button>
        ) : (
          <ErdSaveIndicator status={saveStatus} />
        )}
        <button
          type="button"
          className="grid h-8 w-8 place-items-center rounded-md border border-[#e3e2e0] text-[#5f5e5b] hover:bg-[#f1f1ef] disabled:cursor-not-allowed disabled:text-[#c9c8c4]"
          onClick={() => void refreshFromDisk()}
          disabled={!savedPath || refreshing}
          title="다시 불러오기"
          aria-label="ERD 새로고침"
        >
          <RefreshIcon spinning={refreshing} />
        </button>
        <button
          className="rounded-md border border-[#e3e2e0] px-3 py-1.5 text-[12px] hover:bg-[#f1f1ef]"
          onClick={tryClose}
        >
          닫기
        </button>
        <button
          className={`rounded-md px-3 py-1.5 text-[12px] font-medium text-white ${
            (dirty || pathEditing) && !saving ? 'bg-[#37352f] hover:bg-[#565452]' : 'cursor-not-allowed bg-[#c9c8c4]'
          }`}
          onClick={() => { void save('manual') }}
          disabled={saving || (!dirty && !pathEditing && !!savedPath)}
          title="저장"
        >
          {saving ? '저장 중…' : `저장 (${displayCombo('Mod+KeyS')})`}
        </button>
      </div>

        {/* 본문: 단일 캔버스. 도구 모음과 카드 안에서 모든 편집을 수행한다. */}
          <div
            ref={canvasRef}
            className="relative flex-1 overflow-hidden bg-[#f1f1ef] erd-bg"
            style={{
              cursor: dragCanvasRef.current ? 'grabbing' : (linking || canvasTool === 'relation' ? 'crosshair' : 'default'),
            }}
            onMouseDown={onCanvasMouseDown}
            onMouseMove={onCanvasMouseMove}
            onMouseUp={onCanvasMouseUp}
            onMouseLeave={onCanvasMouseUp}
          >
            {/* 카메라 변환 컨테이너 */}
            <div
              className="absolute left-0 top-0 origin-top-left"
              style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` }}
            >
              {/* 관계선 (SVG) — 테이블 위에 겹치되 클릭 통과, 관계선 자체는 클릭 가능 */}
              <svg
                className="pointer-events-none absolute overflow-visible"
                style={{ left: 0, top: 0, width: 1, height: 1 }}
              >
                {diagram.relations.map((r) => {
                  const info = relLine(r)
                  if (!info) return null
                  return (
                    <g key={r.id} className="pointer-events-auto">
                      <path
                        d={info.path}
                        fill="none"
                        stroke={info.isSelected ? '#37352f' : '#2f6fd0'}
                        strokeWidth={info.isSelected ? 3 : 2.25}
                        strokeDasharray={r.optional ? '5 3' : undefined}
                        className="cursor-pointer"
                        onClick={(e) => {
                          e.stopPropagation()
                          setSelectedRelId(r.id)
                          setSelectedTableId(null)
                        }}
                      />
                      {/* 카디널리티 뱃지 (선 중앙) */}
                      <CardinalityBadge
                        path={info}
                        cardinality={r.cardinality}
                        selected={info.isSelected}
                        onClick={() => {
                          setSelectedRelId(r.id)
                          setSelectedTableId(null)
                        }}
                      />
                    </g>
                  )
                })}
                {/* 링킹 중 임시 선 */}
                {linking && (() => {
                  const from = anchors.get(`${linking.fromTable}:${linking.fromColumn}`)
                  if (!from) return null
                  const fromT = diagram.tables.find((t) => t.id === linking.fromTable)
                  if (!fromT) return null
                  const fromX = linking.x > fromT.x + fromT.width / 2 ? fromT.x + fromT.width : fromT.x
                  return (
                    <path
                      d={`M ${fromX} ${from.rowY} L ${linking.x} ${linking.y}`}
                      fill="none"
                      stroke="#2f6fd0"
                      strokeWidth={2.25}
                      strokeDasharray="4 3"
                    />
                  )
                })()}
              </svg>

              {/* 테이블들 */}
              {diagram.tables.map((t) => (
                <TableBox
                  key={t.id}
                  table={t}
                  selected={selectedTableId === t.id}
                  relationMode={canvasTool === 'relation'}
                  linking={linking}
                  typeOptions={TYPE_SUGGESTIONS.mariadb}
                  onSelect={() => {
                    setSelectedTableId(t.id)
                    setSelectedRelId(null)
                  }}
                  onMove={(x, y) => updateTable(t.id, { x, y })}
                  onTableChange={(patch) => updateTable(t.id, patch)}
                  onTableDuplicate={() => duplicateTable(t.id)}
                  onTableRemove={() => removeTable(t.id)}
                  onColumnAdd={() => addColumn(t.id)}
                  onColumnChange={(columnId, patch) => updateColumn(t.id, columnId, patch)}
                  onColumnRemove={(columnId) => removeColumn(t.id, columnId)}
                  onColumnMove={(columnId, direction) => moveColumn(t.id, columnId, direction)}
                  onColumnReorder={(columnId, targetColumnId, position) => reorderColumn(t.id, columnId, targetColumnId, position)}
                  onRelationColumnPick={(columnId, event) => pickRelationColumn(t.id, columnId, event)}
                  scale={camera.scale}
                />
              ))}
              {selectedRel && selectedRelLine && (
                <RelationPopover
                  relation={selectedRel}
                  tables={diagram.tables}
                  x={(selectedRelLine.from.x + selectedRelLine.to.x) / 2}
                  y={(selectedRelLine.from.y + selectedRelLine.to.y) / 2}
                  onChange={(patch) => updateRelation(selectedRel.id, patch)}
                  onRemove={() => removeRelation(selectedRel.id)}
                />
              )}
            </div>

            <CanvasToolbar
              tool={canvasTool}
              linking={linking}
              onSelect={() => {
                cancelLink()
                setCanvasTool('select')
              }}
              onAddTable={() => {
                cancelLink()
                setCanvasTool('select')
                addTable()
              }}
              onRelation={() => {
                if (canvasTool === 'relation') {
                  cancelLink()
                  setCanvasTool('select')
                  return
                }
                setSelectedTableId(null)
                setSelectedRelId(null)
                setLinking(null)
                setCanvasTool('relation')
              }}
              onZoomIn={() => setCamera((camera) => ({ ...camera, scale: Math.min(3, camera.scale + 0.1) }))}
              onZoomOut={() => setCamera((camera) => ({ ...camera, scale: Math.max(0.25, camera.scale - 0.1) }))}
              onReset={resetView}
            />

            {canvasTool === 'relation' && (
              <div className="pointer-events-none absolute left-14 top-3 z-20 rounded-md border border-[#e3e2e0] bg-white px-2.5 py-1.5 text-[10px] text-[#5f5e5b] shadow-sm">
                {linking ? '연결할 대상 컬럼을 클릭하세요. Esc로 취소' : '관계를 시작할 컬럼을 클릭하세요'}
              </div>
            )}

            {/* 우하단 미니컨트롤 */}
            <div className="pointer-events-auto absolute bottom-3 right-3 flex items-center gap-1 rounded-md border border-[#e3e2e0] bg-white px-2 py-1 text-[11px] shadow-sm">
              <button className="rounded px-1.5 py-0.5 hover:bg-[#f1f1ef]" onClick={() => setCamera((c) => ({ ...c, scale: Math.max(0.25, c.scale - 0.1) }))}>−</button>
              <span className="w-10 text-center tabular-nums text-[#5f5e5b]">{Math.round(camera.scale * 100)}%</span>
              <button className="rounded px-1.5 py-0.5 hover:bg-[#f1f1ef]" onClick={() => setCamera((c) => ({ ...c, scale: Math.min(3, c.scale + 0.1) }))}>+</button>
              <span className="mx-1 h-3 w-px bg-[#e3e2e0]" />
              <button className="rounded px-1.5 py-0.5 text-[#5f5e5b] hover:bg-[#f1f1ef]" onClick={resetView} title="뷰 초기화">
                🎯
              </button>
            </div>

            {/* 좌하단 DDL 입출력 — 다이어그램 전체를 한 번에 가져오거나 내보낸다. */}
            <div className="pointer-events-auto absolute bottom-3 left-3 flex items-center gap-1 rounded-md border border-[#e3e2e0] bg-white p-1 text-[11px] shadow-sm">
              <button
                className="rounded px-2 py-1 text-[#5f5e5b] hover:bg-[#f1f1ef]"
                onClick={() => setDdlImportOpen(true)}
                title="SQL DDL 가져오기"
              >
                📥 DDL 가져오기
              </button>
              <button
                className="rounded px-2 py-1 text-[#5f5e5b] hover:bg-[#f1f1ef]"
                onClick={() => setSqlOpen(true)}
                title="SQL DDL 내보내기"
              >
                📤 DDL 내보내기
              </button>
            </div>
          </div>

        {/* 하단 힌트 바 */}
        <div className="flex items-center justify-between border-t border-[#efefed] bg-[#fafafa] px-4 py-2 text-[11px] text-[#9b9a97]">
          <span>
            💡 휠: 상하 이동 · <b>Shift + 휠</b>: 좌우 이동 · <b>Ctrl + 휠</b>: 확대/축소
          </span>
        </div>
      {sqlOpen && (
        <SqlExportDialog
          sql={toSql(diagram)}
          filename={diagram.meta.title}
          onClose={() => setSqlOpen(false)}
        />
      )}
      {ddlImportOpen && (
        <SqlImportDialog
          onImport={importDdl}
          onClose={() => setDdlImportOpen(false)}
        />
      )}
    </div>
  )
}

/**
 * DDL에서 가져온 테이블 묶음은 현재 설계의 오른쪽에 배치한다.
 * 기존 좌표를 건드리지 않으면서, 가져온 테이블끼리의 상대 위치와 관계선은 그대로 유지한다.
 */
function placeImportedTables(existingTables: ErdTable[], importedTables: ErdTable[]): ErdTable[] {
  if (existingTables.length === 0 || importedTables.length === 0) return importedTables

  const currentRight = Math.max(...existingTables.map((table) => table.x + (table.width || 600)))
  const importedLeft = Math.min(...importedTables.map((table) => table.x))
  const offsetX = currentRight + 80 - importedLeft

  return importedTables.map((table) => ({ ...table, x: table.x + offsetX }))
}

// ─────────────────────────────────────────────────────────
// 카디널리티 배지 (선 중앙)
// ─────────────────────────────────────────────────────────
function CardinalityBadge({
  path,
  cardinality,
  selected,
  onClick,
}: {
  path: { from: { x: number; y: number }; to: { x: number; y: number } }
  cardinality: Cardinality
  selected: boolean
  onClick: () => void
}) {
  const mx = (path.from.x + path.to.x) / 2
  const my = (path.from.y + path.to.y) / 2
  return (
    <g className="cursor-pointer" onClick={(e) => { e.stopPropagation(); onClick() }}>
      <rect
        x={mx - 18}
        y={my - 9}
        width={36}
        height={18}
        rx={9}
        fill="white"
        stroke={selected ? '#37352f' : '#2f6fd0'}
        strokeWidth={selected ? 1.75 : 1.4}
      />
      <text
        x={mx}
        y={my + 4}
        textAnchor="middle"
        fontSize={10}
        fontWeight={600}
        fill={selected ? '#37352f' : '#2f6fd0'}
      >
        {cardinality}
      </text>
    </g>
  )
}

function CanvasToolbar({
  tool,
  linking,
  onSelect,
  onAddTable,
  onRelation,
  onZoomIn,
  onZoomOut,
  onReset,
}: {
  tool: CanvasTool
  linking: { fromTable: string; fromColumn: string } | null
  onSelect: () => void
  onAddTable: () => void
  onRelation: () => void
  onZoomIn: () => void
  onZoomOut: () => void
  onReset: () => void
}) {
  return (
    <div
      className="pointer-events-auto absolute left-3 top-3 z-20 flex w-8 flex-col items-center overflow-hidden rounded-md border border-[#e3e2e0] bg-white p-0.5 shadow-sm"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <ToolButton active={tool === 'select'} title="선택 / 이동" onClick={onSelect}><CursorIcon /></ToolButton>
      <div className="my-0.5 h-px w-full bg-[#efefed]" />
      <ToolButton title="새 테이블" onClick={onAddTable}><TableIcon /></ToolButton>
      <ToolButton active={tool === 'relation'} title={linking ? '연결 대상 선택 중' : '관계 연결'} onClick={onRelation}><RelationIcon /></ToolButton>
      <div className="my-0.5 h-px w-full bg-[#efefed]" />
      <ToolButton title="확대" onClick={onZoomIn}><PlusIcon /></ToolButton>
      <ToolButton title="축소" onClick={onZoomOut}><MinusIcon /></ToolButton>
      <ToolButton title="뷰 초기화" onClick={onReset}><TargetIcon /></ToolButton>
    </div>
  )
}

function ToolButton({ active = false, title, onClick, children }: { active?: boolean; title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className={`grid h-7 w-7 place-items-center rounded transition-colors ${
        active ? 'bg-[#e8e7e4] text-[#37352f]' : 'text-[#777672] hover:bg-[#f1f1ef] hover:text-[#37352f]'
      }`}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function RelationPopover({
  relation,
  tables,
  x,
  y,
  onChange,
  onRemove,
}: {
  relation: ErdRelation
  tables: ErdTable[]
  x: number
  y: number
  onChange: (patch: Partial<ErdRelation>) => void
  onRemove: () => void
}) {
  const fromTable = tables.find((table) => table.id === relation.fromTable)
  const toTable = tables.find((table) => table.id === relation.toTable)
  const fromColumn = fromTable?.columns.find((column) => column.id === relation.fromColumn)
  const toColumn = toTable?.columns.find((column) => column.id === relation.toColumn)

  return (
    <div
      className="absolute z-10 w-[220px] rounded-md border border-[#e3e2e0] bg-white p-2 text-[10px] text-[#5f5e5b] shadow-lg"
      style={{ left: x - 110, top: y + 13 }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span className="font-semibold text-[#37352f]">관계 설정</span>
        <button className="rounded px-1 text-[#c34e4e] hover:bg-[#fff3f3]" title="관계 삭제" onClick={onRemove}><TrashIcon /></button>
      </div>
      <p className="mb-2 truncate rounded bg-[#f7f6f3] px-1.5 py-1 font-mono text-[9px] text-[#777672]" title={`${fromTable?.name}.${fromColumn?.name} → ${toTable?.name}.${toColumn?.name}`}>
        {fromTable?.name}.{fromColumn?.name} → {toTable?.name}.{toColumn?.name}
      </p>
      <div className="flex gap-1">
        {(['1:1', '1:N', 'N:N'] as Cardinality[]).map((cardinality) => (
          <button
            key={cardinality}
            type="button"
            className={`flex-1 rounded border px-1 py-1 font-medium ${
              relation.cardinality === cardinality
                ? 'border-[#37352f] bg-[#f1f1ef] text-[#37352f]'
                : 'border-[#e3e2e0] hover:bg-[#f7f7f5]'
            }`}
            onClick={() => onChange({ cardinality })}
          >
            {cardinality}
          </button>
        ))}
      </div>
      <label className="mt-2 flex items-center gap-1.5">
        <input type="checkbox" checked={relation.optional ?? false} onChange={(event) => onChange({ optional: event.target.checked })} />
        선택적 관계 (점선)
      </label>
      <input
        className="mt-2 w-full rounded border border-[#e3e2e0] px-1.5 py-1 text-[10px] outline-none focus:border-[#d3d1cb]"
        placeholder="관계 설명 (선택)"
        value={relation.label ?? ''}
        onChange={(event) => onChange({ label: event.target.value || undefined })}
      />
    </div>
  )
}

function SvgIcon({ children }: { children: ReactNode }) {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden>{children}</svg>
}

function ErdSaveIndicator({ status }: { status: ErdSaveStatus }) {
  const states: Record<ErdSaveStatus, { text: string; className: string }> = {
    idle: { text: '', className: '' },
    saving: { text: '저장 중…', className: 'text-[#9b9a97]' },
    saved: { text: '저장됨 ✓', className: 'text-green-600' },
    error: { text: '저장 실패', className: 'text-red-500' },
  }
  const state = states[status]
  return state.text ? <span className={`shrink-0 text-[12px] ${state.className}`}>{state.text}</span> : null
}

function CursorIcon() { return <SvgIcon><path d="m3.2 2.5 8.4 5.2-4.1.9-1.7 3.9-2.6-10Z" /><path d="m8.5 11 3 2.6" /></SvgIcon> }
function TableIcon() { return <SvgIcon><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="M2.5 6.2h11M6.2 6.2V13" /></SvgIcon> }
function RelationIcon() { return <SvgIcon><circle cx="4" cy="4" r="1.5" /><circle cx="12" cy="12" r="1.5" /><path d="m5.2 5.2 5.6 5.6M9.5 4h3v3M6.5 12h-3V9" /></SvgIcon> }
function PlusIcon() { return <SvgIcon><path d="M8 3.3v9.4M3.3 8h9.4" /></SvgIcon> }
function MinusIcon() { return <SvgIcon><path d="M3.3 8h9.4" /></SvgIcon> }
function TargetIcon() { return <SvgIcon><circle cx="8" cy="8" r="4.5" /><circle cx="8" cy="8" r="1" /><path d="M8 1.7v1.7M8 12.6v1.7M1.7 8h1.7M12.6 8h1.7" /></SvgIcon> }
function RefreshIcon({ spinning = false }: { spinning?: boolean }) { return <SvgIcon><path className={spinning ? 'origin-center animate-spin' : ''} d="M13 5.8A5.3 5.3 0 1 0 13.3 9" /><path d="M13 2.8v3.1H9.9" /></SvgIcon> }
function EditIcon() { return <SvgIcon><path d="m3 11.8.5-2.4 6.9-6.9 2.1 2.1-6.9 6.9-2.6.3Z" /><path d="m9.4 3.5 2.1 2.1M3 13h10" /></SvgIcon> }
function TrashIcon() { return <SvgIcon><path d="M3.5 5h9M6.3 3.5h3.4M5 5l.5 7h5l.5-7" /></SvgIcon> }

// ─────────────────────────────────────────────────────────
// SQL 내보내기 다이얼로그
// ─────────────────────────────────────────────────────────
function SqlExportDialog({ sql, filename, onClose }: { sql: string; filename: string; onClose: () => void }) {
  const dismissFromBackdrop = useBackdropDismiss<HTMLDivElement>(onClose, filename)
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sql)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard 실패 무시 */
    }
  }
  const download = () => {
    const safeName = (filename.trim() || 'schema').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'schema'
    const url = URL.createObjectURL(new Blob([sql], { type: 'application/sql;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${safeName}.sql`
    link.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50" onClick={dismissFromBackdrop}>
      <div
        className="flex h-[80vh] w-[900px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-[#e3e2e0] bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#efefed] px-4 py-3">
          <h3 className="text-[14px] font-semibold text-[#37352f]">📤 MariaDB SQL DDL 내보내기</h3>
          <div className="flex gap-2">
            <button
              className="rounded border border-[#e3e2e0] px-2.5 py-1 text-[12px] text-[#5f5e5b] hover:bg-[#f1f1ef]"
              onClick={copy}
            >
              {copied ? '복사됨 ✓' : '📋 클립보드 복사'}
            </button>
            <button
              className="rounded border border-[#e3e2e0] px-2.5 py-1 text-[12px] text-[#5f5e5b] hover:bg-[#f1f1ef]"
              onClick={download}
            >
              💾 .sql 저장
            </button>
            <button className="rounded px-2 py-1 text-[13px] text-[#9b9a97] hover:bg-[#f1f1ef]" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
        <textarea
          className="scrollbar-thin flex-1 resize-none bg-[#f7f6f3] p-4 font-mono text-[12px] text-[#37352f] outline-none"
          readOnly
          value={sql}
        />
      </div>
    </div>
  )
}

function SqlImportDialog({ onImport, onClose }: { onImport: (sql: string) => boolean; onClose: () => void }) {
  const [sql, setSql] = useState('')
  const dismissFromBackdrop = useBackdropDismiss<HTMLDivElement>(onClose)
  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50" onClick={dismissFromBackdrop}>
      <div
        className="flex h-[80vh] w-[900px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-[#e3e2e0] bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#efefed] px-4 py-3">
          <div>
            <h3 className="text-[14px] font-semibold text-[#37352f]">📥 SQL DDL 가져오기</h3>
            <p className="mt-0.5 text-[11px] text-[#9b9a97]">CREATE TABLE, PK, UNIQUE, DEFAULT, FK를 읽어 현재 설계에 추가합니다. 기존 테이블과 관계는 유지됩니다.</p>
          </div>
          <button className="rounded px-2 py-1 text-[13px] text-[#9b9a97] hover:bg-[#f1f1ef]" onClick={onClose}>
            ✕
          </button>
        </div>
        <textarea
          className="scrollbar-thin flex-1 resize-none bg-[#f7f6f3] p-4 font-mono text-[12px] text-[#37352f] outline-none"
          autoFocus
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          placeholder={'CREATE TABLE users (\n  id BIGINT PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE\n);\n\nCREATE TABLE posts (\n  id BIGINT PRIMARY KEY,\n  user_id BIGINT NOT NULL REFERENCES users(id)\n);'}
        />
        <div className="flex justify-end gap-2 border-t border-[#efefed] px-4 py-3">
          <button className="rounded border border-[#e3e2e0] px-3 py-1.5 text-[12px] hover:bg-[#f1f1ef]" onClick={onClose}>
            취소
          </button>
          <button
            className="rounded bg-[#37352f] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#565452] disabled:cursor-not-allowed disabled:bg-[#c9c8c4]"
            disabled={!sql.trim()}
            onClick={() => {
              if (onImport(sql)) onClose()
            }}
          >
            테이블 가져오기
          </button>
        </div>
      </div>
    </div>
  )
}
