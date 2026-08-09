"""AI 오케스트레이션 인프라.

Orchestrator 는 우리 앱의 두뇌. Codex/Claude/GPT 등의 AI 엔진을 통일된 인터페이스로 감싼다.
- engine.py : 엔진 인터페이스 + 레지스트리
- orchestrator.py : 프롬프트 조립 · 스트리밍 라우팅 · 로그 기록 · 학습 파이프라인 (Phase B2)
"""
