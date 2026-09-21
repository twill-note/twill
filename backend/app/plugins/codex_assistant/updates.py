"""Codex release checks and installation-aware updates (no shell interpolation)."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import re
import shutil
import time
from urllib.request import Request, urlopen

VERSION_RE = re.compile(r"(?<![\d.])(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?![\d.])")
_cache: tuple[float, dict] | None = None
_check_lock = asyncio.Lock()


def version_key(value: str) -> tuple:
    core, _, pre = value.partition("-")
    return (*map(int, core.split(".")), not bool(pre), pre)


def latest_release() -> str:
    request = Request("https://registry.npmjs.org/@openai/codex/latest", headers={"User-Agent": "Twill"})
    with urlopen(request, timeout=10) as response:
        data = json.loads(response.read(1_000_000))
    version = data.get("version", "")
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise RuntimeError("Codex 최신 버전 응답이 올바르지 않습니다.")
    return version


async def run_command(args: list[str], timeout: float = 20) -> str:
    # npm.cmd is a Windows shim. Invoke its JS entry with Node to avoid cmd.exe
    # quoting issues, including installation paths containing spaces or &.
    executable = Path(args[0])
    if os.name == "nt" and executable.suffix.lower() in {".cmd", ".bat"}:
        js = executable.parent / "node_modules" / "npm" / "bin" / "npm-cli.js"
        node = executable.parent / "node.exe"
        node_command = str(node) if node.is_file() else shutil.which("node")
        if executable.stem.lower() != "npm" or not js.is_file() or not node_command:
            raise RuntimeError("npm 실행 경로를 확인할 수 없습니다. Node.js 설치를 확인해 주세요.")
        args = [node_command, str(js), *args[1:]]
    proc = await asyncio.create_subprocess_exec(
        *args, stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        **({"creationflags": 0x08000000} if os.name == "nt" else {"start_new_session": True}),
    )
    try:
        output, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        if proc.returncode is None:
            if os.name == "nt":
                killer = await asyncio.create_subprocess_exec(
                    "taskkill.exe", "/PID", str(proc.pid), "/T", "/F",
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                    creationflags=0x08000000,
                )
                await killer.wait()
            else:
                import signal
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            await proc.wait()
        raise
    text = output.decode(errors="replace").strip()
    if proc.returncode:
        raise RuntimeError(text[-3000:] or f"Codex 명령 실패 (종료 코드 {proc.returncode})")
    return text


async def installed_version(binary: str) -> str:
    # Windows codex.cmd points to the npm JS launcher, which itself needs Node.
    if os.name == "nt" and Path(binary).suffix.lower() == ".cmd":
        launcher = Path(binary).parent / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
        node = shutil.which("node")
        if not launcher.is_file() or not node:
            raise RuntimeError("Codex 실행 경로를 확인할 수 없습니다.")
        output = await run_command([node, str(launcher), "--version"])
    else:
        output = await run_command([binary, "--version"])
    match = VERSION_RE.search(output)
    if not match:
        raise RuntimeError("설치된 Codex 버전을 확인할 수 없습니다.")
    return match.group(1)


def update_command(binary: str) -> list[str]:
    resolved = Path(binary).resolve()
    parts = {part.lower() for part in resolved.parts}
    if "node_modules" in parts or Path(binary).suffix.lower() == ".cmd":
        # Prefer the npm next to the selected Codex, so another Node install on
        # PATH doesn't get updated while Twill continues using the old binary.
        sibling = Path(binary).parent / ("npm.cmd" if os.name == "nt" else "npm")
        npm = str(sibling) if sibling.is_file() else shutil.which("npm")
        if not npm:
            raise RuntimeError("Codex 업데이트에 필요한 npm을 찾을 수 없습니다.")
        return [npm, "install", "--global", "@openai/codex@latest"]
    if "caskroom" in parts or "cellar" in parts:
        brew = shutil.which("brew")
        if not brew:
            raise RuntimeError("Codex 업데이트에 필요한 Homebrew를 찾을 수 없습니다.")
        return [brew, "upgrade", *( ["--cask"] if "caskroom" in parts else []), "codex"]
    return [binary, "update"]


async def check_update(*, force: bool = False) -> dict:
    global _cache
    async with _check_lock:
        if not force and _cache and time.monotonic() - _cache[0] < 3600:
            return dict(_cache[1])
        binary = shutil.which("codex")
        if not binary:
            return {"installed": False, "current_version": None, "latest_version": None, "update_available": False}
        current, latest = await asyncio.gather(installed_version(binary), asyncio.to_thread(latest_release))
        result = {"installed": True, "current_version": current, "latest_version": latest,
                  "update_available": version_key(latest) > version_key(current)}
        _cache = (time.monotonic(), result)
        return dict(result)


async def install_update() -> dict:
    global _cache
    before = await check_update(force=True)
    if not before["installed"]:
        raise RuntimeError("codex CLI가 설치되어 있지 않습니다.")
    if not before["update_available"]:
        return before
    binary = shutil.which("codex")
    if not binary:
        raise RuntimeError("codex CLI를 찾을 수 없습니다.")
    _cache = None
    await run_command(update_command(binary), timeout=600)
    current = await installed_version(binary)
    if version_key(current) < version_key(before["latest_version"]):
        raise RuntimeError("업데이트 후에도 이전 Codex가 실행됩니다. Codex 설치 경로와 권한을 확인해 주세요.")
    result = {**before, "current_version": current, "update_available": False}
    _cache = (time.monotonic(), result)
    return result
