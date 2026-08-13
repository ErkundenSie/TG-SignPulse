"""Configuration API routes."""

from __future__ import annotations

import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel

from backend.core.auth import get_current_user
from backend.models.user import User
from backend.scheduler import get_scheduler_timezone
from backend.services.config import get_config_service
from backend.utils.storage import is_writable_dir

router = APIRouter()


def _clear_sign_task_cache() -> None:
    try:
        from backend.services.sign_tasks import get_sign_task_service

        get_sign_task_service()._tasks_cache = None
    except Exception:
        # Best-effort cache invalidation; import should still succeed.
        pass


def _mask_secret(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    text = str(value)
    if len(text) <= 8:
        return "****"
    return f"{text[:4]}{'*' * (len(text) - 8)}{text[-4:]}"


class ExportTaskResponse(BaseModel):
    task_name: str
    task_type: str
    config_json: str


class ImportTaskRequest(BaseModel):
    config_json: str
    task_name: Optional[str] = None
    account_name: Optional[str] = None
    task_kind: Optional[str] = None
    overwrite: bool = True


class ImportTaskResponse(BaseModel):
    success: bool
    task_name: str
    message: str


class ImportAllRequest(BaseModel):
    config_json: str
    overwrite: bool = False


class ImportAllResponse(BaseModel):
    signs_imported: int
    signs_skipped: int
    monitors_imported: int
    monitors_skipped: int
    settings_imported: int
    errors: list[str]
    message: str


class TaskListResponse(BaseModel):
    sign_tasks: list[str]
    monitor_tasks: list[str]
    total: int


@router.get("/tasks", response_model=TaskListResponse)
def list_all_tasks(current_user: User = Depends(get_current_user)):
    try:
        sign_tasks = get_config_service().list_sign_tasks()
        monitor_tasks = get_config_service().list_monitor_tasks()
        return TaskListResponse(
            sign_tasks=sign_tasks,
            monitor_tasks=monitor_tasks,
            total=len(sign_tasks) + len(monitor_tasks),
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to list tasks: {str(e)}",
        )


@router.get("/export/sign/{task_name}")
def export_sign_task(
    task_name: str,
    account_name: Optional[str] = None,
    current_user: User = Depends(get_current_user),
):
    try:
        config_json = get_config_service().export_sign_task(
            task_name, account_name=account_name
        )
        if config_json is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Task {task_name} not found",
            )

        return Response(
            content=config_json.encode("utf-8"),
            media_type="application/json; charset=utf-8",
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to export task: {str(e)}",
        )


@router.post("/import/sign", response_model=ImportTaskResponse)
async def import_sign_task(
    request: ImportTaskRequest, current_user: User = Depends(get_current_user)
):
    try:
        service = get_config_service()
        if not is_writable_dir(service.signs_dir):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Data directory is not writable: {service.signs_dir}",
            )

        success = service.import_sign_task(
            request.config_json,
            request.task_name,
            request.account_name,
            task_kind=request.task_kind,
            overwrite=request.overwrite,
        )
        if not success:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid task config",
            )

        data = json.loads(request.config_json)
        final_task_name = request.task_name or data.get("task_name", "imported_task")
        # 若同名覆盖，返回原名；若自动改名需再读一次不必要，覆盖模式保持同名

        from backend.scheduler import sync_jobs

        _clear_sign_task_cache()
        await sync_jobs()
        try:
            from backend.services.keyword_monitor import get_keyword_monitor_service

            await get_keyword_monitor_service().restart_from_tasks()
        except Exception:
            pass

        return ImportTaskResponse(
            success=True,
            task_name=final_task_name,
            message=f"Task {final_task_name} imported",
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to import task: {str(e)}",
        )


@router.get("/export/all")
def export_all_configs(
    include_secrets: bool = False,
    current_user: User = Depends(get_current_user),
):
    try:
        config_json = get_config_service().export_all_configs(
            include_secrets=include_secrets
        )
        filename = (
            "tg_flowpulse_all_configs_full.json"
            if include_secrets
            else "tg_flowpulse_all_configs_redacted.json"
        )
        return Response(
            content=config_json.encode("utf-8"),
            media_type="application/json; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to export all configs: {str(e)}",
        )


