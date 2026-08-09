# 데이터베이스(DB) 폴더

이 앱의 "데이터베이스"는 노션과 비슷하게 **폴더 하나 = DB 하나, 노트 하나 = 행(카드) 하나**다.
폴더에 `.db.json` 이 있으면 그 폴더는 DB로 취급되어 표/보드 뷰로 보여진다 (파일 트리에서는
자식 파일이 숨겨짐 — DB 뷰 안에서만 보임).

## `.db.json` 스키마

```json
{
  "title": "제목",
  "kind": "",
  "columns": [
    { "key": "status", "label": "상태", "type": "status", "visible": true,
      "options": [ { "value": "todo", "label": "할 일", "color": "blue" } ] }
  ],
  "primarySort": null,
  "defaultView": "table",
  "boardGroupBy": null
}
```

**셀 타입(`type`)**: `text` · `number` · `select` · `multi_select` · `status` · `date` ·
`checkbox` · `url` · `path`. `select`/`multi_select`/`status` 는 `options` 배열이 필요하고
각 옵션은 `{value, label, color}` (color는 `gray/brown/orange/yellow/green/blue/purple/pink/red/default`
중 하나). 이 목록에 없는 타입 값을 쓰면 저장이 거부된다(422).

**행(카드) 만들기**: DB 폴더 안에 frontmatter가 있는 `.md` 파일을 하나 만들면 그게 곧 행이다.
파일명은 아무거나 상관없다 — 컬럼 값은 frontmatter의 키로 매칭된다 (컬럼 `key`가
`status`면 frontmatter에 `status: ...`).

## 미리 정의된 특수 DB

- **태스크 보드** (`kind: "task_board"`, 보통 `tasks/`) — 자세한 내용은 `task-board.md` 참고.
- **프로젝트 관리 / 스코프 카탈로그** (`kind: "scopes_board"`, 보통 `scopes/`) — 컬럼:
  `프로젝트`(행의 `label`) · `경로`(`path`, 파일시스템 경로)만 표시하는 고정 테이블이다.
  보드 보기와 추가 표시 열은 지원하지 않는다. 각 행이 프로젝트 하나를 의미하며, 태스크의
  `scope` 값이 이 행들의 파일명(확장자 제외)을 참조한다. 경로를
  설정하면 프로젝트 루트의 `AGENTS.md`가 없을 때 생성되고, 제목의 프로젝트 이름을 누르면
  행 노트 대신 그 실제 파일을 열어 편집한다. 자세한 내용은 `projects-and-scopes.md` 참고.

## 새 DB를 직접 만들 때

일반 노트 폴더를 DB로 바꾸려면 그 폴더에 위 스키마대로 `.db.json`을 쓰면 된다. 굳이 새
DB를 만들 필요 없이 그냥 마크다운 노트로 충분한 작업(단순 문서 생성 등)이라면 DB를 만들
필요는 없다 — DB는 "같은 형태의 항목을 여러 개 표/보드로 관리"할 때만 의미가 있다.
