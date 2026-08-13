import asyncio
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from zipfile import ZipFile

import httpx
import pytest
from starlette.requests import Request


def test_account_store_concurrent_updates_keep_all_accounts(monkeypatch, tmp_path):
    from backend.utils import tg_session

    store_path = tmp_path / "accounts.json"
    monkeypatch.setattr(tg_session, "_account_store_path", lambda: store_path)

    def update(index: int) -> None:
        account = f"account-{index}"
        tg_session.set_account_session_string(account, f"session-{index}")
        tg_session.set_account_profile(account, remark=f"remark-{index}")
        tg_session.set_account_status(account, status="connected")

    with ThreadPoolExecutor(max_workers=12) as executor:
        list(executor.map(update, range(40)))

    data = json.loads(store_path.read_text(encoding="utf-8"))["accounts"]
    assert len(data) == 40
    for index in range(40):
        entry = data[f"account-{index}"]
        assert entry["session_string"] == f"session-{index}"
        assert entry["remark"] == f"remark-{index}"
        assert entry["status"] == "connected"


def test_invalid_session_cleanup_keeps_account_profile(monkeypatch, tmp_path):
    from backend.services import telegram
    from backend.utils import tg_session

    store_path = tmp_path / "accounts.json"
    monkeypatch.setattr(tg_session, "_account_store_path", lambda: store_path)
    monkeypatch.setattr(telegram, "is_string_session_mode", lambda: False)

    tg_session.set_account_session_string("account-a", "expired-session")
    tg_session.set_account_profile(
        "account-a", remark="保留备注", proxy="socks5://127.0.0.1:1080"
    )

    service = object.__new__(telegram.TelegramService)
    service.session_dir = tmp_path
    service._accounts_cache = None

    async def close_client(*args, **kwargs):
        return None

    monkeypatch.setattr("tg_signer.core.close_client_by_name", close_client)
    asyncio.run(service.invalidate_account_session("account-a"))

    profile = tg_session.get_account_profile("account-a")
    assert tg_session.get_account_session_string("account-a") is None
    assert profile["remark"] == "保留备注"
    assert profile["proxy"] == "socks5://127.0.0.1:1080"
    assert profile["needs_relogin"] is True

    accounts = service.list_accounts(force_refresh=True)
    assert [(item["name"], item["needs_relogin"]) for item in accounts] == [
        ("account-a", True)
    ]


def _request_with_ip(headers=None) -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/auth/login",
            "headers": headers or [],
            "client": ("127.0.0.1", 12345),
        }
    )


def test_login_rate_limit_ignores_untrusted_proxy_headers(monkeypatch):
    from backend.api.routes import auth

    monkeypatch.delenv("APP_TRUST_PROXY_HEADERS", raising=False)
    request = _request_with_ip([(b"x-forwarded-for", b"203.0.113.10")])

    assert auth._client_ip(request) == "127.0.0.1"


def test_login_rate_limit_uses_proxy_headers_only_when_enabled(monkeypatch):
    from backend.api.routes import auth

    monkeypatch.setenv("APP_TRUST_PROXY_HEADERS", "true")
    request = _request_with_ip([(b"x-forwarded-for", b"203.0.113.10")])

    assert auth._client_ip(request) == "203.0.113.10"


def test_telegram_http_error_does_not_expose_bot_token():
    from backend.services.push_notifications import _raise_sanitized_http_error

    token = "SECRET_BOT_TOKEN"
    request = httpx.Request("POST", f"https://api.telegram.org/bot{token}/sendMessage")
    response = httpx.Response(401, request=request)

    with pytest.raises(RuntimeError) as caught:
        _raise_sanitized_http_error("Telegram Bot API", response)

    assert token not in str(caught.value)
    assert "HTTP 401" in str(caught.value)


def test_outbound_url_blocks_private_addresses_by_default(monkeypatch):
    from backend.utils.outbound_url import validate_outbound_http_url

    monkeypatch.delenv("APP_ALLOW_PRIVATE_OUTBOUND_URLS", raising=False)

    with pytest.raises(ValueError, match="非公网地址"):
        validate_outbound_http_url("http://127.0.0.1:8080/hook")


