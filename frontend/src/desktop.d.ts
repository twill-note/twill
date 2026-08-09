export {}

type DesktopDocumentTarget = {
  kind: 'note' | 'erd'
  path: string
}

declare global {
  interface Window {
    noteDesktop?: {
      isDesktop: true
      platform: string
      versions: Readonly<{ chrome: string; electron: string }>
      openQuickMemo: () => Promise<void>
      openByeoriWindow: (point?: { x: number; y: number }) => Promise<boolean>
      focusByeoriWindow: () => Promise<boolean>
      isByeoriWindowOpen: () => Promise<boolean>
      reattachByeoriWindow: () => Promise<boolean>
      openDocumentInMain: (target: DesktopDocumentTarget) => Promise<boolean>
      restartApp: () => Promise<boolean>
      onByeoriWindowChange: (callback: (open: boolean) => void) => () => void
      onShowByeoriDock: (callback: () => void) => () => void
      onOpenMainDocument: (callback: (target: DesktopDocumentTarget) => void) => () => void
      setWindowBackground: (color: string) => void
      windowControls: {
        minimize: () => Promise<boolean>
        toggleMaximize: () => Promise<boolean>
        close: () => Promise<boolean>
        isMaximized: () => Promise<boolean>
        beginMove: () => void
        endMove: () => void
        beginResize: (direction: 'north' | 'south' | 'east' | 'west' | 'north-east' | 'north-west' | 'south-east' | 'south-west', point: { x: number; y: number }) => void
        updateResize: (point: { x: number; y: number }) => void
        endResize: (point?: { x: number; y: number }) => void
        onMaximizedChange: (callback: (maximized: boolean) => void) => () => void
      }
    }
  }
}
