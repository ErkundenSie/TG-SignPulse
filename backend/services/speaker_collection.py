"""从当前账号可见的群消息中收集发言者资料。"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

from backend.core.config import get_settings
from backend.core.workspace import get_workspace_key
from backend.services.chat_migration import ChatMigrationService

logger = logging.getLogger("backend.speaker_collection")


class SpeakerCollectionService(ChatMigrationService):
    """仅从当前账号可读的消息中去重收集发言者，不尝试枚举隐藏成员。"""

    MAX_HISTORY_MESSAGES = 5000
    POLL_INTERVAL_SECONDS = 30
    PROFILE_REQUEST_DELAY = 0.08
    WEBSITE_RE = re.compile(
        r"(?<!@)(?:(?:https?://|www\.)[^\s<>\[\]{}()]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|co|cn|app|dev|me|vip|xyz|info|site|top|pro|cc|ai)(?:/[^\s<>\[\]{}()]*)?)",
        re.IGNORECASE,
    )
    PUBLIC_CHAT_USERNAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{2,31}$")

    def __init__(self) -> None:
        super().__init__()
        self._file = self._resolve_file()
        self._lock = asyncio.Lock()
        self._workers: dict[str, asyncio.Task] = {}
        self._scan_locks: dict[str, asyncio.Lock] = {}
        self._data = self._load()

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).replace(microsecond=0).isoformat()

    def _resolve_file(self) -> Path:
        path = get_settings().resolve_workdir() / "speaker_collection" / "data.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def _load(self) -> dict[str, Any]:
        try:
            with self._file.open("r", encoding="utf-8") as fp:
                data = json.load(fp)
            if isinstance(data, dict):
                return {
                    "configs": data.get("configs", {}),
                    "records": data.get("records", {}),
                }
        except (OSError, json.JSONDecodeError):
            pass
        return {"configs": {}, "records": {}}

    def _save(self) -> None:
        tmp = self._file.with_suffix(".tmp")
        with tmp.open("w", encoding="utf-8") as fp:
            json.dump(self._data, fp, ensure_ascii=False, indent=2)
        tmp.replace(self._file)

    @staticmethod
    def _parse_datetime(value: Optional[str]) -> Optional[datetime]:
        if not value:
            return None
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError as exc:
            raise ValueError("时间必须使用 ISO 格式") from exc

    @staticmethod
    def _chat_ref(value: Any) -> str | int:
        text = str(value or "").strip()
        if not text:
            raise ValueError("请提供群组 ID 或 @用户名")
        return int(text) if text.lstrip("-").isdigit() else text

    @classmethod
    def _public_chat_username(cls, value: Any) -> str:
        text = str(value or "").strip()
        if not text:
            raise ValueError("请输入公开群组或频道的用户名")
        if text.lower().startswith(("http://", "https://", "t.me/")):
            url = text if "://" in text else f"https://{text}"
            parts = [part for part in urlparse(url).path.split("/") if part]
            if parts and parts[0].lower() == "s":
                parts = parts[1:]
            text = parts[0] if parts else ""
        text = text.lstrip("@").strip()
        if not cls.PUBLIC_CHAT_USERNAME_RE.fullmatch(text):
            raise ValueError("请输入有效的公开群组或频道用户名")
        return text

    async def resolve_public_chat(
        self, account_name: str, query: str
    ) -> dict[str, Any]:
        username = self._public_chat_username(query)

        async def _resolve(client: Any) -> dict[str, Any]:
            try:
                chat = await client.get_chat(username)
            except Exception as exc:
                logger.info("公开群组解析失败 @%s: %s", username, exc)
                raise ValueError("当前账号无法找到该公开群组或频道") from exc
            chat_type = self._chat_type_name(chat)
            if chat_type not in {"group", "supergroup", "channel"}:
                raise ValueError("该用户名不是群组或频道")
            chat_id = getattr(chat, "id", None)
            if chat_id is None:
                raise ValueError("无法读取该群组或频道的信息")
            resolved_username = self._normalize_username(
                getattr(chat, "username", None)
            )
            return {
                "id": chat_id,
                "title": getattr(chat, "title", None)
                or resolved_username
                or str(chat_id),
                "username": resolved_username or username,
                "type": chat_type,
                "first_name": None,
            }

        return await self._with_client(account_name, _resolve)

    @staticmethod
    def _keywords(value: Any) -> list[str]:
        if not isinstance(value, list):
            value = str(value or "").replace("，", ",").split(",")
        result: list[str] = []
        seen: set[str] = set()
        for item in value:
            keyword = str(item or "").strip()
            if keyword and keyword.casefold() not in seen:
                seen.add(keyword.casefold())
                result.append(keyword)
        if len(result) > 20:
            raise ValueError("关键词数量不能超过 20 个")
        return result

    @classmethod
    def _extract_websites(cls, bio: Any) -> list[str]:
        websites: list[str] = []
        seen: set[str] = set()
        for match in cls.WEBSITE_RE.finditer(str(bio or "")):
            value = match.group(0).rstrip(".,，;；:：!！?？)]}）】\"'")
            if not value:
                continue
            url = (
                value
                if value.lower().startswith(("http://", "https://"))
                else f"https://{value}"
            )
            hostname = (urlparse(url).hostname or "").casefold().removeprefix("www.")
            if hostname in {"t.me", "telegram.me", "telegram.dog"}:
                continue
            key = url.casefold()
            if key not in seen:
                seen.add(key)
                websites.append(url)
        return websites

    def list_configs(self, account_name: Optional[str] = None) -> list[dict[str, Any]]:
        values = list(self._data["configs"].values())
        if account_name:
            values = [
                item for item in values if item.get("account_name") == account_name
            ]
        return sorted(
            (self._config_with_status(item) for item in values),
            key=lambda item: item.get("updated_at", ""),
            reverse=True,
        )

    def _config_with_status(self, config: dict[str, Any]) -> dict[str, Any]:
        result = dict(config)
        if not config.get("continuous"):
            result["monitor_status"] = "one_time"
            return result
        if not config.get("enabled"):
            result["monitor_status"] = (
                "completed" if config.get("completed_at") else "paused"
            )
            return result

        now = datetime.now(timezone.utc)
        start_at = self._parse_datetime(config.get("start_at"))
        end_at = self._parse_datetime(config.get("end_at"))
        if end_at and now > end_at:
            result["monitor_status"] = "completed"
        elif start_at and now < start_at:
            result["monitor_status"] = "waiting"
        else:
            result["monitor_status"] = "running"
        return result

    def get_records(self, config_id: str, limit: int = 500) -> list[dict[str, Any]]:
        values = []
        for item in self._data["records"].values():
            if item.get("config_id") != config_id:
                continue
            record = dict(item)
            record.pop("seen_message_ids", None)
            record["websites"] = record.get("websites") or self._extract_websites(
                record.get("bio")
            )
            values.append(record)
        values.sort(key=lambda item: item.get("last_message_at", ""), reverse=True)
        return values[: max(1, min(limit, 5000))]

    async def save_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        account_name = self._validate_account_name(
            str(payload.get("account_name") or "")
        )
        chat_id = str(payload.get("chat_id") or "").strip()
        self._chat_ref(chat_id)
        config_id = str(payload.get("id") or uuid.uuid4().hex)
        start_at = self._parse_datetime(payload.get("start_at"))
        end_at = self._parse_datetime(payload.get("end_at"))
        keywords = self._keywords(payload.get("profile_keywords"))
        if start_at and end_at and start_at > end_at:
            raise ValueError("开始时间不能晚于结束时间")
        config = {
            "id": config_id,
            "name": str(payload.get("name") or "发言者采集").strip()[:80]
            or "发言者采集",
            "account_name": account_name,
            "chat_id": chat_id,
            "chat_name": str(payload.get("chat_name") or chat_id).strip(),
            "start_at": start_at.isoformat() if start_at else None,
            "end_at": end_at.isoformat() if end_at else None,
            "profile_keywords": keywords,
            "continuous": bool(payload.get("continuous", False)),
            "enabled": bool(payload.get("enabled", True)),
            "history_limit": max(
                1,
                min(
                    int(payload.get("history_limit") or 1000), self.MAX_HISTORY_MESSAGES
                ),
            ),
            "updated_at": self._now(),
            "created_at": self._data["configs"]
            .get(config_id, {})
            .get("created_at", self._now()),
            "last_scan_at": self._data["configs"]
            .get(config_id, {})
            .get("last_scan_at"),
            "last_scan_summary": self._data["configs"]
            .get(config_id, {})
            .get("last_scan_summary", {}),
            "latest_message_id_seen": self._data["configs"]
            .get(config_id, {})
            .get("latest_message_id_seen"),
            "completed_at": None,
        }
        async with self._lock:
            self._data["configs"][config_id] = config
            self._save()
        await self._sync_worker(config)
        return self._config_with_status(config)

    async def set_enabled(self, config_id: str, enabled: bool) -> dict[str, Any]:
        async with self._lock:
            config = self._data["configs"].get(config_id)
            if not config:
                raise KeyError(config_id)
            if not config.get("continuous"):
                raise ValueError("一次性采集任务无需暂停")
            end_at = self._parse_datetime(config.get("end_at"))
            if enabled and end_at and datetime.now(timezone.utc) > end_at:
                raise ValueError("任务结束时间已到，请先修改结束时间")
            config["enabled"] = enabled
            config["completed_at"] = None
            config["updated_at"] = self._now()
            self._save()
            result = self._config_with_status(config)
        await self._sync_worker(config)
        return result

    async def delete_config(self, config_id: str) -> bool:
        async with self._lock:
            if config_id not in self._data["configs"]:
                return False
            self._data["configs"].pop(config_id)
            self._data["records"] = {
                key: value
                for key, value in self._data["records"].items()
                if value.get("config_id") != config_id
            }
            self._save()
        worker = self._workers.pop(config_id, None)
        if worker:
            worker.cancel()
        self._scan_locks.pop(config_id, None)
        return True

    async def _visible_profile(self, client: Any, user: Any) -> Any:
        try:
            return await client.get_chat(user.id)
        except Exception:
            return user

    async def scan(self, config_id: str) -> dict[str, Any]:
        lock = self._scan_locks.setdefault(config_id, asyncio.Lock())
        async with lock:
            return await self._scan_config(config_id)

    async def _scan_config(self, config_id: str) -> dict[str, Any]:
        config = self._data["configs"].get(config_id)
        if not config:
            raise KeyError(config_id)
        start_at = self._parse_datetime(config.get("start_at"))
        end_at = self._parse_datetime(config.get("end_at"))
        keywords = self._keywords(config.get("profile_keywords"))
        chat_ref = self._chat_ref(config["chat_id"])

        async def _scan(client: Any) -> dict[str, Any]:
            scanned = 0
            added = 0
            skipped_no_sender = 0
            skipped_bots = 0
            profile_unavailable = 0
            matched_profiles = 0
            profile_cache: dict[str, Any] = {}
            previous_latest_message_id = (
                int(config.get("latest_message_id_seen"))
                if config.get("continuous")
                and str(config.get("latest_message_id_seen") or "").isdigit()
                else None
            )
            latest_message_id_seen = previous_latest_message_id
            async for message in client.get_chat_history(
                chat_ref, limit=config["history_limit"]
            ):
                message_id = getattr(message, "id", None)
                if (
                    previous_latest_message_id is not None
                    and isinstance(message_id, int)
                    and message_id <= previous_latest_message_id
                ):
                    break
                if isinstance(message_id, int):
                    latest_message_id_seen = max(
                        latest_message_id_seen or message_id, message_id
                    )
                message_date = getattr(message, "date", None)
                if not isinstance(message_date, datetime):
                    continue
                if message_date.tzinfo is None:
                    message_date = message_date.replace(tzinfo=timezone.utc)
                if end_at and message_date > end_at:
                    continue
                if start_at and message_date < start_at:
                    break
                scanned += 1
                user = getattr(message, "from_user", None)
                if user is None:
                    skipped_no_sender += 1
                    continue
                if getattr(user, "is_bot", False):
                    skipped_bots += 1
                    continue
                key = f"{config_id}:{getattr(message.chat, 'id', config['chat_id'])}:{user.id}"
                now = self._now()
                existing = self._data["records"].get(key, {})
                profile = profile_cache.get(str(user.id))
                if profile is None:
                    profile = await self._visible_profile(client, user)
                    profile_cache[str(user.id)] = profile
                    await asyncio.sleep(self.PROFILE_REQUEST_DELAY)
                bio = (
                    getattr(profile, "bio", None)
                    or getattr(profile, "description", None)
                    or ""
                )
                if not bio:
                    profile_unavailable += 1
                hits = [
                    keyword
                    for keyword in keywords
                    if keyword.casefold() in bio.casefold()
                ]
                if keywords and not hits:
                    continue
                if hits:
                    matched_profiles += 1
                seen_message_ids = [
                    int(item)
                    for item in existing.get("seen_message_ids", [])
                    if isinstance(item, int) or str(item).isdigit()
                ]
                is_new_message = (
                    isinstance(message_id, int) and message_id not in seen_message_ids
                )
                if is_new_message:
                    seen_message_ids.append(message_id)
                    seen_message_ids = seen_message_ids[-10000:]
                name = (
                    " ".join(
                        part
                        for part in [
                            getattr(user, "first_name", ""),
                            getattr(user, "last_name", ""),
                        ]
                        if part
                    )
                    or getattr(user, "username", "")
                    or str(user.id)
                )
                first_at = existing.get("first_message_at") or message_date.isoformat()
                last_at = existing.get("last_message_at") or message_date.isoformat()
                first_message_id = existing.get("first_message_id") or message_id
                if message_date.isoformat() < first_at:
                    first_at = message_date.isoformat()
                    first_message_id = message_id
                if message_date.isoformat() > last_at:
                    last_at = message_date.isoformat()
                record = {
                    **existing,
                    "id": key,
                    "config_id": config_id,
                    "account_name": config["account_name"],
                    "chat_id": str(getattr(message.chat, "id", config["chat_id"])),
                    "chat_name": getattr(message.chat, "title", None)
                    or config["chat_name"],
                    "sender_id": str(user.id),
                    "sender": name,
                    "sender_username": getattr(user, "username", None) or "",
                    "profile_url": (
                        f"https://t.me/{user.username}"
                        if getattr(user, "username", None)
                        else ""
                    ),
                    "bio": bio,
                    "websites": self._extract_websites(bio),
                    "matched_keywords": hits,
                    "first_message_at": first_at,
                    "last_message_at": last_at,
                    "first_message_id": first_message_id,
                    "last_message_id": (
                        message_id
                        if message_date.isoformat() >= last_at
                        else existing.get("last_message_id")
                    ),
                    "message_count": int(existing.get("message_count") or 0)
                    + int(is_new_message),
                    "sample_message": (
                        getattr(message, "text", None)
                        or getattr(message, "caption", None)
                        or ""
                    )[:500],
                    "seen_message_ids": seen_message_ids,
                    "updated_at": now,
                }
                if not existing:
                    added += 1
                self._data["records"][key] = record
            return {
                "scanned_messages": scanned,
                "new_speakers": added,
                "matched_speakers": len(self.get_records(config_id, 5000)),
                "messages_without_user": skipped_no_sender,
                "bot_messages": skipped_bots,
                "profiles_without_bio": profile_unavailable,
                "keyword_matched_messages": matched_profiles,
                "unique_speakers": len(self.get_records(config_id, 5000)),
                "latest_message_id_seen": latest_message_id_seen or 0,
            }

        result = await self._with_client(config["account_name"], _scan)
        async with self._lock:
            config["last_scan_at"] = self._now()
            config["last_scan_summary"] = result
            if result.get("latest_message_id_seen"):
                config["latest_message_id_seen"] = result["latest_message_id_seen"]
            self._save()
        return result

    async def _complete_monitor(self, config: dict[str, Any]) -> None:
        async with self._lock:
            current = self._data["configs"].get(config["id"])
            if not current or not current.get("enabled"):
                return
            current["enabled"] = False
            current["completed_at"] = self._now()
            current["updated_at"] = self._now()
            self._save()

    async def _worker(self, config_id: str) -> None:
        try:
            while True:
                config = self._data["configs"].get(config_id)
                if (
                    not config
                    or not config.get("enabled")
                    or not config.get("continuous")
                ):
                    return
                now = datetime.now(timezone.utc)
                start_at = self._parse_datetime(config.get("start_at"))
                end_at = self._parse_datetime(config.get("end_at"))
                if end_at and now > end_at:
                    await self._complete_monitor(config)
                    return
                if start_at and now < start_at:
                    await asyncio.sleep(
                        min(
                            self.POLL_INTERVAL_SECONDS,
                            max(0.1, (start_at - now).total_seconds()),
                        )
                    )
                    continue
                try:
                    await self.scan(config_id)
                except Exception as exc:
                    logger.warning(
                        "Speaker collection poll failed for %s: %s", config_id, exc
                    )
                await asyncio.sleep(self.POLL_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            raise

    async def _sync_worker(self, config: dict[str, Any]) -> None:
        current = self._workers.get(config["id"])
        if config.get("continuous") and config.get("enabled"):
            if not current or current.done():
                self._workers[config["id"]] = asyncio.create_task(
                    self._worker(config["id"])
                )
        elif current:
            current.cancel()
            self._workers.pop(config["id"], None)

    async def start(self) -> None:
        for config in self._data["configs"].values():
            await self._sync_worker(config)

    async def stop(self) -> None:
        workers = list(self._workers.values())
        self._workers.clear()
        for worker in workers:
            worker.cancel()
        if workers:
            await asyncio.gather(*workers, return_exceptions=True)


_services: dict[str, SpeakerCollectionService] = {}


def get_speaker_collection_service() -> SpeakerCollectionService:
    key = get_workspace_key()
    if key not in _services:
        _services[key] = SpeakerCollectionService()
    return _services[key]