def test_outbound_url_allows_explicit_trusted_private_target(monkeypatch):
    from backend.utils.outbound_url import validate_outbound_http_url

    monkeypatch.setenv("APP_ALLOW_PRIVATE_OUTBOUND_URLS", "true")

    assert (
        validate_outbound_http_url("http://127.0.0.1:8080/hook")
        == "http://127.0.0.1:8080/hook"
    )


def test_task_log_handler_filters_other_tasks():
    from backend.services.sign_tasks import TaskLogHandler

    logs = []
    handler = TaskLogHandler(logs, "account-a", "task-a")
    handler.setFormatter(logging.Formatter("%(message)s"))

    own_record = logging.LogRecord(
        "tg-flowpulse",
        logging.INFO,
        __file__,
        1,
        "账户「account-a」- 任务「task-a」: own",
        (),
        None,
    )
    other_record = logging.LogRecord(
        "tg-flowpulse",
        logging.INFO,
        __file__,
        1,
        "账户「account-b」- 任务「task-b」: other",
        (),
        None,
    )
    handler.emit(own_record)
    handler.emit(other_record)

    assert logs == ["账户「account-a」- 任务「task-a」: own"]


def test_single_task_import_forces_requested_task_kind(tmp_path):
    from backend.services.config import ConfigService

    service = object.__new__(ConfigService)
    service.workdir = tmp_path
    service.signs_dir = tmp_path / "signs"
    service.monitors_dir = tmp_path / "monitors"
    service.signs_dir.mkdir()
    service.monitors_dir.mkdir()

    payload = json.dumps(
        {
            "task_name": "same-name",
            "config": {
                "account_name": "account-a",
                "task_kind": "sign",
                "sign_at": "0 0 * * *",
                "chats": [],
            },
        }
    )

    assert service.import_sign_task(
        payload,
        account_name="account-a",
        task_kind="broadcast",
    )
    saved = json.loads(
        (service.signs_dir / "account-a" / "same-name" / "config.json").read_text(
            encoding="utf-8"
        )
    )
    assert saved["task_kind"] == "broadcast"


def test_task_kind_match_rejects_cross_kind_access():
    from backend.api.routes.sign_tasks import _matches_task_kind

    assert _matches_task_kind({"task_kind": "sign"}, "sign") is True
    assert _matches_task_kind({"task_kind": "broadcast"}, "sign") is False
    assert _matches_task_kind({"task_kind": "sign"}, "broadcast") is False


def test_xlsx_external_hyperlink_is_clickable_and_styled():
    from backend.utils.xlsx_export import ExternalHyperlink, build_xlsx_bytes

    workbook = build_xlsx_bytes(
        ["链接"],
        [[ExternalHyperlink("https://example.com/path?a=1&b=2", "打开网站")]],
    )

    with ZipFile(BytesIO(workbook)) as archive:
        sheet = archive.read("xl/worksheets/sheet1.xml").decode("utf-8")
        rels = archive.read("xl/worksheets/_rels/sheet1.xml.rels").decode("utf-8")
        styles = archive.read("xl/styles.xml").decode("utf-8")

    assert (
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
        in sheet
    )
    assert '<c r="A2" s="1" t="inlineStr">' in sheet
    assert '<hyperlink ref="A2" r:id="rId1"/>' in sheet
    assert 'Target="https://example.com/path?a=1&amp;b=2"' in rels
    assert "<u/>" in styles


