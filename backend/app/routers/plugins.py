from fastapi import APIRouter, HTTPException

from ..plugins import registry

router = APIRouter(prefix="/api/plugins", tags=["plugins"])


@router.get("")
def list_plugins():
    return {"plugins": registry.list()}


@router.post("/{plugin_id}/install")
def install(plugin_id: str):
    spec = registry.install(plugin_id)
    return {"id": spec.id, "installed": True}


@router.post("/{plugin_id}/uninstall")
def uninstall(plugin_id: str):
    spec = registry.uninstall(plugin_id)
    return {"id": spec.id, "installed": False}
