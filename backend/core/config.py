from __future__ import annotations

import os
import secrets
from functools import lru_cache
from pathlib import Path
from typing import Optional

from backend.utils.storage import get_initial_data_dir, get_writable_base_dir
from backend.core.workspace import resolve_workspace_dir

try:
    from pydantic.v1 import BaseSettings
except ImportError:
    from pydantic import BaseSettings


_DEFAULT_CORS_ORIGINS = ",".join(
    [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    ]
)


# 生成或获取持久化的密钥
def get_default_secret_key() -> str:
    """获取应用密钥，优先使用环境变量，否则生成持久化本地密钥。"""
    env_secret = os.getenv("APP_SECRET_KEY")
    if env_secret and env_secret.strip():
        return env_secret.strip()

    secret_file = os.getenv("APP_SECRET_KEY_FILE")
    secret_path = (
        Path(secret_file).expanduser()
        if secret_file and secret_file.strip()
        else get_writable_base_dir() / ".secret_key"
    )
    try:
        if secret_path.exists():
            existing = secret_path.read_text(encoding="utf-8").strip()
            if existing:
                return existing
        generated = secrets.token_urlsafe(48)
        secret_path.parent.mkdir(parents=True, exist_ok=True)
        secret_path.write_text(generated, encoding="utf-8")
        return generated
    except OSError:
        return secrets.token_urlsafe(48)


class Settings(BaseSettings):
    app_name: str = "tg-flowpulse"
    host: str = os.getenv("APP_HOST", "127.0.0.1")
    port: int = 3000

    # 使用函数获取默认密钥
    secret_key: str = get_default_secret_key()
    access_token_expire_hours: int = 12
    cors_origins: str = os.getenv("APP_CORS_ORIGINS", _DEFAULT_CORS_ORIGINS)

    timezone: str = os.getenv("TZ", "Asia/Hong_Kong")
    data_dir: Path = get_initial_data_dir()
    db_path: Optional[Path] = None
    signer_workdir: Optional[Path] = None
    session_dir: Optional[Path] = None
    logs_dir: Optional[Path] = None

    class Config:
        env_file = ".env"
        env_prefix = "APP_"
        case_sensitive = False

    @property
    def database_url(self) -> str:
        return f"sqlite:///{self.resolve_db_path()}?check_same_thread=False"

    @property
    def cors_origin_list(self) -> list[str]:
        origins = [item.strip() for item in (self.cors_origins or "").split(",")]
        return [origin for origin in origins if origin]

    def resolve_db_path(self) -> Path:
        return self.db_path or self.resolve_base_dir() / "db.sqlite"

    def resolve_workdir(self) -> Path:
        base = self.signer_workdir or self.resolve_base_dir() / ".signer"
        return resolve_workspace_dir(base)

    def resolve_session_dir(self) -> Path:
        base = self.session_dir or self.resolve_base_dir() / "sessions"
        return resolve_workspace_dir(base)

    def resolve_logs_dir(self) -> Path:
        base = self.logs_dir or self.resolve_base_dir() / "logs"
        return resolve_workspace_dir(base)

    def resolve_base_dir(self) -> Path:
        if self.data_dir and str(self.data_dir) != "/data":
            return self.data_dir
        return get_writable_base_dir()


@lru_cache()
def get_settings() -> Settings:
    return Settings()
