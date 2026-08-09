#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
from pathlib import Path

import yaml


SKILLS_ROOT = Path(__file__).resolve().parents[2]
NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def validate(skill_dir: Path) -> list[str]:
    errors: list[str] = []
    if skill_dir.parent.resolve() != SKILLS_ROOT.resolve():
        return ["스킬북 디렉터리 바로 아래의 스킬만 검증할 수 있습니다."]
    skill_file = skill_dir / "SKILL.md"
    if not skill_file.is_file():
        return ["SKILL.md가 없습니다."]

    text = skill_file.read_text(encoding="utf-8")
    if not text.startswith("---\n") or "\n---\n" not in text[4:]:
        return ["SKILL.md YAML frontmatter 형식이 올바르지 않습니다."]
    _, raw_metadata, body = text.split("---", 2)
    try:
        metadata = yaml.safe_load(raw_metadata) or {}
    except yaml.YAMLError as exc:
        return [f"YAML을 읽을 수 없습니다: {exc}"]

    if set(metadata) != {"name", "description"}:
        errors.append("frontmatter에는 name과 description만 있어야 합니다.")
    name = str(metadata.get("name") or "")
    description = str(metadata.get("description") or "").strip()
    if not NAME_RE.fullmatch(name):
        errors.append("name 형식이 올바르지 않습니다.")
    if name != skill_dir.name:
        errors.append("name과 디렉터리 이름이 다릅니다.")
    if not description:
        errors.append("description은 비어 있을 수 없습니다.")
    if "TODO: 이 스킬을 사용할 때 따라야 할 절차를 작성하세요." in body:
        errors.append("SKILL.md의 생성 템플릿을 완료해야 합니다.")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="앱 전용 스킬을 검증합니다.")
    parser.add_argument("name")
    args = parser.parse_args()

    skill_dir = (SKILLS_ROOT / args.name).resolve()
    errors = validate(skill_dir)
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1
    print(f"valid skillbook:{skill_dir.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
