import { create } from 'zustand'

/**
 * 공통 팝업 API: window.alert/confirm/prompt 대체.
 * 사용법 — await dialog.alert('...'), if (await dialog.confirm('...')) ..., const v = await dialog.prompt('...')
 * App.tsx에 <DialogHost /> 가 한 번 마운트되어 있어야 한다.
 */

export type DialogKind = 'alert' | 'confirm' | 'prompt'

export interface DialogOptions {
  /** 본문 설명 (제목 아래 작은 글씨) */
  detail?: string
  /** 확인 버튼 라벨 (기본: 확인) */
  confirmLabel?: string
  /** 위험 동작(삭제 등) — 확인 버튼을 빨간색으로 */
  danger?: boolean
  /** prompt 전용 */
  placeholder?: string
  defaultValue?: string
}

export interface DialogRequest extends DialogOptions {
  kind: DialogKind
  message: string
  resolve: (value: string | boolean | null) => void
}

interface DialogStore {
  queue: DialogRequest[]
  push: (req: DialogRequest) => void
  shift: () => void
}

export const useDialogStore = create<DialogStore>((set) => ({
  queue: [],
  push: (req) => set((s) => ({ queue: [...s.queue, req] })),
  shift: () => set((s) => ({ queue: s.queue.slice(1) })),
}))

function open(kind: DialogKind, message: string, opts: DialogOptions) {
  return new Promise<string | boolean | null>((resolve) => {
    useDialogStore.getState().push({ kind, message, resolve, ...opts })
  })
}

export const dialog = {
  alert: (message: string, opts: DialogOptions = {}): Promise<void> =>
    open('alert', message, opts).then(() => undefined),
  confirm: (message: string, opts: DialogOptions = {}): Promise<boolean> =>
    open('confirm', message, opts).then((v) => v === true),
  /** 확인 시 입력값, 취소 시 null */
  prompt: (message: string, opts: DialogOptions = {}): Promise<string | null> =>
    open('prompt', message, opts).then((v) => (typeof v === 'string' ? v : null)),
}
