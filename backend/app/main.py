import asyncio
import os
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import config, indexer, watcher
from .ai.engine import registry as engine_registry
from .ai import sessions as ai_sessions
from .plugins.codex_assistant.codex_engine import engine as codex_engine
from .plugins.codex_assistant.app_server import client as codex_app_server
from .plugins.erd_designer import router as erd_router
from .plugins import registry as plugin_registry
from .routers import ai, assets, db, events, files, notes, plugins, quick_memos, skillbook, skills, terminal, workspace


@asynccontextmanager
async def lifespan(app: FastAPI):
    config.ensure_dirs()
    # 브라우저 새로고침과 달리 서버 재시작은 메모리의 실행을 복원할 수 없다.
    # 고아 active_run을 running으로 남기지 않아 사용자가 즉시 재시도할 수 있게 한다.
    ai_sessions.reconcile_stale_active_runs()
    indexer.full_scan()
    # Twill AI는 설치형 플러그인이 아닌 앱 기본 AI 기능이다.
    engine_registry.register(codex_engine, make_default=True)
    plugin_registry.bind(app)
    plugin_registry.discover()
    plugin_registry.apply_state()
    watch_task = asyncio.create_task(watcher.watch_loop())
    try:
        yield
    finally:
        watch_task.cancel()
        with suppress(asyncio.CancelledError):
            await watch_task
        await codex_app_server.stop()


app = FastAPI(title="Twill", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(files.router)
app.include_router(notes.router)
app.include_router(quick_memos.router)
app.include_router(assets.router)
app.include_router(workspace.router)
app.include_router(terminal.router)
app.include_router(events.router)
app.include_router(db.router)
app.include_router(ai.router)
app.include_router(erd_router, prefix="/api/erd")
app.include_router(skillbook.router)
app.include_router(skills.router)
app.include_router(plugins.router)


@app.get("/assets/{name}")
def serve_asset(name: str):
    """워크스페이스 전환에 따라 현재 루트의 assets에서 서빙 (정적 마운트 대신 동적 처리)."""
    if "/" in name or name != Path(name).name:
        raise HTTPException(status_code=400)
    p = config.assets_dir() / name
    if not p.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(p)


def frontend_dist_dir() -> Path:
    """Electron/production mode에서 제공할 Vite 빌드 디렉터리."""
    configured = os.environ.get("NOTE_APP_FRONTEND_DIST")
    return Path(configured).expanduser().resolve() if configured else config.REPO_ROOT / "frontend" / "dist"


def mount_frontend(application: FastAPI) -> bool:
    """빌드 결과가 있을 때만 루트에 정적 UI를 연결한다.

    API와 사용자 첨부 파일 라우트 뒤에 마운트하므로 기존 웹 API의 우선순위는
    그대로 유지된다. Vite 번들은 `/app-assets`를 사용해 사용자 `/assets`와 충돌하지 않는다.
    """
    dist = frontend_dist_dir()
    if not (dist.is_dir() and (dist / "index.html").is_file()):
        return False
    application.mount("/", StaticFiles(directory=str(dist), html=True), name="frontend")
    return True


mount_frontend(app)
