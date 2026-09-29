import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[2]))
# Packaged apps supply a first-run default separately from an explicit workspace override.
# NOTES_DIR remains an override for development and isolated runs.
DEFAULT_NOTES_DIR = Path(os.environ.get("NOTES_DIR") or os.environ.get("TWILL_DEFAULT_NOTES_DIR") or REPO_ROOT / "notes").resolve()

CONFIG_PATH = Path.home() / ".config" / "note-app" / "config.json"

# 파일 API와 인덱싱에서 접근을 막는 내부 디렉토리 이름.
# 태스크/실행/프로젝트 데이터 폴더는 전용 화면과 API에서 계속 사용해야 하므로 여기에
# 넣지 않는다.
EXCLUDED_DIRS = {"assets", ".trash"}

# 왼쪽 파일 탐색기의 워크스페이스 루트에서만 숨기는 앱 관리 폴더. 폴더가 실제로
# 존재하지 않아도 단순 이름 필터로만 동작하므로 새 워크스페이스를 열 때 선행 생성이
# 필요하지 않다.
TREE_HIDDEN_ROOT_DIRS = {"assets", "memories", "runs", "scopes", "tasks", ".projects"}

_state: dict = {"root": DEFAULT_NOTES_DIR, "recent": [], "plugins": {}}


def _load() -> None:
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        root = Path(data.get("root", "")).expanduser()
        if str(root) and root.is_dir():
            _state["root"] = root.resolve()
        _state["recent"] = [p for p in data.get("recent", []) if Path(p).is_dir()]
        _state["plugins"] = dict(data.get("plugins", {}))
    except (OSError, json.JSONDecodeError, ValueError):
        pass
    # 환경변수로 명시한 경우 저장된 설정보다 우선
    if "NOTES_DIR" in os.environ:
        _state["root"] = DEFAULT_NOTES_DIR


def _save() -> None:
    try:
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(
            json.dumps(
                {"root": str(_state["root"]), "recent": _state["recent"], "plugins": _state["plugins"]},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    except OSError:
        pass


def plugin_data_dir(plugin_id: str) -> Path:
    p = CONFIG_PATH.parent / "plugins" / plugin_id
    p.mkdir(parents=True, exist_ok=True)
    return p


def plugin_installed(plugin_id: str) -> bool:
    return bool(_state["plugins"].get(plugin_id))


def set_plugin_installed(plugin_id: str, installed: bool) -> None:
    _state["plugins"][plugin_id] = installed
    _save()


def notes_dir() -> Path:
    return _state["root"]


def assets_dir() -> Path:
    return _state["root"] / "assets"


def trash_dir() -> Path:
    return _state["root"] / ".trash"


def db_path() -> Path:
    return _state["root"] / ".index.db"


def recent_roots() -> list[str]:
    return list(_state["recent"])


def set_notes_dir(path: Path) -> None:
    path = path.expanduser().resolve()
    _state["root"] = path
    recent = [str(path)] + [p for p in _state["recent"] if p != str(path)]
    _state["recent"] = recent[:8]
    ensure_dirs()
    _save()


def ensure_dirs() -> None:
    notes_dir().mkdir(parents=True, exist_ok=True)
    assets_dir().mkdir(parents=True, exist_ok=True)
    trash_dir().mkdir(parents=True, exist_ok=True)
    from . import onboarding

    onboarding.seed_if_empty(notes_dir())


_load()
