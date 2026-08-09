interface Props {
  enabled: boolean
  onToggle: () => void
}

/** 본문 편집기에서 공통으로 쓰는 브라우저 맞춤법 검사 토글. */
export default function SpellcheckToggleButton({ enabled, onToggle }: Props) {
  return (
    <button
      type="button"
      className={`rounded px-1.5 py-0.5 text-[13px] hover:bg-[#f1f1ef] ${
        enabled ? 'text-[#37352f]' : 'text-[#c8c7c4] line-through'
      }`}
      title="맞춤법 검사"
      aria-label={`맞춤법 검사 ${enabled ? '끄기' : '켜기'}`}
      aria-pressed={enabled}
      onClick={onToggle}
    >
      가<span className="text-[10px] align-top">✓</span>
    </button>
  )
}
