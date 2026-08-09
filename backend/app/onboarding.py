"""Seed a genuinely empty workspace with a small, removable onboarding kit."""

from __future__ import annotations

import json
from pathlib import Path

import frontmatter


SEED_VERSION = 3
WORKSPACE_FILE = ".workspace.json"
IGNORED_EMPTY_ENTRIES = {"assets", ".trash", ".ai-orchestrator", WORKSPACE_FILE}
SCAFFOLD_DIRS = {"tasks", "scopes"}

WELCOME_BODY = """# 1. Twill 시작하기

Twill은 Markdown 문서, 실제 코드 프로젝트, 태스크 보드와 Codex 기반 AI 작업을 한 공간에서 연결하는 로컬 워크스페이스입니다.

## 5분 빠른 시작

1. 왼쪽 아래의 **+ 섹션**을 눌러 연습용 섹션을 만듭니다.
2. 상단의 **프로젝트 관리(🌐)**를 열어 방금 만든 프로젝트의 **경로**를 실제 코드 폴더로 지정합니다.
3. 섹션 안에 문서를 만들고 요구사항이나 메모를 작성합니다.
4. 문서에서 태스크를 만들거나 **태스크 보드(📋)**에서 새 카드를 추가합니다.
5. 카드를 **실행** 상태로 옮겨 Twill AI에 맡기고, 작업이 끝나면 **확인 필요**에서 결과를 검토합니다.
6. 검토가 끝난 카드를 **완료**로 옮깁니다.

## 핵심 개념

- **저장소**: Markdown 문서와 Twill 설정이 저장되는 폴더입니다.
- **섹션**: 관련 문서와 폴더를 한 프로젝트 단위로 묶는 영역입니다.
- **프로젝트**: Twill AI가 실제 파일을 확인하고 수정할 코드 폴더입니다.
- **태스크**: 해야 할 작업과 AI 실행 상태를 관리하는 카드입니다.
- **Twill AI**: 섹션·문서·태스크의 문맥을 정리해 Codex에 전달하고 결과를 보여주는 기능입니다.

## 화면 구성

- **왼쪽 패널**: 저장소, 섹션, 폴더와 문서를 관리합니다.
- **상단 탭**: 태스크 보드, 프로젝트 관리, 오늘의 노트, 캘린더, 할 일과 스킬북을 엽니다.
- **가운데 편집 영역**: 문서를 작성하거나 관리 화면을 표시합니다.
- **오른쪽 도구 모음**: Twill AI와 터미널을 열고 닫습니다.

자세한 설명과 단축키는 [[2. Twill 사용 가이드]]에서 확인할 수 있습니다.

모든 문서와 태스크는 선택한 저장소 안에 로컬 파일로 저장됩니다. 이 안내 문서와 예시 태스크는 자유롭게 수정하거나 삭제해도 되며, 삭제한 초기 데이터는 자동으로 다시 생성되지 않습니다.
"""

