import unittest
from unittest.mock import patch
from app.routers.terminal import terminal_environment, WINDOWS_UTF8_INIT


class TerminalEncodingTests(unittest.TestCase):
    def test_finder_and_c_locale_use_utf8(self):
        with patch.dict('os.environ', {'LC_ALL': 'C'}, clear=True), patch('sys.platform', 'darwin'):
            env = terminal_environment()
            self.assertEqual(env['LC_ALL'], 'en_US.UTF-8')
            self.assertEqual(env['PYTHONIOENCODING'], 'utf-8')

    def test_existing_utf8_locale_is_preserved(self):
        with patch.dict('os.environ', {'LANG': 'ko_KR.UTF-8'}, clear=True):
            self.assertEqual(terminal_environment()['LANG'], 'ko_KR.UTF-8')

    def test_windows_initializes_both_console_directions_and_pipeline(self):
        for setting in ('65001', '[Console]::InputEncoding', '[Console]::OutputEncoding', '$OutputEncoding'):
            self.assertIn(setting, WINDOWS_UTF8_INIT)
