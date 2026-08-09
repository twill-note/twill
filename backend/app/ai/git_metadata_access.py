"""Twill AI의 사용자 동의 기반 Git 메타데이터 쓰기 권한 관리.

Codex의 ``workspace-write`` 샌드박스는 의도적으로 ``.git``을 읽기 전용으로
보호한다. 이 모듈은 사용자가 Twill에서 명시적으로 허용했을 때만 Codex의
사용자 규칙 디렉터리에, 일반적인 로컬 Git 메타데이터 갱신 명령을 샌드박스 밖에서
실행하도록 하는 앱 소유 규칙 파일을 설치한다.
"""
from __future__ import annotations

import os
import uuid
from pathlib import Path


RULES_DIRNAME = "rules"
RULE_FILENAME = "byeori-git-metadata.rules"
MANAGED_RULE_MARKER = "# Managed by Twill: Twill AI Git metadata access."
# 이 마커는 이 기능이 도입되기 전에 앱 운영자가 추가한 동일 규칙도 안전하게 관리하기
# 위한 하위호환 처리다. 다른 규칙 파일은 절대 삭제하지 않는다.
_LEGACY_MANAGED_RULE_MARKERS = (
    "# Managed by Note App: Byeori Git metadata access.",
    "# Byeori runs Codex with `approvalPolicy = \"never\"`",
)
# 기존 테스트·외부 참조가 단일 레거시 마커를 읽어도 호환되게 유지한다.
_LEGACY_MANAGED_RULE_MARKER = _LEGACY_MANAGED_RULE_MARKERS[-1]

RULE_CONTENT = f'''{MANAGED_RULE_MARKER}
# Codex protects .git and linked-worktree gitdirs in a workspace-write sandbox.
# The user explicitly allowed Twill AI to perform these common local metadata
# updates outside that sandbox. Remote publication and destructive reset are
# intentionally excluded.
prefix_rule(
    pattern = [
        "git",
        [
            "add",
            "commit",
            "fetch",
            "pull",
            "merge",
            "rebase",
            "revert",
            "stash",
            "branch",
            "switch",
            "checkout",
            "tag",
            "cherry-pick",
            "bisect",
            "remote",
            "notes",
            "replace",
            "update-ref",
            "maintenance",
            "gc",
            "prune",
            "repack",
            "pack-refs",
        ],
    ],
    decision = "allow",
    justification = "The user allowed Twill AI to update local Git metadata.",
    match = [
        "git add -A",
        "git commit -m checkpoint",
        "git stash push -m WIP",
        "git fetch origin",
        "git rebase main",
    ],
    not_match = [
        "git status",
        "git push origin main",
        "git reset --hard HEAD",
        "git -C ../other-project add -A",
    ],
)
'''


class GitMetadataAccessConflictError(RuntimeError):
    """앱이 소유하지 않은 동일 경로의 규칙 파일을 보존해야 할 때 발생한다."""


def rules_path(home: Path | None = None) -> Path:
    """Codex가 실제로 읽는 사용자 rules 디렉터리의 앱 소유 파일 경로.

    Codex는 ``CODEX_HOME``을 지정할 수 있다. Twill AI가 시작하는 subprocess도 같은 환경을
    상속하므로, 일반적인 ``~/.codex``만 가정하지 않고 그 값을 존중한다.
    """
    codex_home = home or Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser()
    return codex_home / RULES_DIRNAME / RULE_FILENAME


def _is_managed(content: str) -> bool:
    return MANAGED_RULE_MARKER in content or any(marker in content for marker in _LEGACY_MANAGED_RULE_MARKERS)


def status(home: Path | None = None) -> dict[str, bool]:
    path = rules_path(home)
    try:
        content = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {"enabled": False, "managed": True}
    except OSError:
        return {"enabled": False, "managed": False}
    return {"enabled": _is_managed(content), "managed": _is_managed(content)}


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(content, encoding="utf-8")
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def set_enabled(enabled: bool, home: Path | None = None) -> dict[str, bool]:
    """앱 관리 규칙을 설치하거나 제거하고, 최종 활성 상태를 반환한다."""
    path = rules_path(home)
    if enabled:
        if path.exists():
            try:
                existing = path.read_text(encoding="utf-8")
            except OSError as exc:
                raise GitMetadataAccessConflictError("기존 Git 권한 규칙을 읽을 수 없습니다.") from exc
            if not _is_managed(existing):
                raise GitMetadataAccessConflictError(
                    "같은 Codex 규칙 파일을 다른 설정이 사용하고 있어 덮어쓰지 않았습니다."
                )
        _atomic_write(path, RULE_CONTENT)
    elif path.exists():
        try:
            existing = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise GitMetadataAccessConflictError("기존 Git 권한 규칙을 읽을 수 없습니다.") from exc
        if not _is_managed(existing):
            raise GitMetadataAccessConflictError(
                "같은 Codex 규칙 파일을 다른 설정이 사용하고 있어 삭제하지 않았습니다."
            )
        path.unlink()
    return status(home)
