import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    sys.version_info >= (3, 14),
    reason="pyrogram is not importable on Python 3.14 in the local test env",
)


class DummyClient:
    def __init__(self, name, *args, **kwargs):
        self.name = name
        self.workdir = Path(kwargs["workdir"])
        self.key = kwargs["key"]
        self.is_connected = False
        self._tg_signpulse_no_updates = kwargs.get("no_updates")


def test_get_client_rebuilds_disconnected_cache_when_no_updates_changes(
    monkeypatch, tmp_path
):
    from tg_signer import core

    monkeypatch.setattr(core, "Client", DummyClient)
    core._CLIENT_INSTANCES.clear()
    core._CLIENT_REFS.clear()
    core._CLIENT_ASYNC_LOCKS.clear()

    first = core.get_client("account", workdir=tmp_path, no_updates=True)
    second = core.get_client("account", workdir=tmp_path, no_updates=False)

    assert second is not first
    assert second._tg_signpulse_no_updates is False


def test_get_client_keeps_connected_cache_when_no_updates_changes(
    monkeypatch, tmp_path
):
    from tg_signer import core

    monkeypatch.setattr(core, "Client", DummyClient)
    core._CLIENT_INSTANCES.clear()
    core._CLIENT_REFS.clear()
    core._CLIENT_ASYNC_LOCKS.clear()

    first = core.get_client("account", workdir=tmp_path, no_updates=True)
    first.is_connected = True
    second = core.get_client("account", workdir=tmp_path, no_updates=False)

    assert second is first


def test_get_client_rebuilds_disconnected_memory_cache_when_session_changes(
    monkeypatch, tmp_path
):
    from tg_signer import core

    monkeypatch.setattr(core, "Client", DummyClient)
    core._CLIENT_INSTANCES.clear()
    core._CLIENT_REFS.clear()
    core._CLIENT_ASYNC_LOCKS.clear()

    first = core.get_client(
        "account",
        workdir=tmp_path,
        session_string="old-session",
        in_memory=True,
    )
    second = core.get_client(
        "account",
        workdir=tmp_path,
        session_string="new-session",
        in_memory=True,
    )

    assert second is not first


class DummyStoppableClient:
    def __init__(self, *, is_connected=False, is_initialized=False):
        self.is_connected = is_connected
        self.is_initialized = is_initialized
        self.stopped = 0
        self.disconnected = 0

    async def stop(self):
        self.stopped += 1
        if not self.is_initialized:
            raise ConnectionError("Client is already terminated")
        self.is_initialized = False
        self.is_connected = False

    async def disconnect(self):
        self.disconnected += 1
        if not self.is_connected:
            raise ConnectionError("Client is already disconnected")
        self.is_connected = False


@pytest.mark.asyncio
async def test_stop_client_safely_disconnects_connected_uninitialized_client():
    from tg_signer import core

    client = DummyStoppableClient(is_connected=True, is_initialized=False)

    await core._stop_client_safely(client)

    assert client.stopped == 0
    assert client.disconnected == 1
    assert client.is_connected is False


@pytest.mark.asyncio
async def test_stop_client_safely_stops_initialized_client():
    from tg_signer import core

    client = DummyStoppableClient(is_connected=True, is_initialized=True)

    await core._stop_client_safely(client)

    assert client.stopped == 1
    assert client.disconnected == 0
    assert client.is_connected is False
    assert client.is_initialized is False


@pytest.mark.asyncio
async def test_stop_client_safely_ignores_already_stopped_client():
    from tg_signer import core

    client = DummyStoppableClient(is_connected=False, is_initialized=False)

    await core._stop_client_safely(client)

    assert client.stopped == 0
    assert client.disconnected == 0
