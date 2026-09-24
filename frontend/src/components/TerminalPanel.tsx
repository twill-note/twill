import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import { APP_MONO_FONT_FAMILY, ensureKoreanFontLoaded } from '../fontFamilies'
import { useAppStore } from '../store'
import { useThemeStore } from '../theme'

/**
 * 우측 도크에 마운트되는 터미널 탭 본문.
 * RightDock 이 열려있고 활성 탭이 이 컴포넌트일 때만 마운트된다.
 * 셸 세션은 마운트 유지 동안 지속되며, 도크 자체를 닫아도(display:none) 파괴되지 않는다.
 */
export default function TerminalPanel() {
  const rightDockOpen = useAppStore((s) => s.rightDockOpen)
  const activeRightTab = useAppStore((s) => s.activeRightTab)
  const appTheme = useThemeStore((s) => s.theme)
  const isVisible = rightDockOpen && activeRightTab === 'system:terminal'
  const [connected, setConnected] = useState(false)
  const [session, setSession] = useState(0)

  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!hostRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: APP_MONO_FONT_FAMILY,
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: terminalTheme(useThemeStore.getState().theme),
    })
    term.attachCustomKeyEventHandler(
      (ev) => !(ev.ctrlKey && (ev.key === '`' || ev.code === 'Backquote')),
    )
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(hostRef.current)
    fit.fit()
    let disposed = false
    void Promise.all([ensureKoreanFontLoaded(), document.fonts.load('13px "JetBrains Mono"')]).then(() => {
      if (!disposed) { fit.fit(); term.refresh(0, term.rows - 1) }
    }).catch(() => {})
    termRef.current = term
    fitRef.current = fit

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/api/terminal/ws`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      term.focus()
    }
    ws.onmessage = (e) => term.write(new Uint8Array(e.data as ArrayBuffer))
    ws.onclose = () => {
      setConnected(false)
      term.write('\r\n\x1b[90m[세션이 종료되었습니다. ↻ 버튼으로 다시 시작하세요]\x1b[0m\r\n')
    }

    const send = (msg: object) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    }
    term.onData((data) => send({ type: 'input', data }))
    term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }))

    const observer = new ResizeObserver(() => {
      if (hostRef.current && hostRef.current.offsetWidth > 0) fit.fit()
    })
    observer.observe(hostRef.current)

    return () => {
      disposed = true
      observer.disconnect()
      ws.onclose = null
      ws.close()
      term.dispose()
      termRef.current = null
      wsRef.current = null
    }
  }, [session])

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme(appTheme)
  }, [appTheme])

  useEffect(() => {
    if (isVisible && termRef.current) {
      requestAnimationFrame(() => {
        fitRef.current?.fit()
        termRef.current?.focus()
      })
    }
  }, [isVisible])

  const restart = () => setSession((s) => s + 1)

  return (
    <div className="twill-terminal flex h-full min-h-0 flex-col bg-[#1e1e1e]">
      <div className="twill-terminal-toolbar flex h-8 shrink-0 items-center justify-between border-b border-[#333] px-3">
        <span className="twill-terminal-title flex items-center gap-2 text-[12px] font-medium text-[#cccccc]">
          <span className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-[#4ec9b0]' : 'bg-[#6e6e6e]'}`} />
          터미널
        </span>
        <button
          className="twill-terminal-restart rounded px-1.5 py-0.5 text-[13px] text-[#9d9d9d] hover:bg-[#333] hover:text-white"
          title="세션 다시 시작"
          onClick={restart}
        >
          ↻
        </button>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 pl-2 pt-1" />
    </div>
  )
}

function terminalTheme(theme: string) {
  if (theme === 'graphiteteal') {
    return {
      background: '#151719', foreground: '#ccdDe3', cursor: '#80cbc4',
      selectionBackground: '#303b3e', black: '#151719', red: '#f78c6c',
      green: '#c3e88d', yellow: '#ffc857', blue: '#82aaff', magenta: '#c792ea',
      cyan: '#89ddff', white: '#ccdDe3', brightBlack: '#61686b', brightRed: '#ff9cac',
      brightGreen: '#d7f5aa', brightYellow: '#ffda85', brightBlue: '#a8c3ff',
      brightMagenta: '#dfb4f4', brightCyan: '#a8e8ff', brightWhite: '#e8f1f4',
    }
  }
  return {
    background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4',
    selectionBackground: '#264f78',
  }
}
