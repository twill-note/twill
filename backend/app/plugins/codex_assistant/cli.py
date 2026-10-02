"""Resolve Codex npm launchers without invoking a command shell on Windows."""
import os
import ntpath
import json
from pathlib import Path
import shutil
import signal


def codex_process_options() -> dict:
    env = dict(os.environ)
    env.pop("TWILL_DESKTOP_SHUTDOWN_TOKEN", None)
    return {"env": env, **({"creationflags": 0x08000200} if os.name == "nt" else {"start_new_session": True})}


def _windows_shell_environment(env: dict[str, str], is_file=os.path.isfile) -> tuple[dict[str, str], str]:
    """Filter only incompatible PowerShell entries during Codex shell discovery.

    The original PATH is restored for commands via shell_environment_policy, so
    unrelated WindowsApps aliases remain available inside the selected shell.
    """
    result = dict(env)
    path_key = next((key for key in env if key.lower() == "path"), "PATH")
    entries = env.get(path_key, "").split(";")
    safe = []
    shells = []
    for entry in entries:
        directory = entry.strip().strip('"')
        normalized = ntpath.normpath(directory).lower()
        pwsh = ntpath.join(directory, "pwsh.exe")
        store_alias = normalized.endswith(r"\microsoft\windowsapps")
        store_package = any(part.startswith("microsoft.powershell_") for part in normalized.split("\\"))
        if (store_alias or store_package) and is_file(pwsh):
            continue
        safe.append(entry)
        if directory and is_file(pwsh):
            shells.append(pwsh)
    windir = next((value for key, value in env.items() if key.lower() == "systemroot"), None)
    windir = windir or next((value for key, value in env.items() if key.lower() == "windir"), r"C:\Windows")
    builtin = ntpath.join(windir, r"System32\WindowsPowerShell\v1.0\powershell.exe")
    shell = shells[0] if shells else builtin
    if not is_file(shell):
        raise FileNotFoundError("실행 가능한 PowerShell을 찾을 수 없습니다. Windows 기본 PowerShell 경로를 확인하세요.")
    # Explicitly prefer a regular PowerShell installation; never use a Store alias.
    selected_dir = ntpath.dirname(shell)
    path = ";".join(safe)
    if safe != entries or not shells:
        path = ";".join([selected_dir, *safe])
    result[path_key] = path
    return result, shell


def codex_app_server_launch() -> tuple[list[str], dict, str | None]:
    options = codex_process_options()
    args = ["app-server"]
    shell = None
    if os.name == "nt":
        original = options["env"]
        options["env"], shell = _windows_shell_environment(original)
        original_path = next((v for k, v in original.items() if k.lower() == "path"), "")
        # Set at process startup: discovery uses the sanitized process env, shell
        # commands inherit the complete user PATH. No global environment changes.
        args += ["-c", "shell_environment_policy.set.PATH=" + json.dumps(original_path)]
    return codex_command(*args), options, shell


def codex_command(*args: str) -> list[str]:
    from .codex_cli import codex_binary

    binary = codex_binary()
    if not binary:
        raise FileNotFoundError("codex CLI가 설치되어 있지 않습니다")
    return command_for_binary(binary, *args)


def command_for_binary(binary: str, *args: str) -> list[str]:
    if os.name == "nt" and Path(binary).suffix.lower() in {".cmd", ".bat"}:
        launcher = Path(binary).parent / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
        sibling_node = Path(binary).parent / "node.exe"
        node = str(sibling_node) if sibling_node.is_file() else shutil.which("node")
        if not node or not launcher.is_file():
            raise FileNotFoundError("Codex의 Node.js 실행 경로를 찾을 수 없습니다")
        return [node, str(launcher), *args]
    return [binary, *args]


async def stop_codex_process(proc, timeout: float = 3) -> None:
    """Windows npm launches a Node parent and Rust child; terminate both."""
    import asyncio

    if os.name == 'nt':
        if proc.returncode is not None:
            return
        killer = await asyncio.create_subprocess_exec(
            'taskkill.exe', '/PID', str(proc.pid), '/T', '/F',
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            creationflags=0x08000000,
        )
        try:
            await asyncio.wait_for(killer.wait(), timeout=10)
        except asyncio.TimeoutError:
            killer.kill()
            await killer.wait()
            raise
        if killer.returncode != 0 and proc.returncode is None:
            raise RuntimeError('Codex 프로세스를 종료하지 못했습니다.')
        await asyncio.wait_for(proc.wait(), timeout=timeout)
        return
    # Every managed Codex command starts a new session. Reap that session even
    # if the npm parent has exited while its Rust child still owns a pipe.
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(proc.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await asyncio.wait_for(proc.wait(), timeout=timeout)
