import { tr } from '../i18n'
interface Props {
  enabled: boolean
  onToggle: () => void
}

/** 본문 편집기에서 공통으로 쓰는 브라우저 맞춤법 검사 토글. */
export default function SpellcheckToggleButton({ enabled, onToggle }: Props) {
  return (
    <button
      type="button"
      className={`inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded px-1.5 py-0.5 text-[13px] hover:bg-[#f1f1ef] ${
        enabled ? 'text-[#37352f]' : 'text-[#c8c7c4] line-through'
      }`}
      title={tr("맞춤법 검사")}
      aria-label={`맞춤법 검사 ${enabled ? tr("끄기") : tr("켜기")}`}
      aria-pressed={enabled}
      onClick={onToggle}
    >

      {tr("가")}<span className="text-[10px]">✓</span>
    </button>
  )
}
