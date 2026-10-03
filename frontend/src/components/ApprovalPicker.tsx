import { useEffect, useId, useRef, useState } from 'react'
import { useAiStore } from '../aiStore'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

export type ApprovalMode = 'never' | 'on-request'
export const approvalMode = (value: unknown): ApprovalMode => value === 'on-request' ? 'on-request' : 'never'

/** Shared fixed choices for chat, task cards and workspace defaults. */
export default function ApprovalPicker({ value, onChange, disabled, label, title }: {
  value: ApprovalMode
  onChange: (value: ApprovalMode) => void | Promise<void>
  disabled?: boolean
  label: string
  title?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  const options = [{ value: 'never' as const, label: t('자동 모드') }, { value: 'on-request' as const, label: t('승인 모드') }]
  useEffect(() => {
    if (!open || disabled) return
    const rect = trigger.current!.getBoundingClientRect()
    setPosition({ top: rect.bottom + 90 > window.innerHeight ? rect.top - 86 : rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - 176)) })
    menu.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus()
    const dismiss = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false)
    }
    const close = () => setOpen(false)
    document.addEventListener('pointerdown', dismiss)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open, disabled])
  return <>
    <button ref={trigger} type="button" aria-label={label} title={title} disabled={disabled || saving} aria-haspopup="listbox" aria-expanded={open && !disabled} aria-controls={open ? id : undefined}
      className="flex items-center gap-2 whitespace-nowrap rounded border border-[#e3e2e0] bg-white px-2 py-1 text-[11px] text-[#37352f] hover:bg-[#f7f7f5] disabled:opacity-50"
      onClick={event => { event.stopPropagation(); setOpen(!open) }}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) } }}>
      {options.find(option => option.value === value)?.label}<span aria-hidden="true" className="text-[#9b9a97]">⌄</span>
    </button>
    {open && !disabled && createPortal(<div ref={menu} id={id} role="listbox" aria-label={label} style={position}
      className="fixed z-[10000] w-40 rounded-md border border-[#e3e2e0] bg-white p-1 text-[#37352f] shadow-lg"
      onKeyDown={event => {
        if (event.key === 'Escape' || event.key === 'Tab') { setOpen(false); if (event.key === 'Escape') { event.preventDefault(); trigger.current?.focus() } event.stopPropagation() }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          const buttons = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('[role="option"]'))
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
          buttons[event.key === 'Home' ? 0 : event.key === 'End' ? 1 : (current + 1) % 2]?.focus()
        }
      }}>
      {options.map(option => <button type="button" key={option.value} role="option" aria-selected={value === option.value}
        className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-[12px] hover:bg-[#f7f7f5] focus:bg-[#f1f1ef] focus:outline-none"
        onClick={async event => {
          event.stopPropagation(); setOpen(false); trigger.current?.focus()
          if (option.value === value) return
          setSaving(true)
          try { await onChange(option.value); window.dispatchEvent(new Event('twill:approval-mode-changed')); useAiStore.getState().notifySave(true) }
          catch { useAiStore.getState().notifySave(false) }
          finally { setSaving(false) }
        }}>
        <span aria-hidden="true" className="w-3">{value === option.value ? '✓' : ''}</span>{option.label}
      </button>)}
    </div>, document.body)}
  </>
}
