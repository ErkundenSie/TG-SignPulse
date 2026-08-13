from fastapi import APIRouter

from backend.api.routes import (
    accounts,
    admin_users,
    automation_rules,
    auth,
    bulk_group_membership,
    config,
    events,
    monitors,
    speaker_collection,
    sign_tasks,
    system_logs,
    tasks,
    user,
)

router = APIRouter()
router.include_router(auth.router, prefix="/auth", tags=["auth"])
router.include_router(user.router, prefix="/user", tags=["user"])
router.include_router(admin_users.router, prefix="/admin/users", tags=["admin-users"])
router.include_router(accounts.router, prefix="/accounts", tags=["accounts"])
router.include_router(
    bulk_group_membership.router,
    prefix="/bulk-group-membership",
    tags=["bulk-group-membership"],
)
router.include_router(
    automation_rules.router,
    prefix="/automation-rules",
    tags=["automation-rules"],
)
router.include_router(tasks.router, prefix="/tasks", tags=["tasks"])
router.include_router(sign_tasks.router, prefix="/sign-tasks", tags=["sign-tasks"])
router.include_router(monitors.router, prefix="/monitors", tags=["monitors"])
router.include_router(
    speaker_collection.router,
    prefix="/speaker-collections",
    tags=["speaker-collections"],
)
router.include_router(config.router, prefix="/config", tags=["config"])
router.include_router(events.router, prefix="/events", tags=["events"])
router.include_router(system_logs.router, prefix="/system-logs", tags=["system-logs"])
