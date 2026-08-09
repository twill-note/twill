import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.routers.files import get_document_link_target, resolve_document_link_target


class DocumentLinkTargetTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name) / "notes"
        self.root.mkdir()
        (self.root / "회의록").mkdir()
        (self.root / "회의록" / "결정.md").write_text("결정", encoding="utf-8")
        (self.root / "설계.erd.json").write_text("{}", encoding="utf-8")
        (self.root / "frontend" / "src").mkdir(parents=True)
        (self.root / "frontend" / "src" / "App.tsx").write_text("export {}", encoding="utf-8")
        (self.root / ".trash").mkdir()
        (self.root / ".trash" / "삭제됨.md").write_text("삭제됨", encoding="utf-8")
        self.other_project = Path(self.temp_dir.name) / "other-project"
        self.other_project.mkdir()
        (self.other_project / "README.md").write_text("다른 프로젝트", encoding="utf-8")
        self.notes_dir = patch("app.routers.files.notes_dir", return_value=self.root)
        self.notes_dir_mock = self.notes_dir.start()

    def tearDown(self):
        self.notes_dir.stop()
        self.temp_dir.cleanup()

    def test_existing_markdown_and_erd_are_resolved_with_codex_suffixes(self):
        self.assertEqual(
            {"kind": "note", "path": "회의록/결정.md"},
            resolve_document_link_target("회의록/%EA%B2%B0%EC%A0%95.md:12:4"),
        )
        self.assertEqual(
            {"kind": "note", "path": "회의록/결정.md"},
            resolve_document_link_target("회의록\\결정.md#결정"),
        )
        self.assertEqual(
            {"kind": "erd", "path": "설계.erd.json"},
            resolve_document_link_target(f"{self.root / '설계.erd.json'}:8"),
        )
        self.assertEqual(
            {"target": {"kind": "note", "path": "회의록/결정.md"}},
            get_document_link_target("회의록/결정.md"),
        )

    def test_external_local_escape_and_missing_paths_are_never_targets(self):
        blocked = [
            f"file://{self.root / '회의록' / '결정.md'}",
            str(self.other_project / "README.md"),
            "frontend/src/App.tsx",
            "없는/문서.md",
            "회의록/../회의록/결정.md",
            "회의록/%2e%2e/회의록/결정.md",
            ".trash/삭제됨.md",
            "https://example.com/회의록/결정.md",
        ]

        for href in blocked:
            with self.subTest(href=href):
                self.assertIsNone(resolve_document_link_target(href))

    def test_switching_workspace_invalidates_an_old_session_path(self):
        next_root = Path(self.temp_dir.name) / "new-notes"
        next_root.mkdir()
        (next_root / "새 문서.md").write_text("새 루트", encoding="utf-8")
        old_absolute_path = str(self.root / "회의록" / "결정.md")

        self.notes_dir_mock.return_value = next_root

        self.assertIsNone(resolve_document_link_target(old_absolute_path))
        self.assertIsNone(resolve_document_link_target("회의록/결정.md"))
        self.assertEqual(
            {"kind": "note", "path": "새 문서.md"},
            resolve_document_link_target("%EC%83%88%20%EB%AC%B8%EC%84%9C.md"),
        )

    def test_target_is_rechecked_before_an_open_action(self):
        document = self.root / "회의록" / "결정.md"
        self.assertIsNotNone(resolve_document_link_target("회의록/결정.md"))

        document.unlink()

        # ChatDocumentLink는 클릭 직전에 이 같은 API 결과를 다시 확인하므로, 렌더 뒤
        # 삭제된 문서는 기존 anchor를 눌러도 내부 편집기로 열리지 않는다.
        self.assertIsNone(resolve_document_link_target("회의록/결정.md"))

    def test_document_title_is_not_used_as_a_link_identity(self):
        document = self.root / "회의록" / "결정.md"
        document.write_text("---\ntitle: 바뀐 회의 제목\n---\n\n본문", encoding="utf-8")

        self.assertEqual(
            {"kind": "note", "path": "회의록/결정.md"},
            resolve_document_link_target("회의록/결정.md"),
        )


if __name__ == "__main__":
    unittest.main()
