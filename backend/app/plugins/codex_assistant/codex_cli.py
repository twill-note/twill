"""Codex CLI 탐색, 버전 선택, Twill 전용 런타임 업데이트.

Twill 설치본은 빌드 시점의 최신 Codex CLI를 함께 제공한다. 사용자가 앱 안에서
업데이트하면 공식 OpenAI 릴리스 패키지를 사용자 쓰기 가능 폴더에 설치한다. 시스템
PATH에 여러 CLI가 있더라도 실행 가능한 후보의 버전을 비교해 가장 최신 버전을 고른다.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
from typing import Callable, Iterable, Mapping
from urllib.request import Request, urlopen
import uuid


RELEASE_CHANNEL_URL = "https://releases.openai.com/codex/channels/latest"
_VERSION_RE = re.compile(r"(?P<version>\d+\.\d+\.\d+(?:-(?:alpha|beta)(?:\.\d+){0,2})?)", re.IGNORECASE)
_SOURCE_PRIORITY = {
    "path": 0,
    "standalone": 1,
    "bundled": 2,
    "managed": 3,
    "override": 4,
}


@dataclass(frozen=True)
class CodexInstallation:
    binary: str
    version: str
    source: str

    def as_status(self) -> dict[str, str | bool]:
        return {
            "binary": self.binary,
            "version": self.version,
            "source": self.source,
            "bundled": self.source == "bundled",
            "managed": self.source == "managed",
        }


def _normalize_version(value: str) -> str | None:
    match = _VERSION_RE.search(value or "")
    return match.group("version") if match else None


def _version_key(value: str) -> tuple[int, ...]:
    normalized = _normalize_version(value)
    if not normalized:
        return (-1,)
    core, _, suffix = normalized.partition("-")
    major, minor, patch = (int(part) for part in core.split("."))
    if not suffix:
        return major, minor, patch, 3, 0, 0
    parts = suffix.split(".")
    release_rank = 2 if parts[0].lower() == "beta" else 1
    numbers = [int(part) for part in parts[1:] if part.isdigit()]
    numbers.extend([0] * (2 - len(numbers)))
    return major, minor, patch, release_rank, numbers[0], numbers[1]


def _platform_target(system: str | None = None, machine: str | None = None) -> str:
    system_name = (system or platform.system()).lower()
    machine_name = (machine or platform.machine()).lower()
    architecture = {
        "amd64": "x86_64",
        "x64": "x86_64",
        "x86_64": "x86_64",
        "arm64": "aarch64",
        "aarch64": "aarch64",
    }.get(machine_name)
    if architecture is None:
        raise RuntimeError(f"지원하지 않는 Codex CPU 아키텍처입니다: {machine_name}")
    platform_suffix = {
        "windows": "pc-windows-msvc",
        "darwin": "apple-darwin",
        "linux": "unknown-linux-musl",
    }.get(system_name)
    if platform_suffix is None:
        raise RuntimeError(f"지원하지 않는 Codex 운영체제입니다: {system_name}")
    return f"{architecture}-{platform_suffix}"


def _runtime_binary(runtime_dir: Path, system: str | None = None) -> Path:
    executable = "codex.exe" if (system or platform.system()).lower() == "windows" else "codex"
    return runtime_dir / "bin" / executable


def managed_runtime_dir(environ: Mapping[str, str] | None = None, home: Path | None = None) -> Path:
    env = os.environ if environ is None else environ
    configured = env.get("TWILL_CODEX_MANAGED_DIR")
    if configured:
        return Path(configured).expanduser()
    return (home or Path.home()) / ".twill" / "codex-runtime"


def _candidate_paths(
    environ: Mapping[str, str] | None = None,
    home: Path | None = None,
    system: str | None = None,
    which: Callable[[str], str | None] = shutil.which,
) -> list[tuple[Path, str]]:
    env = os.environ if environ is None else environ
    home_dir = home or Path.home()
    system_name = (system or platform.system()).lower()
    executable = "codex.exe" if system_name == "windows" else "codex"
    override = env.get("TWILL_CODEX_BINARY")
    if override:
        return [(Path(override).expanduser(), "override")]

    candidates: list[tuple[Path, str]] = []
    candidates.append((_runtime_binary(managed_runtime_dir(env, home_dir), system_name), "managed"))

    bundled = env.get("TWILL_BUNDLED_CODEX_BINARY")
    if bundled:
        candidates.append((Path(bundled).expanduser(), "bundled"))

    install_dir = env.get("CODEX_INSTALL_DIR")
    if install_dir:
        candidates.append((Path(install_dir).expanduser() / executable, "standalone"))
    if system_name == "windows":
        local_app_data = env.get("LOCALAPPDATA")
        if local_app_data:
            candidates.append((Path(local_app_data) / "Programs" / "OpenAI" / "Codex" / "bin" / executable, "standalone"))
    else:
        candidates.append((home_dir / ".local" / "bin" / executable, "standalone"))

    path_binary = which("codex")
    if path_binary:
        candidates.append((Path(path_binary), "path"))

    deduplicated: list[tuple[Path, str]] = []
    seen: set[str] = set()
    for path, source in candidates:
        key = os.path.normcase(os.path.abspath(str(path)))
        if key in seen:
            continue
        seen.add(key)
        deduplicated.append((path, source))
    return deduplicated


def _read_version(binary: Path) -> str | None:
    from .cli import command_for_binary

    if not binary.is_file():
        return None
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    try:
        completed = subprocess.run(
            command_for_binary(str(binary), "--version"),
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=creationflags,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    return _normalize_version(f"{completed.stdout}\n{completed.stderr}")


def list_codex_installations(
    candidates: Iterable[tuple[Path, str]] | None = None,
) -> list[CodexInstallation]:
    found: list[CodexInstallation] = []
    for binary, source in candidates or _candidate_paths():
        version = _read_version(binary)
        if version:
            found.append(CodexInstallation(str(binary.resolve()), version, source))
    return found


def resolve_codex_installation(
    candidates: Iterable[tuple[Path, str]] | None = None,
) -> CodexInstallation | None:
    installations = list_codex_installations(candidates)
    if not installations:
        return None
    return max(
        installations,
        key=lambda item: (_version_key(item.version), _SOURCE_PRIORITY.get(item.source, -1)),
    )


def codex_binary() -> str | None:
    installation = resolve_codex_installation()
    return installation.binary if installation else None


def _open_url(url: str, timeout: int):
    return urlopen(Request(url, headers={"User-Agent": "Twill-Codex-Installer/0.1"}), timeout=timeout)


def _safe_extract(archive: tarfile.TarFile, destination: Path) -> None:
    root = destination.resolve()
    for member in archive.getmembers():
        relative = PurePosixPath(member.name)
        if relative.is_absolute() or ".." in relative.parts:
            raise RuntimeError(f"Codex 패키지에 안전하지 않은 경로가 있습니다: {member.name}")
        target = (root / Path(*relative.parts)).resolve()
        if target != root and root not in target.parents:
            raise RuntimeError(f"Codex 패키지가 설치 폴더를 벗어납니다: {member.name}")
        if member.issym() or member.islnk():
            link = PurePosixPath(member.linkname)
            link_target = (target.parent / Path(*link.parts)).resolve()
            if link.is_absolute() or (link_target != root and root not in link_target.parents):
                raise RuntimeError(f"Codex 패키지에 안전하지 않은 링크가 있습니다: {member.name}")
    archive.extractall(destination)


def _download_release_metadata(metadata_url: str = RELEASE_CHANNEL_URL) -> dict:
    with _open_url(metadata_url, 30) as response:
        return json.loads(response.read().decode("utf-8"))


def download_latest_codex_runtime(
    destination: Path | str,
    *,
    metadata_url: str = RELEASE_CHANNEL_URL,
    system: str | None = None,
    machine: str | None = None,
) -> CodexInstallation:
    """공식 릴리스 패키지를 검증해 destination에 원자적으로 설치한다."""
    destination_path = Path(destination).expanduser().resolve()
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    metadata = _download_release_metadata(metadata_url)
    version = _normalize_version(str(metadata.get("tag_name") or ""))
    if not version:
        raise RuntimeError("최신 Codex 릴리스 버전을 확인하지 못했습니다.")

    target = _platform_target(system, machine)
    asset_name = f"codex-package-{target}.tar.gz"
    asset = next(
        (item for item in metadata.get("assets", []) if isinstance(item, dict) and item.get("name") == asset_name),
        None,
    )
    if not asset:
        raise RuntimeError(f"현재 플랫폼용 Codex 패키지를 찾지 못했습니다: {asset_name}")
    download_url = str(asset.get("browser_download_url") or "")
    digest = str(asset.get("digest") or "")
    if not download_url.startswith("https://releases.openai.com/codex/"):
        raise RuntimeError("Codex 패키지 다운로드 주소가 공식 OpenAI 릴리스 주소가 아닙니다.")
    if not re.fullmatch(r"sha256:[0-9a-fA-F]{64}", digest):
        raise RuntimeError("Codex 패키지 SHA-256 정보를 확인하지 못했습니다.")
    expected_hash = digest.split(":", 1)[1].lower()

    existing_binary = _runtime_binary(destination_path, system)
    if _read_version(existing_binary) == version:
        return CodexInstallation(str(existing_binary), version, "managed")

    with tempfile.TemporaryDirectory(prefix=".codex-download-", dir=destination_path.parent) as temporary:
        temporary_path = Path(temporary)
        archive_path = temporary_path / asset_name
        stage_path = temporary_path / "runtime"
        stage_path.mkdir()
        hasher = hashlib.sha256()
        with _open_url(download_url, 300) as response, archive_path.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
                hasher.update(chunk)
        actual_hash = hasher.hexdigest()
        if actual_hash != expected_hash:
            raise RuntimeError(
                f"Codex 패키지 무결성 확인에 실패했습니다. expected={expected_hash}, actual={actual_hash}"
            )

        with tarfile.open(archive_path, "r:gz") as archive:
            _safe_extract(archive, stage_path)

        stage_binary = _runtime_binary(stage_path, system)
        if os.name != "nt" and stage_binary.is_file():
            stage_binary.chmod(stage_binary.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        installed_version = _read_version(stage_binary)
        if installed_version != version:
            raise RuntimeError(
                f"설치한 Codex CLI 버전이 릴리스 정보와 다릅니다: {installed_version or 'unknown'} != {version}"
            )
        (stage_path / ".twill-codex-version.json").write_text(
            json.dumps({"version": version, "target": target, "sha256": expected_hash}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        backup_path = destination_path.with_name(f"{destination_path.name}.backup-{uuid.uuid4().hex}")
        replaced = destination_path.exists()
        if replaced:
            destination_path.rename(backup_path)
        try:
            shutil.move(str(stage_path), str(destination_path))
        except Exception:
            if replaced and backup_path.exists() and not destination_path.exists():
                backup_path.rename(destination_path)
            raise
        if backup_path.exists():
            shutil.rmtree(backup_path)

    final_binary = _runtime_binary(destination_path, system)
    return CodexInstallation(str(final_binary), version, "managed")
