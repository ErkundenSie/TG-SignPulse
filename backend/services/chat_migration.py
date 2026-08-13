"""
Telegram 群组/频道迁移服务。

导出当前账号加入的群组与频道，并在另一个账号上按公开用户名或邀请链接尝试加入。
私密群、管理员审批、验证码机器人等 Telegram 侧限制不会被绕过，只会在结果中标记
为需要人工处理。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from backend.core.config import get_settings
from backend.core.workspace import get_workspace_key
from backend.utils.account_locks import get_account_lock
from backend.utils.names import validate_name_segment
from backend.utils.proxy import build_proxy_dict
from backend.utils.tg_session import (
    get_account_proxy,
    get_account_session_string,
    get_global_semaphore,
    get_session_mode,
    load_session_string_file,
)
from tg_signer.core import get_client

logger = logging.getLogger("backend.chat_migration")

MIGRATION_KIND = "tg-flowpulse-chat-migration"
MIGRATION_VERSION = 1
MIGRATABLE_CHAT_TYPES = {"group", "supergroup", "channel"}
EXPORT_SCOPES = {"all", "groups", "channels"}
INVITE_LINK_RE = re.compile(
    r"(?:https?://)?(?:t\.me|telegram\.me)/(?:joinchat/|\+)([A-Za-z0-9_-]+)",
    re.IGNORECASE,
)


class ChatMigrationService:
    """导出/导入账号加入的群组与频道。"""

    def __init__(self) -> None:
        self.settings = get_settings()
        self.session_dir = self.settings.resolve_session_dir()
        self.session_dir.mkdir(parents=True, exist_ok=True)
        self.background_jobs: Dict[str, Dict[str, Any]] = {}

    def _validate_account_name(self, account_name: str) -> str:
        return validate_name_segment(account_name, "account_name")

    @staticmethod
    def _utc_now() -> str:
        return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"

    @staticmethod
    def _clean_text(value: Any) -> str:
        return str(value or "").strip()

    @staticmethod
    def _chat_type_name(chat: Any) -> str:
        chat_type = getattr(chat, "type", None)
        name = getattr(chat_type, "name", None)
        if name:
            return str(name).lower()
        text = str(chat_type or "").split(".")[-1]
        return text.lower()

    @staticmethod
    def _normalize_username(value: Any) -> str:
        text = str(value or "").strip()
        if not text:
            return ""
        if text.startswith("https://t.me/") or text.startswith("http://t.me/"):
            text = text.rstrip("/").split("/")[-1]
        if text.startswith("@"):
            text = text[1:]
        if not text or text.startswith("+") or "/" in text:
            return ""
        return text

    @staticmethod
    def _invite_hash(value: Any) -> str:
        text = str(value or "").strip()
        if not text:
            return ""
        if text.startswith("+"):
            return text[1:]
        match = INVITE_LINK_RE.search(text)
        return match.group(1) if match else ""

    @staticmethod
    def _is_invite_ref(value: Any) -> bool:
        text = str(value or "").strip()
        return bool(text.startswith("+") or INVITE_LINK_RE.search(text))

    @staticmethod
    def _normalize_export_scope(value: Any) -> str:
        scope = str(value or "all").strip().lower()
        if scope not in EXPORT_SCOPES:
            raise ValueError("导出范围无效，可选值: all/groups/channels")
        return scope

    @staticmethod
    def _chat_matches_scope(chat_type: str, scope: str) -> bool:
        if scope == "all":
            return chat_type in MIGRATABLE_CHAT_TYPES
        if scope == "groups":
            return chat_type in {"group", "supergroup"}
        if scope == "channels":
            return chat_type == "channel"
        return False

    def _get_effective_proxy(self, account_name: str) -> Optional[str]:
        proxy_value = get_account_proxy(account_name)
        if proxy_value:
            return proxy_value
        try:
            from backend.services.config import get_config_service

            global_proxy = (
                get_config_service().get_global_settings().get("global_proxy")
            )
            if isinstance(global_proxy, str) and global_proxy.strip():
                return global_proxy.strip()
        except Exception:
            pass
        return None

    def _get_telegram_api_config(self) -> tuple[int, str]:
        from backend.services.config import get_config_service

        tg_config = get_config_service().get_telegram_config()
        api_id = os.getenv("TG_API_ID") or tg_config.get("api_id")
        api_hash = os.getenv("TG_API_HASH") or tg_config.get("api_hash")

        try:
            parsed_api_id = int(api_id) if api_id is not None else None
        except (TypeError, ValueError):
            parsed_api_id = None

        if isinstance(api_hash, str):
            api_hash = api_hash.strip()

        if not parsed_api_id or not api_hash:
            raise ValueError("未配置 Telegram API ID 或 API Hash")
        return parsed_api_id, str(api_hash)

    def _build_client(self, account_name: str, *, no_updates: bool = True):
        account_name = self._validate_account_name(account_name)
        session_mode = get_session_mode()
        session_string = None
        in_memory = session_mode == "string"

        if session_mode == "string":
            session_string = get_account_session_string(
                account_name
            ) or load_session_string_file(self.session_dir, account_name)
            if not session_string:
                raise ValueError(f"账号 {account_name} 登录已失效，请重新登录")
        else:
            session_file = self.session_dir / f"{account_name}.session"
            if not session_file.exists():
                fallback_session_string = get_account_session_string(
                    account_name
                ) or load_session_string_file(self.session_dir, account_name)
                if fallback_session_string:
                    session_string = fallback_session_string
                    in_memory = True
                else:
                    raise ValueError(f"账号 {account_name} 登录已失效，请重新登录")

        api_id, api_hash = self._get_telegram_api_config()
        proxy_dict = None
        proxy_value = self._get_effective_proxy(account_name)
        if proxy_value:
            proxy_dict = build_proxy_dict(proxy_value)

        return get_client(
            name=account_name,
            workdir=self.session_dir,
            api_id=api_id,
            api_hash=api_hash,
            session_string=session_string,
            in_memory=in_memory,
            proxy=proxy_dict,
            no_updates=no_updates,
        )

    async def _with_client(self, account_name: str, handler):
        account_name = self._validate_account_name(account_name)
        client = self._build_client(account_name)
        async with get_account_lock(account_name):
            async with get_global_semaphore():
                async with client:
                    await client.get_me()
                    return await handler(client)

    async def _safe_enrich_chat(self, client: Any, chat: Any) -> Any:
        chat_id = getattr(chat, "id", None)
        if chat_id is None:
            return chat
        try:
            return await client.get_chat(chat_id)
        except Exception as exc:
            logger.debug("Failed to enrich chat %s: %s", chat_id, exc)
            return chat

    def _build_export_item(self, chat: Any, export_note: str = "") -> Dict[str, Any]:
        chat_id = getattr(chat, "id", None)
        username = self._normalize_username(getattr(chat, "username", None))
        title = (
            getattr(chat, "title", None)
            or getattr(chat, "first_name", None)
            or username
            or str(chat_id or "")
        )
        chat_type = self._chat_type_name(chat)
        invite_link = self._clean_text(getattr(chat, "invite_link", None))

        join_type = "none"
        join_value = ""
        join_url = ""
        if username:
            join_type = "username"
            join_value = username
            join_url = f"https://t.me/{username}"
        elif invite_link:
            join_type = "invite_link"
            join_value = invite_link
            join_url = invite_link
        elif not export_note:
            export_note = (
                "私密群/频道缺少公开用户名或可用邀请链接，需要手动复制邀请链接后加入。"
            )

        return {
            "id": chat_id,
            "title": title,
            "username": username or None,
            "type": chat_type,
            "invite_link": invite_link or None,
            "join": {
                "type": join_type,
                "value": join_value or None,
                "url": join_url or None,
            },
            "export_note": export_note or None,
        }

    async def export_account_chats(
        self,
        account_name: str,
        *,
        include_private_refs: bool = True,
        scope: str = "all",
    ) -> Dict[str, Any]:
        """导出账号加入的群组和频道。"""

        account_name = self._validate_account_name(account_name)
        scope = self._normalize_export_scope(scope)

        async def _export(client: Any) -> Dict[str, Any]:
            items: List[Dict[str, Any]] = []
            seen_ids: set[str] = set()

            async for dialog in client.get_dialogs():
                chat = getattr(dialog, "chat", None)
                if chat is None:
                    continue
                chat_id = getattr(chat, "id", None)
                if chat_id is None:
                    continue

                chat_type = self._chat_type_name(chat)
                if not self._chat_matches_scope(chat_type, scope):
                    continue

                key = str(chat_id)
                if key in seen_ids:
                    continue
                seen_ids.add(key)

                username = self._normalize_username(getattr(chat, "username", None))
                invite_link = self._clean_text(getattr(chat, "invite_link", None))
                if include_private_refs and not username and not invite_link:
                    chat = await self._safe_enrich_chat(client, chat)

                items.append(self._build_export_item(chat))
                await asyncio.sleep(0.03)

            joinable = sum(
                1
                for item in items
                if (item.get("join") or {}).get("type") in {"username", "invite_link"}
            )
            manual_required = len(items) - joinable
            has_private_links = any(item.get("invite_link") for item in items)
            return {
                "kind": MIGRATION_KIND,
                "version": MIGRATION_VERSION,
                "source_account": account_name,
                "scope": scope,
                "exported_at": self._utc_now(),
                "items": items,
                "summary": {
                    "total": len(items),
                    "joinable": joinable,
                    "manual_required": manual_required,
                },
                "warning": (
                    "导出文件包含私密邀请链接，请像密码一样妥善保管。"
                    if has_private_links
                    else None
                ),
            }

        return await self._with_client(account_name, _export)

    def _load_migration(self, migration: Any) -> Dict[str, Any]:
        if isinstance(migration, str):
            try:
                migration = json.loads(migration)
            except json.JSONDecodeError as exc:
                raise ValueError(f"导入内容不是有效 JSON: {exc}") from exc

        if not isinstance(migration, dict):
            raise ValueError("导入内容必须是迁移 JSON 对象")

        items = migration.get("items")
        if not isinstance(items, list):
            raise ValueError("迁移 JSON 缺少 items 列表")

        return migration

    def _join_ref_from_item(self, item: Dict[str, Any]) -> Tuple[str, str]:
        join = item.get("join")
        if isinstance(join, dict):
            join_type = self._clean_text(join.get("type"))
            join_value = self._clean_text(join.get("value") or join.get("url"))
            if join_type == "username":
                username = self._normalize_username(join_value)
                if username:
                    return f"@{username}", "username"
            if join_type == "invite_link" and join_value:
                return join_value, "invite_link"

        username = self._normalize_username(item.get("username"))
        if username:
            return f"@{username}", "username"

        for key in ("invite_link", "join_url", "join_ref"):
            value = self._clean_text(item.get(key))
            if not value:
                continue
            if self._is_invite_ref(value):
                return value, "invite_link"
            username = self._normalize_username(value)
            if username:
                return f"@{username}", "username"

        return "", "none"

    def _item_membership_keys(self, item: Dict[str, Any]) -> set[str]:
        keys: set[str] = set()
        item_id = item.get("id")
        if item_id is not None:
            keys.add(f"id:{item_id}")

        username = self._normalize_username(item.get("username"))
        if username:
            keys.add(f"username:{username.lower()}")

        join = item.get("join")
        if isinstance(join, dict):
            join_type = self._clean_text(join.get("type"))
            join_value = self._clean_text(join.get("value") or join.get("url"))
            if join_type == "username":
                username = self._normalize_username(join_value)
                if username:
                    keys.add(f"username:{username.lower()}")

        return keys

    def _chat_membership_keys(self, chat: Any) -> set[str]:
        keys: set[str] = set()
        chat_id = getattr(chat, "id", None)
        if chat_id is not None:
            keys.add(f"id:{chat_id}")

        username = self._normalize_username(getattr(chat, "username", None))
        if username:
            keys.add(f"username:{username.lower()}")
        return keys

    async def _load_existing_membership_keys(self, client: Any) -> set[str]:
        keys: set[str] = set()
        async for dialog in client.get_dialogs():
            chat = getattr(dialog, "chat", None)
            if chat is None:
                continue
            chat_type = self._chat_type_name(chat)
            if chat_type not in MIGRATABLE_CHAT_TYPES:
                continue
            keys.update(self._chat_membership_keys(chat))
        return keys

    def _already_member_result(
        self, item: Dict[str, Any], join_ref: str = ""
    ) -> Dict[str, Any]:
        result = self._base_result(
            item,
            "already_member",
            "目标账号已在该群组/频道中，已跳过。",
        )
        result["join_ref"] = join_ref or None
        return result

    def _is_already_member_item(
        self,
        item: Dict[str, Any],
        existing_membership_keys: set[str],
    ) -> bool:
        return bool(self._item_membership_keys(item) & existing_membership_keys)

    @staticmethod
    def _base_result(item: Dict[str, Any], status: str, message: str) -> Dict[str, Any]:
        return {
            "id": item.get("id"),
            "title": item.get("title")
            or item.get("username")
            or str(item.get("id") or ""),
            "username": item.get("username"),
            "type": item.get("type"),
            "status": status,
            "message": message,
            "needs_manual_check": False,
            "join_ref": None,
            "wait_seconds": None,
        }

    @staticmethod
    def _exception_text(exc: BaseException) -> str:
        detail = str(exc) or type(exc).__name__
        return f"{type(exc).__name__}: {detail}"

    def _map_join_exception(self, exc: BaseException) -> Dict[str, Any]:
        text = self._exception_text(exc)
        upper = text.upper()
        class_name = type(exc).__name__

        if "FLOOD_WAIT" in upper or "FLOODWAIT" in class_name.upper():
            wait_seconds = getattr(exc, "value", None)
            try:
                wait_seconds = int(wait_seconds)
            except (TypeError, ValueError):
                wait_seconds = None
            return {
                "status": "flood_wait",
                "message": (
                    f"触发 Telegram 频率限制，请等待 {wait_seconds} 秒后再继续。"
                    if wait_seconds
                    else "触发 Telegram 频率限制，请稍后再继续。"
                ),
                "wait_seconds": wait_seconds,
                "needs_manual_check": True,
            }

        if "USER_ALREADY_PARTICIPANT" in upper or "ALREADY" in upper:
            return {
                "status": "already_member",
                "message": "目标账号已在该群组/频道中。",
                "needs_manual_check": False,
            }

        if "INVITE_REQUEST_SENT" in upper or "REQUEST_SENT" in upper:
            return {
                "status": "request_sent",
                "message": "已提交加入申请，需等待管理员审批。",
                "needs_manual_check": True,
            }

        if (
            "CHANNEL_PRIVATE" in upper
            or "INVITE_HASH_EXPIRED" in upper
            or "INVITE_HASH_INVALID" in upper
            or "USERNAME_NOT_OCCUPIED" in upper
            or "USERNAME_INVALID" in upper
        ):
            return {
                "status": "manual_required",
                "message": f"无法自动加入，需要人工检查邀请链接或用户名。{text}",
                "needs_manual_check": True,
            }

        if "CHANNELS_TOO_MUCH" in upper or "USER_CHANNELS_TOO_MUCH" in upper:
            return {
                "status": "failed",
                "message": "目标账号加入的群组/频道数量已达 Telegram 限制。",
                "needs_manual_check": True,
            }

        if "USER_BANNED" in upper or "CHAT_ADMIN_REQUIRED" in upper:
            return {
                "status": "failed",
                "message": f"Telegram 拒绝加入。{text}",
                "needs_manual_check": True,
            }

        return {
            "status": "failed",
            "message": text,
            "needs_manual_check": True,
        }

    async def _join_one(self, client: Any, item: Dict[str, Any]) -> Dict[str, Any]:
        result = self._base_result(item, "failed", "")
        join_ref, join_type = self._join_ref_from_item(item)
        result["join_ref"] = join_ref or None

        if not join_ref:
            result.update(
                {
                    "status": "manual_required",
                    "message": "缺少公开用户名或邀请链接，需人工加入。",
                    "needs_manual_check": True,
                }
            )
            return result

        try:
            await client.join_chat(join_ref)
            result.update(
                {
                    "status": "joined",
                    "message": (
                        "已加入。若群内有验证码或验证机器人，请在 Telegram 客户端完成验证。"
                        if join_type == "invite_link"
                        else "已加入。若群内有验证码或验证机器人，请在 Telegram 客户端完成验证。"
                    ),
                    "needs_manual_check": True,
                }
            )
            return result
        except Exception as exc:
            mapped = self._map_join_exception(exc)
            result.update(mapped)
            return result

    @staticmethod
    def _delay_after_flood_wait(
        result: Dict[str, Any],
        *,
        fallback_delay_seconds: float,
    ) -> float:
        """Return how long to pause before continuing after a FloodWait result."""

        wait_seconds = result.get("wait_seconds")
        try:
            wait_seconds = float(wait_seconds)
        except (TypeError, ValueError):
            wait_seconds = 0.0
        return max(wait_seconds, fallback_delay_seconds, 1.0)

    async def _sleep_import_delay(
        self,
        seconds: float,
        *,
        cancel_requested=None,
        step_seconds: float = 1.0,
    ) -> bool:
        """Sleep in small chunks so background imports can be canceled while waiting.

        Returns True if cancellation was requested during the sleep.
        """

        remaining = max(0.0, float(seconds or 0))
        while remaining > 0:
            if cancel_requested and cancel_requested():
                return True
            chunk = min(step_seconds, remaining)
            await asyncio.sleep(chunk)
            remaining -= chunk
        return bool(cancel_requested and cancel_requested())

    def _note_flood_wait_retry(
        self, result: Dict[str, Any], wait_seconds: float
    ) -> None:
        result["status"] = "failed"
        result["message"] = (
            f"{result.get('message') or '触发 Telegram 频率限制。'}"
            f" 已等待 {int(wait_seconds)} 秒后继续导入；该条保留为失败，可稍后单独重试。"
        )
        result["needs_manual_check"] = True

    async def import_account_chats(
        self,
        account_name: str,
        migration: Any,
        *,
        dry_run: bool = False,
        delay_seconds: float = 5.0,
    ) -> Dict[str, Any]:
        """将导出的群组/频道清单导入到目标账号。"""

        account_name = self._validate_account_name(account_name)
        migration_data = self._load_migration(migration)
        items = [
            item
            for item in migration_data.get("items", [])
            if isinstance(item, dict)
            and self._clean_text(item.get("type")).lower() in MIGRATABLE_CHAT_TYPES
        ]

        delay_seconds = max(0.0, min(float(delay_seconds or 0), 120.0))

        async def _import(client: Any) -> Dict[str, Any]:
            results: List[Dict[str, Any]] = []
            existing_membership_keys = await self._load_existing_membership_keys(client)

            for index, item in enumerate(items):
                join_ref, _join_type = self._join_ref_from_item(item)
                if self._is_already_member_item(item, existing_membership_keys):
                    results.append(self._already_member_result(item, join_ref))
                    continue

                if dry_run:
                    result = self._base_result(
                        item,
                        "ready" if join_ref else "manual_required",
                        (
                            "可自动尝试加入。"
                            if join_ref
                            else "缺少公开用户名或邀请链接，需人工加入。"
                        ),
                    )
                    result["join_ref"] = join_ref or None
                    result["needs_manual_check"] = not bool(join_ref)
                    results.append(result)
                    continue

                result = await self._join_one(client, item)
                if result["status"] == "flood_wait":
                    wait_seconds = self._delay_after_flood_wait(
                        result,
                        fallback_delay_seconds=delay_seconds,
                    )
                    await self._sleep_import_delay(wait_seconds)
                    self._note_flood_wait_retry(result, wait_seconds)
                results.append(result)
                if delay_seconds > 0 and index < len(items) - 1:
                    await asyncio.sleep(delay_seconds)

            summary: Dict[str, int] = {
                "total": len(results),
                "joined": 0,
                "already_member": 0,
                "request_sent": 0,
                "manual_required": 0,
                "failed": 0,
                "flood_wait": 0,
                "skipped": 0,
                "ready": 0,
            }
            for result in results:
                status = str(result.get("status") or "failed")
                summary[status] = summary.get(status, 0) + 1

            logger.info(
                "Chat migration import finished account=%s dry_run=%s total=%s summary=%s",
                account_name,
                dry_run,
                len(results),
                summary,
            )

            return {
                "success": True,
                "dry_run": dry_run,
                "source_account": migration_data.get("source_account"),
                "target_account": account_name,
                "imported_at": self._utc_now(),
                "summary": summary,
                "results": results,
                "notice": "需要审批、验证码或私密链接缺失的条目不会被绕过，需在 Telegram 客户端人工处理。",
            }

        return await self._with_client(account_name, _import)

    def start_import_job(
        self,
        account_name: str,
        migration: Any,
        *,
        dry_run: bool = False,
        delay_seconds: float = 5.0,
    ) -> Dict[str, Any]:
        account_name = self._validate_account_name(account_name)
        migration_data = self._load_migration(migration)
        items = [
            item
            for item in migration_data.get("items", [])
            if isinstance(item, dict)
            and self._clean_text(item.get("type")).lower() in MIGRATABLE_CHAT_TYPES
        ]
        delay_seconds = max(0.0, min(float(delay_seconds or 0), 120.0))
        job_id = uuid.uuid4().hex
        job = {
            "job_id": job_id,
            "status": "running",
            "account_name": account_name,
            "dry_run": dry_run,
            "delay_seconds": delay_seconds,
            "created_at": self._utc_now(),
            "updated_at": self._utc_now(),
            "finished_at": None,
            "progress": {"done": 0, "total": len(items)},
            "summary": self._empty_import_summary(),
            "results": [],
            "items": items,
            "error": None,
            "notice": "需要审批、验证码或私密链接缺失的条目不会被绕过，需在 Telegram 客户端人工处理。",
            "cancel_requested": False,
        }
        self.background_jobs[job_id] = job
        asyncio.create_task(
            self._run_import_job(job_id, account_name, migration_data, items)
        )
        return self.get_import_job(job_id)

    def get_import_job(self, job_id: str) -> Dict[str, Any]:
        job = self.background_jobs.get(job_id)
        if not job:
            raise KeyError(job_id)
        return self._public_job(job)

    def cancel_import_job(self, job_id: str) -> Dict[str, Any]:
        job = self.background_jobs.get(job_id)
        if not job:
            raise KeyError(job_id)
        if job["status"] in {"running", "canceling"}:
            job["status"] = "canceling"
            job["cancel_requested"] = True
            job["updated_at"] = self._utc_now()
        return self._public_job(job)

    async def _run_import_job(
        self,
        job_id: str,
        account_name: str,
        migration_data: Dict[str, Any],
        items: List[Dict[str, Any]],
    ) -> None:
        job = self.background_jobs[job_id]

        async def _import(client: Any) -> None:
            existing_membership_keys = await self._load_existing_membership_keys(client)
            for index, item in enumerate(items):
                if job.get("cancel_requested"):
                    job["status"] = "canceled"
                    job["finished_at"] = self._utc_now()
                    return

                join_ref, _join_type = self._join_ref_from_item(item)
                if self._is_already_member_item(item, existing_membership_keys):
                    result = self._already_member_result(item, join_ref)
                elif job["dry_run"]:
                    result = self._base_result(
                        item,
                        "ready" if join_ref else "manual_required",
                        (
                            "可自动尝试加入。"
                            if join_ref
                            else "缺少公开用户名或邀请链接，需人工加入。"
                        ),
                    )
                    result["join_ref"] = join_ref or None
                    result["needs_manual_check"] = not bool(join_ref)
                else:
                    result = await self._join_one(client, item)
                    if result["status"] == "flood_wait":
                        wait_seconds = self._delay_after_flood_wait(
                            result,
                            fallback_delay_seconds=job["delay_seconds"],
                        )
                        canceled = await self._sleep_import_delay(
                            wait_seconds,
                            cancel_requested=lambda: bool(job.get("cancel_requested")),
                        )
                        if canceled:
                            job["status"] = "canceled"
                            job["finished_at"] = self._utc_now()
                            return
                        self._note_flood_wait_retry(result, wait_seconds)

                job["results"].append(result)
                job["progress"] = {"done": len(job["results"]), "total": len(items)}
                job["summary"] = self._summarize_import_results(job["results"])
                job["updated_at"] = self._utc_now()

                if (
                    not job["dry_run"]
                    and job["delay_seconds"] > 0
                    and index < len(items) - 1
                ):
                    canceled = await self._sleep_import_delay(
                        job["delay_seconds"],
                        cancel_requested=lambda: bool(job.get("cancel_requested")),
                    )
                    if canceled:
                        job["status"] = "canceled"
                        job["finished_at"] = self._utc_now()
                        return

        try:
            await self._with_client(account_name, _import)
            if job["status"] not in {"canceled"}:
                job["status"] = "completed"
                job["finished_at"] = self._utc_now()
        except Exception as exc:
            logger.exception("Background chat migration import failed job=%s", job_id)
            job["status"] = "failed"
            job["error"] = str(exc)
            job["finished_at"] = self._utc_now()
        finally:
            job["updated_at"] = self._utc_now()
            job["summary"] = self._summarize_import_results(job["results"])

    @staticmethod
    def _empty_import_summary() -> Dict[str, int]:
        return {
            "total": 0,
            "joined": 0,
            "already_member": 0,
            "request_sent": 0,
            "manual_required": 0,
            "failed": 0,
            "flood_wait": 0,
            "skipped": 0,
            "ready": 0,
        }

    def _summarize_import_results(
        self, results: List[Dict[str, Any]]
    ) -> Dict[str, int]:
        summary = self._empty_import_summary()
        summary["total"] = len(results)
        for result in results:
            status = str(result.get("status") or "failed")
            summary[status] = summary.get(status, 0) + 1
        return summary

    @staticmethod
    def _public_job(job: Dict[str, Any]) -> Dict[str, Any]:
        return {key: value for key, value in job.items() if key != "cancel_requested"}


_chat_migration_services: dict[str, ChatMigrationService] = {}


def get_chat_migration_service() -> ChatMigrationService:
    key = get_workspace_key()
    if key not in _chat_migration_services:
        _chat_migration_services[key] = ChatMigrationService()
    return _chat_migration_services[key]
