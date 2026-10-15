import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from app import config, db
from app.routers import files


class DocumentRenameTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        state = patch.dict(config._state, {'root': self.root})
        state.start()
        self.addCleanup(state.stop)
        for target in ('app.routers.files.notes_dir', 'app.indexer.notes_dir'):
            mock = patch(target, return_value=self.root)
            mock.start()
            self.addCleanup(mock.stop)
        self.addCleanup(self.close_db)
        files.create_entry(files.CreateRequest(path='original', type='file'))

    def close_db(self):
        conn = getattr(db._local, 'conn', None)
        if conn:
            conn.close()
            db._local.conn = None

    def save(self, title, **overrides):
        before = files.get_content('original.md')
        return files.save_content(files.SaveRequest(**{
            'path': before['path'], 'frontmatter': {**before['frontmatter'], 'title': title},
            'body': 'edited body', 'mtime': before['mtime'], 'sync_title': True, **overrides,
        }))

    def test_title_renames_file_companion_and_project_membership(self):
        files.create_entry(files.CreateRequest(path='original/child', type='file'))
        (self.root / '.workspace.json').write_text(json.dumps({'sections': [{'id': 'p', 'items': ['original.md']}]}))
        result = self.save('새 제목')
        self.assertEqual(result['path'], '새 제목.md')
        self.assertFalse((self.root / 'original.md').exists())
        self.assertTrue((self.root / '새 제목/child.md').is_file())
        self.assertEqual(files.get_content(result['path'])['body'], 'edited body')
        self.assertEqual(json.loads((self.root / '.workspace.json').read_text())['sections'][0]['items'], ['새 제목.md'])

    def test_duplicate_titles_do_not_overwrite_other_documents(self):
        files.create_entry(files.CreateRequest(path='taken', type='file'))
        self.assertEqual(self.save('taken')['path'], 'taken (2).md')
        self.assertEqual(files.get_content('taken.md')['body'], '')

    def test_case_only_title_change_updates_the_actual_filename(self):
        self.assertEqual(self.save('ORIGINAL')['path'], 'ORIGINAL.md')
        names = [path.name for path in self.root.iterdir()]
        self.assertIn('ORIGINAL.md', names)
        self.assertNotIn('original.md', names)

    def test_windows_reserved_names_and_path_characters_are_portable(self):
        self.assertEqual(self.save('CON')['path'], '_CON.md')
        path = files._title_destination(self.root / 'sample.md', 'a/b:c?d*e\\f')
        self.assertEqual(path.name, 'a b c d e f.md')
        self.assertEqual(path.parent, self.root)

    def test_conflict_preserves_file_and_path(self):
        with self.assertRaises(HTTPException) as error:
            self.save('new', mtime=0)
        self.assertEqual(error.exception.status_code, 409)
        self.assertTrue((self.root / 'original.md').exists())
        self.assertFalse((self.root / 'new.md').exists())

    def test_retry_after_rename_failure_still_synchronizes_filename(self):
        with patch.object(files, 'rename_entry', side_effect=HTTPException(status_code=409, detail='File is busy')):
            with self.assertRaises(HTTPException):
                self.save('new')
        self.assertEqual(files.get_content('original.md')['frontmatter']['title'], 'new')
        self.assertEqual(self.save('new')['path'], 'new.md')

    def test_metadata_only_save_preserves_existing_contract(self):
        self.assertEqual(self.save('new', sync_title=False)['path'], 'original.md')

    def test_move_updates_membership_and_preserves_children(self):
        files.create_entry(files.CreateRequest(path='original/child', type='file'))
        files.create_entry(files.CreateRequest(path='project', type='dir'))
        (self.root / '.workspace.json').write_text(json.dumps({'sections': [{'id': 'p', 'items': ['original.md']}]}))
        result = files.move_entry(files.MoveRequest(path='original.md', dest_dir='project'))
        self.assertEqual(result['path'], 'project/original.md')
        self.assertTrue((self.root / 'project/original/child.md').is_file())
        self.assertEqual(json.loads((self.root / '.workspace.json').read_text())['sections'][0]['items'], [])
