import unittest

from app.plugins.codex_assistant.app_server import _app_server_command


class CodexAppServerProcessTests(unittest.TestCase):
    def test_app_server_uses_default_stdio_transport_for_version_compatibility(self) -> None:
        command = _app_server_command("codex")

        self.assertEqual(command, ("codex", "app-server"))
        self.assertNotIn("--stdio", command)


class WindowsShellTests(unittest.TestCase):
    def test_store_alias_uses_builtin_without_mutating_parent(self):
        from app.plugins.codex_assistant.cli import _windows_shell_environment
        alias = r"C:\Users\한 글\AppData\Local\Microsoft\WindowsApps"
        builtin = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        env = {"Path": alias + r";C:\Git\bin;;C:\node", "SystemRoot": r"C:\Windows"}
        before = dict(env)
        child, selected = _windows_shell_environment(env, lambda path: path in {alias + r"\pwsh.exe", builtin})
        self.assertEqual(selected, builtin)
        self.assertNotIn(alias, child["Path"])
        self.assertIn(r"C:\Git\bin;;C:\node", child["Path"])
        self.assertEqual(env, before)

    def test_regular_shell_beats_store_and_other_package_is_allowed(self):
        from app.plugins.codex_assistant.cli import _windows_shell_environment
        store = r"C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6_x64"
        regular = r"C:\Program Files\WindowsApps\Other.Package\PowerShell"
        env = {"PATH": store + ";" + regular}
        child, selected = _windows_shell_environment(env, lambda p: p.endswith("pwsh.exe"))
        self.assertEqual(selected, regular + r"\pwsh.exe")
        self.assertNotIn(store, child["PATH"])

    def test_no_alias_does_not_remove_windowsapps(self):
        from app.plugins.codex_assistant.cli import _windows_shell_environment
        shell_dir = r"C:\PowerShell 7"
        env = {"PATH": shell_dir + r";C:\Users\me\AppData\Local\Microsoft\WindowsApps"}
        child, _ = _windows_shell_environment(env, lambda p: p == shell_dir + r"\pwsh.exe")
        self.assertEqual(child, env)

    def test_non_windows_launch_does_not_change_environment(self):
        from unittest.mock import patch
        from app.plugins.codex_assistant.cli import codex_app_server_launch
        with patch("app.plugins.codex_assistant.cli.os.name", "posix"), patch("app.plugins.codex_assistant.cli.codex_command", side_effect=lambda *args: ["codex", *args]):
            command, options, shell = codex_app_server_launch()
        self.assertEqual(command, ["codex", "app-server"])
        self.assertIsNone(shell)
        self.assertTrue(options["start_new_session"])
