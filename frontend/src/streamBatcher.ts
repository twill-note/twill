type StreamEvent = { type: string; itemId?: unknown; text?: unknown; [key: string]: unknown }

/** Coalesce adjacent text chunks. Lifecycle/control events flush in arrival order. */
export function createStreamBatcher(dispatch: (event: StreamEvent) => void) {
  let pending: StreamEvent | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    const event = pending
    pending = null
    if (event) dispatch(event)
  }
  return {
    flush,
    push(event: StreamEvent) {
      if (!['reasoning_delta', 'tool_output_delta'].includes(event.type)) {
        flush()
        dispatch(event)
        return
      }
      if (pending && (pending.type !== event.type || pending.itemId !== event.itemId)) flush()
      pending = pending ? { ...pending, text: String(pending.text ?? '') + String(event.text ?? '') } : event
      if (timer === undefined) timer = setTimeout(flush, 50)
    },
  }
}
