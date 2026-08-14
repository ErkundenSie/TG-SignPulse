from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel

from backend.core.auth import get_current_user
from backend.core.config import get_settings
from backend.models.user import User

router = APIRouter()


class SystemLogsResponse(BaseModel):
    path: str
    lines: list[str]
    line_count: int | None = None
    file_size: int
    updated_at: str | None = None
    exists: bool


def _app_log_path() -> Path:
    settings = get_settings()
    logs_dir = settings.resolve_logs_dir()
    logs_dir.mkdir(parents=True, exist_ok=True)
    return logs_dir / "app.log"


def _tail_lines(path: Path, limit: int) -> list[str]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8", errors="replace") as fp:
        return list(deque((line.rstrip("\n") for line in fp), maxlen=limit))


@router.get("", response_model=SystemLogsResponse)
def get_system_logs(
    limit: int = Query(500, ge=1, le=5000),
    current_user: User = Depends(get_current_user),
):
    path = _app_log_path()
    try:
        stat = path.stat() if path.exists() else None
        return SystemLogsResponse(
            path=str(path),
            lines=_tail_lines(path, limit),
            line_count=None,
            file_size=0 if stat is None else stat.st_size,
            updated_at=(
                None
                if stat is None
                else datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
            ),
            exists=path.exists(),
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to read system logs: {exc}",
        )


@router.delete("")
def clear_system_logs(current_user: User = Depends(get_current_user)):
    path = _app_log_path()
    try:
        path.write_text("", encoding="utf-8")
        return {"success": True, "message": "System logs cleared"}
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to clear system logs: {exc}",
        )


@router.get("/export")
def export_system_logs(current_user: User = Depends(get_current_user)):
    path = _app_log_path()
    content = ""
    if path.exists():
        content = path.read_text(encoding="utf-8", errors="replace")
    return Response(
        content=content,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="tg-flowpulse-system.log"'},
    )
