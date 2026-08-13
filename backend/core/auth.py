from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta
from typing import AsyncGenerator, Optional

import pyotp
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from backend.core.config import get_settings
from backend.core.database import get_db
from backend.core.security import verify_password
from backend.models.user import User
from backend.core.workspace import activate_workspace, reset_workspace

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")

settings = get_settings()
logger = logging.getLogger("backend.auth")
ALGORITHM = "HS256"


class AuthService:
    def __init__(self, secret_key: str, access_token_expire_hours: int):
        self.secret_key = secret_key
        self.access_token_expire_hours = access_token_expire_hours

    def create_access_token(
        self, data: dict, expires_delta: Optional[timedelta] = None
    ) -> str:
        to_encode = data.copy()
        expire = datetime.utcnow() + (
            expires_delta or timedelta(hours=self.access_token_expire_hours)
        )
        to_encode.update({"exp": expire})
        return jwt.encode(to_encode, self.secret_key, algorithm=ALGORITHM)

    def verify_totp(self, secret: str, code: str) -> bool:
        try:
            if not isinstance(code, str):
                return False
            normalized_code = code.strip().replace(" ", "")
            if not normalized_code:
                return False
            totp = pyotp.TOTP(secret)
            raw_window = os.getenv("APP_TOTP_VALID_WINDOW")
            raw_window = raw_window.strip() if isinstance(raw_window, str) else ""
            try:
                valid_window = int(raw_window) if raw_window else 1
            except ValueError:
                valid_window = 1
            if valid_window < 0:
                valid_window = 0
            return totp.verify(normalized_code, valid_window=valid_window)
        except Exception:
            logger.exception("TOTP verification failed unexpectedly")
            return False

    def authenticate_user(
        self, db: Session, username: str, password: str
    ) -> Optional[User]:
        user = db.query(User).filter(User.username == username).first()
        if not user or not user.is_active:
            return None
        if not verify_password(password, user.password_hash):
            return None
        return user

    def verify_token(self, token: str, db: Session) -> Optional[User]:
        try:
            payload = jwt.decode(token, self.secret_key, algorithms=[ALGORITHM])
            username: str = payload.get("sub")  # type: ignore[assignment]
            if username is None:
                return None
        except JWTError:
            return None
        user = db.query(User).filter(User.username == username).first()
        return user if user and user.is_active else None


auth_service = AuthService(settings.secret_key, settings.access_token_expire_hours)


def get_auth_service() -> AuthService:
    return auth_service


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    return auth_service.create_access_token(data, expires_delta)


def verify_totp(secret: str, code: str) -> bool:
    return auth_service.verify_totp(secret, code)


def authenticate_user(db: Session, username: str, password: str) -> Optional[User]:
    return auth_service.authenticate_user(db, username, password)


async def get_current_user(
    token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)
) -> AsyncGenerator[User, None]:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        user = verify_token(token, db)
        if user is None:
            raise credentials_exception
    except HTTPException:
        raise credentials_exception
    workspace_token = activate_workspace(user.id, user.is_admin)
    try:
        yield user
    finally:
        reset_workspace(workspace_token)


# OAuth2 scheme that doesn't auto-error on missing token
oauth2_scheme_optional = OAuth2PasswordBearer(
    tokenUrl="/api/auth/login", auto_error=False
)


async def get_current_user_optional(
    token: Optional[str] = Depends(oauth2_scheme_optional),
    db: Session = Depends(get_db),
) -> AsyncGenerator[Optional[User], None]:
    """获取当前用户，如果无法认证则返回 None（不抛出异常）"""
    if not token:
        yield None
        return
    user = verify_token(token, db)
    if user is None:
        yield None
        return
    workspace_token = activate_workspace(user.id, user.is_admin)
    try:
        yield user
    finally:
        reset_workspace(workspace_token)


def verify_token(token: str, db: Session) -> Optional[User]:
    """验证 Token 并返回用户对象"""
    return auth_service.verify_token(token, db)


def require_admin(current_user: User = Depends(get_current_user)) -> User:
    if not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator access required",
        )
    return current_user
