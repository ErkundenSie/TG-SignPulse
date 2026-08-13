from __future__ import annotations

from contextvars import ContextVar, Token
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class WorkspaceContext:
    user_id: int
    is_admin: bool = False


_current_workspace: ContextVar[WorkspaceContext | None] = ContextVar(
    "tg_flowpulse_workspace", default=None
)


def activate_workspace(user_id: int, is_admin: bool = False) -> Token:
    return _current_workspace.set(
        WorkspaceContext(user_id=int(user_id), is_admin=bool(is_admin))
    )


def reset_workspace(token: Token) -> None:
    _current_workspace.reset(token)


def get_workspace_context() -> WorkspaceContext | None:
    return _current_workspace.get()


def get_workspace_key() -> str:
    context = get_workspace_context()
    if context is None:
        return "system"
    return f"user-{context.user_id}"


def resolve_workspace_dir(base_dir: Path) -> Path:
    context = get_workspace_context()
    # 首个管理员继续使用历史全局目录，避免升级时移动既有账号和任务文件。
    # 其他用户使用独立的不可变数字 ID 目录，避免用户名修改影响工作区位置。
    if context is None or context.is_admin:
        return base_dir
    return base_dir / "workspaces" / f"user-{context.user_id}"
