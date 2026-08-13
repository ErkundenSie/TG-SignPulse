from __future__ import annotations

import asyncio
import json
import logging
import random
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
from pyrogram import filters
from pyrogram.handlers import EditedMessageHandler, MessageHandler
from pyrogram.types import Message

from backend.core.workspace import get_workspace_context, get_workspace_key
from backend.services.chat_migration import ChatMigrationService
from backend.utils.account_locks import get_account_lock
from backend.utils.names import validate_name_segment
from backend.utils.outbound_url import validate_outbound_http_url

logger = logging.getLogger("backend.automation_rules")

SUPPORTED_TRIGGERS = {"message", "timer", "startup"}
SUPPORTED_HANDLERS = {
    "send_text",
    "reply_text",
    "extract_regex",
    "ai_reply",
    "blacklist_filter",
    "delay",
    "forward",
    "http_callback",
    "external_forward",
    "server_chan",
    "schedule_next",
    "store_state",
    "load_state",
    "random_pick",
}
_TEMPLATE_RE = re.compile(r"(?:\$\{|\{)([A-Za-z_][A-Za-z0-9_]*)\}")


class AutomationRuleService(ChatMigrationService):
    MAX_RULES = 200
    MAX_TRIGGERS = 10
    MAX_HANDLERS = 30
    MAX_DELAY_SECONDS = 300.0
    MAX_REGEX_LENGTH = 200
    MAX_LOG_ITEMS = 1000
    MAX_ACTIVE_EXECUTIONS = 100

    def __init__(self) -> None:
        super().__init__()
        self.root = self.settings.resolve_workdir() / "automation_rules"
        self.root.mkdir(parents=True, exist_ok=True)
        self._lifecycle_lock = asyncio.Lock()
        self._io_locks: dict[str, asyncio.Lock] = {}
        self._handler_refs: list[tuple[str, Any, Any]] = []
        self._active_clients: dict[str, Any] = {}
        self._message_rules: dict[str, list[dict[str, Any]]] = {}
        self._execution_tasks: set[asyncio.Task] = set()
        self._running_counts: dict[str, int] = {}

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).replace(microsecond=0).isoformat()

    def _rule_dir(self, rule_id: str) -> Path:
        safe_id = validate_name_segment(rule_id, "rule_id")
        return self.root / safe_id

    def _config_file(self, rule_id: str) -> Path:
        return self._rule_dir(rule_id) / "config.json"

    def _state_file(self, rule_id: str) -> Path:
        return self._rule_dir(rule_id) / "state.json"

    def _logs_file(self, rule_id: str) -> Path:
        return self._rule_dir(rule_id) / "logs.json"

    @staticmethod
    def _read_json(path: Path, default: Any) -> Any:
        try:
            with path.open("r", encoding="utf-8") as fp:
                return json.load(fp)
        except (OSError, json.JSONDecodeError):
            return default

    @staticmethod
    def _write_json(path: Path, value: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(f"{path.suffix}.{uuid.uuid4().hex}.tmp")
        with tmp.open("w", encoding="utf-8") as fp:
            json.dump(value, fp, ensure_ascii=False, indent=2)
        tmp.replace(path)

    def _io_lock(self, rule_id: str) -> asyncio.Lock:
        return self._io_locks.setdefault(rule_id, asyncio.Lock())

    def list_rules(self, account_name: Optional[str] = None) -> list[dict[str, Any]]:
        normalized_account = str(account_name or "").strip()
        rules: list[dict[str, Any]] = []
        if not self.root.exists():
            return rules
        for config_file in self.root.glob("*/config.json"):
            value = self._read_json(config_file, None)
            if not isinstance(value, dict):
                continue
            if normalized_account and value.get("account_name") != normalized_account:
                continue
            rules.append(value)
        rules.sort(
            key=lambda item: (
                str(item.get("group") or ""),
                str(item.get("name") or "").casefold(),
            )
        )
        return rules

    def get_rule(self, rule_id: str) -> Optional[dict[str, Any]]:
        value = self._read_json(self._config_file(rule_id), None)
        return value if isinstance(value, dict) else None

    @staticmethod
    def _normalize_reference(value: Any) -> str | int | None:
        text = str(value or "").strip()
        if not text:
            return None
        if text.lstrip("-").isdigit():
            return int(text)
        if text.startswith("@"):
            return text
        return text

    @classmethod
    def _validate_regex(cls, pattern: Any, field_name: str) -> str:
        value = str(pattern or "")
        if not value:
            raise ValueError(f"{field_name}不能为空")
        if len(value) > cls.MAX_REGEX_LENGTH:
            raise ValueError(f"{field_name}不能超过 {cls.MAX_REGEX_LENGTH} 个字符")
        try:
            re.compile(value)
        except re.error as exc:
            raise ValueError(f"{field_name}不是有效正则表达式: {exc}") from exc
        return value

    def validate_rule(
        self, raw: dict[str, Any], *, current_id: str = ""
    ) -> dict[str, Any]:
        if not isinstance(raw, dict):
            raise ValueError("自动化规则格式无效")
        name = str(raw.get("name") or "").strip()
        if not name or len(name) > 80:
            raise ValueError("规则名称长度必须为 1-80 个字符")
        account_name = self._validate_account_name(str(raw.get("account_name") or ""))
        group = str(raw.get("group") or "默认分组").strip()[:80] or "默认分组"
        triggers = raw.get("triggers")
        handlers = raw.get("handlers")
        if not isinstance(triggers, list) or not (
            1 <= len(triggers) <= self.MAX_TRIGGERS
        ):
            raise ValueError(f"触发器数量必须为 1-{self.MAX_TRIGGERS}")
        if not isinstance(handlers, list) or not (
            1 <= len(handlers) <= self.MAX_HANDLERS
        ):
            raise ValueError(f"动作数量必须为 1-{self.MAX_HANDLERS}")

        normalized_triggers: list[dict[str, Any]] = []
        for index, trigger in enumerate(triggers):
            if not isinstance(trigger, dict):
                raise ValueError(f"第 {index + 1} 个触发器格式无效")
            trigger_type = str(trigger.get("type") or "").strip().lower()
            if trigger_type not in SUPPORTED_TRIGGERS:
                raise ValueError(f"不支持的触发器: {trigger_type}")
            params = trigger.get("params") or {}
            if not isinstance(params, dict):
                raise ValueError(f"第 {index + 1} 个触发器参数无效")
            params = dict(params)
            trigger_id = str(trigger.get("id") or f"trigger_{index + 1}").strip()[:80]
            if trigger_type == "timer":
                cron = str(params.get("cron") or "").strip()
                interval = params.get("interval_seconds")
                if bool(cron) == bool(interval):
                    raise ValueError("定时触发器必须且只能配置 Cron 或间隔秒数")
                if cron:
                    from backend.scheduler import create_cron_trigger

                    try:
                        create_cron_trigger(cron)
                    except Exception as exc:
                        raise ValueError(f"Cron 表达式无效: {exc}") from exc
                else:
                    try:
                        interval = int(interval)
                    except (TypeError, ValueError) as exc:
                        raise ValueError("定时间隔必须是整数秒") from exc
                    if interval < 10 or interval > 86400 * 30:
                        raise ValueError("定时间隔必须在 10 秒到 30 天之间")
                    params["interval_seconds"] = interval
                try:
                    random_seconds = int(params.get("random_seconds") or 0)
                except (TypeError, ValueError) as exc:
                    raise ValueError("随机延迟必须是整数秒") from exc
                if random_seconds < 0 or random_seconds > 3600:
                    raise ValueError("随机延迟必须在 0-3600 秒之间")
                params["random_seconds"] = random_seconds
            normalized_triggers.append(
                {
                    "id": trigger_id or f"trigger_{index + 1}",
                    "type": trigger_type,
                    "params": params,
                }
            )

        filters_value = raw.get("filters") or None
        if filters_value is not None:
            if not isinstance(filters_value, dict):
                raise ValueError("过滤条件格式无效")
            filters_value = dict(filters_value)
            text_rule = str(filters_value.get("text_rule") or "all").lower()
            if text_rule not in {"all", "exact", "contains", "regex"}:
                raise ValueError("文本匹配方式无效")
            filters_value["text_rule"] = text_rule
            if (
                text_rule != "all"
                and not str(filters_value.get("text_value") or "").strip()
            ):
                raise ValueError("文本匹配值不能为空")
            if text_rule == "regex":
                self._validate_regex(filters_value.get("text_value"), "文本过滤正则")

        normalized_handlers: list[dict[str, Any]] = []
        for index, handler in enumerate(handlers):
            if not isinstance(handler, dict):
                raise ValueError(f"第 {index + 1} 个动作格式无效")
            name_value = str(handler.get("handler") or "").strip().lower()
            if name_value not in SUPPORTED_HANDLERS:
                raise ValueError(f"不支持的动作: {name_value}")
            params = handler.get("params") or {}
            if not isinstance(params, dict):
                raise ValueError(f"第 {index + 1} 个动作参数无效")
            params = dict(params)
            if name_value == "delay":
                try:
                    seconds = float(
                        params.get("seconds") or params.get("delay_seconds") or 0
                    )
                except (TypeError, ValueError) as exc:
                    raise ValueError("延迟秒数无效") from exc
                if seconds < 0 or seconds > self.MAX_DELAY_SECONDS:
                    raise ValueError(
                        f"单次延迟必须在 0-{int(self.MAX_DELAY_SECONDS)} 秒之间"
                    )
                params["seconds"] = seconds
            elif name_value == "extract_regex":
                self._validate_regex(params.get("pattern"), "提取正则")
            elif name_value in {"http_callback", "external_forward"}:
                targets = (
                    params.get("targets")
                    if name_value == "external_forward"
                    else [params]
                )
                if not isinstance(targets, list) or not targets:
                    raise ValueError("HTTP 回调目标不能为空")
                for target in targets:
                    if (
                        not isinstance(target, dict)
                        or str(target.get("type") or "http") != "http"
                    ):
                        raise ValueError("当前自动化面板仅允许安全的 HTTP(S) 外部回调")
                    validate_outbound_http_url(str(target.get("url") or ""))
            elif name_value == "ai_reply":
                prompt = str(params.get("prompt") or "").strip()
                if not prompt or len(prompt) > 4000:
                    raise ValueError("AI 系统提示词长度必须为 1-4000 个字符")
            elif name_value == "schedule_next":
                for field in (
                    "delay_seconds",
                    "delay_minutes",
                    "offset_seconds",
                    "offset_minutes",
                ):
                    if params.get(field) in (None, ""):
                        continue
                    try:
                        value = float(params[field])
                    except (TypeError, ValueError) as exc:
                        raise ValueError("下次执行延迟格式无效") from exc
                    if value < 0:
                        raise ValueError("下次执行延迟不能为负数")
            normalized_handlers.append({"handler": name_value, "params": params})

        values = raw.get("vars") or {}
        if not isinstance(values, dict) or len(values) > 100:
            raise ValueError("初始变量格式无效或数量过多")

        rule_id = current_id or str(raw.get("id") or uuid.uuid4().hex)
        return {
            "_version": 1,
            "id": validate_name_segment(rule_id, "rule_id"),
            "name": name,
            "account_name": account_name,
            "group": group,
            "enabled": bool(raw.get("enabled", True)),
            "drop_if_running": bool(raw.get("drop_if_running", True)),
            "triggers": normalized_triggers,
            "filters": filters_value,
            "handlers": normalized_handlers,
            "vars": values,
            "created_at": str(raw.get("created_at") or self._now()),
            "updated_at": self._now(),
        }

    async def create_rule(self, raw: dict[str, Any]) -> dict[str, Any]:
        if len(self.list_rules()) >= self.MAX_RULES:
            raise ValueError(f"自动化规则不能超过 {self.MAX_RULES} 条")
        rule = self.validate_rule(raw)
        if any(
            item.get("account_name") == rule["account_name"]
            and str(item.get("name") or "").casefold() == rule["name"].casefold()
            for item in self.list_rules()
        ):
            raise ValueError("当前账号下已存在同名自动化规则")
        self._write_json(self._config_file(rule["id"]), rule)
        await self.reload()
        return rule

    async def update_rule(self, rule_id: str, raw: dict[str, Any]) -> dict[str, Any]:
        current = self.get_rule(rule_id)
        if current is None:
            raise KeyError(rule_id)
        merged = {
            **current,
            **raw,
            "id": rule_id,
            "created_at": current.get("created_at"),
        }
        rule = self.validate_rule(merged, current_id=rule_id)
        if any(
            item.get("id") != rule_id
            and item.get("account_name") == rule["account_name"]
            and str(item.get("name") or "").casefold() == rule["name"].casefold()
            for item in self.list_rules()
        ):
            raise ValueError("当前账号下已存在同名自动化规则")
        self._write_json(self._config_file(rule_id), rule)
        await self.reload()
        return rule

    async def delete_rule(self, rule_id: str) -> bool:
        import shutil

        path = self._rule_dir(rule_id)
        if not path.exists():
            return False
        shutil.rmtree(path)
        self._io_locks.pop(rule_id, None)
        await self.reload()
        return True

    async def set_enabled(self, rule_id: str, enabled: bool) -> dict[str, Any]:
        current = self.get_rule(rule_id)
        if current is None:
            raise KeyError(rule_id)
        return await self.update_rule(rule_id, {**current, "enabled": enabled})

    def _load_state(self, rule_id: str) -> dict[str, Any]:
        value = self._read_json(self._state_file(rule_id), {})
        if not isinstance(value, dict):
            return {}
        values = value.get("values")
        return values if isinstance(values, dict) else {}

    async def _save_state(self, rule_id: str, values: dict[str, Any]) -> None:
        async with self._io_lock(rule_id):
            self._write_json(
                self._state_file(rule_id),
                {"_version": 1, "updated_at": self._now(), "values": values},
            )

    def get_state(self, rule_id: str) -> dict[str, Any]:
        if self.get_rule(rule_id) is None:
            raise KeyError(rule_id)
        return self._load_state(rule_id)

    async def clear_state(self, rule_id: str) -> None:
        if self.get_rule(rule_id) is None:
            raise KeyError(rule_id)
        await self._save_state(rule_id, {})

    async def _append_log(
        self,
        rule_id: str,
        level: str,
        message: str,
        *,
        trigger: str = "",
        context: Optional[dict[str, Any]] = None,
    ) -> None:
        entry = {
            "time": self._now(),
            "level": level.lower(),
            "trigger": trigger,
            "message": str(message)[:1000],
            "context": context or {},
        }
        async with self._io_lock(rule_id):
            value = self._read_json(
                self._logs_file(rule_id), {"_version": 1, "items": []}
            )
            items = value.get("items") if isinstance(value, dict) else []
            if not isinstance(items, list):
                items = []
            items.append(entry)
            self._write_json(
                self._logs_file(rule_id),
                {"_version": 1, "items": items[-self.MAX_LOG_ITEMS :]},
            )

    def get_logs(self, rule_id: str, limit: int = 200) -> list[dict[str, Any]]:
        if self.get_rule(rule_id) is None:
            raise KeyError(rule_id)
        value = self._read_json(self._logs_file(rule_id), {"items": []})
        items = value.get("items") if isinstance(value, dict) else []
        if not isinstance(items, list):
            return []
        return list(reversed(items[-max(1, min(limit, 1000)) :]))

    @staticmethod
    def _message_text(message: Optional[Message]) -> str:
        if message is None:
            return ""
        return str(
            getattr(message, "text", None) or getattr(message, "caption", None) or ""
        ).strip()

    @staticmethod
    def _identifier_matches(expected: Any, numeric_id: Any, username: Any) -> bool:
        expected_value = AutomationRuleService._normalize_reference(expected)
        if expected_value is None:
            return False
        if isinstance(expected_value, int):
            return str(numeric_id) == str(expected_value)
        return (
            str(username or "").lstrip("@").casefold()
            == str(expected_value).lstrip("@").casefold()
        )

    def _trigger_matches(self, trigger: dict[str, Any], message: Message) -> bool:
        params = trigger.get("params") or {}
        outgoing = bool(getattr(message, "outgoing", False))
        if outgoing and not bool(params.get("include_outgoing", False)):
            return False
        chat = getattr(message, "chat", None)
        chat_id = getattr(chat, "id", None)
        chat_username = getattr(chat, "username", None)
        expected_chats = params.get("chat_ids") or []
        if params.get("chat_id") not in (None, ""):
            expected_chats = [params.get("chat_id"), *expected_chats]
        if expected_chats and not any(
            self._identifier_matches(item, chat_id, chat_username)
            for item in expected_chats
        ):
            return False
        sender = getattr(message, "from_user", None)
        sender_id = getattr(sender, "id", None)
        sender_username = getattr(sender, "username", None)
        expected_senders = params.get("from_user_ids") or []
        if expected_senders and not any(
            self._identifier_matches(item, sender_id, sender_username)
            for item in expected_senders
        ):
            return False
        if params.get("reply_to_me"):
            replied = getattr(message, "reply_to_message", None)
            replied_sender = getattr(replied, "from_user", None)
            if not bool(getattr(replied_sender, "is_self", False)):
                return False
        reply_to_id = params.get("reply_to_message_id")
        if reply_to_id not in (None, ""):
            replied = getattr(message, "reply_to_message", None)
            if str(getattr(replied, "id", "")) != str(reply_to_id):
                return False
        return True

    def _filter_matches(
        self, filters_value: Optional[dict[str, Any]], message: Message
    ) -> tuple[bool, dict[str, Any]]:
        if not filters_value:
            return True, {}
        chat = getattr(message, "chat", None)
        sender = getattr(message, "from_user", None)
        chat_ids = filters_value.get("chat_ids") or []
        if filters_value.get("chat_id") not in (None, ""):
            chat_ids = [filters_value.get("chat_id"), *chat_ids]
        if chat_ids and not any(
            self._identifier_matches(
                item, getattr(chat, "id", None), getattr(chat, "username", None)
            )
            for item in chat_ids
        ):
            return False, {}
        sender_ids = filters_value.get("from_user_ids") or []
        if sender_ids and not any(
            self._identifier_matches(
                item, getattr(sender, "id", None), getattr(sender, "username", None)
            )
            for item in sender_ids
        ):
            return False, {}
        text_rule = str(filters_value.get("text_rule") or "all").lower()
        text_value = str(filters_value.get("text_value") or "")
        text = self._message_text(message)[:4000]
        ignore_case = bool(filters_value.get("ignore_case", True))
        compared_text = text.casefold() if ignore_case else text
        compared_value = text_value.casefold() if ignore_case else text_value
        if text_rule == "all":
            return True, {}
        if text_rule == "exact":
            return compared_text == compared_value, {}
        if text_rule == "contains":
            return compared_value in compared_text, {}
        flags = re.IGNORECASE if ignore_case else 0
        match = re.search(text_value, text, flags)
        if not match:
            return False, {}
        variables = {"match": match.group(0)}
        for index, value in enumerate(match.groups(), 1):
            variables[f"group{index}"] = value or ""
        variables.update({key: value or "" for key, value in match.groupdict().items()})
        return True, variables

    def _event_variables(
        self,
        rule: dict[str, Any],
        trigger: dict[str, Any],
        message: Optional[Message],
        matched: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        chat = getattr(message, "chat", None)
        sender = getattr(message, "from_user", None)
        params = trigger.get("params") or {}
        values = {
            **(rule.get("vars") or {}),
            **self._load_state(rule["id"]),
            "text": self._message_text(message),
            "chat_id": getattr(chat, "id", None) or params.get("chat_id") or "",
            "chat_title": getattr(chat, "title", None)
            or getattr(chat, "first_name", None)
            or "",
            "chat_username": getattr(chat, "username", None) or "",
            "message_id": getattr(message, "id", None) or "",
            "sender_id": getattr(sender, "id", None) or "",
            "sender_username": getattr(sender, "username", None) or "",
            "sender_name": " ".join(
                part
                for part in [
                    getattr(sender, "first_name", None),
                    getattr(sender, "last_name", None),
                ]
                if part
            ),
            "trigger_type": trigger.get("type") or "manual",
            "trigger_id": trigger.get("id") or "",
            "now": self._now(),
        }
        values.update(matched or {})
        return values

    @staticmethod
    def _template_value(value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, (dict, list)):
            return json.dumps(value, ensure_ascii=False)
        return str(value)

    def _render(self, value: Any, variables: dict[str, Any]) -> Any:
        if not isinstance(value, str):
            return value
        return _TEMPLATE_RE.sub(
            lambda match: self._template_value(
                variables.get(match.group(1), match.group(0))
            ),
            value,
        )

    def _render_object(self, value: Any, variables: dict[str, Any]) -> Any:
        if isinstance(value, dict):
            return {
                key: self._render_object(item, variables) for key, item in value.items()
            }
        if isinstance(value, list):
            return [self._render_object(item, variables) for item in value]
        return self._render(value, variables)

    @staticmethod
    def _target_chat(
        params: dict[str, Any], variables: dict[str, Any]
    ) -> str | int | None:
        value = (
            params.get("chat_id")
            or params.get("to_chat_id")
            or variables.get("chat_id")
        )
        return AutomationRuleService._normalize_reference(value)

    def _get_ai_tools(self):
        from tg_signer.ai_tools import AITools, OpenAIConfigManager

        for workdir in (
            self.settings.resolve_session_dir(),
            self.settings.resolve_workdir(),
        ):
            config = OpenAIConfigManager(workdir).load_config()
            if config:
                return AITools(config)
        raise RuntimeError("未配置可用的 AI 服务")

    async def _http_callback(
        self,
        params: dict[str, Any],
        variables: dict[str, Any],
        message: Optional[Message],
    ) -> None:
        url = validate_outbound_http_url(str(params.get("url") or ""))
        method = str(params.get("method") or "post").lower()
        if method not in {"post", "put", "patch"}:
            raise ValueError("HTTP 回调仅支持 POST/PUT/PATCH")
        headers = params.get("headers") or {}
        if not isinstance(headers, dict) or len(headers) > 30:
            raise ValueError("HTTP 请求头格式无效")
        payload = params.get("payload")
        if payload is None:
            payload = {
                "text": self._message_text(message),
                "chat_id": variables.get("chat_id"),
                "message_id": variables.get("message_id"),
                "sender_id": variables.get("sender_id"),
                "vars": variables,
            }
        payload = self._render_object(payload, variables)
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except json.JSONDecodeError as exc:
                raise ValueError("HTTP JSON 请求体格式无效") from exc
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            response = await client.request(
                method,
                url,
                headers={str(k): str(v) for k, v in headers.items()},
                json=payload,
            )
            response.raise_for_status()

    async def _execute_handler(
        self,
        rule: dict[str, Any],
        handler: dict[str, Any],
        client: Any,
        message: Optional[Message],
        variables: dict[str, Any],
    ) -> str:
        name = handler["handler"]
        params = self._render_object(handler.get("params") or {}, variables)
        if name in {"send_text", "reply_text"}:
            text = str(params.get("text") or "")
            target = self._target_chat(params, variables)
            if not text or target is None:
                raise ValueError("发送文本需要目标会话和内容")
            reply_to = params.get("reply_to_message_id")
            if name == "reply_text" and not reply_to:
                reply_to = variables.get("message_id")
            sent = await client.send_message(
                target, text, reply_to_message_id=reply_to or None
            )
            delete_after = float(params.get("delete_after") or 0)
            if delete_after >= 0 and params.get("delete_after") not in (None, ""):

                async def _delete_later() -> None:
                    if delete_after:
                        await asyncio.sleep(min(delete_after, self.MAX_DELAY_SECONDS))
                    try:
                        await sent.delete()
                    except Exception:
                        pass

                task = asyncio.create_task(_delete_later())
                self._track_task(task)
        elif name == "extract_regex":
            source = str(params.get("text") or variables.get("text") or "")[:4000]
            pattern = self._validate_regex(params.get("pattern"), "提取正则")
            match = re.search(
                pattern, source, re.IGNORECASE if params.get("ignore_case", True) else 0
            )
            if not match:
                return "stop" if params.get("required", True) else "continue"
            var_name = str(params.get("var") or "extracted")
            value = next(
                (item for item in match.groups() if item is not None), match.group(0)
            )
            variables[var_name] = value
            for index, item in enumerate(match.groups(), 1):
                variables[f"group{index}"] = item or ""
            variables.update(
                {key: value or "" for key, value in match.groupdict().items()}
            )
        elif name == "ai_reply":
            prompt = str(params.get("prompt") or "")
            query = str(params.get("query") or variables.get("text") or "")
            answer = str(
                await self._get_ai_tools().get_reply(prompt, query) or ""
            ).strip()
            variables[str(params.get("var") or "ai_reply")] = answer
            if params.get("send", True):
                target = self._target_chat(params, variables)
                if target is None:
                    raise ValueError("AI 回复缺少目标会话")
                reply_to = (
                    variables.get("message_id") if params.get("reply", True) else None
                )
                await client.send_message(
                    target, answer, reply_to_message_id=reply_to or None
                )
        elif name == "blacklist_filter":
            source = str(params.get("text") or variables.get("text") or "")
            values = params.get("values") or params.get("items") or []
            if isinstance(values, str):
                values = re.split(r"[\n,，]+", values)
            compared = source.casefold() if params.get("ignore_case", True) else source
            if any(
                (str(item).casefold() if params.get("ignore_case", True) else str(item))
                in compared
                for item in values
                if str(item)
            ):
                return "stop"
        elif name == "delay":
            seconds = min(
                max(float(params.get("seconds") or 0), 0), self.MAX_DELAY_SECONDS
            )
            if seconds:
                await asyncio.sleep(seconds)
        elif name == "forward":
            if message is None:
                raise ValueError("转发动作只能由消息触发")
            target = self._target_chat(params, variables)
            if target is None:
                raise ValueError("转发动作缺少目标会话")
            await client.forward_messages(
                target,
                params.get("from_chat_id") or variables.get("chat_id"),
                params.get("message_id") or variables.get("message_id"),
            )
        elif name == "http_callback":
            await self._http_callback(params, variables, message)
        elif name == "external_forward":
            for target in params.get("targets") or []:
                if (
                    isinstance(target, dict)
                    and str(target.get("type") or "http") == "http"
                ):
                    await self._http_callback(target, variables, message)
        elif name == "server_chan":
            from tg_signer.notification.server_chan import sc_send

            send_key = str(params.get("send_key") or "")
            if not send_key:
                raise ValueError("Server 酱 SendKey 不能为空")
            await sc_send(
                send_key,
                str(params.get("title") or "Automation"),
                str(params.get("body") or variables.get("text") or ""),
            )
        elif name == "schedule_next":
            delay_seconds: Any = params.get("delay_seconds")
            if delay_seconds in (None, ""):
                delay_seconds = float(params.get("delay_minutes") or 0) * 60
            from_var = str(params.get("from_var") or "").strip()
            if from_var:
                delay_seconds = float(variables.get(from_var, delay_seconds) or 0)
                unit = str(params.get("from_var_unit") or "seconds").strip().lower()
                if unit in {"minute", "minutes", "min", "m"}:
                    delay_seconds *= 60
            offset_seconds: Any = params.get("offset_seconds")
            if offset_seconds in (None, ""):
                offset_seconds = float(params.get("offset_minutes") or 0) * 60
            total_seconds = float(delay_seconds or 0) + float(offset_seconds or 0)
            if total_seconds <= 0 or total_seconds > 86400 * 30:
                raise ValueError("下次执行延迟必须在 0 秒到 30 天之间")
            target_trigger_id = str(
                params.get("trigger_id") or params.get("target_trigger_id") or ""
            )
            if not target_trigger_id:
                current_trigger_id = str(variables.get("trigger_id") or "")
                if any(
                    trigger.get("type") == "timer"
                    and str(trigger.get("id") or "") == current_trigger_id
                    for trigger in rule.get("triggers") or []
                ):
                    target_trigger_id = current_trigger_id
            timer_index = next(
                (
                    index
                    for index, trigger in enumerate(rule.get("triggers") or [])
                    if trigger.get("type") == "timer"
                    and (
                        not target_trigger_id
                        or str(trigger.get("id") or "") == target_trigger_id
                    )
                ),
                None,
            )
            if timer_index is None:
                raise ValueError("未找到可调整的定时触发器")
            target_trigger = rule["triggers"][timer_index]
            target_trigger_id = str(
                target_trigger.get("id") or f"trigger_{timer_index + 1}"
            )
            next_at = datetime.now(timezone.utc) + timedelta(seconds=total_seconds)
            from backend import scheduler as scheduler_module

            workspace = get_workspace_context()
            if workspace is None:
                raise ValueError("工作区上下文不可用")
            scheduler_module.scheduler.modify_job(
                f"automation-{workspace.user_id}-{rule['id']}-{timer_index}",
                next_run_time=next_at,
            )
            state = self._load_state(rule["id"])
            trigger_state = state.setdefault("_triggers", {}).setdefault(
                target_trigger_id, {}
            )
            trigger_state["next_run_at"] = next_at.isoformat()
            await self._save_state(rule["id"], state)
            variables["next_run_at"] = next_at.isoformat()
        elif name == "store_state":
            key = str(params.get("key") or "").strip()
            if not key:
                raise ValueError("状态键不能为空")
            state = self._load_state(rule["id"])
            state[key] = params.get(
                "value", variables.get(str(params.get("from_var") or key), "")
            )
            await self._save_state(rule["id"], state)
            variables[key] = state[key]
        elif name == "load_state":
            key = str(params.get("key") or "").strip()
            target_var = str(params.get("var") or key).strip()
            variables[target_var] = self._load_state(rule["id"]).get(
                key, params.get("default", "")
            )
        elif name == "random_pick":
            items = params.get("items") or []
            if not isinstance(items, list) or not items:
                raise ValueError("随机选择候选项不能为空")
            variables[str(params.get("var") or "picked")] = random.choice(items)
        return "continue"

    def _track_task(self, task: asyncio.Task) -> None:
        self._execution_tasks.add(task)
        task.add_done_callback(self._execution_tasks.discard)

    async def execute(
        self,
        rule_id: str,
        *,
        trigger_type: str = "manual",
        trigger_index: Optional[int] = None,
        client: Any = None,
        message: Optional[Message] = None,
        matched: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        rule = self.get_rule(rule_id)
        if rule is None:
            raise KeyError(rule_id)
        if trigger_index is not None:
            triggers = rule.get("triggers") or []
            if trigger_index < 0 or trigger_index >= len(triggers):
                raise ValueError("触发器索引无效")
            trigger = triggers[trigger_index]
        else:
            trigger = next(
                (
                    item
                    for item in rule.get("triggers") or []
                    if item.get("type") == trigger_type
                ),
                {"id": "manual", "type": trigger_type, "params": {}},
            )
        running = self._running_counts.get(rule_id, 0)
        if running and rule.get("drop_if_running", True):
            await self._append_log(
                rule_id, "warning", "规则正在运行，本次触发已跳过", trigger=trigger_type
            )
            return {"success": False, "skipped": True, "message": "规则正在运行"}
        self._running_counts[rule_id] = running + 1
        started_at = self._now()
        context_info = {
            "chat_id": str(getattr(getattr(message, "chat", None), "id", "") or ""),
            "message_id": str(getattr(message, "id", "") or ""),
        }
        await self._append_log(
            rule_id, "info", "开始执行规则", trigger=trigger_type, context=context_info
        )

        async def _run(active_client: Any) -> dict[str, Any]:
            variables = self._event_variables(rule, trigger, message, matched)
            for index, handler in enumerate(rule.get("handlers") or []):
                name = str(handler.get("handler") or "")
                try:
                    result = await self._execute_handler(
                        rule, handler, active_client, message, variables
                    )
                    await self._append_log(
                        rule_id,
                        "info",
                        f"动作 {index + 1} · {name} 执行完成",
                        trigger=trigger_type,
                    )
                    if result != "continue":
                        await self._append_log(
                            rule_id,
                            "info",
                            f"动作链由 {name} 终止",
                            trigger=trigger_type,
                        )
                        break
                except Exception as exc:
                    await self._append_log(
                        rule_id,
                        "error",
                        f"动作 {index + 1} · {name} 失败：{exc}",
                        trigger=trigger_type,
                    )
                    raise
            return {
                "success": True,
                "started_at": started_at,
                "finished_at": self._now(),
                "vars": variables,
            }

        try:
            params = trigger.get("params") or {}
            random_seconds = int(params.get("random_seconds") or 0)
            if random_seconds > 0:
                await asyncio.sleep(random.uniform(0, random_seconds))
            if client is not None:
                result = await _run(client)
            else:
                active_client = self._build_client(rule["account_name"])
                async with get_account_lock(rule["account_name"]):
                    await active_client.__aenter__()
                try:
                    result = await _run(active_client)
                finally:
                    async with get_account_lock(rule["account_name"]):
                        await active_client.__aexit__(None, None, None)
            await self._append_log(
                rule_id, "success", "规则执行成功", trigger=trigger_type
            )
            return result
        except Exception as exc:
            await self._append_log(
                rule_id, "error", f"规则执行失败：{exc}", trigger=trigger_type
            )
            return {
                "success": False,
                "error": str(exc),
                "started_at": started_at,
                "finished_at": self._now(),
            }
        finally:
            count = self._running_counts.get(rule_id, 1) - 1
            if count > 0:
                self._running_counts[rule_id] = count
            else:
                self._running_counts.pop(rule_id, None)

    async def run_manual(self, rule_id: str) -> dict[str, Any]:
        return await self.execute(rule_id, trigger_type="manual")

    async def _on_message(
        self, account_name: str, client: Any, message: Message, event_type: str
    ) -> None:
        if len(self._execution_tasks) >= self.MAX_ACTIVE_EXECUTIONS:
            logger.warning("Automation execution queue is full; dropping message event")
            return
        for rule in self._message_rules.get(account_name, []):
            if not rule.get("enabled", True):
                continue
            for index, trigger in enumerate(rule.get("triggers") or []):
                if trigger.get("type") != "message" or not self._trigger_matches(
                    trigger, message
                ):
                    continue
                matched_ok, matched = self._filter_matches(rule.get("filters"), message)
                if not matched_ok:
                    continue
                task = asyncio.create_task(
                    self.execute(
                        rule["id"],
                        trigger_type=event_type,
                        trigger_index=index,
                        client=client,
                        message=message,
                        matched=matched,
                    )
                )
                self._track_task(task)

    async def _stop_listeners(self) -> None:
        for account_name, client, handler_ref in self._handler_refs:
            async with get_account_lock(account_name):
                try:
                    client.remove_handler(*handler_ref)
                except Exception:
                    pass
        for account_name, client in self._active_clients.items():
            async with get_account_lock(account_name):
                try:
                    await client.__aexit__(None, None, None)
                except Exception:
                    pass
        self._handler_refs = []
        self._active_clients = {}
        self._message_rules = {}

    async def start(self, *, run_startup: bool = False) -> None:
        async with self._lifecycle_lock:
            await self._stop_listeners()
            enabled = [item for item in self.list_rules() if item.get("enabled", True)]
            message_rules = [
                item
                for item in enabled
                if any(
                    trigger.get("type") == "message"
                    for trigger in item.get("triggers") or []
                )
            ]
            for rule in message_rules:
                self._message_rules.setdefault(rule["account_name"], []).append(rule)
            for account_name in sorted(self._message_rules):
                client = self._build_client(account_name, no_updates=False)

                async def on_message(
                    _client: Any, message: Message, name: str = account_name
                ) -> None:
                    await self._on_message(name, _client, message, "message")

                async def on_edited(
                    _client: Any, message: Message, name: str = account_name
                ) -> None:
                    await self._on_message(name, _client, message, "edited_message")

                refs = [
                    client.add_handler(
                        MessageHandler(on_message, filters.incoming | filters.outgoing)
                    ),
                    client.add_handler(
                        EditedMessageHandler(
                            on_edited, filters.incoming | filters.outgoing
                        )
                    ),
                ]
                try:
                    async with get_account_lock(account_name):
                        await asyncio.wait_for(client.__aenter__(), timeout=20)
                except Exception as exc:
                    for ref in refs:
                        try:
                            client.remove_handler(*ref)
                        except Exception:
                            pass
                    logger.warning(
                        "Automation listener failed for %s: %s", account_name, exc
                    )
                    for rule in self._message_rules[account_name]:
                        await self._append_log(
                            rule["id"],
                            "error",
                            "消息监听启动失败，请检查账号登录、代理和 Telegram API 配置",
                        )
                    continue
                for ref in refs:
                    self._handler_refs.append((account_name, client, ref))
                self._active_clients[account_name] = client
                for rule in self._message_rules[account_name]:
                    await self._append_log(rule["id"], "info", "消息监听已启动")
            await self.sync_schedules()

        if run_startup:
            for rule in enabled:
                for index, trigger in enumerate(rule.get("triggers") or []):
                    if trigger.get("type") == "startup":
                        task = asyncio.create_task(
                            self.execute(
                                rule["id"], trigger_type="startup", trigger_index=index
                            )
                        )
                        self._track_task(task)

    async def reload(self) -> None:
        await self.start(run_startup=False)

    async def stop(self) -> None:
        async with self._lifecycle_lock:
            await self._stop_listeners()
            tasks = list(self._execution_tasks)
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            self._execution_tasks.clear()
            self._running_counts.clear()

    async def sync_schedules(self) -> None:
        from apscheduler.triggers.interval import IntervalTrigger

        from backend import scheduler as scheduler_module
        from backend.scheduler import (
            _job_run_automation_rule,
            create_cron_trigger,
            get_scheduler_timezone,
        )

        active_scheduler = scheduler_module.scheduler
        if active_scheduler is None:
            return
        workspace = get_workspace_context()
        if workspace is None:
            return
        user_id = workspace.user_id
        existing = {
            job.id
            for job in active_scheduler.get_jobs()
            if job.id.startswith(f"automation-{user_id}-")
        }
        desired: set[str] = set()
        for rule in self.list_rules():
            if not rule.get("enabled", True):
                continue
            for index, trigger in enumerate(rule.get("triggers") or []):
                if trigger.get("type") != "timer":
                    continue
                job_id = f"automation-{user_id}-{rule['id']}-{index}"
                desired.add(job_id)
                params = trigger.get("params") or {}
                cron = str(params.get("cron") or "").strip()
                if cron:
                    schedule_trigger = create_cron_trigger(cron)
                else:
                    schedule_trigger = IntervalTrigger(
                        seconds=int(params["interval_seconds"]),
                        timezone=get_scheduler_timezone(),
                    )
                next_run_time = None
                trigger_id = str(trigger.get("id") or f"trigger_{index + 1}")
                raw_next_run = (
                    self._load_state(rule["id"])
                    .get("_triggers", {})
                    .get(trigger_id, {})
                    .get("next_run_at")
                )
                if raw_next_run:
                    try:
                        parsed_next_run = datetime.fromisoformat(str(raw_next_run))
                        if parsed_next_run > datetime.now(timezone.utc):
                            next_run_time = parsed_next_run
                    except (TypeError, ValueError):
                        pass
                schedule_options = (
                    {"next_run_time": next_run_time} if next_run_time else {}
                )
                active_scheduler.add_job(
                    _job_run_automation_rule,
                    trigger=schedule_trigger,
                    id=job_id,
                    args=[user_id, rule["id"], index],
                    replace_existing=True,
                    **schedule_options,
                )
        for job_id in existing - desired:
            active_scheduler.remove_job(job_id)

    def get_status(self, rule_id: str) -> dict[str, Any]:
        rule = self.get_rule(rule_id)
        if rule is None:
            raise KeyError(rule_id)
        scheduled: list[dict[str, Any]] = []
        try:
            from backend import scheduler as scheduler_module

            if scheduler_module.scheduler is not None:
                workspace = get_workspace_context()
                if workspace is not None:
                    prefix = f"automation-{workspace.user_id}-{rule_id}-"
                    for job in scheduler_module.scheduler.get_jobs():
                        if job.id.startswith(prefix):
                            scheduled.append(
                                {
                                    "id": job.id,
                                    "next_run_time": (
                                        job.next_run_time.isoformat()
                                        if job.next_run_time
                                        else None
                                    ),
                                }
                            )
        except Exception:
            pass
        listener_active = any(
            account == rule.get("account_name")
            for account, _client, _ref in self._handler_refs
        ) and any(
            trigger.get("type") == "message" for trigger in rule.get("triggers") or []
        )
        logs = self.get_logs(rule_id, 1)
        return {
            "enabled": bool(rule.get("enabled", True)),
            "running": self._running_counts.get(rule_id, 0) > 0,
            "listener_active": listener_active,
            "scheduled_jobs": scheduled,
            "last_log": logs[0] if logs else None,
        }


_automation_rule_services: dict[str, AutomationRuleService] = {}


def get_automation_rule_service() -> AutomationRuleService:
    key = get_workspace_key()
    if key not in _automation_rule_services:
        _automation_rule_services[key] = AutomationRuleService()
    return _automation_rule_services[key]
