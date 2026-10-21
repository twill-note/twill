"""Ensure the shipped backend contains the exact, network-enabled Codex adapter."""
from __future__ import annotations

import argparse
import ast
from pathlib import Path

from PyInstaller.archive.readers import CArchiveReader


def verify(executable: Path) -> None:
    source = Path(__file__).resolve().parents[1] / "backend/app/plugins/codex_assistant/codex_engine.py"
    archive = CArchiveReader(str(executable))
    pyz_name = next(name for name, entry in archive.toc.items() if entry[-1] == "z")
    code = archive.open_embedded_archive(pyz_name).extract("app.plugins.codex_assistant.codex_engine")
    expected = compile(source.read_text(encoding="utf-8"), code.co_filename, "exec", optimize=0)
    if code != expected:
        raise RuntimeError("Packaged Codex adapter differs from the release source; rebuild the backend.")
    tree = ast.parse(source.read_text(encoding="utf-8"))
    base = next(node.value for node in tree.body if isinstance(node, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == "_BASE_CONFIG" for target in node.targets))
    if ast.literal_eval(base).get("sandbox_workspace_write.network_access") is not True:
        raise RuntimeError("Thread network permission is missing.")
    run_turn = next(node for node in ast.walk(tree) if isinstance(node, ast.AsyncFunctionDef) and node.name == "run_turn")
    if not any(isinstance(node, ast.Dict) and any(
        isinstance(key, ast.Constant) and key.value == "networkAccess"
        and isinstance(value, ast.Constant) and value.value is True
        for key, value in zip(node.keys, node.values)
    ) for node in ast.walk(run_turn)):
        raise RuntimeError("Turn network permission is missing.")
    print(f"Verified exact packaged Codex adapter and both network permissions: {executable}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    verify(parser.parse_args().executable)
