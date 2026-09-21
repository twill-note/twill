from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from app import skillbook


class SkillbookMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.old = self.root / 'install' / 'skillbook'
        self.new = self.root / 'user' / 'skillbook'
        self.bundled = self.root / 'bundle' / 'skillbook'
        for name, value in [('SKILLBOOK_ROOT', self.new), ('APP_SKILLS_DIR', self.new / 'skills'), ('TRASH_DIR', self.new / '.trash'), ('BUNDLED_SKILLBOOK_ROOT', self.bundled)]:
            p = patch.object(skillbook, name, value)
            p.start()
            self.addCleanup(p.stop)

    def write(self, base, name, content='original'):
        root = base / 'skills' / name
        root.mkdir(parents=True)
        (root / 'SKILL.md').write_text(f'---\nname: {name}\ndescription: test\n---\n{content}')
        return root

    def test_reinstall_preserves_skills_assets_and_trash(self):
        original = self.write(self.old, 'my-skill')
        (original / 'assets').mkdir()
        (original / 'assets' / 'image.png').write_bytes(b'\x89PNG')
        trash = self.old / '.trash' / 'removed'
        trash.mkdir(parents=True)
        (trash / 'SKILL.md').write_text('old')
        result = skillbook.initialize_skillbook([self.old])
        shutil.rmtree(self.old.parent)
        skillbook.initialize_skillbook([self.old])
        self.assertIn('skills/my-skill', result['imported'])
        self.assertEqual((self.new / 'skills/my-skill/assets/image.png').read_bytes(), b'\x89PNG')
        self.assertTrue((self.new / '.trash/removed/SKILL.md').exists())

    def test_existing_user_content_wins_and_deletion_does_not_resurrect(self):
        self.write(self.old, 'same', 'old')
        target = self.write(self.new, 'same', 'edited')
        skillbook.initialize_skillbook([self.old])
        self.assertIn('edited', (target / 'SKILL.md').read_text())
        shutil.rmtree(target)
        skillbook.initialize_skillbook([self.old])
        self.assertFalse(target.exists())

    def test_failed_copy_can_retry(self):
        self.write(self.old, 'retry')
        with patch.object(shutil, 'copytree', side_effect=OSError('full disk')):
            with self.assertRaises(OSError):
                skillbook.initialize_skillbook([self.old])
        self.assertEqual(list(self.new.glob('.migrated-*')), [])
        skillbook.initialize_skillbook([self.old])
        self.assertTrue((self.new / 'skills/retry/SKILL.md').exists())

    def test_symlinks_are_not_followed(self):
        source = self.write(self.old, 'retry')
        try:
            (source / 'external').symlink_to(self.root / 'outside')
        except OSError as exc:
            self.skipTest(f'symlink creation is not available: {exc}')
        skillbook.initialize_skillbook([self.old])
        self.assertFalse((self.new / 'skills/retry/external').is_symlink())

    def test_builtin_updates_without_replacing_editable_skill(self):
        self.write(self.bundled, 'create-system-skill', 'new guide')
        self.write(self.new, 'create-system-skill', 'old guide')
        target = self.write(self.new, 'mine', 'keep')
        skillbook.initialize_skillbook([])
        self.assertIn('new guide', (self.new / 'skills/create-system-skill/SKILL.md').read_text())
        self.assertIn('keep', (target / 'SKILL.md').read_text())
