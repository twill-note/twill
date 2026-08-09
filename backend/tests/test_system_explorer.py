import base64
import re
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.routers import workspace


class SystemExplorerTests(unittest.TestCase):
    def test_native_windows_uses_shell_explore_action(self):
        target = Path("C:/Users/choi/My Notes")

        with (
            patch.object(workspace.platform, "system", return_value="Windows"),
            patch.object(workspace.os, "startfile", create=True) as startfile,
            patch.object(workspace.subprocess, "Popen") as popen,
            patch.object(workspace.subprocess, "run") as run,
        ):
            workspace._open_system_explorer(target)

        startfile.assert_called_once_with(workspace.os.path.normpath(str(target)), "explore", show_cmd=1)
        popen.assert_not_called()
        run.assert_not_called()

    def test_wsl_uses_windows_shell_start_process(self):
        target = Path("/home/choi/My Notes")
        win_path = r"\\wsl.localhost\Ubuntu\home\choi\My Notes"
        run_results = [SimpleNamespace(stdout=f"{win_path}\n"), SimpleNamespace(stdout="")]

        with (
            patch.object(workspace.platform, "system", return_value="Linux"),
            patch.object(workspace, "_is_wsl", return_value=True),
            patch.object(workspace.subprocess, "run", side_effect=run_results) as run,
            patch.object(workspace.subprocess, "Popen") as popen,
        ):
            workspace._open_system_explorer(target)

        self.assertEqual(["wslpath", "-w", str(target)], run.call_args_list[0].args[0])
        command = run.call_args_list[1].args[0]
        self.assertEqual("powershell.exe", command[0])
        self.assertIn("-Command", command)
        script = command[command.index("-Command") + 1]
        encoded_path = re.search(r"FromBase64String\('([^']+)'\)", script).group(1)
        self.assertEqual(win_path, base64.b64decode(encoded_path).decode("utf-8"))
        self.assertIn("Start-Process -FilePath explorer.exe", script)
        self.assertIn("$argument = '\"' + $target + '\"'", script)
        self.assertEqual(subprocess.DEVNULL, run.call_args_list[1].kwargs["stdout"])
        self.assertTrue(run.call_args_list[1].kwargs["check"])
        self.assertEqual(10, run.call_args_list[1].kwargs["timeout"])
        popen.assert_not_called()

    def test_wsl_path_is_safely_carried_as_base64_data(self):
        path = r"C:\Users\choi\O'Brien Notes"
        command = workspace._powershell_explorer_command(path)

        script = command[command.index("-Command") + 1]
        encoded_path = re.search(r"FromBase64String\('([^']+)'\)", script).group(1)

        self.assertEqual(path, base64.b64decode(encoded_path).decode("utf-8"))
        self.assertNotIn(path, script)

    def test_macos_open_does_not_use_background_option(self):
        target = Path("/Users/choi/My Notes")

        with (
            patch.object(workspace.platform, "system", return_value="Darwin"),
            patch.object(workspace.subprocess, "Popen") as popen,
            patch.object(workspace.subprocess, "run") as run,
        ):
            workspace._open_system_explorer(target)

        popen.assert_called_once_with(
            ["open", str(target)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.assertNotIn("-g", popen.call_args.args[0])
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
