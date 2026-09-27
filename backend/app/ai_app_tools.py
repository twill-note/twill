"""Dynamic Codex tools backed by Twill's native calendar and to-do data."""
from __future__ import annotations

import datetime
import json
from typing import Any

from fastapi import HTTPException

from . import db
from .routers import notes


def _args(value: Any) -> dict:
    if not isinstance(value, dict):
        raise ValueError("도구 입력은 객체여야 합니다")
    return value


def _invoke(function, *args, **kwargs):
    try:
        return function(*args, **kwargs)
    except HTTPException as exc:
        raise ValueError(str(exc.detail)) from exc


def _iso_date(value: Any, *, default_today: bool = False) -> str | None:
    if value is None or value == "":
        return datetime.date.today().isoformat() if default_today else None
    try:
        parsed = datetime.date.fromisoformat(str(value))
    except ValueError as exc:
        raise ValueError("날짜는 YYYY-MM-DD 형식이어야 합니다") from exc
    if parsed.isoformat() != str(value):
        raise ValueError("날짜는 YYYY-MM-DD 형식이어야 합니다")
    return parsed.isoformat()


def list_calendar_events_tool(arguments: Any) -> str:
    args = _args(arguments)
    date = _iso_date(args.get("date"), default_today=not args.get("start_date"))
    start_date = _iso_date(args.get("start_date"))
    end_date = _iso_date(args.get("end_date"))
    if bool(start_date) != bool(end_date):
        raise ValueError("기간 조회에는 start_date와 end_date가 모두 필요합니다")
    return json.dumps(
        {"events": _invoke(notes.list_calendar_events, date=date, start_date=start_date, end_date=end_date)},
        ensure_ascii=False,
    )


def create_calendar_event_tool(arguments: Any) -> str:
    args = _args(arguments)
    event = _invoke(notes.create_calendar_event, notes.CalendarEventCreate(**args))
    return json.dumps({"created": True, "event": event}, ensure_ascii=False)


def update_calendar_event_tool(arguments: Any) -> str:
    args = _args(arguments)
    event_id = str(args.pop("event_id", "")).strip()
    if not event_id:
        raise ValueError("event_id가 필요합니다")
    event = _invoke(notes.update_calendar_event, event_id, notes.CalendarEventUpdate(**args))
    return json.dumps({"updated": True, "event": event}, ensure_ascii=False)


def delete_calendar_event_tool(arguments: Any) -> str:
    args = _args(arguments)
    event_id = str(args.get("event_id", "")).strip()
    if not event_id:
        raise ValueError("event_id가 필요합니다")
    return json.dumps(_invoke(notes.delete_calendar_event, event_id), ensure_ascii=False)


def list_todos_tool(arguments: Any) -> str:
    args = _args(arguments)
    date = _iso_date(args.get("date"), default_today=True)
    include_done = bool(args.get("include_done", False))
    groups = db.all_todos(include_done=include_done)
    result = [
        {**group, "items": [item for item in group["items"] if include_done or not item["done"]]}
        for group in groups
        if group.get("date") == date and (include_done or any(not item["done"] for item in group["items"]))
    ]
    return json.dumps({"date": date, "groups": result}, ensure_ascii=False)


def create_todo_tool(arguments: Any) -> str:
    args = _args(arguments)
    result = _invoke(notes.create_todo, notes.CreateTodoRequest(**args))
    return json.dumps(result, ensure_ascii=False)


def complete_todo_tool(arguments: Any) -> str:
    args = _args(arguments)
    query = str(args.get("text", "")).strip().casefold()
    if not query:
        raise ValueError("완료할 할 일의 text가 필요합니다")
    date = _iso_date(args.get("date"))
    path = str(args.get("path") or "").strip()
    matches = []
    for group in db.all_todos(include_done=True):
        if date and group.get("date") != date:
            continue
        if path and group.get("path") != path:
            continue
        for item in group["items"]:
            if query == item["text"].casefold() or query in item["text"].casefold():
                matches.append({**item, "path": group["path"], "title": group["title"], "date": group["date"]})
    if not matches:
        raise ValueError("일치하는 할 일을 찾지 못했습니다")
    open_matches = [item for item in matches if not item["done"]]
    if open_matches:
        matches = open_matches
    if len(matches) > 1:
        return json.dumps({"completed": False, "reason": "multiple_matches", "matches": matches}, ensure_ascii=False)
    item = matches[0]
    if item["done"]:
        return json.dumps({"completed": True, "already_done": True, "item": item}, ensure_ascii=False)
    result = _invoke(notes.toggle_todo, notes.ToggleRequest(path=item["path"], line=item["line"], text=item["text"]))
    return json.dumps({"completed": result["done"], "item": item}, ensure_ascii=False)