@router.post("/import/all", response_model=ImportAllResponse)
async def import_all_configs(
    request: ImportAllRequest, current_user: User = Depends(get_current_user)
):
    try:
        result = get_config_service().import_all_configs(
            request.config_json, request.overwrite
        )

        message_parts = []
        if result.get("signs_imported", 0) > 0:
            message_parts.append(f"sign tasks imported: {result['signs_imported']}")
        if result.get("signs_skipped", 0) > 0:
            message_parts.append(f"sign tasks skipped: {result['signs_skipped']}")
        if result.get("monitors_imported", 0) > 0:
            message_parts.append(
                f"monitor tasks imported: {result['monitors_imported']}"
            )
        if result.get("monitors_skipped", 0) > 0:
            message_parts.append(f"monitor tasks skipped: {result['monitors_skipped']}")
        if result.get("settings_imported", 0) > 0:
            message_parts.append(f"settings imported: {result['settings_imported']}")

        message = "; ".join(message_parts) if message_parts else "No config imported"

        from backend.scheduler import sync_jobs

        _clear_sign_task_cache()
        await sync_jobs()
        try:
            from backend.services.keyword_monitor import get_keyword_monitor_service

            await get_keyword_monitor_service().restart_from_tasks()
        except Exception:
            pass

        return ImportAllResponse(
            signs_imported=int(result.get("signs_imported", 0)),
            signs_skipped=int(result.get("signs_skipped", 0)),
            monitors_imported=int(result.get("monitors_imported", 0)),
            monitors_skipped=int(result.get("monitors_skipped", 0)),
            settings_imported=int(result.get("settings_imported", 0)),
            errors=[str(item) for item in result.get("errors", [])],
            message=message,
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to import all configs: {str(e)}",
        )


@router.delete("/sign/{task_name}")
async def delete_sign_task(
    task_name: str,
    account_name: Optional[str] = None,
    current_user: User = Depends(get_current_user),
):
    try:
        success = get_config_service().delete_sign_config(
            task_name, account_name=account_name
        )
        if not success:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Task {task_name} not found",
            )

        from backend.scheduler import sync_jobs

        _clear_sign_task_cache()
        await sync_jobs()

        return {"success": True, "message": f"Task {task_name} deleted"}
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete task: {str(e)}",
        )


class AIConfigRequest(BaseModel):
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    model: Optional[str] = None


class AIConfigResponse(BaseModel):
    has_config: bool
    base_url: Optional[str] = None
    model: Optional[str] = None
    api_key_masked: Optional[str] = None


class AIConfigSaveResponse(BaseModel):
    success: bool
    message: str


class AITestResponse(BaseModel):
    success: bool
    message: str
    model_used: Optional[str] = None


@router.get("/ai", response_model=AIConfigResponse)
def get_ai_config(current_user: User = Depends(get_current_user)):
    try:
        config = get_config_service().get_ai_config()
        if not config:
            return AIConfigResponse(has_config=False)

        api_key = config.get("api_key", "")
        if api_key:
            masked = (
                api_key[:4] + "*" * (len(api_key) - 8) + api_key[-4:]
                if len(api_key) > 8
                else "****"
            )
        else:
            masked = None

        return AIConfigResponse(
            has_config=True,
            base_url=config.get("base_url"),
            model=config.get("model"),
            api_key_masked=masked,
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to read AI config: {str(e)}",
        )


@router.post("/ai", response_model=AIConfigSaveResponse)
def save_ai_config(
    request: AIConfigRequest, current_user: User = Depends(get_current_user)
):
    try:
        get_config_service().save_ai_config(
            api_key=request.api_key,
            base_url=request.base_url,
            model=request.model,
        )
        return AIConfigSaveResponse(success=True, message="AI config saved")
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to save AI config: {str(e)}",
        )


@router.post("/ai/test", response_model=AITestResponse)
async def test_ai_connection(current_user: User = Depends(get_current_user)):
    try:
        result = await get_config_service().test_ai_connection()
        return AITestResponse(**result)
    except Exception as e:
        return AITestResponse(success=False, message=f"AI test failed: {str(e)}")


@router.delete("/ai", response_model=AIConfigSaveResponse)
def delete_ai_config(current_user: User = Depends(get_current_user)):
    try:
        get_config_service().delete_ai_config()
        return AIConfigSaveResponse(success=True, message="AI config deleted")
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete AI config: {str(e)}",
        )


class GlobalSettingsRequest(BaseModel):
    sign_interval: Optional[int] = None
    log_retention_days: int = 7
    timezone: Optional[str] = None
    data_dir: Optional[str] = None
    global_proxy: Optional[str] = None
    telegram_bot_notify_enabled: bool = False
    telegram_bot_login_notify_enabled: bool = False
    telegram_bot_task_failure_enabled: bool = True
    telegram_bot_token: Optional[str] = None
    telegram_bot_chat_id: Optional[str] = None
    telegram_bot_message_thread_id: Optional[int] = None


