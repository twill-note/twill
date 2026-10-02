import unittest

from app.plugins.codex_assistant.codex_engine import _classify, _error_event


class CodexEventMappingTests(unittest.TestCase):
    def test_windows_shell_spawn_error_has_distinct_failure_stage(self):
        event = _error_event({"message": "CreateProcessAsUserW failed: 5"})
        self.assertEqual("shell_spawn_failed", event["code"])
        self.assertEqual("shell_spawn", event["stage"])
        self.assertIn("failed: 5", event["message"])
        self.assertNotEqual("shell_spawn_failed", _error_event({"message": "command failed"}).get("code"))

    def test_command_events_keep_the_same_tool_item_id(self):
        started = _classify(
            "item/started",
            {"item": {"id": "cmd-1", "type": "commandExecution", "command": "npm test"}},
        )
        completed = _classify(
            "item/completed",
            {
                "item": {
                    "id": "cmd-1",
                    "type": "commandExecution",
                    "command": "npm test",
                    "exitCode": 0,
                }
            },
        )

        self.assertEqual("cmd-1", started["itemId"])
        self.assertEqual("command", started["tool_type"])
        self.assertEqual("cmd-1", completed["itemId"])
        self.assertTrue(completed["success"])

        failed = _classify(
            "item/completed",
            {"item": {"id": "cmd-2", "type": "commandExecution", "command": "npm test", "exitCode": 1}},
        )
        self.assertFalse(failed["success"])

    def test_file_change_completion_can_close_the_inline_tool_block(self):
        event = _classify(
            "item/completed",
            {
                "item": {
                    "id": "file-1",
                    "type": "fileChange",
                    "changes": [{"path": "/workspace/src/app.ts"}],
                }
            },
        )

        self.assertEqual("file_change", event["type"])
        self.assertEqual("file-1", event["itemId"])
        self.assertEqual("file_change", event["tool_type"])

    def test_image_generation_completion_keeps_result_inside_backend(self):
        event = _classify(
            "item/completed",
            {
                "item": {
                    "id": "image-1",
                    "type": "imageGeneration",
                    "status": "completed",
                    "result": "raw-base64-result",
                    "savedPath": "/tmp/generated.png",
                    "revisedPrompt": "a quiet workspace",
                }
            },
        )

        self.assertEqual("image_result_candidate", event["type"])
        self.assertEqual("image-1", event["itemId"])
        self.assertEqual("/tmp/generated.png", event["savedPath"])
        self.assertEqual("raw-base64-result", event["result"])


if __name__ == "__main__":
    unittest.main()
