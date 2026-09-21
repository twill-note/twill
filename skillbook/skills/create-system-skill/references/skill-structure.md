# 앱 전용 스킬 구조

필수 구조:

```text
skillbook/skills/<skill-name>/
└── SKILL.md
```

필요할 때만 추가:

```text
├── agents/
│   └── openai.yaml
├── scripts/
├── references/
└── assets/
```

`SKILL.md`는 발견과 실행에 꼭 필요한 지침만 담는다. 반복해서 읽을 필요가 없는
상세 설명은 `references/`, 결정적으로 실행할 수 있는 작업은 `scripts/`, 결과물에
사용할 파일은 `assets/`에 둔다.

앱 스킬 저장소는 `list_skillbook`이 반환하는 `storage_path` 아래의 `skills` 폴더다. 앱 설치 폴더 밖의 사용자 데이터 경로에 보존된다. 글로벌 Codex
스킬 디렉터리로 복사하거나 설치하지 않는다.
