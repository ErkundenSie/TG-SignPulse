from __future__ import annotations

from pathlib import Path

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    WebSocket,
    status,
)
from sqlalchemy.orm import Session

from backend.core.auth import get_current_user
from backend.core.database import get_db
from backend.models.account import Account
from backend.models.task_log import TaskLog
from backend.scheduler import sync_jobs
from backend.schemas.task import TaskCreate, TaskOut, TaskUpdate
from backend.schemas.task_log import TaskLogOut
from backend.services import tasks as task_service
from backend.utils.ws_auth import accept_authenticated_websocket
from backend.utils.ws_stream import stream_log_updates

router = APIRouter()


@router.get("", response_model=list[TaskOut])
def list_tasks(db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    return task_service.list_tasks(db, current_user.id)


@router.post("", response_model=TaskOut, status_code=status.HTTP_201_CREATED)
async def create_task(
    payload: TaskCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    account = (
        db.query(Account)
        .filter(Account.id == payload.account_id, Account.user_id == current_user.id)
        .first()
    )
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    task = task_service.create_task(
        db,
        name=payload.name,
        cron=payload.cron,
        enabled=payload.enabled,
        account_id=payload.account_id,
        user_id=current_user.id,
    )
    await sync_jobs()
    return task


@router.get("/{task_id}", response_model=TaskOut)
def get_task(
    task_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    task = task_service.get_task(db, task_id, current_user.id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.put("/{task_id}", response_model=TaskOut)
async def update_task(
    task_id: int,
    payload: TaskUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    task = task_service.get_task(db, task_id, current_user.id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if payload.account_id is not None:
        account = (
            db.query(Account)
            .filter(
                Account.id == payload.account_id,
                Account.user_id == current_user.id,
            )
            .first()
        )
        if not account:
            raise HTTPException(status_code=404, detail="Account not found")
    updated = task_service.update_task(
        db,
        task,
        name=payload.name,
        cron=payload.cron,
        enabled=payload.enabled,
        account_id=payload.account_id,
    )
    await sync_jobs()
    return updated


@router.delete("/{task_id}", status_code=status.HTTP_200_OK)
async def delete_task(
    task_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    task = task_service.get_task(db, task_id, current_user.id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    task_service.delete_task(db, task)
    await sync_jobs()
    return {"ok": True}


@router.post("/{task_id}/run", response_model=TaskLogOut)
async def run_task(
    task_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    task = task_service.get_task(db, task_id, current_user.id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    log = await task_service.run_task_once(db, task)
    return log


@router.get("/{task_id}/logs", response_model=list[TaskLogOut])
def list_logs(
    task_id: int,
    limit: int = 50,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    task = task_service.get_task(db, task_id, current_user.id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    logs = task_service.list_task_logs(db, task_id, current_user.id, limit=limit)
    return logs


@router.websocket("/ws/{task_id}")
async def task_logs_ws(
    websocket: WebSocket,
    task_id: int,
    token: str | None = Query(None),
    db: Session = Depends(get_db),
):
    """
    WebSocket 实时推送数据库任务日志
    """
    current_user = await accept_authenticated_websocket(websocket, db, token)
    if current_user is None:
        return
    if not task_service.get_task(db, task_id, current_user.id):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await stream_log_updates(
        websocket,
        get_logs=lambda: task_service.get_active_logs(task_id),
        is_running=lambda: task_service.is_task_running(task_id),
    )


@router.get("/logs/{log_id}/output")
def get_log_output(
    log_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """获取任务日志的完整输出文件内容"""
    log = (
        db.query(TaskLog)
        .filter(TaskLog.id == log_id, TaskLog.user_id == current_user.id)
        .first()
    )
    if not log:
        raise HTTPException(status_code=404, detail="Log not found")

    if not log.log_path or not Path(log.log_path).exists():
        return {"output": log.output or "No detailed log file available."}

    try:
        with open(log.log_path, "r", encoding="utf-8") as f:
            content = f.read()
        return {"output": content}
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to read log file: {str(e)}"
        )
