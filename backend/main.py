from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

from fastapi import FastAPI, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend.api import router as api_router  # noqa: E402
from backend.core.config import get_settings  # noqa: E402
from backend.core.database import (  # noqa: E402
    Base,
    get_engine,
    get_session_local,
    init_engine,
)
from backend.core.migrations import migrate_schema  # noqa: E402
from backend.core.workspace import activate_workspace, reset_workspace  # noqa: E402
from backend.models.user import User  # noqa: E402
from backend.scheduler import (  # noqa: E402
    init_scheduler,
    shutdown_scheduler,
    sync_jobs,
)
from backend.services.users import ensure_admin  # noqa: E402
from backend.utils.app_logging import setup_app_logging  # noqa: E402
from backend.utils.paths import (
    ensure_data_dirs,
    ensure_user_workspace_dirs,
)  # noqa: E402
from backend.utils.static_files import StaticFileResolver  # noqa: E402


# Silence /health check logs
class HealthCheckFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        return "/health" not in msg and "/healthz" not in msg and "/readyz" not in msg


logging.getLogger("uvicorn.access").addFilter(HealthCheckFilter())

settings = get_settings()
setup_app_logging(settings.resolve_logs_dir())

app = FastAPI(title=settings.app_name, version="0.1.0")
app.state.ready = False

app.add_middleware(GZipMiddleware, minimum_size=1000)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials="*" not in settings.cors_origin_list,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API 路由必须在静态文件挂载之前注册，并使用 /api 前缀
app.include_router(api_router, prefix="/api")


@app.get("/health")
def health_check() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/healthz")
def health_checkz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/readyz")
def ready_check(response: Response) -> dict[str, str]:
    if app.state.ready:
        return {"status": "ready"}
    response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {"status": "starting"}


# 静态前端托管（Mode A: 单容器，FastAPI 提供静态文件）
# 挂载 Next.js 静态资源。容器使用 /web，本地运行使用 frontend/out。
configured_web_dir = os.getenv("APP_WEB_DIR", "").strip()
local_web_dir = Path(__file__).resolve().parents[1] / "frontend" / "out"
web_dir = (
    Path(configured_web_dir).expanduser()
    if configured_web_dir
    else Path("/web") if Path("/web").exists() else local_web_dir
)
next_static_dir = web_dir / "_next"
static_resolver = StaticFileResolver(web_dir)

if next_static_dir.exists():
    app.mount(
        "/_next",
        StaticFiles(directory=next_static_dir),
        name="nextjs_static",
    )


def _spa_response(full_path: str):
    """Resolve SPA/static frontend file for GET/HEAD page navigation."""
    if not next_static_dir.exists():
        return {"detail": "Frontend not built"}

    file_path = static_resolver.existing_file(full_path)
    if file_path:
        return FileResponse(file_path)

    html_path = static_resolver.existing_html_file(full_path)
    if html_path:
        return FileResponse(html_path)

    index_path = static_resolver.index_file()
    if index_path:
        return FileResponse(index_path)

    return {"detail": "Frontend not built"}


# Catch-all：兼容 Next.js 客户端路由的 GET/HEAD 预取，避免 HEAD 405 导致空白页
@app.api_route("/{full_path:path}", methods=["GET", "HEAD"])
async def serve_spa(full_path: str):
    return _spa_response(full_path)


@app.on_event("startup")
async def on_startup() -> None:
    ensure_data_dirs(settings)
    init_engine()
    Base.metadata.create_all(bind=get_engine())
    migrate_schema(get_engine())
    with get_session_local()() as db:
        admin = ensure_admin(db)
        ensure_user_workspace_dirs(settings, admin.id, admin.is_admin)
    await init_scheduler(sync_on_startup=False)

    async def _post_startup() -> None:
        try:
            await sync_jobs()
            from backend.services.keyword_monitor import get_keyword_monitor_service
            from backend.services.automation_rules import (
                get_automation_rule_service,
            )
            from backend.services.speaker_collection import (
                get_speaker_collection_service,
            )

            with get_session_local()() as db:
                users = db.query(User).filter(User.is_active.is_(True)).all()
            for user in users:
                workspace_token = activate_workspace(user.id, user.is_admin)
                try:
                    await get_keyword_monitor_service().restart_from_tasks()
                    await get_automation_rule_service().start(run_startup=True)
                    await get_speaker_collection_service().start()
                finally:
                    reset_workspace(workspace_token)
        except Exception as exc:
            logging.getLogger("backend.startup").error(
                f"Delayed scheduler sync failed: {exc}"
            )
        finally:
            app.state.ready = True

    asyncio.create_task(_post_startup())


@app.on_event("shutdown")
async def on_shutdown() -> None:
    shutdown_scheduler()
    try:
        from backend.services.keyword_monitor import get_keyword_monitor_service
        from backend.services.automation_rules import get_automation_rule_service
        from backend.services.bulk_group_membership import (
            get_bulk_group_membership_service,
        )
        from backend.services.speaker_collection import get_speaker_collection_service

        with get_session_local()() as db:
            users = db.query(User).all()
        for user in users:
            workspace_token = activate_workspace(user.id, user.is_admin)
            try:
                await get_keyword_monitor_service().stop()
                await get_automation_rule_service().stop()
                await get_bulk_group_membership_service().stop()
                await get_speaker_collection_service().stop()
            finally:
                reset_workspace(workspace_token)
    except Exception:
        pass
