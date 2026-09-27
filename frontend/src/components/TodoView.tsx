import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useAppStore } from '../store'
import type { TodoGroup } from '../types'
import { dialog } from '../dialog'
import { tr } from '../i18n'

export default function TodoView() {
  const openFile = useAppStore((s) => s.openFile)
  const [groups, setGroups] = useState<TodoGroup[]>([])
  const [includeDone, setIncludeDone] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (withDone: boolean) => {
    setLoading(true)
    try {
      setGroups(await api.todos(withDone))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(includeDone)
  }, [load, includeDone])

  useEffect(() => {
    const onDataChanged = (event: Event) => {
      const type = (event as CustomEvent<{ type?: string }>).detail?.type
      if (type === 'todos-changed' || type === 'fs-changed') void load(includeDone)
    }
    window.addEventListener('twill:data-changed', onDataChanged)
    return () => window.removeEventListener('twill:data-changed', onDataChanged)
  }, [includeDone, load])

  const toggle = async (path: string, line: number, text: string) => {
    try {
      await api.toggleTodo(path, line, text)
      await load(includeDone)
    } catch (e) {
      dialog.alert((e as Error).message)
    }
  }

  const total = groups.reduce((n, g) => n + g.items.filter((i) => !i.done).length, 0)

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-[#37352f]">{tr("✅ 할 일 모아보기")}</h2>
            <p className="mt-0.5 text-[13px] text-[#9b9a97]">

              {tr("모든 노트의 체크박스를 한곳에서 · 미완료")} {total}{tr("개")}
            </p>
          </div>
          <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-[#5f5e5b]">
            <input
              type="checkbox"
              checked={includeDone}
              onChange={(e) => setIncludeDone(e.target.checked)}
            />

            {tr("완료 항목 표시")}
          </label>
        </div>

        {loading && groups.length === 0 && <p className="text-[13px] text-[#9b9a97]">{tr("불러오는 중…")}</p>}

        {!loading && groups.length === 0 && (
          <div className="rounded-lg border border-dashed border-[#e3e2e0] px-4 py-10 text-center text-[13px] text-[#9b9a97]">

            {tr("남은 할 일이 없습니다 🎉")}
            <br />

            {tr("노트에")} <code className="rounded bg-[#f1f1ef] px-1">{tr("- [ ] 할 일")}</code>  {tr("을 적으면 여기에 모입니다")}
          </div>
        )}

        {groups.map((g) => (
          <div key={g.path} className="mb-4 rounded-lg border border-[#efefed] bg-white">
            <button
              className="flex w-full items-baseline gap-2 border-b border-[#f4f4f2] px-4 py-2.5 text-left hover:bg-[#fbfbfa]"
              onClick={() => openFile(g.path)}
              title={g.path}
            >
              <span className="truncate text-[14px] font-semibold text-[#37352f]">📄 {g.title}</span>
              {g.date && <span className="shrink-0 text-[11px] text-[#9b9a97]">{g.date}</span>}
              <span className="ml-auto shrink-0 text-[11px] text-[#c8c7c4]">{g.path}</span>
            </button>
            <div className="px-4 py-2">
              {g.items.map((item) => (
                <label
                  key={`${item.line}:${item.text}`}
                  className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 hover:bg-[#fbfbfa]"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={item.done}
                    onChange={() => toggle(g.path, item.line, item.text)}
                  />
                  <span className={`text-[13px] ${item.done ? 'text-[#c8c7c4] line-through' : 'text-[#37352f]'}`}>
                    {item.text}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
