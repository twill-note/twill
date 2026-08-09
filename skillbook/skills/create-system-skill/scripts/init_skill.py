#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


SKILLS_ROOT = Path(__file__).resolve().parents[2]
NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
ALLOWED_RESOURCES = {"scripts", "references", "assets"}


def main() -> int:
    parser = argparse.ArgumentParser(description="스킬북에 앱 전용 스킬을 초기화합니다.")
    parser.add_argument("name")
    parser.add_argument("--description", required=True)
    parser.add_argument("--resources", default="")
    args = parser.parse_args()

    name = args.name.strip()
    description = args.description.strip()
    if not NAME_RE.fullmatch(name):
        parser.error("name은 소문자, 숫자, 하이픈만 사용할 수 있습니다.")
    if not description:
        parser.error("description은 비어 있을 수 없습니다.")

    resources = {item.strip() for item in args.resources.split(",") if item.strip()}
    unknown = resources - ALLOWED_RESOURCES
    if unknown:
        parser.error(f"지원하지 않는 resource: {', '.join(sorted(unknown))}")

    skill_dir = SKILLS_ROOT / name
    if skill_dir.exists():
        parser.error(f"이미 존재하는 스킬입니다: {name}")
    skill_dir.mkdir(parents=True)
    for resource in sorted(resources):
        (skill_dir / resource).mkdir()

    skill_md = (
        "---\n"
        f"name: {name}\n"
        f"description: {json.dumps(description, ensure_ascii=False)}\n"
        "---\n\n"
        f"# {name}\n\n"
        "TODO: 이 스킬을 사용할 때 따라야 할 절차를 작성하세요.\n"
    )
    (skill_dir / "SKILL.md").write_text(skill_md, encoding="utf-8")
    print(f"created skillbook:{name} at {skill_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
