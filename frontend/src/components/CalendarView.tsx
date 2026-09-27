import { useEffect, useState } from 'react'
import { api } from '../api'
import { useAppStore } from '../store'
import type { NoteMeta } from '../types'
import { dialog } from '../dialog'
import { tr } from '../i18n'

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

function ymd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export default function CalendarView() {
  const { openFile, refreshTree } = useAppStore()
  const today = new Date()
  const [cursor, setCursor] = useState({ year: today.getFullYear(), month: today.getMonth() + 1 })
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [selected, setSelected] = useState<string>(ymd(today))
  const [notes, setNotes] = useState<NoteMeta[]>([])

  useEffect(() => {
    api.calendar(cursor.year, cursor.month).then(setCounts)
  }, [cursor])

  useEffect(() => {
    api.notesByDate(selected).then(setNotes)
  }, [selected])

  const moveMonth = (delta: number) => {
    setCursor(({ year, month }) => {
      const d = new Date(year, month - 1 + delta, 1)
      return { year: d.getFullYear(), month: d.getMonth() + 1 }
    })
  }

  const createDailyNote = async () => {
    const name = await dialog.prompt('새 노트 이름', { defaultValue: selected, confirmLabel: '만들기' })
    if (!name?.trim()) return
    try {
      const res = await api.createEntry(`daily/${name.trim()}`, 'file', selected)
      await refreshTree()
      openFile(res.path)
    } catch (e) {
      dialog.alert((e as Error).message)
    }
  }

  const firstDay = new Date(cursor.year, cursor.month - 1, 1)
  const daysInMonth = new Date(cursor.year, cursor.month, 0).getDate()
  const leadingBlanks = firstDay.getDay()
  const cells: (number | null)[] = [
    ...Array.from({ length: leadingBlanks }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]
  const todayStr = ymd(today)

  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-y-auto p-8">
        <div className="mx-auto max-w-3xl">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-bold text-[#37352f]">
              {cursor.year}{tr("년")} {cursor.month}{tr("월")}
            </h2>
            <div className="flex gap-1 text-[13px]">
              <button className="rounded border border-[#e3e2e0] px-2.5 py-1 hover:bg-[#f1f1ef]" onClick={() => moveMonth(-1)}>
                ←
              </button>
              <button
                className="rounded border border-[#e3e2e0] px-2.5 py-1 hover:bg-[#f1f1ef]"
                onClick={() => {
                  setCursor({ year: today.getFullYear(), month: today.getMonth() + 1 })
                  setSelected(todayStr)
                }}
              >

                {tr("오늘")}
              </button>
              <button className="rounded border border-[#e3e2e0] px-2.5 py-1 hover:bg-[#f1f1ef]" onClick={() => moveMonth(1)}>
                →
              </button>
            </div>
          </div>

          <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-[#e9e9e7] bg-[#e9e9e7]">
            {WEEKDAYS.map((d, i) => (
              <div
                key={d}
                className={`bg-[#f7f7f5] py-1.5 text-center text-[12px] font-medium ${
                  i === 0 ? 'text-red-400' : i === 6 ? 'text-blue-400' : 'text-[#787774]'
                }`}
              >
                {d}
              </div>
            ))}
            {cells.map((day, i) => {
              if (day === null) return <div key={`b${i}`} className="min-h-20 bg-white" />
              const dateStr = `${cursor.year}-${String(cursor.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
              const count = counts[dateStr] ?? 0
              const isToday = dateStr === todayStr
              const isSelected = dateStr === selected
              return (
                <button
                  key={dateStr}
                  className={`min-h-20 bg-white p-1.5 text-left align-top transition hover:bg-[#fbfbfa] ${
                    isSelected ? 'ring-2 ring-inset ring-blue-400' : ''
                  }`}
                  onClick={() => setSelected(dateStr)}
                >
                  <span
                    className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[13px] ${
                      isToday ? 'bg-red-500 font-semibold text-white' : 'text-[#37352f]'
                    }`}
                  >
                    {day}
                  </span>
                  {count > 0 && (
                    <div className="mt-1 inline-block rounded bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-600">

                      {tr("노트")} {count}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="flex w-72 shrink-0 flex-col border-l border-[#e9e9e7] bg-[#fbfbfa]">
        <div className="flex items-center justify-between border-b border-[#efefed] px-4 py-3">
          <h3 className="text-[14px] font-semibold text-[#37352f]">{selected}</h3>
          <button
            className="rounded bg-[#37352f] px-2 py-1 text-[12px] text-white hover:bg-[#565452]"
            onClick={createDailyNote}
          >

            {tr("+ 새 노트")}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {notes.map((n) => (
            <button
              key={n.path}
              className="mb-1 block w-full rounded-md border border-[#efefed] bg-white px-3 py-2 text-left hover:border-[#d3d1cb]"
              onClick={() => openFile(n.path)}
            >
              <div className="truncate text-[13px] font-medium text-[#37352f]">📄 {n.title}</div>
              <div className="truncate text-[11px] text-[#9b9a97]">{n.path}</div>
              {n.tags.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {n.tags.map((t) => (
                    <span key={t} className="rounded-full bg-[#ececea] px-1.5 text-[10px] text-[#5f5e5b]">
                      #{t}
                    </span>
                  ))}
                </div>
              )}
            </button>
          ))}
          {notes.length === 0 && (
            <p className="px-2 py-4 text-center text-[12px] text-[#9b9a97]">{tr("이 날짜에 작성된 노트가 없습니다")}</p>
          )}
        </div>
      </div>
    </div>
  )
}
