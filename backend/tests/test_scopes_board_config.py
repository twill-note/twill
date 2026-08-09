import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.routers.db import DbConfig, SaveConfigRequest, get_config, save_config


class ScopesBoardConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.scopes = self.root / "scopes"
        self.scopes.mkdir()
        self.notes_dir = patch("app.routers.db.notes_dir", return_value=self.root)
        self.notes_dir.start()

    def tearDown(self):
        self.notes_dir.stop()
        self.temp_dir.cleanup()

    def test_legacy_project_board_is_exposed_as_path_only_table(self):
        (self.scopes / ".db.json").write_text(
            json.dumps(
                {
                    "title": "프로젝트 관리",
                    "kind": "scopes_board",
                    "columns": [
                        {"key": "project", "label": "그룹", "type": "select", "visible": True},
                        {"key": "label", "label": "이름", "type": "text", "visible": True},
                        {"key": "path", "label": "경로", "type": "path", "visible": True},
                        {"key": "owner", "label": "담당자", "type": "text", "visible": True},
                    ],
                    "defaultView": "board",
                    "boardGroupBy": "project",
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        config = get_config("scopes")

        self.assertEqual(config["defaultView"], "table")
        self.assertIsNone(config["boardGroupBy"])
        self.assertEqual([column["key"] for column in config["columns"]], ["path"])

    def test_saving_cannot_restore_project_board_or_extra_columns(self):
        result = save_config(
            SaveConfigRequest(
                dir="scopes",
                config=DbConfig(
                    title="프로젝트 관리",
                    kind="scopes_board",
                    columns=[
                        {"key": "path", "label": "임의 이름", "type": "text"},
                        {"key": "owner", "label": "담당자", "type": "text"},
                    ],
                    defaultView="board",
                    boardGroupBy="owner",
                ),
            )
        )

        self.assertEqual(result["defaultView"], "table")
        self.assertIsNone(result["boardGroupBy"])
        self.assertEqual([column["key"] for column in result["columns"]], ["path"])
        self.assertEqual(result["columns"][0]["label"], "경로")
        self.assertEqual(result["columns"][0]["type"], "path")


if __name__ == "__main__":
    unittest.main()
