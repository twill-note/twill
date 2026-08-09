import { useEffect, useRef, useState } from 'react'

const PRESETS = [
  '📝', '📄', '📁', '📊', '📈', '📅', '✅', '❗',
  '💡', '🔥', '⭐', '🚀', '🎯', '📌', '🔖', '💼',
  '🧠', '🔧', '🛠️', '🐛', '📚', '🔒', '🔑', '🌐',
  '💾', '🖥️', '📱', '☁️', '⚙️', '🧪', '📦', '🗂️',
  '✏️', '🗒️', '💬', '❓', '⚠️', '🕒', '🏠', '🎨',
  '🧩', '🍀', '🌙', '☀️', '❤️', '👍', '🎉', '💰',
]

interface Props {
  onSelect: (emoji: string) => void
  onRemove?: () => void
  onClose: () => void
}

/** 이모지 선택 팝오버 — 부모는 relative 컨테이너여야 한다. */
export default function EmojiPicker({ onSelect, onRemove, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [custom, setCustom] = useState('')

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="absolute top-full left-0 z-40 mt-1 w-[264px] rounded-lg border border-[#e3e2e0] bg-white p-2 shadow-xl"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="grid grid-cols-8 gap-0.5">
        {PRESETS.map((e) => (
          <button
            key={e}
            className="native-emoji rounded p-1 text-[17px] hover:bg-[#f1f1ef]"
            onClick={() => {
              onSelect(e)
              onClose()
            }}
          >
            {e}
          </button>
        ))}
      </div>
      <div className="mt-2 flex gap-1.5">
        <input
          className="min-w-0 flex-1 rounded border border-[#e3e2e0] px-2 py-1 text-[12px] outline-none focus:border-blue-400"
          placeholder="직접 입력 (예: 🐳)"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && custom.trim()) {
              onSelect(custom.trim())
              onClose()
            }
          }}
        />
        {onRemove && (
          <button
            className="rounded border border-[#e3e2e0] px-2 py-1 text-[12px] text-[#5f5e5b] hover:bg-[#f1f1ef]"
            onClick={() => {
              onRemove()
              onClose()
            }}
          >
            제거
          </button>
        )}
      </div>
    </div>
  )
}
