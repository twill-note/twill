import json
import sqlite3
import threading

from . import config

_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS notes (
    path TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    date TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    body TEXT NOT NULL DEFAULT '',
    updated_at REAL NOT NULL DEFAULT 0,
    icon TEXT NOT NULL DEFAULT '',
    props TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_notes_date ON notes(date);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    path UNINDEXED, title, body, tokenize='trigram'
);
CREATE TABLE IF NOT EXISTS todos (
    path TEXT NOT NULL,
    line INTEGER NOT NULL,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_todos_path ON todos(path);
CREATE TABLE IF NOT EXISTS calendar_events (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    time TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_date ON calendar_events(date, time);
CREATE TABLE IF NOT EXISTS links (
    src TEXT NOT NULL,
    target TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_src ON links(src);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target);
"""


def get_conn() -> sqlite3.Connection:
    """워크스페이스(노트 루트) 전환 시 해당 루트의 DB로 자동 재연결."""
    path = str(config.db_path())
    conn = getattr(_local, "conn", None)
    if conn is None or getattr(_local, "db_path", None) != path:
        if conn is not None:
            conn.close()
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        conn.executescript(SCHEMA)
        # 기존 DB 마이그레이션 (컬럼이 이미 있으면 무시)
        for stmt in (
            "ALTER TABLE notes ADD COLUMN icon TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE notes ADD COLUMN props TEXT NOT NULL DEFAULT '{}'",
        ):
            try:
                conn.execute(stmt)
            except sqlite3.OperationalError:
                pass
        _local.conn = conn
        _local.db_path = path
    return conn


def upsert_note(
    path: str,
    title: str,
    date: str | None,
    tags: list[str],
    body: str,
    updated_at: float,
    todos: list[tuple[int, str, bool]] | None = None,
    links: list[str] | None = None,
    icon: str = "",
    props: dict | None = None,
) -> None:
    conn = get_conn()
    with conn:
        conn.execute(
            """INSERT INTO notes(path, title, date, tags, body, updated_at, icon, props)
               VALUES(?,?,?,?,?,?,?,?)
               ON CONFLICT(path) DO UPDATE SET
                 title=excluded.title, date=excluded.date, tags=excluded.tags,
                 body=excluded.body, updated_at=excluded.updated_at,
                 icon=excluded.icon, props=excluded.props""",
            (path, title, date, json.dumps(tags, ensure_ascii=False), body, updated_at,
             icon, json.dumps(props or {}, ensure_ascii=False)),
        )
        conn.execute("DELETE FROM notes_fts WHERE path = ?", (path,))
        conn.execute("INSERT INTO notes_fts(path, title, body) VALUES(?,?,?)", (path, title, body))
        conn.execute("DELETE FROM todos WHERE path = ?", (path,))
        conn.executemany(
            "INSERT INTO todos(path, line, text, done) VALUES(?,?,?,?)",
            [(path, line, text, int(done)) for line, text, done in (todos or [])],
        )
        conn.execute("DELETE FROM links WHERE src = ?", (path,))
        conn.executemany("INSERT INTO links(src, target) VALUES(?,?)", [(path, t) for t in (links or [])])


def delete_note(path: str) -> None:
    conn = get_conn()
    with conn:
        for table, col in (("notes", "path"), ("notes_fts", "path"), ("todos", "path"), ("links", "src")):
            conn.execute(f"DELETE FROM {table} WHERE {col} = ?", (path,))


def delete_prefix(prefix: str) -> None:
    """디렉토리 이동/삭제 시 하위 노트 인덱스 일괄 제거."""
    conn = get_conn()
    like = prefix.rstrip("/") + "/%"
    with conn:
        for table, col in (("notes", "path"), ("notes_fts", "path"), ("todos", "path"), ("links", "src")):
            conn.execute(f"DELETE FROM {table} WHERE {col} = ? OR {col} LIKE ?", (prefix, like))


def clear_all() -> None:
    conn = get_conn()
    with conn:
        for table in ("notes", "notes_fts", "todos", "links"):
            conn.execute(f"DELETE FROM {table}")


def all_todos(include_done: bool = False) -> list[dict]:
    """노트별로 묶은 체크박스 목록 (기본: 미완료만). 템플릿 폴더는 제외."""
    q = """SELECT t.path, t.line, t.text, t.done, n.title, n.date
           FROM todos t JOIN notes n ON n.path = t.path
           WHERE t.path NOT LIKE 'templates/%'"""
    if not include_done:
        q += " AND t.done = 0"
    q += " ORDER BY n.date IS NULL, n.date DESC, n.title, t.line"
    groups: dict[str, dict] = {}
    for r in get_conn().execute(q).fetchall():
        g = groups.setdefault(r["path"], {"path": r["path"], "title": r["title"], "date": r["date"], "items": []})
        g["items"].append({"line": r["line"], "text": r["text"], "done": bool(r["done"])})
    return list(groups.values())


def backlinks(names: list[str]) -> list[dict]:
    """names(제목/파일명) 중 하나를 [[링크]]로 참조하는 노트 목록."""
    names = [n for n in names if n]
    if not names:
        return []
    qmarks = ",".join("?" * len(names))
    rows = get_conn().execute(
        f"""SELECT DISTINCT n.* FROM links l JOIN notes n ON n.path = l.src
            WHERE l.target IN ({qmarks}) ORDER BY n.date DESC, n.title""",
        names,
    ).fetchall()
    return [_row_to_note(r) for r in rows]


def outgoing_links(src: str) -> list[str]:
    rows = get_conn().execute("SELECT DISTINCT target FROM links WHERE src = ?", (src,)).fetchall()
    return [r["target"] for r in rows]


def resolve_link_target(name: str) -> dict | None:
    """[[name]]이 가리키는 노트를 파일명(stem) 또는 제목으로 해석."""
    for r in get_conn().execute("SELECT * FROM notes").fetchall():
        stem = r["path"].rsplit("/", 1)[-1].removesuffix(".md")
        if stem == name or r["title"] == name:
            return _row_to_note(r)
    return None


def _row_to_note(row: sqlite3.Row) -> dict:
    return {
        "path": row["path"],
        "title": row["title"],
        "date": row["date"],
        "tags": json.loads(row["tags"]),
        "icon": row["icon"],
    }


def all_icons() -> dict[str, str]:
    """트리 표시용: 아이콘이 설정된 노트의 path → icon 매핑."""
    rows = get_conn().execute("SELECT path, icon FROM notes WHERE icon != ''").fetchall()
    return {r["path"]: r["icon"] for r in rows}


def notes_under(dir_prefix: str) -> list[dict]:
    """데이터베이스(테이블) 뷰용: 디렉토리 하위 노트를 임의 frontmatter 속성(props)까지 포함해 반환."""
    conn = get_conn()
    if dir_prefix:
        like = dir_prefix.rstrip("/") + "/%"
        rows = conn.execute(
            "SELECT * FROM notes WHERE path LIKE ? ORDER BY date DESC, title", (like,)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM notes WHERE path NOT LIKE 'templates/%' ORDER BY date DESC, title"
        ).fetchall()
    return [
        {**_row_to_note(r), "props": json.loads(r["props"]), "updated_at": r["updated_at"]}
        for r in rows
    ]


def notes_by_date(date: str) -> list[dict]:
    rows = get_conn().execute(
        "SELECT * FROM notes WHERE date = ? ORDER BY title", (date,)
    ).fetchall()
    return [_row_to_note(r) for r in rows]


def notes_by_tag(tag: str) -> list[dict]:
    rows = get_conn().execute("SELECT * FROM notes ORDER BY date DESC, title").fetchall()
    result = []
    for r in rows:
        if tag in json.loads(r["tags"]):
            result.append(_row_to_note(r))
    return result


def calendar_counts(year: int, month: int) -> dict[str, int]:
    prefix = f"{year:04d}-{month:02d}-%"
    rows = get_conn().execute(
        "SELECT date, COUNT(*) AS cnt FROM notes WHERE date LIKE ? GROUP BY date", (prefix,)
    ).fetchall()
    return {r["date"]: r["cnt"] for r in rows}


def calendar_event_counts(year: int, month: int) -> dict[str, int]:
    prefix = f"{year:04d}-{month:02d}-%"
    rows = get_conn().execute(
        "SELECT date, COUNT(*) AS cnt FROM calendar_events WHERE date LIKE ? GROUP BY date", (prefix,)
    ).fetchall()
    return {r["date"]: r["cnt"] for r in rows}


def calendar_events(*, date: str | None = None, start_date: str | None = None, end_date: str | None = None) -> list[dict]:
    conn = get_conn()
    if date:
        rows = conn.execute(
            "SELECT * FROM calendar_events WHERE date = ? ORDER BY time, title", (date,)
        ).fetchall()
    elif start_date and end_date:
        rows = conn.execute(
            "SELECT * FROM calendar_events WHERE date BETWEEN ? AND ? ORDER BY date, time, title",
            (start_date, end_date),
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM calendar_events ORDER BY date, time, title").fetchall()
    return [dict(row) for row in rows]


def create_calendar_event(*, event_id: str, date: str, time: str, title: str, description: str) -> dict:
    import time as clock

    now = clock.time()
    with get_conn():
        get_conn().execute(
            "INSERT INTO calendar_events(id,date,time,title,description,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
            (event_id, date, time, title, description, now, now),
        )
    return next(item for item in calendar_events(date=date) if item["id"] == event_id)


def update_calendar_event(event_id: str, fields: dict[str, str]) -> dict | None:
    import time as clock

    allowed = {key: value for key, value in fields.items() if key in {"date", "time", "title", "description"}}
    if not allowed:
        rows = get_conn().execute("SELECT * FROM calendar_events WHERE id = ?", (event_id,)).fetchall()
        return dict(rows[0]) if rows else None
    assignments = ", ".join(f"{key} = ?" for key in allowed)
    values = [*allowed.values(), clock.time(), event_id]
    with get_conn():
        cursor = get_conn().execute(
            f"UPDATE calendar_events SET {assignments}, updated_at = ? WHERE id = ?", values
        )
    if cursor.rowcount == 0:
        return None
    rows = get_conn().execute("SELECT * FROM calendar_events WHERE id = ?", (event_id,)).fetchall()
    return dict(rows[0])


def delete_calendar_event(event_id: str) -> bool:
    with get_conn():
        cursor = get_conn().execute("DELETE FROM calendar_events WHERE id = ?", (event_id,))
    return cursor.rowcount > 0


def all_tags() -> list[dict]:
    rows = get_conn().execute("SELECT tags FROM notes").fetchall()
    counts: dict[str, int] = {}
    for r in rows:
        for t in json.loads(r["tags"]):
            counts[t] = counts.get(t, 0) + 1
    return [{"tag": t, "count": c} for t, c in sorted(counts.items(), key=lambda x: (-x[1], x[0]))]


def _make_snippet(body: str, q: str, radius: int = 60) -> str:
    idx = body.lower().find(q.lower())
    if idx < 0:
        return body[: radius * 2].strip()
    start = max(0, idx - radius)
    end = min(len(body), idx + len(q) + radius)
    snippet = body[start:end].replace("\n", " ").strip()
    if start > 0:
        snippet = "…" + snippet
    if end < len(body):
        snippet = snippet + "…"
    return snippet


def search(q: str, limit: int = 50) -> list[dict]:
    conn = get_conn()
    q = q.strip()
    if not q:
        return []
    if len(q) >= 3:
        # trigram FTS — 한국어 포함 부분 문자열 매칭
        fts_query = '"' + q.replace('"', '""') + '"'
        try:
            rows = conn.execute(
                """SELECT n.* FROM notes_fts f JOIN notes n ON n.path = f.path
                   WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?""",
                (fts_query, limit),
            ).fetchall()
        except sqlite3.OperationalError:
            rows = []
    else:
        like = f"%{q}%"
        rows = conn.execute(
            "SELECT * FROM notes WHERE title LIKE ? OR body LIKE ? ORDER BY updated_at DESC LIMIT ?",
            (like, like, limit),
        ).fetchall()
    results = []
    for r in rows:
        note = _row_to_note(r)
        note["snippet"] = _make_snippet(r["body"], q)
        results.append(note)
    return results
