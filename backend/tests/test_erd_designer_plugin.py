import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from app.plugins.erd_designer import DiagramSaveRequest, get_diagram, list_diagrams, save_diagram


def diagram(title: str = "주문 스키마") -> dict:
    return {
        "version": 1,
        "meta": {"title": title, "dialect": "mariadb", "updated": 100},
        "tables": [{"id": "orders", "name": "orders", "columns": []}],
        "relations": [],
    }


class ErdDesignerPluginTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.notes_dir = patch("app.plugins.erd_designer.config.notes_dir", return_value=self.root)
        self.notes_dir.start()

    def tearDown(self):
        self.notes_dir.stop()
        self.temp_dir.cleanup()

    def test_save_list_and_reopen_diagram(self):
        saved = save_diagram(DiagramSaveRequest(path="erd/orders.erd.json", diagram=diagram()))

        self.assertEqual("erd/orders.erd.json", saved["path"])
        self.assertTrue((self.root / saved["path"]).is_file())
        self.assertEqual(
            [{
                "path": "erd/orders.erd.json",
                "title": "주문 스키마",
                "dialect": "mariadb",
                "updated": 100,
                "tables": 1,
                "relations": 0,
            }],
            list_diagrams()["diagrams"],
        )
        self.assertEqual(diagram(), get_diagram("erd/orders.erd.json")["diagram"])

    def test_rejects_workspace_escape(self):
        with self.assertRaises(HTTPException) as raised:
            save_diagram(DiagramSaveRequest(path="../outside.erd.json", diagram=diagram()))

        self.assertEqual(400, raised.exception.status_code)

    def test_title_synced_new_diagram_uses_normalized_title_filename(self):
        saved = save_diagram(DiagramSaveRequest(
            path="erd/diagram-20260716-101010-001.erd.json",
            diagram=diagram(" 주문/서비스: ERD "),
            sync_title=True,
        ))

        self.assertEqual("erd/주문 서비스 ERD.erd.json", saved["path"])
        self.assertTrue((self.root / "erd/주문 서비스 ERD.erd.json").is_file())
        self.assertFalse((self.root / "erd/diagram-20260716-101010-001.erd.json").exists())
        self.assertEqual("title", saved["diagram"]["meta"]["filenameMode"])

    def test_title_change_renames_existing_diagram_without_losing_contents(self):
        original = save_diagram(DiagramSaveRequest(
            path="erd/diagram-20260716-101010-001.erd.json",
            diagram=diagram("주문 서비스 ERD"),
            sync_title=True,
        ))
        renamed_diagram = diagram("정산 ERD")
        renamed_diagram["tables"].append({"id": "settlements", "name": "settlements", "columns": []})

        saved = save_diagram(DiagramSaveRequest(
            path=original["path"], diagram=renamed_diagram, sync_title=True,
        ))

        self.assertEqual("erd/정산 ERD.erd.json", saved["path"])
        self.assertFalse((self.root / original["path"]).exists())
        self.assertEqual(renamed_diagram["tables"], get_diagram(saved["path"])["diagram"]["tables"])

    def test_title_filename_collision_keeps_original_file(self):
        original = save_diagram(DiagramSaveRequest(
            path="erd/diagram-20260716-101010-001.erd.json",
            diagram=diagram("주문 서비스 ERD"),
            sync_title=True,
        ))
        conflicting = save_diagram(DiagramSaveRequest(
            path="erd/existing.erd.json",
            diagram=diagram("정산 ERD"),
            sync_title=True,
        ))
        before = (self.root / original["path"]).read_bytes()
        updated = diagram("정산 ERD")
        updated["tables"].append({"id": "new", "name": "new", "columns": []})

        with self.assertRaises(HTTPException) as raised:
            save_diagram(DiagramSaveRequest(path=original["path"], diagram=updated, sync_title=True))

        self.assertEqual(409, raised.exception.status_code)
        self.assertIn("제목을 바꾸거나", raised.exception.detail)
        self.assertEqual(before, (self.root / original["path"]).read_bytes())
        self.assertTrue((self.root / conflicting["path"]).is_file())

    def test_invalid_title_does_not_create_or_replace_file(self):
        bad = diagram(' <>:"/\\|?* ')

        with self.assertRaises(HTTPException) as raised:
            save_diagram(DiagramSaveRequest(path="erd/diagram-20260716-101010-001.erd.json", diagram=bad, sync_title=True))

        self.assertEqual(422, raised.exception.status_code)
        self.assertFalse((self.root / "erd").exists())

    def test_rename_failure_restores_original_path_and_contents(self):
        original = save_diagram(DiagramSaveRequest(
            path="erd/diagram-20260716-101010-001.erd.json",
            diagram=diagram("주문 서비스 ERD"),
            sync_title=True,
        ))
        source = self.root / original["path"]
        before = source.read_bytes()
        updated = diagram("정산 ERD")

        with patch("app.plugins.erd_designer.os.replace", side_effect=[None, OSError("write failed"), None]):
            with self.assertRaises(HTTPException) as raised:
                save_diagram(DiagramSaveRequest(path=original["path"], diagram=updated, sync_title=True))

        self.assertEqual(500, raised.exception.status_code)
        self.assertEqual(before, source.read_bytes())
        self.assertFalse((self.root / "erd/정산 ERD.erd.json").exists())

    def test_manual_path_is_an_explicit_title_rename_exception(self):
        saved = save_diagram(DiagramSaveRequest(
            path="erd/직접 지정.erd.json",
            diagram=diagram("주문 서비스 ERD"),
            sync_title=False,
        ))
        changed = diagram("정산 ERD")

        resaved = save_diagram(DiagramSaveRequest(path=saved["path"], diagram=changed, sync_title=False))

        self.assertEqual("erd/직접 지정.erd.json", resaved["path"])
        stored = json.loads((self.root / resaved["path"]).read_text(encoding="utf-8"))
        self.assertEqual("manual", stored["meta"]["filenameMode"])


if __name__ == "__main__":
    unittest.main()
