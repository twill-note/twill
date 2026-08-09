import unittest

from app.plugins.codex_assistant.app_server import _app_server_command


class CodexAppServerProcessTests(unittest.TestCase):
    def test_app_server_uses_default_stdio_transport_for_version_compatibility(self) -> None:
        command = _app_server_command("codex")

        self.assertEqual(command, ("codex", "app-server"))
        self.assertNotIn("--stdio", command)
