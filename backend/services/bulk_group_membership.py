from __future__ import annotations

import asyncio
import json
import logging
import random
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional
from urllib.parse import urlparse

from backend.core.workspace import get_workspace_key
from backend.services.chat_migration import ChatMigrationService

logger = logging.getLogger("backend.bulk_group_membership")

ACTIVE_STATUSES = {"running", "canceling"}
FINAL_STATUSES = {"completed", "canceled", "failed"}
SUPPORTED_MODES = {"join", "leave_selected", "leave_all_groups"}
MAX_LINKS = 500
MAX_LOGS = 1000
MAX_HISTORY = 50
MAX_FLOOD_RETRIES = 3


class BulkGroupMembershipService(ChatMigrationService):
    def __init__(self) -> None:
        super().__init__()
        self.root = self.settings.resolve_workdir() / "bulk_group_membership"
        self.root.mkdir(parents=True, exist_ok=True)
        self.jobs: Dict[str, Dict[str, Any]] = {}
        self._tasks: Dict[str, asyncio.Task] = {}
        self._load_jobs()

    @staticmethod
    def _now() -> str:
        return (
            datetime.now(timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z")
        )

    def _job_file(self, job_id: str) -> Path:
        return self.root / f"{job_id}.json"

    def _write_job(self, job: Dict[str, Any]) -> None:
        payload = {key: value for key, value in job.items() if not key.startswith("_")}
        path = self._job_file(str(job["job_id"]))
        temp = path.with_suffix(".tmp")
        temp.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        temp.replace(path)

    def _load_jobs(self) -> None:
        loaded: List[Dict[str, Any]] = []
        for path in self.root.glob("*.json"):
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(value, dict) or not value.get("job_id"):
                continue
            if value.get("status") in ACTIVE_STATUSES:
                value["status"] = "failed"
                value["error"] = "服务重启，原任务已中断"
                value["finished_at"] = self._now()
                value["updated_at"] = self._now()
                self._append_log(
                    value, "error", "服务重启，原任务已中断", persist=False
                )
                self._write_job(value)
            loaded.append(value)
        loaded.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
        self.jobs = {str(item["job_id"]): item for item in loaded[:MAX_HISTORY]}

    def _append_log(
        self,
        job: Dict[str, Any],
        level: str,
        message: str,
        *,
        ref: Optional[str] = None,
        persist: bool = True,
    ) -> None:
        logs = job.setdefault("logs", [])
        logs.append(
            {"time": self._now(), "level": level, "message": message, "ref": ref}
        )
        if len(logs) > MAX_LOGS:
            del logs[:-MAX_LOGS]
        job["updated_at"] = self._now()
        if persist:
            self._write_job(job)

    @staticmethod
    def _public_job(job: Dict[str, Any]) -> Dict[str, Any]:
        return {key: value for key, value in job.items() if not key.startswith("_")}

    @staticmethod
    def _normalize_links(links: List[str]) -> List[str]:
        normalized: List[str] = []
        seen: set[str] = set()
        for raw in links:
            for item in re.split(r"[\r\n]+", str(raw or "")):
                value = item.strip()
                if not value or value in seen:
                    continue
                seen.add(value)
                normalized.append(value)
        if not normalized:
            raise ValueError("加入模式至少需要一个群组或频道链接")
        if len(normalized) > MAX_LINKS:
            raise ValueError(f"单个任务最多支持 {MAX_LINKS} 个群组或频道链接")
        return normalized

    def _normalize_join_ref(self, value: str) -> str:
        text = str(value or "").strip()
        if not text:
            raise ValueError("群组或频道链接不能为空")
        if text.startswith("+"):
            invite_hash = text[1:].split("?", 1)[0].strip()
            if not re.fullmatch(r"[A-Za-z0-9_-]+", invite_hash):
                raise ValueError("私密群邀请链接格式无效")
            return f"https://t.me/+{invite_hash}"
        candidate = text if "://" in text else f"https://{text}"
        parsed = urlparse(candidate)
        host = (parsed.hostname or "").lower()
        if host in {"t.me", "www.t.me", "telegram.me", "www.telegram.me"}:
            parts = [part for part in parsed.path.split("/") if part]
            if not parts:
                raise ValueError("群组或频道链接缺少用户名或邀请标识")
            if parts[0].lower() == "joinchat" and len(parts) == 2:
                if not re.fullmatch(r"[A-Za-z0-9_-]+", parts[1]):
                    raise ValueError("私密群邀请链接格式无效")
                return f"https://t.me/+{parts[1]}"
            if parts[0].startswith("+") and len(parts) == 1:
                invite_hash = parts[0][1:]
                if not re.fullmatch(r"[A-Za-z0-9_-]+", invite_hash):
                    raise ValueError("私密群邀请链接格式无效")
                return f"https://t.me/+{invite_hash}"
            if len(parts) != 1 or not re.fullmatch(r"[A-Za-z0-9_]{5,32}", parts[0]):
                raise ValueError("仅支持群组或频道主页链接，不支持消息链接")
            return f"@{parts[0]}"
        username = text.removeprefix("@").strip()
        if re.fullmatch(r"[A-Za-z0-9_]{5,32}", username):
            return f"@{username}"
        raise ValueError(
            "群组或频道链接格式无效，仅支持 t.me 链接、@用户名和私密邀请链接"
        )

    @staticmethod
    def _validate_delay(
        min_delay_seconds: Any, max_delay_seconds: Any
    ) -> tuple[float, float]:
        try:
            minimum = float(min_delay_seconds)
            maximum = float(max_delay_seconds)
        except (TypeError, ValueError) as exc:
            raise ValueError("加退群间隔必须是数字") from exc
        if minimum < 1 or maximum < 1 or minimum > maximum or maximum > 3600:
            raise ValueError("间隔范围必须满足 1 ≤ 最小秒数 ≤ 最大秒数 ≤ 3600")
        return minimum, maximum

    def list_jobs(self, limit: int = 20) -> List[Dict[str, Any]]:
        bounded = max(1, min(int(limit), MAX_HISTORY))
        values = sorted(
            self.jobs.values(),
            key=lambda item: str(item.get("created_at") or ""),
            reverse=True,
        )
        return [self._public_job(item) for item in values[:bounded]]

    def get_job(self, job_id: str) -> Dict[str, Any]:
        job = self.jobs.get(str(job_id))
        if not job:
            raise KeyError(job_id)
        return self._public_job(job)

    async def _iter_account_group_chats(self, client: Any) -> AsyncIterator[Any]:
        seen_ids: set[int] = set()
        for from_archive in (False, True):
            async for dialog in client.get_dialogs(from_archive=from_archive):
                chat = getattr(dialog, "chat", None)
                chat_id = getattr(chat, "id", None)
                if (
                    chat is None
                    or chat_id is None
                    or chat_id in seen_ids
                    or self._chat_type_name(chat)
                    not in {"group", "supergroup", "channel"}
                ):
                    continue
                seen_ids.add(chat_id)
                yield chat

    async def list_account_groups(self, account_name: str) -> List[Dict[str, Any]]:
        account_name = self._validate_account_name(account_name)

        async def _list(client: Any) -> List[Dict[str, Any]]:
            groups: List[Dict[str, Any]] = []
            async for chat in self._iter_account_group_chats(client):
                groups.append(
                    {
                        "id": getattr(chat, "id", None),
                        "title": getattr(chat, "title", None)
                        or str(getattr(chat, "id", "")),
                        "username": self._normalize_username(
                            getattr(chat, "username", None)
                        )
                        or None,
                        "type": self._chat_type_name(chat),
                    }
                )
                if len(groups) >= MAX_LINKS:
                    break
            groups.sort(key=lambda item: str(item.get("title") or "").casefold())
            return groups

        return await self._with_client(account_name, _list)

    def start_job(
        self,
        *,
        account_name: str,
        mode: str,
        links: Optional[List[str]],
        selected_chat_ids: Optional[List[int]],
        min_delay_seconds: Any,
        max_delay_seconds: Any,
        auto_wait_flood: bool = True,
    ) -> Dict[str, Any]:
        account_name = self._validate_account_name(account_name)
        mode = str(mode or "").strip().lower()
        if mode not in SUPPORTED_MODES:
            raise ValueError("工作模式无效")
        minimum, maximum = self._validate_delay(min_delay_seconds, max_delay_seconds)
        normalized_links = self._normalize_links(links or []) if mode == "join" else []
        normalized_chat_ids: List[int] = []
        if mode == "leave_selected":
            seen_chat_ids: set[int] = set()
            for raw_chat_id in selected_chat_ids or []:
                try:
                    chat_id = int(raw_chat_id)
                except (TypeError, ValueError) as exc:
                    raise ValueError("退出目标包含无效群组或频道 ID") from exc
                if chat_id not in seen_chat_ids:
                    seen_chat_ids.add(chat_id)
                    normalized_chat_ids.append(chat_id)
            if not normalized_chat_ids:
                raise ValueError("请至少选择一个需要退出的群组或频道")
            if len(normalized_chat_ids) > MAX_LINKS:
                raise ValueError(f"单个任务最多支持 {MAX_LINKS} 个群组或频道")
        if any(
            item.get("account_name") == account_name
            and item.get("status") in ACTIVE_STATUSES
            for item in self.jobs.values()
        ):
            raise ValueError("该账号已有批量加退群任务正在运行")

        job_id = uuid.uuid4().hex
        job: Dict[str, Any] = {
            "job_id": job_id,
            "status": "running",
            "mode": mode,
            "account_name": account_name,
            "min_delay_seconds": minimum,
            "max_delay_seconds": maximum,
            "auto_wait_flood": bool(auto_wait_flood),
            "created_at": self._now(),
            "updated_at": self._now(),
            "finished_at": None,
            "progress": {
                "done": 0,
                "total": (
                    len(normalized_links)
                    if mode == "join"
                    else len(normalized_chat_ids)
                ),
            },
            "summary": {},
            "results": [],
            "logs": [],
            "error": None,
            "_links": normalized_links,
            "_selected_chat_ids": normalized_chat_ids,
            "_cancel_requested": False,
        }
        self.jobs[job_id] = job
        mode_text = (
            "批量加入群组或频道"
            if mode == "join"
            else (
                "退出所选群组或频道"
                if mode == "leave_selected"
                else "退出账号上的所有群组或频道"
            )
        )
        self._append_log(job, "info", f"任务已创建：{mode_text}")
        task = asyncio.create_task(self._run_job(job_id))
        self._tasks[job_id] = task
        task.add_done_callback(lambda _task, key=job_id: self._tasks.pop(key, None))
        return self.get_job(job_id)

    def cancel_job(self, job_id: str) -> Dict[str, Any]:
        job = self.jobs.get(str(job_id))
        if not job:
            raise KeyError(job_id)
        if job.get("status") in ACTIVE_STATUSES:
            job["status"] = "canceling"
            job["_cancel_requested"] = True
            self._append_log(
                job, "warning", "已收到停止请求，将在当前操作或等待结束后安全停止"
            )
        return self._public_job(job)

    async def _cancelable_sleep(self, job: Dict[str, Any], seconds: float) -> bool:
        remaining = max(0.0, float(seconds))
        while remaining > 0:
            if job.get("_cancel_requested"):
                return True
            chunk = min(1.0, remaining)
            await asyncio.sleep(chunk)
            remaining -= chunk
        return bool(job.get("_cancel_requested"))

    @staticmethod
    def _wait_seconds(exc: BaseException) -> Optional[int]:
        class_name = type(exc).__name__.upper()
        text = str(exc).upper()
        if "FLOODWAIT" not in class_name and "FLOOD_WAIT" not in text:
            return None
        try:
            return max(1, int(getattr(exc, "value", 0) or 0))
        except (TypeError, ValueError):
            return 1

    async def _call_with_flood_wait(
        self,
        job: Dict[str, Any],
        ref: str,
        operation,
    ) -> tuple[bool, Any]:
        attempts = 0
        while True:
            if job.get("_cancel_requested"):
                return False, {"status": "canceled", "message": "任务已停止"}
            try:
                return True, await operation()
            except Exception as exc:
                wait_seconds = self._wait_seconds(exc)
                if wait_seconds is None:
                    return False, exc
                if not job.get("auto_wait_flood"):
                    return False, exc
                attempts += 1
                self._append_log(
                    job,
                    "warning",
                    f"触发 Telegram 频率限制，自动等待 {wait_seconds} 秒后重试（{attempts}/{MAX_FLOOD_RETRIES}）",
                    ref=ref,
                )
                if await self._cancelable_sleep(job, wait_seconds):
                    return False, {
                        "status": "canceled",
                        "message": "等待期间任务已停止",
                    }
                if attempts >= MAX_FLOOD_RETRIES:
                    return False, exc

    def _add_result(self, job: Dict[str, Any], result: Dict[str, Any]) -> None:
        job.setdefault("results", []).append(result)
        job["progress"]["done"] = len(job["results"])
        summary: Dict[str, int] = {"total": len(job["results"])}
        for item in job["results"]:
            status = str(item.get("status") or "failed")
            summary[status] = summary.get(status, 0) + 1
        job["summary"] = summary
        job["updated_at"] = self._now()
        self._write_job(job)

    async def _join_item(
        self, client: Any, job: Dict[str, Any], raw_ref: str
    ) -> Dict[str, Any]:
        try:
            join_ref = self._normalize_join_ref(raw_ref)
        except ValueError as exc:
            return {
                "ref": raw_ref,
                "title": raw_ref,
                "status": "failed",
                "message": str(exc),
            }

        self._append_log(job, "info", "正在加入群组或频道", ref=raw_ref)
        success, value = await self._call_with_flood_wait(
            job,
            raw_ref,
            lambda: client.join_chat(join_ref),
        )
        if success:
            title = (
                getattr(value, "title", None)
                or getattr(value, "username", None)
                or raw_ref
            )
            return {
                "ref": raw_ref,
                "title": str(title),
                "chat_id": getattr(value, "id", None),
                "status": "joined",
                "message": "已加入群组或频道；如还有验证机器人，请在 Telegram 客户端完成验证。",
            }
        if isinstance(value, dict):
            return {"ref": raw_ref, "title": raw_ref, **value}
        mapped = self._map_join_exception(value)
        return {"ref": raw_ref, "title": raw_ref, **mapped}

    async def _leave_item(
        self, client: Any, job: Dict[str, Any], chat: Any
    ) -> Dict[str, Any]:
        chat_id = getattr(chat, "id", None)
        title = getattr(chat, "title", None) or str(chat_id or "未知群组或频道")
        target_name = "频道" if self._chat_type_name(chat) == "channel" else "群组"
        ref = f"{title} ({chat_id})"
        self._append_log(job, "info", f"正在退出{target_name}", ref=ref)
        success, value = await self._call_with_flood_wait(
            job,
            ref,
            lambda: client.leave_chat(chat_id),
        )
        if success:
            return {
                "ref": str(chat_id),
                "title": title,
                "chat_id": chat_id,
                "status": "left",
                "message": f"已退出{target_name}",
            }
        if isinstance(value, dict):
            return {"ref": str(chat_id), "title": title, "chat_id": chat_id, **value}
        text = self._exception_text(value)
        upper = text.upper()
        status = "not_member" if "USER_NOT_PARTICIPANT" in upper else "failed"
        message = f"账号已不在该{target_name}中" if status == "not_member" else text
        return {
            "ref": str(chat_id),
            "title": title,
            "chat_id": chat_id,
            "status": status,
            "message": message,
        }

    async def _run_items(self, client: Any, job: Dict[str, Any]) -> None:
        if job["mode"] == "join":
            items: List[Any] = list(job.get("_links") or [])
        else:
            self._append_log(job, "info", "正在读取账号已加入的群组和频道")
            items = []
            selected_ids = {
                int(chat_id) for chat_id in job.get("_selected_chat_ids") or []
            }
            async for chat in self._iter_account_group_chats(client):
                if (
                    job["mode"] == "leave_all_groups"
                    or getattr(chat, "id", None) in selected_ids
                ):
                    items.append(chat)
                if job["mode"] == "leave_selected" and len(items) >= len(selected_ids):
                    break
                if job["mode"] == "leave_all_groups" and len(items) >= MAX_LINKS:
                    break
            job["progress"] = {"done": 0, "total": len(items)}
            if job["mode"] == "leave_selected" and len(items) != len(selected_ids):
                self._append_log(
                    job,
                    "warning",
                    f"选择了 {len(selected_ids)} 个群组或频道，当前账号中找到 {len(items)} 个",
                )
            self._append_log(job, "info", f"共确认 {len(items)} 个待退出群组或频道")

        total = len(items)
        for index, item in enumerate(items):
            if job.get("_cancel_requested"):
                return
            result = (
                await self._join_item(client, job, item)
                if job["mode"] == "join"
                else await self._leave_item(client, job, item)
            )
            self._add_result(job, result)
            level = (
                "success"
                if result.get("status")
                in {"joined", "left", "already_member", "request_sent"}
                else "warning"
            )
            self._append_log(
                job,
                level,
                str(result.get("message") or "操作完成"),
                ref=str(result.get("title") or result.get("ref") or ""),
            )
            if index < total - 1 and not job.get("_cancel_requested"):
                delay = random.uniform(
                    job["min_delay_seconds"], job["max_delay_seconds"]
                )
                self._append_log(job, "info", f"等待 {delay:.1f} 秒后执行下一项")
                if await self._cancelable_sleep(job, delay):
                    return

    async def _run_job(self, job_id: str) -> None:
        job = self.jobs[job_id]
        try:
            await self._with_client(
                job["account_name"], lambda client: self._run_items(client, job)
            )
            if job.get("_cancel_requested"):
                job["status"] = "canceled"
                self._append_log(job, "warning", "任务已安全停止")
            else:
                job["status"] = "completed"
                self._append_log(job, "success", "批量加退群任务执行完成")
        except asyncio.CancelledError:
            job["status"] = "canceled"
            job["error"] = "服务停止，任务已取消"
            self._append_log(job, "warning", "服务停止，任务已取消")
        except Exception as exc:
            logger.exception("Bulk group membership job failed job=%s", job_id)
            job["status"] = "failed"
            job["error"] = str(exc)
            self._append_log(job, "error", f"任务执行失败：{exc}")
        finally:
            job["finished_at"] = self._now()
            job["updated_at"] = self._now()
            self._write_job(job)

    async def stop(self) -> None:
        tasks = list(self._tasks.values())
        for job in self.jobs.values():
            if job.get("status") in ACTIVE_STATUSES:
                job["status"] = "canceling"
                job["_cancel_requested"] = True
        if tasks:
            try:
                await asyncio.wait_for(
                    asyncio.gather(*tasks, return_exceptions=True), timeout=5.0
                )
            except asyncio.TimeoutError:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()


_services: dict[str, BulkGroupMembershipService] = {}


def get_bulk_group_membership_service() -> BulkGroupMembershipService:
    key = get_workspace_key()
    if key not in _services:
        _services[key] = BulkGroupMembershipService()
    return _services[key]