def test_speaker_collection_export_has_only_clickable_website_columns(monkeypatch):
    from backend.api.routes import speaker_collection

    records = [
        {
            "sender": "User",
            "sender_username": "user",
            "sender_id": "1",
            "profile_url": "https://t.me/user",
            "bio": "bio",
            "websites": ["https://one.example", "https://two.example"],
            "matched_keywords": [],
            "message_count": 1,
        }
    ]
    service = SimpleNamespace(get_records=lambda *_args: records)
    monkeypatch.setattr(
        speaker_collection, "get_speaker_collection_service", lambda: service
    )

    response = speaker_collection.export_records("task", current_user=SimpleNamespace())

    with ZipFile(BytesIO(response.body)) as archive:
        sheet = archive.read("xl/worksheets/sheet1.xml").decode("utf-8")
        rels = archive.read("xl/worksheets/_rels/sheet1.xml.rels").decode("utf-8")

    assert ">网站<" not in sheet
    assert "网站链接 1" in sheet
    assert "网站链接 2" in sheet
    assert "https://t.me/user" in sheet
    assert "https://one.example" in sheet
    assert "https://two.example" in sheet
    assert "打开个人主页" not in sheet
    assert "打开网站" not in sheet
    assert rels.count("relationships/hyperlink") == 3


def test_create_task_detects_directory_created_during_race(monkeypatch, tmp_path):
    from backend.services.sign_tasks import SignTaskService

    service = object.__new__(SignTaskService)
    service.signs_dir = tmp_path / "signs"
    service.signs_dir.mkdir()
    task_dir = service.signs_dir / "account-a" / "same-name"
    task_dir.mkdir(parents=True)
    monkeypatch.setattr(service, "_resolve_task_dir", lambda *_args: None)

    with pytest.raises(ValueError, match="已存在"):
        service.create_task(
            task_name="same-name",
            account_name="account-a",
            sign_at="0 0 * * *",
            chats=[],
        )


@pytest.mark.asyncio
async def test_update_difference_failure_is_not_reported_as_empty(monkeypatch):
    from pyrogram import raw

    from tg_signer import core

    async def fail(*_args, **_kwargs):
        raise asyncio.TimeoutError("network timeout")

    async def no_wait(_seconds):
        return None

    monkeypatch.setattr(core, "_original_invoke", fail)
    monkeypatch.setattr(core.asyncio, "sleep", no_wait)
    query = raw.functions.updates.GetDifference(pts=1, date=2, qts=3)

    with pytest.raises(asyncio.TimeoutError):
        await core._patched_invoke(SimpleNamespace(), query)


@pytest.mark.asyncio
async def test_login_discovers_forum_topics_via_client(monkeypatch, tmp_path):
    from pyrogram.enums import ChatType

    from tg_signer import core

    topic_calls = []
    chat = SimpleNamespace(
        id=-100123,
        title="Forum",
        type=ChatType.SUPERGROUP,
        username="forum",
        first_name=None,
        last_name=None,
        is_forum=True,
    )
    user = SimpleNamespace(id=42)

    class FakeApp:
        key = "forum-login-test"

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get_me(self):
            return user

        async def get_dialogs(self, limit):
            assert limit == 20
            yield SimpleNamespace(chat=chat)

        async def get_forum_topics(self, chat_id, limit):
            topic_calls.append((chat_id, limit))
            yield SimpleNamespace(
                id=7,
                title="Topic",
                is_closed=False,
                is_pinned=False,
            )

        async def save_session_string(self):
            return None

    class Worker(core.BaseUserWorker):
        def __init__(self):
            self.app = FakeApp()
            self._account = "account"
            self.task_name = "task"
            self.user = None

        def get_user_dir(self, _user):
            path = Path(tmp_path) / "users" / "42"
            path.mkdir(parents=True, exist_ok=True)
            return path

        def set_me(self, value):
            self.user = value

    core._LOGIN_USERS.pop(FakeApp.key, None)
    core._LOGIN_ASYNC_LOCKS.pop(FakeApp.key, None)
    core._API_ASYNC_LOCKS.pop(FakeApp.key, None)
    core._API_LAST_CALL_AT.pop(FakeApp.key, None)
    monkeypatch.setattr(core, "print_to_user", lambda _message: None)

    worker = Worker()
    await worker.login(print_chat=True)

    assert worker.user is user
    assert topic_calls == [(-100123, 20)]


