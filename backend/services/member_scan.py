"""群成员公开资料关键词筛选服务。"""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any, Dict, List, Optional

from pyrogram.enums import ChatMembersFilter

from backend.core.workspace import get_workspace_key
from backend.services.chat_migration import ChatMigrationService


class MemberScanService(ChatMigrationService):
    """筛选当前 Telegram 账号有权访问的群成员公开资料。"""

    MAX_MEMBERS = 10000
    MAX_KEYWORDS = 20
    PROFILE_REQUEST_DELAY = 0.12

    @staticmethod
    def _normalize_keywords(values: List[str]) -> List[str]:
        normalized: List[str] = []
        seen: set[str] = set()
        for value in values:
            keyword = str(value or "").strip()
            if not keyword:
                continue
            if len(keyword) > 64:
                raise ValueError("单个关键词不能超过 64 个字符")
            key = keyword.casefold()
            if key not in seen:
                seen.add(key)
                normalized.append(keyword)
        if len(normalized) > MemberScanService.MAX_KEYWORDS:
            raise ValueError(f"关键词数量不能超过 {MemberScanService.MAX_KEYWORDS} 个")
        return normalized

    @staticmethod
    def _member_name(user: Any) -> str:
        return " ".join(
            part
            for part in (
                str(getattr(user, "first_name", "") or "").strip(),
                str(getattr(user, "last_name", "") or "").strip(),
            )
            if part
        )

    async def _get_visible_profile(self, client: Any, user: Any) -> Any:
        """尽力取得 Telegram 当前账号可见的资料，不绕过隐私设置。"""
        user_id = getattr(user, "id", None)
        if user_id is None:
            return user
        try:
            return await client.get_chat(user_id)
        except Exception:
            return user

    def _build_member_item(
        self,
        user: Any,
        profile: Any,
        chat_id: str,
        matched_keywords: List[str],
    ) -> Dict[str, Any]:
        user_id = getattr(user, "id", None)
        username = self._normalize_username(getattr(user, "username", None))
        bio = self._clean_text(
            getattr(profile, "bio", None) or getattr(profile, "description", None)
        )
        phone = self._clean_text(
            getattr(profile, "phone_number", None)
            or getattr(user, "phone_number", None)
        )
        return {
            "user_id": user_id,
            "name": self._member_name(user) or username or str(user_id or ""),
            "username": username or None,
            "profile_url": f"https://t.me/{username}" if username else None,
            "bio": bio or None,
            # 仅包含 Telegram 已返回给当前账号的字段；通常为空。
            "phone": phone or None,
            "is_bot": bool(getattr(user, "is_bot", False)),
            "source_chat_id": chat_id,
            "matched_keywords": matched_keywords,
        }

    async def scan_chat_members(
        self,
        account_name: str,
        chat_id: str,
        keywords: List[str],
        *,
        limit: int = 3000,
        include_bots: bool = False,
    ) -> Dict[str, Any]:
        """遍历成员资料，保留所有可读取成员并标记关键词命中。"""
        account_name = self._validate_account_name(account_name)
        chat_ref = str(chat_id or "").strip()
        if not chat_ref:
            raise ValueError("请提供群组 ID 或 @用户名")
        client_chat_ref: str | int = (
            int(chat_ref) if chat_ref.lstrip("-").isdigit() else chat_ref
        )
        normalized_keywords = self._normalize_keywords(keywords)
        safe_limit = max(1, min(int(limit), self.MAX_MEMBERS))

        async def _scan(client: Any) -> Dict[str, Any]:
            items: List[Dict[str, Any]] = []
            scanned = 0
            skipped_bots = 0
            async for member in client.get_chat_members(
                client_chat_ref,
                limit=safe_limit,
                filter=ChatMembersFilter.RECENT,
            ):
                user = getattr(member, "user", None)
                if user is None:
                    continue
                if getattr(user, "is_bot", False) and not include_bots:
                    skipped_bots += 1
                    continue

                scanned += 1
                profile = await self._get_visible_profile(client, user)
                bio = self._clean_text(
                    getattr(profile, "bio", None)
                    or getattr(profile, "description", None)
                )
                searchable = " ".join(
                    (
                        self._member_name(user),
                        str(getattr(user, "username", "") or ""),
                        bio,
                    )
                ).casefold()
                hits = [
                    keyword
                    for keyword in normalized_keywords
                    if keyword.casefold() in searchable
                ]
                items.append(self._build_member_item(user, profile, chat_ref, hits))
                await asyncio.sleep(self.PROFILE_REQUEST_DELAY)

            chat = await client.get_chat(client_chat_ref)
            reported_count = int(getattr(chat, "members_count", 0) or 0)
            if reported_count > 1 and scanned <= 1:
                raise ValueError(
                    f"Telegram 仅返回了 {scanned} 名成员，但该群显示约 {reported_count} 名成员。"
                    "当前登录账号没有读取完整成员列表的权限，请使用该群管理员账号登录后重试。"
                )

            return {
                "account_name": account_name,
                "chat_id": chat_ref,
                "keywords": normalized_keywords,
                "scanned_at": datetime.utcnow().replace(microsecond=0).isoformat()
                + "Z",
                "items": items,
                "summary": {
                    "requested_limit": safe_limit,
                    "reported_member_count": reported_count or None,
                    "scanned": scanned,
                    "matched": sum(1 for item in items if item.get("matched_keywords")),
                    "skipped_bots": skipped_bots,
                },
                "notice": (
                    "仅导出当前 Telegram 账号可见的资料；手机号通常受隐私设置保护，"
                    "不会尝试绕过限制。"
                ),
            }

        return await self._with_client(account_name, _scan)


_member_scan_services: dict[str, MemberScanService] = {}


def get_member_scan_service() -> MemberScanService:
    key = get_workspace_key()
    if key not in _member_scan_services:
        _member_scan_services[key] = MemberScanService()
    return _member_scan_services[key]