GUIDE_BODY = """# 2. Twill 사용 가이드

## 1. 저장소와 문서

저장소는 Twill이 문서 루트로 사용하는 폴더입니다. 왼쪽 위의 폴더 선택 기능에서 기존 Markdown 폴더나 새 폴더를 저장소로 지정할 수 있습니다.

- 왼쪽 문서 목록에서 문서와 폴더를 만들고 이동하거나 삭제할 수 있습니다.
- 문서는 Markdown 파일로 저장되므로 Twill 밖의 편집기에서도 열 수 있습니다.
- `[[문서 이름]]` 형식으로 다른 문서를 연결할 수 있습니다.
- Markdown 체크박스인 `- [ ] 할 일`은 상단의 **할 일(✅)** 화면에 모아 표시됩니다.
- 자주 여는 문서는 고정해 상단에서 `Alt+1`부터 `Alt+9`로 열 수 있습니다.

## 2. 섹션이란?

섹션은 관련 문서와 폴더를 하나의 업무 또는 프로젝트 단위로 묶는 왼쪽 패널의 작업 영역입니다. 단순한 문서 제목이 아니라 문서, 프로젝트 경로, 태스크와 AI 문맥을 연결하는 기준입니다.

**+ 섹션**을 누르고 이름을 입력하면 다음 항목이 함께 만들어집니다.

1. 왼쪽 패널의 새 섹션
2. 섹션과 이름이 같은 기본 문서 폴더
3. **프로젝트 관리**에 연결할 프로젝트 항목

루트의 폴더나 문서를 섹션으로 옮겨 분류할 수 있습니다. 섹션을 삭제하더라도 실제 폴더와 문서는 삭제되지 않고 `Root` 영역으로 돌아갑니다.

## 3. 섹션과 프로젝트 관리 연결

섹션의 문서 폴더와 프로젝트 관리의 경로는 역할이 다릅니다.

```text
섹션: 쇼핑몰 개발
문서 폴더: Twill 저장소/쇼핑몰 개발
프로젝트 경로: C:\\Projects\\shopping-mall
```

- **문서 폴더**에는 기획서, 회의록과 요구사항 같은 Markdown 문서를 저장합니다.
- **프로젝트 경로**에는 Twill AI가 확인하고 수정할 실제 소스 코드가 있습니다.
- **섹션**은 두 공간을 하나의 작업 문맥으로 연결합니다.

섹션을 만들면 프로젝트 관리 행은 자동으로 생기지만 실제 코드 경로는 자동 추측하지 않습니다. 상단의 **프로젝트 관리(🌐)**를 열고 해당 행의 **경로** 셀을 클릭해 폴더를 선택해야 합니다. 경로가 지정되면 프로젝트의 `AGENTS.md`도 관리할 수 있습니다.

## 4. 태스크 보드

태스크 보드는 해야 할 일을 카드로 기록하고, 사람이 검토하는 과정과 Twill AI의 실행 상태를 함께 관리하는 기능입니다. 상단의 **태스크 보드(📋)**에서 직접 카드를 만들거나, 문서를 보면서 그 문서와 연결된 태스크를 만들 수 있습니다.

카드에는 수행할 작업과 대상 파일, 기대하는 결과, 완료 조건, 확인 방법과 연결할 프로젝트를 구체적으로 적는 것이 좋습니다.

### 태스크 상태

- **보류**: 선행 작업, 결정 또는 외부 조건을 기다려 지금 진행할 수 없는 상태입니다.
- **대기**: 작성은 끝났지만 아직 실행하지 않은 상태입니다.
- **실행**: Twill AI가 작업 중이거나 같은 프로젝트의 실행 대기열에 들어간 상태입니다.
- **확인 필요**: AI 작업이 끝났고 사용자가 변경 내용과 결과를 검토해야 하는 상태입니다.
- **완료**: 결과 검토까지 끝난 상태입니다.

카드를 열어 제목, 설명과 속성을 편집할 수 있고, 끌어서 다른 상태로 이동할 수 있습니다. AI 실행이 끝났다고 바로 완료되는 것이 아니라 **확인 필요**에서 사용자가 결과를 확인하는 흐름을 권장합니다.

## 5. 프로젝트별 태스크 관리

태스크의 **프로젝트** 속성은 프로젝트 관리에 등록된 항목을 참조합니다.

- 섹션 안의 문서에서 태스크를 만들면 그 섹션의 프로젝트가 자동 연결됩니다.
- 태스크 보드 위쪽의 **전체 프로젝트** 메뉴에서 특정 프로젝트의 카드만 볼 수 있습니다.
- 프로젝트가 정해지지 않은 공통 작업은 프로젝트 없이 관리할 수 있습니다.
- 프로젝트를 지정하면 Twill AI가 해당 프로젝트 경로를 작업 디렉터리로 사용합니다.
- 같은 프로젝트의 작업은 충돌을 줄이기 위해 실행 순서를 기다릴 수 있으며, 서로 다른 프로젝트의 작업은 별도 문맥으로 관리됩니다.

## 6. Twill AI와 Codex

Twill AI는 대화와 태스크 실행 화면을 제공하고, 섹션·문서·태스크 정보를 작업 문맥으로 구성해 Codex 엔진에 전달합니다.

```text
사용자 질문 또는 태스크
→ Twill AI가 관련 문맥 구성
→ Codex가 지정된 프로젝트에서 파일 확인·수정·명령 실행
→ Twill에 진행 과정, 결과와 실행 로그 표시
→ 사용자가 결과 검토
```

- Codex 사용을 위해 계정 로그인이 필요할 수 있습니다.
- 일반 채팅은 현재 문서와 선택한 프로젝트 문맥을 바탕으로 답합니다.
- 태스크 실행은 카드에 지정된 프로젝트 경로에서 수행됩니다.
- 프로젝트의 `AGENTS.md`에는 Codex가 따라야 할 규칙을 작성할 수 있습니다.
- `MEMORIES.md`에는 반복해서 활용할 워크스페이스 지식을 보관합니다.
- AI가 파일을 수정하거나 명령을 실행할 수 있으므로 **확인 필요** 단계에서 결과를 검토하세요.

## 7. 상단 화면과 기본 단축키

| 기능 | 역할 | Windows | macOS |
| --- | --- | --- | --- |
| 검색 | 저장소 문서 검색 | `Ctrl+K` | `⌘K` |
| 태스크 보드 | 작업 카드 관리와 AI 실행 | `Alt+T` | `⌥T` |
| 프로젝트 관리 | 실제 코드 폴더 연결 | `Alt+P` | `⌥P` |
| 오늘의 노트 | 오늘 날짜의 문서 생성 또는 열기 | `Ctrl+D` | `⌘D` |
| 캘린더 | 날짜가 지정된 문서 탐색 | `Alt+C` | `⌥C` |
| 할 일 | 문서의 체크박스 모아보기 | `Alt+H` | `⌥H` |
| Twill AI | AI 대화와 실행 내역 패널 | `Alt+B` | `⌥B` |
| 터미널 | 명령 실행 패널 | `Ctrl` + `` ` `` | `⌃` + `` ` `` |

상단의 **스킬북(📚)**에서는 Twill AI가 활용할 작업 지침을 관리합니다. 고정한 문서는 `Alt+1`~`Alt+9`(macOS는 `⌥1`~`⌥9`)로 열 수 있습니다. 주요 단축키는 설정에서 변경할 수 있습니다.

## 8. 설정에서 할 수 있는 일

왼쪽 위의 **설정(⚙)**에서는 다음 항목을 관리합니다.

- **테마**: 앱의 표시 테마를 바꿉니다.
- **모든 파일 표시**: Markdown과 Twill 전용 파일 외에 저장소의 다른 파일도 탐색기에 표시합니다.
- **기본 모델**: Twill AI가 기본으로 사용할 Codex 모델을 선택합니다.
- **기본 강도**: AI가 작업을 검토하고 추론하는 강도를 지정합니다.
- **채팅 질문 메모리 학습**: 대화에서 확인된 재사용 가능한 지식을 메모리에 저장할지 정합니다.
- **Git 메타데이터 쓰기 권한**: 이 기기의 Codex가 `git add`, 커밋, 브랜치와 병합 같은 로컬 Git 정보를 변경할 수 있게 합니다. 원격 `push`와 `git reset --hard`는 허용 대상에서 제외됩니다.
- **단축키**: 검색과 주요 화면의 키 조합을 변경하거나 기본값으로 되돌립니다.

## 9. 따라 해보기

1. `개인 웹사이트` 섹션을 추가합니다.
2. 프로젝트 관리에서 실제 웹사이트 코드 폴더를 경로로 지정합니다.
3. 섹션 폴더에 `홈 화면 요구사항.md`를 만들고 요구사항을 적습니다.
4. 문서에서 `홈 화면 구현하기` 태스크를 만듭니다.
5. 태스크 보드에서 프로젝트가 연결됐는지 확인합니다.
6. 카드를 **실행**으로 옮기고 Twill AI로 작업을 시작합니다.
7. **확인 필요**에서 실행 로그와 변경된 소스 코드를 검토합니다.
8. 문제가 없으면 카드를 **완료**로 옮깁니다.

빠른 시작으로 돌아가려면 [[1. Twill 시작하기]]를 여세요.
"""

