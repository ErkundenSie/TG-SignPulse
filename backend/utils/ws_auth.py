from __future__ import annotations

from typing import Optional

from fastapi import WebSocket, status
from sqlalchemy.orm import Session

from backend.core.auth import verify_token
from backend.core.workspace import activate_workspace
from backend.models.user import User

_TOKEN_PROTOCOL = "tg-flowpulse-token"


def extract_ws_token(websocket: WebSocket, query_token: Optional[str]) -> Optional[str]:
    """Read a websocket bearer token from subprotocols, with query fallback."""
    header = websocket.headers.get("sec-websocket-protocol", "")
    protocols = [item.strip() for item in header.split(",") if item.strip()]
    for idx, item in enumerate(protocols):
        if item == _TOKEN_PROTOCOL and idx + 1 < len(protocols):
            return protocols[idx + 1]
    return query_token


async def authenticate_websocket(
    websocket: WebSocket,
    db: Session,
    query_token: Optional[str],
) -> Optional[User]:
    token = extract_ws_token(websocket, query_token)
    if not token:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return None
    try:
        user = verify_token(token, db)
    except Exception:
        user = None
    if not user:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return None
    activate_workspace(user.id, user.is_admin)
    return user


def ws_auth_subprotocol(websocket: WebSocket) -> Optional[str]:
    header = websocket.headers.get("sec-websocket-protocol", "")
    protocols = [item.strip() for item in header.split(",") if item.strip()]
    return _TOKEN_PROTOCOL if _TOKEN_PROTOCOL in protocols else None


async def accept_authenticated_websocket(
    websocket: WebSocket,
    db: Session,
    query_token: Optional[str],
) -> Optional[User]:
    user = await authenticate_websocket(websocket, db, query_token)
    if user is None:
        return None
    await websocket.accept(subprotocol=ws_auth_subprotocol(websocket))
    return user