def test_speaker_collection_reports_time_window_statuses():
    from backend.services.speaker_collection import SpeakerCollectionService

    service = object.__new__(SpeakerCollectionService)
    now = datetime.now(timezone.utc)

    assert (
        service._config_with_status({"continuous": False})["monitor_status"]
        == "one_time"
    )
    assert (
        service._config_with_status({"continuous": True, "enabled": True})[
            "monitor_status"
        ]
        == "running"
    )
    assert (
        service._config_with_status(
            {
                "continuous": True,
                "enabled": True,
                "start_at": (now + timedelta(minutes=5)).isoformat(),
            }
        )["monitor_status"]
        == "waiting"
    )
    assert (
        service._config_with_status(
            {
                "continuous": True,
                "enabled": True,
                "end_at": (now - timedelta(minutes=5)).isoformat(),
            }
        )["monitor_status"]
        == "completed"
    )


@pytest.mark.asyncio
async def test_speaker_collection_worker_stops_at_end_time():
    from backend.services.speaker_collection import SpeakerCollectionService

    service = object.__new__(SpeakerCollectionService)
    config = {
        "id": "expired-task",
        "continuous": True,
        "enabled": True,
        "end_at": (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat(),
    }
    service._data = {"configs": {config["id"]: config}, "records": {}}
    completed = []

    async def complete_monitor(current):
        completed.append(current["id"])

    service._complete_monitor = complete_monitor

    await service._worker(config["id"])

    assert completed == [config["id"]]


@pytest.mark.asyncio
async def test_speaker_collection_can_pause_and_resume_continuous_task():
    from backend.services.speaker_collection import SpeakerCollectionService

    service = object.__new__(SpeakerCollectionService)
    service._lock = asyncio.Lock()
    service._data = {
        "configs": {
            "task": {
                "id": "task",
                "continuous": True,
                "enabled": True,
                "start_at": None,
                "end_at": None,
            }
        },
        "records": {},
    }
    service._save = lambda: None
    synced = []

    async def sync_worker(config):
        synced.append(config["enabled"])

    service._sync_worker = sync_worker

    paused = await service.set_enabled("task", False)
    resumed = await service.set_enabled("task", True)

    assert paused["monitor_status"] == "paused"
    assert resumed["monitor_status"] == "running"
    assert synced == [False, True]


@pytest.mark.asyncio
async def test_continuous_speaker_collection_only_scans_new_messages():
    from backend.services.speaker_collection import SpeakerCollectionService

    now = datetime.now(timezone.utc)
    user = SimpleNamespace(
        id=42,
        first_name="Speaker",
        last_name="",
        username="speaker",
        is_bot=False,
        bio="公开简介",
    )
    chat = SimpleNamespace(id=-1001, title="Group")

    def message(message_id):
        return SimpleNamespace(
            id=message_id,
            date=now + timedelta(seconds=message_id),
            from_user=user,
            chat=chat,
            text=f"message-{message_id}",
            caption=None,
        )

    class FakeClient:
        def __init__(self):
            self.messages = [message(3), message(2), message(1)]

        async def get_chat_history(self, _chat_ref, limit):
            for item in self.messages[:limit]:
                yield item

        async def get_chat(self, _user_id):
            return user

    client = FakeClient()
    service = object.__new__(SpeakerCollectionService)
    service._lock = asyncio.Lock()
    service._scan_locks = {}
    service._data = {
        "configs": {
            "task": {
                "id": "task",
                "name": "Task",
                "account_name": "account",
                "chat_id": "-1001",
                "chat_name": "Group",
                "start_at": None,
                "end_at": None,
                "profile_keywords": [],
                "continuous": True,
                "enabled": True,
                "history_limit": 100,
            }
        },
        "records": {},
    }
    service._save = lambda: None
    service.PROFILE_REQUEST_DELAY = 0

    async def with_client(_account_name, handler):
        return await handler(client)

    service._with_client = with_client

    first = await service.scan("task")
    client.messages = [message(4), message(3), message(2)]
    second = await service.scan("task")

    record = next(iter(service._data["records"].values()))
    assert first["scanned_messages"] == 3
    assert second["scanned_messages"] == 1
    assert record["message_count"] == 4
    assert service._data["configs"]["task"]["latest_message_id_seen"] == 4
