"""Resolve Codex npm launchers without invoking a command shell on Windows."""
import os
from pathlib import Path
import shutil


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

    if proc.returncode is not None:
        return
    if os.name == 'nt':
        killer = await asyncio.create_subprocess_exec(
            'taskkill.exe', '/PID', str(proc.pid), '/T', '/F',
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            creationflags=0x08000000,
        )
        await asyncio.wait_for(killer.wait(), timeout=10)
        if killer.returncode != 0 and proc.returncode is None:
            raise RuntimeError('Codex 프로세스를 종료하지 못했습니다.')
        await asyncio.wait_for(proc.wait(), timeout=timeout)
        return
    try:
        proc.terminate()
        await asyncio.wait_for(proc.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
    except ProcessLookupError:
        pass
