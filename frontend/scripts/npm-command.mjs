/**
 * Return an npm command that child_process can execute on the current platform.
 * On Windows npm is a .cmd shim; routing through cmd.exe avoids spawn failures
 * when the desktop build is triggered by Electron/Node.
 */
export function npmRunCommand(scriptName, platform = process.platform, env = process.env) {
  if (typeof scriptName !== 'string' || !/^[a-z0-9:_-]+$/i.test(scriptName)) {
    throw new TypeError(`잘못된 npm 스크립트 이름입니다: ${scriptName}`)
  }

  if (platform === 'win32') {
    return {
      command: env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `npm.cmd run ${scriptName}`],
    }
  }

  return {
    command: 'npm',
    args: ['run', scriptName],
  }
}
