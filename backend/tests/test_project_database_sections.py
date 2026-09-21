import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.routers.workspace import (
    CreateProjectSectionRequest,
    RenameProjectRequest,
    SetProjectPathRequest,
    create_project_section,
    get_sections,
    list_scopes,
    rename_project,
    rename_scope_project,
    set_project_path,
)
from app.ai.orchestrator import _resolve_scope_cwd


class ProjectSectionTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.notes_dir = patch("app.routers.workspace.config.notes_dir", return_value=self.root)
        self.notes_dir.start()

    def tearDown(self):
        self.notes_dir.stop()
        self.temp_dir.cleanup()

    def test_new_section_creates_project_folder_without_database_folder(self):
        with patch("app.routers.workspace.indexer.index_file") as index_file:
            section = create_project_section(CreateProjectSectionRequest(name="주문 서비스"))["section"]

        self.assertEqual(["주문 서비스"], section["items"])
        self.assertNotIn("database_dir", section)
        self.assertTrue((self.root / "주문 서비스").is_dir())
        self.assertFalse((self.root / "주문 서비스" / "database").exists())
        self.assertEqual([], list(self.root.rglob("*.erd.json")))
        scope_note = self.root / "scopes" / f"{section['scope_id']}.md"
        self.assertTrue(scope_note.is_file())
        self.assertTrue((self.root / ".projects" / section["scope_id"] / "AGENTS.md").is_file())
        scope = next(item for item in list_scopes()["scopes"] if item["id"] == section["scope_id"])
        self.assertEqual("", scope["path"])
        self.assertFalse(scope["has_path"])
        self.assertIsNone(section["project_path"])
        index_file.assert_called_once_with(f"scopes/{scope_note.name}")

    def test_pathless_project_uses_its_own_ai_working_directory(self):
        section = create_project_section(CreateProjectSectionRequest(name="문서 전용"))["section"]

        cwd = Path(_resolve_scope_cwd({}, section["scope_id"]))

        self.assertEqual((self.root / ".projects" / section["scope_id"]).resolve(), cwd)
        self.assertTrue((cwd / "AGENTS.md").is_file())

    def test_pathless_db_row_keeps_matching_legacy_project_path(self):
        section = create_project_section(CreateProjectSectionRequest(name="전환 프로젝트"))["section"]
        external = self.root / "legacy-code"
        external.mkdir()
        workspace_path = self.root / ".workspace.json"
        workspace = json.loads(workspace_path.read_text(encoding="utf-8"))
        workspace["scopes"] = [
            {"id": section["scope_id"], "label": "전환 프로젝트", "path": str(external)}
        ]
        workspace_path.write_text(json.dumps(workspace, ensure_ascii=False), encoding="utf-8")

        scope = next(item for item in list_scopes()["scopes"] if item["id"] == section["scope_id"])

        self.assertEqual(str(external), scope["path"])
        self.assertTrue(scope["has_path"])
        self.assertEqual(str(external), get_sections()["sections"][0]["project_path"])
        self.assertEqual(str(external.resolve()), _resolve_scope_cwd(workspace, section["scope_id"]))

    def test_assigning_path_later_preserves_project_documents_and_identifiers(self):
        section = create_project_section(CreateProjectSectionRequest(name="나중에 연결"))["section"]
        before = (self.root / ".workspace.json").read_text(encoding="utf-8")
        external = self.root / "external-code"
        external.mkdir()
        internal_agents = self.root / ".projects" / section["scope_id"] / "AGENTS.md"
        internal_agents.write_text("# 이 프로젝트의 유지할 규칙\n", encoding="utf-8")

        result = set_project_path(section["id"], SetProjectPathRequest(path=str(external)))

        stored = get_sections()["sections"][0]
        self.assertEqual(section["id"], stored["id"])
        self.assertEqual(section["scope_id"], stored["scope_id"])
        self.assertEqual(section["items"], stored["items"])
        self.assertEqual(str(external.resolve()), stored["project_path"])
        self.assertEqual(str(external.resolve()), result["path"])
        self.assertTrue((external / "AGENTS.md").is_file())
        self.assertEqual(internal_agents.read_text(encoding="utf-8"), (external / "AGENTS.md").read_text(encoding="utf-8"))
        # 경로 연결은 sections 원본의 문서 배치나 식별자를 다시 쓰지 않는다.
        self.assertEqual(before, (self.root / ".workspace.json").read_text(encoding="utf-8"))

    def test_rename_updates_both_sidebar_project_and_scope_label(self):
        section = create_project_section(CreateProjectSectionRequest(name="이전 이름"))["section"]

        renamed = rename_project(section["id"], RenameProjectRequest(name="새 이름"))["section"]
        scope = next(item for item in list_scopes()["scopes"] if item["id"] == section["scope_id"])

        self.assertEqual("새 이름", renamed["name"])
        self.assertEqual(section["id"], renamed["id"])
        self.assertEqual(section["items"], renamed["items"])
        self.assertEqual("새 이름", scope["label"])

    def test_scope_board_rename_updates_linked_sidebar_project(self):
        section = create_project_section(CreateProjectSectionRequest(name="이전 이름"))["section"]

        renamed = rename_scope_project(section["scope_id"], RenameProjectRequest(name="새 이름"))["section"]
        stored = get_sections()["sections"][0]
        scope = next(item for item in list_scopes()["scopes"] if item["id"] == section["scope_id"])

        self.assertEqual("새 이름", renamed["name"])
        self.assertEqual("새 이름", stored["name"])
        self.assertEqual("새 이름", scope["label"])

    def test_legacy_section_is_migrated_to_project_without_losing_custom_data(self):
        (self.root / ".workspace.json").write_text(
            '{"sections":[{"id":"legacy","name":"기존","expanded":false,"items":["기존"],"custom":"keep"}]}',
            encoding="utf-8",
        )
        (self.root / "기존").mkdir()

        project = get_sections()["sections"][0]
        stored = json.loads((self.root / ".workspace.json").read_text(encoding="utf-8"))["sections"][0]

        self.assertEqual("legacy", project["id"])
        self.assertEqual(["기존"], project["items"])
        self.assertEqual("keep", stored["custom"])
        self.assertTrue(project["scope_id"])
        self.assertTrue((self.root / ".projects" / project["scope_id"] / "AGENTS.md").is_file())

    def test_existing_scope_identifier_is_preserved_when_its_row_is_missing(self):
        (self.root / ".workspace.json").write_text(
            '{"sections":[{"id":"legacy","name":"기존","expanded":true,"items":[],"scope_id":"stable-scope"}]}',
            encoding="utf-8",
        )

        project = get_sections()["sections"][0]

        self.assertEqual("stable-scope", project["scope_id"])
        self.assertTrue((self.root / "scopes" / "stable-scope.md").is_file())
        self.assertTrue((self.root / ".projects" / "stable-scope" / "AGENTS.md").is_file())

    def test_legacy_database_directory_setting_is_removed_without_deleting_files(self):
        workspace = self.root / ".workspace.json"
        workspace.write_text(
            '{"sections":[{"id":"s-old","name":"기존 프로젝트","expanded":true,"items":[],"database_dir":"기존 프로젝트/database"}]}',
            encoding="utf-8",
        )
        legacy_dir = self.root / "기존 프로젝트" / "database"
        legacy_dir.mkdir(parents=True)

        section = get_sections()["sections"][0]

        self.assertNotIn("database_dir", section)
        self.assertTrue(legacy_dir.is_dir())


if __name__ == "__main__":
    unittest.main()
