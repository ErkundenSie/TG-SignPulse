from __future__ import annotations

import asyncio
from typing import Dict

from backend.core.workspace import get_workspace_key

_ACCOUNT_LOCKS: Dict[str, asyncio.Lock] = {}


def get_account_lock(account_name: str) -> asyncio.Lock:
    key = f"{get_workspace_key()}:{account_name}"
    lock = _ACCOUNT_LOCKS.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _ACCOUNT_LOCKS[key] = lock
    return lock
