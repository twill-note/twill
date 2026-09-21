/** Stop the backend tree before relaunch so the new UI cannot reuse stale auth. */
export async function stopDesktopBackend({ child, owned, platform, runCommand, killGroup, timeoutMs = 5000 }) {
  if (!owned || !child || child.exitCode !== null || child.signalCode) return
  if (platform === 'win32') {
    await runCommand('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], 10_000)
    return
  }
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  let timer
  await Promise.race([
    exited,
    new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs) }),
  ])
  clearTimeout(timer)
  try { killGroup(-child.pid, 'SIGKILL') } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  if (child.exitCode === null && child.signalCode === null) await exited
}

export function desktopRelaunchArgs(argv) {
  return [...argv.slice(1).filter((arg) => arg !== '--fresh-backend'), '--fresh-backend']
}
