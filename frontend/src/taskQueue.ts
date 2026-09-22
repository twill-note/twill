/** Only an explicitly ordered batch waits for its predecessors. */
export function canStartTask(
  session: { id: string; batchId?: string | null; batchOrder?: number | null },
  sessions: ReadonlyArray<{ id: string; kind: string; batchId?: string | null; batchOrder?: number | null; cardStatus?: string | null }>,
): boolean {
  const order = session.batchOrder
  if (!session.batchId || order == null) return true
  return !sessions.some((other) =>
    other.id !== session.id && other.kind === 'task' && other.batchId === session.batchId &&
    other.batchOrder != null && other.batchOrder < order &&
    !['verify', 'completed', 'done'].includes(other.cardStatus ?? ''),
  )
}