TASK_BODY = """Twill의 기본 작업 흐름을 직접 따라 해보는 예시 카드입니다.

- [ ] [[1. Twill 시작하기]] 문서 열기
- [ ] 왼쪽 아래의 **+ 섹션**으로 연습용 섹션 만들기
- [ ] **프로젝트 관리**에서 자동 생성된 프로젝트 항목 확인하기
- [ ] 프로젝트의 경로 셀을 클릭해 실제 폴더 선택해 보기
- [ ] 이 카드를 다른 상태로 옮겨 태스크 흐름 익히기
- [ ] 사용법을 익혔다면 이 카드를 **완료**로 옮기기

이 카드는 자유롭게 편집하거나 삭제해도 됩니다.
"""


def _workspace_data(root: Path) -> dict:
    path = root / WORKSPACE_FILE
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _is_effectively_empty(root: Path) -> bool:
    for entry in root.iterdir():
        if entry.name in IGNORED_EMPTY_ENTRIES:
            continue
        if entry.name.startswith(".index.db"):
            continue
        if entry.name in SCAFFOLD_DIRS and entry.is_dir():
            if all(child.name == ".db.json" for child in entry.iterdir()):
                continue
        return False
    return True


def _write_note(path: Path, title: str, body: str, **metadata: object) -> None:
    post = frontmatter.Post(body.strip(), title=title, **metadata)
    path.write_text(frontmatter.dumps(post) + "\n", encoding="utf-8")


