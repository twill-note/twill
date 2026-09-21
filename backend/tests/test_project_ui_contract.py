import unittest
from pathlib import Path


class ProjectUiContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(__file__).resolve().parents[2]

    def test_creation_dialog_keeps_skip_left_of_path_selection(self):
        source = (self.root / "frontend" / "src" / "components" / "ProjectPathDialog.tsx").read_text(
            encoding="utf-8"
        )

        self.assertLess(source.index("'선택 안함'"), source.index("'경로 선택'"))
        self.assertIn('className="flex items-center justify-between"', source)

    def test_desktop_project_path_uses_native_picker_and_keeps_custom_fallback(self):
        component = (self.root / "frontend" / "src" / "components" / "ProjectPathDialog.tsx").read_text(
            encoding="utf-8"
        )
        main = (self.root / "frontend" / "electron" / "main.mjs").read_text(encoding="utf-8")
        preload = (self.root / "frontend" / "electron" / "preload.cjs").read_text(encoding="utf-8")

        self.assertIn("selectProjectDirectory", component)
        self.assertIn("if (nativePicker) return null", component)
        self.assertIn("api.browse", component)  # 브라우저/향후 재사용용 커스텀 선택기는 보존한다.
        self.assertIn("dialog.showOpenDialog", main)
        self.assertIn("properties: ['openDirectory']", main)
        self.assertIn("desktop:select-project-directory", preload)

    def test_ai_response_and_editor_image_actions_keep_required_ui_contracts(self):
        byeori = (self.root / "frontend" / "src" / "components" / "ByeoriPanel.tsx").read_text(
            encoding="utf-8"
        )
        editor = (self.root / "frontend" / "src" / "components" / "Editor.tsx").read_text(
            encoding="utf-8"
        )
        copy_button = byeori[
            byeori.index("function ChatCopyButton") : byeori.index("function ChatCodeBlock")
        ]
        running_turn_submit = byeori[
            byeori.index("const sendSteer = () =>") : byeori.index("const restoreRecoveryToDraft")
        ]
        annotation_save = editor[
            editor.index("function ImageAnnotateButton") : editor.index("function SaveIndicator")
        ]

        self.assertIn("function ChatCopyButton", byeori)
        self.assertIn("navigator.clipboard.writeText", byeori)
        self.assertIn("border-0 bg-transparent p-0", copy_button)
        self.assertNotIn("bg-white/85", copy_button)
        self.assertNotIn("backdrop-blur", copy_button)
        # 실행 중 후속 요청도 첨부 이미지를 메시지 payload로 넘기고, 전송 직후
        # 입력창의 첨부 목록을 비워 다음 요청에 남지 않게 한다.
        self.assertIn("steer(active.id, text", running_turn_submit)
        self.assertIn(
            "images.map((image) => ({ url: image.url, name: image.name, alt: image.name }))",
            running_turn_submit,
        )
        self.assertIn(
            "files.map((file) => ({ url: file.url, name: file.name }))", running_turn_submit
        )
        self.assertLess(
            running_turn_submit.index("steer(active.id, text"),
            running_turn_submit.index("setAttachments([])"),
        )

        # BlockNote의 실제 블록 id를 이미지 콘텐츠의 상위 블록에서 찾아 갱신하고,
        # 갱신이 성공한 경우에만 주석 편집기를 닫는다.
        self.assertIn("block.closest('[data-id]')", annotation_save)
        self.assertIn("editor.updateBlock(modal.blockId", annotation_save)
        self.assertLess(
            annotation_save.index("editor.updateBlock(modal.blockId"),
            annotation_save.index("setModal(null)"),
        )

    def test_task_board_whole_run_action_is_in_running_column(self):
        source = (self.root / "frontend" / "src" / "components" / "DatabaseView.tsx").read_text(
            encoding="utf-8"
        )

        self.assertIn("groupValue === 'running'", source)
        self.assertIn("label: '전체 실행'", source)

    def test_sidebar_exposes_project_terms_and_late_path_action(self):
        source = (self.root / "frontend" / "src" / "components" / "FileTree.tsx").read_text(
            encoding="utf-8"
        )

        self.assertIn("+ 프로젝트", source)
        self.assertIn("프로젝트 경로 지정", source)
        self.assertIn("menu.section.project_path", source)
        self.assertNotIn('label="✏️ 섹션 이름 변경"', source)


if __name__ == "__main__":
    unittest.main()
