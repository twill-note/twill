"""플러그인 프레임워크.

각 플러그인은 backend/app/plugins/<plugin_id>/__init__.py 에 아래를 노출:
- MANIFEST: dict — id, name, version, description, permissions, ui(확장점 힌트)
- router: fastapi.APIRouter (선택) — install 시 /api/plugins/<id> 하위로 마운트
- on_install() / on_uninstall() (선택) — 라이프사이클 훅

레지스트리는 프로세스 시작 시 built-in 플러그인을 스캔해서 등록하고,
설정 파일(plugins.json)에 저장된 installed 상태에 따라 router를 붙였다 뗐다 한다.
현재는 uvicorn --reload 없이도 상태 변경이 즉시 반영되도록 include_router를 재실행한다.
"""
from __future__ import annotations

import importlib
import logging
import pkgutil
from dataclasses import dataclass, field
from typing import Any, Callable

from fastapi import APIRouter, FastAPI, HTTPException

from .. import config

log = logging.getLogger("plugins")


@dataclass
class PluginSpec:
    id: str
    name: str
    version: str = "0.1.0"
    description: str = ""
    permissions: list[str] = field(default_factory=list)
    ui: dict = field(default_factory=dict)  # 프론트에 그대로 전달되는 확장점 힌트
    router: APIRouter | None = None
    on_install: Callable[[], None] | None = None
    on_uninstall: Callable[[], None] | None = None
    module: Any = None


class PluginRegistry:
    def __init__(self) -> None:
        self._plugins: dict[str, PluginSpec] = {}
        self._app: FastAPI | None = None
        self._mounted: set[str] = set()

    def bind(self, app: FastAPI) -> None:
        self._app = app

    def discover(self) -> None:
        """backend/app/plugins/<subpkg> 를 순회하며 등록."""
        pkg = importlib.import_module(__name__)
        for m in pkgutil.iter_modules(pkg.__path__):
            if not m.ispkg:
                continue
            mod_name = f"{__name__}.{m.name}"
            try:
                mod = importlib.import_module(mod_name)
            except Exception as e:  # noqa: BLE001
                log.warning("failed to import plugin %s: %s", mod_name, e)
                continue
            manifest = getattr(mod, "MANIFEST", None)
            if not isinstance(manifest, dict) or "id" not in manifest:
                continue
            # 코어 기능으로 승격된 모듈은 구현 코드를 재사용하더라도 플러그인 목록·설치
            # 상태의 영향을 받지 않는다.
            if manifest.get("core_feature"):
                continue
            spec = PluginSpec(
                id=manifest["id"],
                name=manifest.get("name", manifest["id"]),
                version=manifest.get("version", "0.1.0"),
                description=manifest.get("description", ""),
                permissions=list(manifest.get("permissions", [])),
                ui=dict(manifest.get("ui", {})),
                router=getattr(mod, "router", None),
                on_install=getattr(mod, "on_install", None),
                on_uninstall=getattr(mod, "on_uninstall", None),
                module=mod,
            )
            self._plugins[spec.id] = spec
            log.info("discovered plugin: %s (%s)", spec.id, spec.name)

    def apply_state(self) -> None:
        """설정 파일 상태에 맞춰 installed 플러그인의 router를 마운트하고 on_install 훅을 호출.

        부팅 시 이미 installed 상태인 플러그인들에게 재활성화 시그널을 보냄
        (예: AI 엔진 어댑터 재등록). on_install 은 idempotent 해야 한다.
        """
        for pid, spec in self._plugins.items():
            if config.plugin_installed(pid) and pid not in self._mounted:
                self._mount(pid)
                if spec.on_install:
                    try:
                        spec.on_install()
                    except Exception as e:  # noqa: BLE001
                        log.warning("on_install (activate) failed for %s: %s", pid, e)

    def _mount(self, plugin_id: str) -> None:
        spec = self._plugins.get(plugin_id)
        if not spec or not self._app or spec.router is None:
            self._mounted.add(plugin_id)
            return
        # /api/plugins/<id> prefix 로 include
        self._app.include_router(spec.router, prefix=f"/api/plugins/{plugin_id}")
        self._mounted.add(plugin_id)
        log.info("mounted plugin router: %s", plugin_id)

    def _unmount(self, plugin_id: str) -> None:
        """FastAPI 는 include_router 취소 API가 없어 라우트를 직접 제거한다.

        FastAPI ≥ 0.139 에서는 include_router 가 _IncludedRouter 래퍼를 하나 붙이므로
        include_context.prefix 로 매칭해서 제거한다. (구버전 대비 path prefix 매칭도 병행)
        """
        if not self._app or plugin_id not in self._mounted:
            return
        target_prefix = f"/api/plugins/{plugin_id}"
        keep = []
        removed = 0
        for r in self._app.router.routes:
            ctx = getattr(r, "include_context", None)
            wrapper_prefix = getattr(ctx, "prefix", None) if ctx is not None else None
            path = getattr(r, "path", "") or getattr(r, "path_format", "")
            if wrapper_prefix == target_prefix or (
                isinstance(path, str) and path.startswith(target_prefix + "/")
            ):
                removed += 1
                continue
            keep.append(r)
        self._app.router.routes = keep
        self._mounted.discard(plugin_id)
        log.info("unmounted plugin router: %s (%d routes removed)", plugin_id, removed)

    def install(self, plugin_id: str) -> PluginSpec:
        spec = self._plugins.get(plugin_id)
        if not spec:
            raise HTTPException(status_code=404, detail="플러그인을 찾을 수 없습니다")
        if not config.plugin_installed(plugin_id):
            config.set_plugin_installed(plugin_id, True)
            if spec.on_install:
                try:
                    spec.on_install()
                except Exception as e:  # noqa: BLE001
                    log.warning("on_install failed for %s: %s", plugin_id, e)
        self._mount(plugin_id)
        return spec

    def uninstall(self, plugin_id: str) -> PluginSpec:
        spec = self._plugins.get(plugin_id)
        if not spec:
            raise HTTPException(status_code=404, detail="플러그인을 찾을 수 없습니다")
        self._unmount(plugin_id)
        if config.plugin_installed(plugin_id):
            if spec.on_uninstall:
                try:
                    spec.on_uninstall()
                except Exception as e:  # noqa: BLE001
                    log.warning("on_uninstall failed for %s: %s", plugin_id, e)
            config.set_plugin_installed(plugin_id, False)
        return spec

    def list(self) -> list[dict]:
        out = []
        for spec in self._plugins.values():
            out.append(
                {
                    "id": spec.id,
                    "name": spec.name,
                    "version": spec.version,
                    "description": spec.description,
                    "permissions": spec.permissions,
                    "ui": spec.ui,
                    "installed": config.plugin_installed(spec.id),
                }
            )
        return out

    def get(self, plugin_id: str) -> PluginSpec | None:
        return self._plugins.get(plugin_id)


registry = PluginRegistry()
