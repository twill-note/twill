import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const TOOLTIP_ATTRIBUTE = 'data-desktop-tooltip'
const SHOW_DELAY_MS = 400
const VIEWPORT_MARGIN = 8
const ANCHOR_GAP = 7

type TooltipState = {
  text: string
  target: Element
}

type TooltipPosition = {
  left: number
  top: number
}

function tooltipTarget(value: EventTarget | null): Element | null {
  return value instanceof Element
    ? value.closest(`[${TOOLTIP_ATTRIBUTE}]`)
    : null
}

function isWithinTarget(target: Element, relatedTarget: EventTarget | null) {
  return relatedTarget instanceof Node && target.contains(relatedTarget)
}

function migrateTitle(element: Element) {
  const title = element.getAttribute('title')
  if (title === null) return
  const normalized = title.trim()
  if (normalized) element.setAttribute(TOOLTIP_ATTRIBUTE, normalized)
  else element.removeAttribute(TOOLTIP_ATTRIBUTE)
  element.removeAttribute('title')
}

function migrateTitles(root: ParentNode) {
  if (root instanceof Element && root.hasAttribute('title')) migrateTitle(root)
  root.querySelectorAll('[title]').forEach(migrateTitle)
}

export default function DesktopTooltip() {
  const enabled = Boolean(window.noteDesktop)
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const [position, setPosition] = useState<TooltipPosition>({ left: 0, top: 0 })
  const tooltipRef = useRef<HTMLDivElement>(null)
  const showTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled) return

    const clearShowTimer = () => {
      if (showTimerRef.current === null) return
      window.clearTimeout(showTimerRef.current)
      showTimerRef.current = null
    }
    const hide = () => {
      clearShowTimer()
      setTooltip(null)
    }
    const show = (target: Element, delay: number) => {
      const text = target.getAttribute(TOOLTIP_ATTRIBUTE)?.trim()
      if (!text) return
      clearShowTimer()
      showTimerRef.current = window.setTimeout(() => {
        showTimerRef.current = null
        if (!target.isConnected) return
        setTooltip({ text, target })
      }, delay)
    }
    const onPointerOver = (event: PointerEvent) => {
      const target = tooltipTarget(event.target)
      if (!target || isWithinTarget(target, event.relatedTarget)) return
      show(target, SHOW_DELAY_MS)
    }
    const onPointerOut = (event: PointerEvent) => {
      const target = tooltipTarget(event.target)
      if (!target || isWithinTarget(target, event.relatedTarget)) return
      hide()
    }
    const onFocusIn = (event: FocusEvent) => {
      const target = tooltipTarget(event.target)
      if (target) show(target, 0)
    }
    const onFocusOut = (event: FocusEvent) => {
      const target = tooltipTarget(event.target)
      if (!target || isWithinTarget(target, event.relatedTarget)) return
      hide()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide()
    }

    migrateTitles(document)
    const observer = new MutationObserver((records) => {
      records.forEach((record) => {
        if (record.type === 'attributes') migrateTitle(record.target as Element)
        record.addedNodes.forEach((node) => {
          if (node instanceof Element) migrateTitles(node)
        })
      })
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['title'],
      childList: true,
      subtree: true,
    })

    document.addEventListener('pointerover', onPointerOver)
    document.addEventListener('pointerout', onPointerOut)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', hide)
    window.addEventListener('resize', hide)
    window.addEventListener('scroll', hide, true)

    return () => {
      clearShowTimer()
      observer.disconnect()
      document.removeEventListener('pointerover', onPointerOver)
      document.removeEventListener('pointerout', onPointerOut)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', hide)
      window.removeEventListener('resize', hide)
      window.removeEventListener('scroll', hide, true)
    }
  }, [enabled])

  useLayoutEffect(() => {
    if (!tooltip || !tooltipRef.current) return
    const anchor = tooltip.target.getBoundingClientRect()
    const popup = tooltipRef.current.getBoundingClientRect()
    const left = Math.min(
      window.innerWidth - VIEWPORT_MARGIN - popup.width / 2,
      Math.max(VIEWPORT_MARGIN + popup.width / 2, anchor.left + anchor.width / 2),
    )
    const fitsBelow = anchor.bottom + ANCHOR_GAP + popup.height <= window.innerHeight - VIEWPORT_MARGIN
    const top = fitsBelow
      ? anchor.bottom + ANCHOR_GAP
      : Math.max(VIEWPORT_MARGIN, anchor.top - ANCHOR_GAP - popup.height)
    setPosition({ left, top })
  }, [tooltip])

  if (!enabled || !tooltip) return null

  return createPortal(
    <div
      ref={tooltipRef}
      className="desktop-tooltip"
      role="tooltip"
      style={{ left: position.left, top: position.top, transform: 'translateX(-50%)' }}
    >
      {tooltip.text}
    </div>,
    document.body,
  )
}
