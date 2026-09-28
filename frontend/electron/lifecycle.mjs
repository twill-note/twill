const hasExited = (child) => child.exitCode !== null || Boolean(child.signalCode)

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const finish = (exited) => {
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
  })
}

/** Include descendants in their own PTY sessions and process groups. */
export function desktopDescendants(snapshot, rootPid) {
  const rows = snapshot.trim().split('\n').map((line) => {
    const [pid, parent, group] = line.trim().split(/\s+/).map(Number)
    return { pid, parent, group }
  }).filter((row) => row.pid > 0 && row.parent > 0 && row.group > 0)
  const descendants = new Map()
  const parents = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (parents.has(row.parent) && !parents.has(row.pid)) {
        descendants.set(row.pid, row)
        parents.add(row.pid)
        changed = true
      }
    }
  }
  return [...descendants.values()]
}

/** Gracefully stop the owned backend, then reap its full process tree. */
export async function stopDesktopBackend({
  child, owned, platform, runCommand, killGroup, killProcess,
  requestShutdown, timeoutMs = 8000, forceTimeoutMs = 3000,
}) {
  if (!owned || !child || !child.pid) return
  let descendants = []
  if (platform !== 'win32' && runCommand && !hasExited(child)) {
    try {
      descendants = desktopDescendants(await runCommand('ps', ['-axo', 'pid=,ppid=,pgid=']), child.pid)
    } catch (error) {
      console.warn('[desktop] 자식 프로세스 목록 조회 실패. 백엔드 자체 정리와 프로세스 그룹 종료로 진행합니다.', error.message)
    }
  }
  if (!hasExited(child)) {
    let requested = false
    if (requestShutdown) {
      try {
        await requestShutdown()
        requested = true
      } catch (error) {
        console.warn('[desktop] 정상 종료 요청 실패, 프로세스 종료로 진행합니다.', error.message)
      }
    }
    if (!requested && platform !== 'win32') {
      try { child.kill('SIGTERM') } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    if (requested || platform !== 'win32') await waitForExit(child, timeoutMs)
  }
  if (platform === 'win32') {
    // A kill-on-close Windows job also closes AI/terminal children on exit.
    // taskkill handles a hung backend; it can race with a successful exit.
    if (!hasExited(child)) {
      try {
        await runCommand('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], 10_000)
      } catch (error) {
        if (!hasExited(child)) throw error
      }
    }
  } else {
    const ownedPids = new Set([child.pid, ...descendants.map((row) => row.pid)])
    const groups = new Set([child.pid, ...descendants.filter((row) => ownedPids.has(row.group)).map((row) => row.group)])
    for (const group of groups) {
      try { killGroup(-group, 'SIGKILL') } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    for (const { pid } of descendants) {
      try { killProcess?.(pid, 'SIGKILL') } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
  }
  if (!await waitForExit(child, forceTimeoutMs)) {
    throw new Error(`백엔드 프로세스가 종료되지 않았습니다 (PID ${child.pid}).`)
  }
}

export function desktopRelaunchArgs(argv) {
  return [...argv.slice(1).filter((arg) => arg !== '--fresh-backend'), '--fresh-backend']
}
