from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from backend.core.auth import require_admin
from backend.core.database import get_db
from backend.core.security import hash_password
from backend.models.user import User
from backend.utils.paths import ensure_user_workspace_dirs
from backend.core.config import get_settings

router = APIRouter()


class ManagedUserOut(BaseModel):
    id: int
    username: str
    is_admin: bool
    is_active: bool
    created_at: datetime

    class Config:
        orm_mode = True


class CreateUserRequest(BaseModel):
    username: str
    password: str


class UpdateUserRequest(BaseModel):
    username: Optional[str] = None
    password: Optional[str] = None
    is_active: Optional[bool] = None


def _normalize_username(value: str) -> str:
    username = (value or "").strip()
    if not 3 <= len(username) <= 50:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="用户名长度必须为 3 至 50 个字符",
        )
    return username


def _validate_password(value: str) -> str:
    if len(value or "") < 8:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="密码长度至少为 8 个字符",
        )
    return value


def _get_regular_user(db: Session, user_id: int) -> User:
    user = db.query(User).filter(User.id == user_id, User.is_admin.is_(False)).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="用户不存在")
    return user


@router.get("", response_model=list[ManagedUserOut])
def list_regular_users(
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    return (
        db.query(User)
        .filter(User.is_admin.is_(False))
        .order_by(User.created_at.desc(), User.id.desc())
        .all()
    )


@router.post("", response_model=ManagedUserOut, status_code=status.HTTP_201_CREATED)
def create_regular_user(
    payload: CreateUserRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    username = _normalize_username(payload.username)
    password = _validate_password(payload.password)
    if db.query(User.id).filter(func.lower(User.username) == username.lower()).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="用户名已存在")

    user = User(
        username=username,
        password_hash=hash_password(password),
        is_admin=False,
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    ensure_user_workspace_dirs(get_settings(), user.id, user.is_admin)
    return user


@router.patch("/{user_id}", response_model=ManagedUserOut)
def update_regular_user(
    user_id: int,
    payload: UpdateUserRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    user = _get_regular_user(db, user_id)

    if payload.username is not None:
        username = _normalize_username(payload.username)
        existing = (
            db.query(User)
            .filter(func.lower(User.username) == username.lower(), User.id != user.id)
            .first()
        )
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="用户名已存在"
            )
        user.username = username

    if payload.password is not None:
        user.password_hash = hash_password(_validate_password(payload.password))

    if payload.is_active is not None:
        user.is_active = payload.is_active

    db.commit()
    db.refresh(user)
    return user


@router.post("/{user_id}/reset-totp", response_model=ManagedUserOut)
def reset_regular_user_totp(
    user_id: int,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    user = _get_regular_user(db, user_id)
    user.totp_secret = None
    db.commit()
    db.refresh(user)
    return user