class GlobalSettingsResponse(BaseModel):
    sign_interval: Optional[int] = None
    log_retention_days: int = 7
    timezone: str
    data_dir: Optional[str] = None
    global_proxy: Optional[str] = None
    telegram_bot_notify_enabled: bool = False
    telegram_bot_login_notify_enabled: bool = False
    telegram_bot_task_failure_enabled: bool = True
    telegram_bot_token_masked: Optional[str] = None
    telegram_bot_chat_id: Optional[str] = None
    telegram_bot_message_thread_id: Optional[int] = None


@router.get("/settings", response_model=GlobalSettingsResponse)
def get_global_settings(current_user: User = Depends(get_current_user)):
    try:
        settings = dict(get_config_service().get_global_settings())
        if not current_user.is_admin:
            settings["data_dir"] = None
        token = settings.pop("telegram_bot_token", None)
        settings["telegram_bot_token_masked"] = _mask_secret(token)
        return GlobalSettingsResponse(**settings)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to read global settings: {str(e)}",
        )


@router.post("/settings", response_model=AIConfigSaveResponse)
async def save_global_settings(
    request: GlobalSettingsRequest, current_user: User = Depends(get_current_user)
):
    try:
        settings = {
            "sign_interval": request.sign_interval,
            "log_retention_days": request.log_retention_days,
            "timezone": request.timezone,
            "global_proxy": request.global_proxy,
            "telegram_bot_notify_enabled": request.telegram_bot_notify_enabled,
            "telegram_bot_login_notify_enabled": request.telegram_bot_login_notify_enabled,
            "telegram_bot_task_failure_enabled": request.telegram_bot_task_failure_enabled,
            "telegram_bot_chat_id": request.telegram_bot_chat_id,
            "telegram_bot_message_thread_id": request.telegram_bot_message_thread_id,
        }
        fields_set = getattr(
            request, "model_fields_set", getattr(request, "__fields_set__", set())
        )
        if "data_dir" in fields_set:
            if not current_user.is_admin:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Only the administrator can change the application data directory",
                )
            settings["data_dir"] = request.data_dir
        if "telegram_bot_token" in fields_set:
            settings["telegram_bot_token"] = request.telegram_bot_token

        previous_timezone = get_scheduler_timezone()
        get_config_service().save_global_settings(settings)
        if request.timezone and request.timezone != previous_timezone:
            from backend.scheduler import reload_scheduler

            await reload_scheduler()
        return AIConfigSaveResponse(success=True, message="Global settings saved")
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to save global settings: {str(e)}",
        )


class TelegramConfigRequest(BaseModel):
    api_id: str
    api_hash: str


class TelegramConfigResponse(BaseModel):
    api_id: str
    api_hash_masked: str
    is_custom: bool
    default_api_id: str
    default_api_hash_masked: str


class TelegramConfigSaveResponse(BaseModel):
    success: bool
    message: str


@router.get("/telegram", response_model=TelegramConfigResponse)
def get_telegram_config(current_user: User = Depends(get_current_user)):
    try:
        config = get_config_service().get_telegram_config()
        service = get_config_service()
        return TelegramConfigResponse(
            api_id=config.get("api_id", ""),
            api_hash_masked=_mask_secret(config.get("api_hash", "")) or "",
            is_custom=bool(config.get("is_custom", False)),
            default_api_id=service.DEFAULT_TG_API_ID,
            default_api_hash_masked=_mask_secret(service.DEFAULT_TG_API_HASH) or "",
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to read Telegram config: {str(e)}",
        )


@router.post("/telegram", response_model=TelegramConfigSaveResponse)
def save_telegram_config(
    request: TelegramConfigRequest, current_user: User = Depends(get_current_user)
):
    try:
        if not request.api_id or not request.api_hash:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="api_id and api_hash are required",
            )

        success = get_config_service().save_telegram_config(
            api_id=request.api_id,
            api_hash=request.api_hash,
        )
        if not success:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to save Telegram config",
            )
        return TelegramConfigSaveResponse(success=True, message="Telegram config saved")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to save Telegram config: {str(e)}",
        )


@router.delete("/telegram", response_model=TelegramConfigSaveResponse)
def reset_telegram_config(current_user: User = Depends(get_current_user)):
    try:
        get_config_service().reset_telegram_config()
        return TelegramConfigSaveResponse(success=True, message="Telegram config reset")
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to reset Telegram config: {str(e)}",
        )
