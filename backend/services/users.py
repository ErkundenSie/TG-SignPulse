from __future__ import annotations

import logging
import os
import secrets

from sqlalchemy.orm import Session

from backend.core.security import hash_password
from backend.models.user import User
from backend.utils.storage import get_writable_base_dir

logger = logging.getLogger("backend.users")


def ensure_admin(db: Session, username: str = "admin", password: str = None):
    """
    仅在用户表为空时创建一个默认管理员。
    防止用户修改用户名后，系统又自动创建一个默认的 admin 账号。
    """
    # 检查是否已有任何用户存在
    admin = db.query(User).filter(User.is_admin.is_(True)).first()
    if admin:
        return admin

    first_user = db.query(User).order_by(User.id.asc()).first()
    if first_user:
        first_user.is_admin = True
        db.commit()
        return first_user

    if not password:
        env_pwd = os.getenv("ADMIN_PASSWORD")
        if env_pwd:
            password = env_pwd
        else:
            password = secrets.token_urlsafe(24)
            password_file = get_writable_base_dir() / "initial_admin_password.txt"
            try:
                password_file.parent.mkdir(parents=True, exist_ok=True)
                password_file.write_text(
                    f"username={username}\npassword={password}\n",
                    encoding="utf-8",
                )
            except OSError:
                password_file = None
            logger.warning(
                "SECURITY WARNING: Initial admin account created with a generated password. "
                "Set ADMIN_PASSWORD to control this value. Password file: %s",
                password_file or "unavailable",
            )

    # 如果没有任何用户，则创建默认管理员
    new_user = User(
        username=username,
        password_hash=hash_password(password),
        is_admin=True,
        is_active=True,
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    return new_user
