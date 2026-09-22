type Guard = () => Promise<void> | void
const guards = new Set<Guard>()
export function registerRestartGuard(guard: Guard): () => void {
  guards.add(guard)
  return () => { guards.delete(guard) }
}
export async function prepareForRestart() {
  for (const guard of guards) await guard()
}
if (typeof window !== 'undefined') window.noteDesktop?.onPrepareRestart(prepareForRestart)
