import asyncio
import unittest
from unittest.mock import AsyncMock
from app.ai.run_control import requests_pause
from app.ai.orchestrator import Orchestrator, _ActiveRun

class RunControlTests(unittest.TestCase):
    def test_direct_pause(self):
        for text in ["잠깐 멈춰", "일단 작업 중단해줘", "현재 작업을 일시 중단해주세요", "그만", "pause", "stop the current task please"]:
            with self.subTest(text=text):
                self.assertTrue(requests_pause(text))

    def test_not_pause(self):
        for text in ["중단하지 마", "중단 버튼을 수정해줘", "'멈춰'라고 답해", "취소 오류 분석", "don't stop"]:
            self.assertFalse(requests_pause(text))

    def test_pause_before_turn_id_is_known(self):
        async def exercise():
            o = Orchestrator()
            engine = AsyncMock()
            run = _ActiveRun(run_id="run", engine=engine)
            run.thread_id = "thread"
            o._active["run"] = run
            self.assertTrue(await o.steer("run", "잠깐 멈춰"))
            self.assertTrue(run.cancelled)
            engine.steer.assert_not_called()
        asyncio.run(exercise())