def _seed_content(root: Path) -> None:
    from .routers.db import TASK_BOARD_PRESET

    tasks = root / "tasks"
    tasks.mkdir(parents=True, exist_ok=True)
    (tasks / ".db.json").write_text(
        json.dumps(TASK_BOARD_PRESET, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    _write_note(root / "1. Twill 시작하기.md", "1. Twill 시작하기", WELCOME_BODY, tags=["guide"])
    _write_note(root / "2. Twill 사용 가이드.md", "2. Twill 사용 가이드", GUIDE_BODY, tags=["guide"])
    _write_note(
        tasks / "카드 뷰로 문서 하나 남기기.md",
        "카드 뷰로 문서 하나 남기기",
        TASK_BODY,
        type="docs",
        priority="normal",
        status="todo",
    )


def _upgrade_v1(root: Path) -> None:
    for relative in (
        "Twill 시작하기.md",
        "Twill 사용 가이드.md",
        "tasks/시작 가이드 확인하기.md",
    ):
        path = root / relative
        if path.is_file():
            path.unlink()
    _seed_content(root)


def _upgrade_v2(root: Path) -> None:
    """Refresh only the bundled onboarding notes, preserving board settings."""
    tasks = root / "tasks"
    tasks.mkdir(parents=True, exist_ok=True)
    _write_note(root / "1. Twill 시작하기.md", "1. Twill 시작하기", WELCOME_BODY, tags=["guide"])
    _write_note(root / "2. Twill 사용 가이드.md", "2. Twill 사용 가이드", GUIDE_BODY, tags=["guide"])
    _write_note(
        tasks / "카드 뷰로 문서 하나 남기기.md",
        "카드 뷰로 문서 하나 남기기",
        TASK_BODY,
        type="docs",
        priority="normal",
        status="todo",
    )


def seed_if_empty(root: Path) -> bool:
    """Create onboarding files once, returning whether a seed was written."""
    root.mkdir(parents=True, exist_ok=True)
    workspace = _workspace_data(root)
    try:
        seeded_version = int(workspace.get("onboarding_seed_version") or 0)
    except (TypeError, ValueError):
        seeded_version = 0
    if seeded_version >= SEED_VERSION:
        return False
    if seeded_version in (1, 2):
        if seeded_version == 1:
            _upgrade_v1(root)
        else:
            _upgrade_v2(root)
        workspace["onboarding_seed_version"] = SEED_VERSION
        (root / WORKSPACE_FILE).write_text(
            json.dumps(workspace, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return True
    if not _is_effectively_empty(root):
        return False

    _seed_content(root)

    workspace["onboarding_seed_version"] = SEED_VERSION
    (root / WORKSPACE_FILE).write_text(
        json.dumps(workspace, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return True
