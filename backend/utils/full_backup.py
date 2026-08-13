from __future__ import annotations

import json
import os
import shutil
import sqlite3
import tempfile
from datetime import datetime
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Any
from zipfile import ZIP_DEFLATED, BadZipFile, ZipFile

from sqlalchemy.orm import Session

from backend.core.config import Settings
from backend.core.workspace import activate_workspace, reset_workspace
from backend.models.account import Account
from backend.models.task import Task
from backend.models.task_log import TaskLog
from backend.models.user import User

BACKUP_VERSION = 1
USER_SCOPE = "user"
SYSTEM_SCOPE = "system"
_MAX_ARCHIVE_FILES = 20_000
_MAX_ARCHIVE_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024
_MAX_ARCHIVE_UPLOAD_BYTES = 512 * 1024 * 1024
_PENDING_RESTORE_DIR = ".restore-pending"
_DEPLOYMENT_ENV_NAMES = (
    "APP_SECRET_KEY",
    "APP_CORS_ORIGINS",
    "APP_TOTP_VALID_WINDOW",
    "TG_API_ID",
    "TG_API_HASH",
    "TG_SESSION_MODE",
    "TG_SESSION_NO_UPDATES",
    "TG_NO_UPDATES",
    "TZ",
)


class BackupError(ValueError):
    pass


async def read_backup_upload(upload: Any) -> bytes:
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = await upload.read(1024 * 1024)
        if not chunk:
            return b"".join(chunks)
        size += len(chunk)
        if size > _MAX_ARCHIVE_UPLOAD_BYTES:
            raise BackupError("备份文件超过 512 MB 上传限制")
        chunks.append(chunk)


def _serialize_datetime(value: Any) -> Any:
    return value.isoformat() if isinstance(value, datetime) else value


def _parse_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        return None


def _write_tree(archive: ZipFile, source: Path, prefix: str) -> None:
    if not source.exists():
        return
    archive.writestr(f"{prefix}/", b"")
    for path in source.rglob("*"):
        if path.is_symlink():
            continue
        relative_path = path.relative_to(source).as_posix()
        if path.is_dir():
            archive.writestr(f"{prefix}/{relative_path}/", b"")
        elif path.is_file():
            archive.write(path, f"{prefix}/{relative_path}")


def _safe_archive_entries(archive: ZipFile) -> list:
    entries = archive.infolist()
    if len(entries) > _MAX_ARCHIVE_FILES:
        raise BackupError("备份文件条目过多")
    total_size = 0
    for entry in entries:
        path = PurePosixPath(entry.filename)
        if (
            not entry.filename
            or path.is_absolute()
            or ".." in path.parts
            or "\\" in entry.filename
        ):
            raise BackupError("备份文件包含不安全路径")
        mode = (entry.external_attr >> 16) & 0o170000
        if mode == 0o120000:
            raise BackupError("备份文件不能包含符号链接")
        total_size += entry.file_size
        if total_size > _MAX_ARCHIVE_UNCOMPRESSED_BYTES:
            raise BackupError("备份解压后的数据量超过限制")
    return entries


def _read_manifest(archive: ZipFile) -> dict[str, Any]:
    try:
        manifest = json.loads(archive.read("manifest.json"))
    except (KeyError, json.JSONDecodeError) as exc:
        raise BackupError("备份文件缺少有效 manifest.json") from exc
    if not isinstance(manifest, dict) or manifest.get("version") != BACKUP_VERSION:
        raise BackupError("不支持的备份文件版本")
    return manifest


def _extract_archive(
    data: bytes, destination: Path, expected_scope: str
) -> dict[str, Any]:
    try:
        with ZipFile(BytesIO(data)) as archive:
            _safe_archive_entries(archive)
            manifest = _read_manifest(archive)
            if manifest.get("scope") != expected_scope:
                raise BackupError("备份类型与当前恢复操作不匹配")
            destination.mkdir(parents=True, exist_ok=True)
            for entry in archive.infolist():
                target = destination.joinpath(*PurePosixPath(entry.filename).parts)
                resolved = target.resolve(strict=False)
                if destination.resolve() not in resolved.parents:
                    raise BackupError("备份文件包含不安全路径")
                if entry.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
            return manifest
    except BadZipFile as exc:
        raise BackupError("上传的文件不是有效 ZIP 备份") from exc


def _replace_tree(source: Path, target: Path) -> None:
    if target.exists():
        shutil.rmtree(target)
    if source.exists():
        shutil.copytree(source, target)
    else:
        target.mkdir(parents=True, exist_ok=True)


def _database_payload(db: Session, user: User) -> dict[str, Any]:
    accounts = db.query(Account).filter(Account.user_id == user.id).all()
    tasks = db.query(Task).filter(Task.user_id == user.id).all()
    logs = db.query(TaskLog).filter(TaskLog.user_id == user.id).all()
    return {
        "accounts": [
            {
                "account_name": item.account_name,
                "api_id": item.api_id,
                "api_hash": item.api_hash,
                "proxy": item.proxy,
                "status": item.status,
                "last_login_at": _serialize_datetime(item.last_login_at),
                "created_at": _serialize_datetime(item.created_at),
                "updated_at": _serialize_datetime(item.updated_at),
            }
            for item in accounts
        ],
        "tasks": [
            {
                "source_id": item.id,
                "name": item.name,
                "cron": item.cron,
                "enabled": item.enabled,
                "account_name": item.account.account_name if item.account else None,
                "last_run_at": _serialize_datetime(item.last_run_at),
                "created_at": _serialize_datetime(item.created_at),
                "updated_at": _serialize_datetime(item.updated_at),
            }
            for item in tasks
        ],
        "task_logs": [
            {
                "source_task_id": item.task_id,
                "status": item.status,
                "log_path": item.log_path,
                "output": item.output,
                "started_at": _serialize_datetime(item.started_at),
                "finished_at": _serialize_datetime(item.finished_at),
            }
            for item in logs
        ],
    }


def export_user_backup(settings: Settings, db: Session, user: User) -> bytes:
    token = activate_workspace(user.id, user.is_admin)
    try:
        workdir = settings.resolve_workdir()
        session_dir = settings.resolve_session_dir()
        logs_dir = settings.resolve_logs_dir()
        archive_buffer = BytesIO()
        with ZipFile(archive_buffer, "w", compression=ZIP_DEFLATED) as archive:
            archive.writestr(
                "manifest.json",
                json.dumps(
                    {
                        "version": BACKUP_VERSION,
                        "scope": USER_SCOPE,
                        "exported_at": datetime.utcnow().isoformat() + "Z",
                        "source_user": {
                            "id": user.id,
                            "username": user.username,
                            "is_admin": user.is_admin,
                        },
                        "includes": [
                            "Telegram sessions",
                            "account profiles and proxy settings",
                            "application and task configuration",
                            "workspace logs and data",
                            "user-owned database records",
                        ],
                        "excludes": [
                            "application login username",
                            "application password hash",
                            "application two-factor secret",
                            "application user status",
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
            )
            archive.writestr(
                "database.json",
                json.dumps(_database_payload(db, user), ensure_ascii=False, indent=2),
            )
            _write_tree(archive, workdir, "workspace/workdir")
            _write_tree(archive, session_dir, "workspace/sessions")
            _write_tree(archive, logs_dir, "workspace/logs")
        return archive_buffer.getvalue()
    finally:
        reset_workspace(token)


def _validate_database_restore(
    db: Session, user: User, payload: dict[str, Any]
) -> None:
    account_names = {
        str(raw.get("account_name") or "").strip()
        for raw in payload.get("accounts") or []
        if isinstance(raw, dict) and str(raw.get("account_name") or "").strip()
    }
    if account_names:
        conflicts = (
            db.query(Account.account_name)
            .filter(Account.account_name.in_(account_names), Account.user_id != user.id)
            .all()
        )
        if conflicts:
            raise BackupError(f"账号名称已被其他用户使用: {conflicts[0][0]}")


def _insert_database_restore(db: Session, user: User, payload: dict[str, Any]) -> None:
    accounts_by_name: dict[str, Account] = {}
    for raw in payload.get("accounts") or []:
        if not isinstance(raw, dict):
            continue
        account_name = str(raw.get("account_name") or "").strip()
        if not account_name:
            continue
        account = Account(
            user_id=user.id,
            account_name=account_name,
            api_id=str(raw.get("api_id") or ""),
            api_hash=str(raw.get("api_hash") or ""),
            proxy=raw.get("proxy"),
            status=str(raw.get("status") or "idle"),
            last_login_at=_parse_datetime(raw.get("last_login_at")),
            created_at=_parse_datetime(raw.get("created_at")) or datetime.utcnow(),
            updated_at=_parse_datetime(raw.get("updated_at")) or datetime.utcnow(),
        )
        db.add(account)
        db.flush()
        accounts_by_name[account_name] = account

    task_ids: dict[Any, int] = {}
    for raw in payload.get("tasks") or []:
        if not isinstance(raw, dict):
            continue
        account = accounts_by_name.get(str(raw.get("account_name") or ""))
        if account is None:
            continue
        task = Task(
            user_id=user.id,
            name=str(raw.get("name") or ""),
            cron=str(raw.get("cron") or ""),
            enabled=bool(raw.get("enabled", True)),
            account_id=account.id,
            last_run_at=_parse_datetime(raw.get("last_run_at")),
            created_at=_parse_datetime(raw.get("created_at")) or datetime.utcnow(),
            updated_at=_parse_datetime(raw.get("updated_at")) or datetime.utcnow(),
        )
        db.add(task)
        db.flush()
        task_ids[raw.get("source_id")] = task.id

    for raw in payload.get("task_logs") or []:
        if not isinstance(raw, dict):
            continue
        task_id = task_ids.get(raw.get("source_task_id"))
        if task_id is None:
            continue
        db.add(
            TaskLog(
                user_id=user.id,
                task_id=task_id,
                status=str(raw.get("status") or "pending"),
                log_path=raw.get("log_path"),
                output=raw.get("output"),
                started_at=_parse_datetime(raw.get("started_at")) or datetime.utcnow(),
                finished_at=_parse_datetime(raw.get("finished_at")),
            )
        )


def _restore_database(db: Session, user: User, payload: dict[str, Any]) -> None:
    _validate_database_restore(db, user, payload)
    user_id = user.id
    db.query(TaskLog).filter(TaskLog.user_id == user.id).delete(
        synchronize_session=False
    )
    db.query(Task).filter(Task.user_id == user.id).delete(synchronize_session=False)
    db.query(Account).filter(Account.user_id == user.id).delete(
        synchronize_session=False
    )
    db.flush()
    db.expunge_all()
    restored_user = db.get(User, user_id)
    if restored_user is None:
        raise BackupError("当前用户不存在")
    _insert_database_restore(db, restored_user, payload)


def restore_user_backup(
    settings: Settings, db: Session, user: User, archive_data: bytes
) -> None:
    with tempfile.TemporaryDirectory(prefix="tg-flowpulse-user-restore-") as temp_dir:
        staging = Path(temp_dir)
        _extract_archive(archive_data, staging, USER_SCOPE)
        database_file = staging / "database.json"
        if not database_file.exists():
            raise BackupError("备份文件缺少数据库数据")
        try:
            database_payload = json.loads(database_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise BackupError("备份数据库数据无效") from exc
        if not isinstance(database_payload, dict):
            raise BackupError("备份数据库数据无效")
        _validate_database_restore(db, user, database_payload)
        workspace_root = staging / "workspace"
        required_workspace_dirs = ("workdir", "sessions", "logs")
        if any(
            not (workspace_root / name).is_dir() for name in required_workspace_dirs
        ):
            raise BackupError("备份文件缺少完整工作区数据")

        rollback_dir = staging / "rollback"
        token = activate_workspace(user.id, user.is_admin)
        try:
            targets = {
                "workdir": settings.resolve_workdir(),
                "sessions": settings.resolve_session_dir(),
                "logs": settings.resolve_logs_dir(),
            }
            existing_targets: set[str] = set()
            for name, target in targets.items():
                if target.exists():
                    shutil.copytree(target, rollback_dir / name)
                    existing_targets.add(name)
            try:
                _replace_tree(staging / "workspace" / "workdir", targets["workdir"])
                _replace_tree(staging / "workspace" / "sessions", targets["sessions"])
                _replace_tree(staging / "workspace" / "logs", targets["logs"])
                _restore_database(db, user, database_payload)
                db.commit()
            except Exception:
                db.rollback()
                for name, target in targets.items():
                    if name in existing_targets:
                        _replace_tree(rollback_dir / name, target)
                    elif target.exists():
                        shutil.rmtree(target)
                raise
        finally:
            reset_workspace(token)


def export_system_backup(settings: Settings) -> bytes:
    base_dir = settings.resolve_base_dir()
    archive_buffer = BytesIO()
    with ZipFile(archive_buffer, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr(
            "manifest.json",
            json.dumps(
                {
                    "version": BACKUP_VERSION,
                    "scope": SYSTEM_SCOPE,
                    "exported_at": datetime.utcnow().isoformat() + "Z",
                    "includes": ["complete application data directory"],
                },
                ensure_ascii=False,
                indent=2,
            ),
        )
        deployment_env = "\n".join(
            f"{name}={os.environ[name]}"
            for name in _DEPLOYMENT_ENV_NAMES
            if os.environ.get(name) is not None
        )
        archive.writestr(
            "system/.runtime.env", deployment_env + ("\n" if deployment_env else "")
        )
        db_path = settings.resolve_db_path()
        if db_path.exists():
            with tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False) as temp_db:
                temp_db_path = Path(temp_db.name)
            try:
                source = sqlite3.connect(db_path)
                target = sqlite3.connect(temp_db_path)
                try:
                    source.backup(target)
                finally:
                    target.close()
                    source.close()
                archive.write(temp_db_path, "system/db.sqlite")
            finally:
                temp_db_path.unlink(missing_ok=True)
        for path in base_dir.iterdir():
            if path.name == _PENDING_RESTORE_DIR or path.is_symlink():
                continue
            if path.name in {
                db_path.name,
                f"{db_path.name}-wal",
                f"{db_path.name}-shm",
            }:
                continue
            if path.is_file():
                archive.write(path, f"system/{path.name}")
            elif path.is_dir():
                _write_tree(archive, path, f"system/{path.name}")
    return archive_buffer.getvalue()


def stage_system_restore(settings: Settings, archive_data: bytes) -> None:
    base_dir = settings.resolve_base_dir()
    pending_dir = base_dir / _PENDING_RESTORE_DIR
    with tempfile.TemporaryDirectory(prefix="tg-flowpulse-system-restore-") as temp_dir:
        temp_root = Path(temp_dir)
        manifest = _extract_archive(archive_data, temp_root, SYSTEM_SCOPE)
        system_dir = temp_root / "system"
        if not system_dir.is_dir():
            raise BackupError("系统备份缺少数据目录")
        replacement_dir = base_dir / f"{_PENDING_RESTORE_DIR}.new"
        if replacement_dir.exists():
            shutil.rmtree(replacement_dir)
        shutil.copytree(system_dir, replacement_dir / "payload" / "system")
        (replacement_dir / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        if pending_dir.exists():
            shutil.rmtree(pending_dir)
        replacement_dir.replace(pending_dir)


def apply_pending_system_restore(settings: Settings) -> bool:
    base_dir = settings.resolve_base_dir()
    pending_dir = base_dir / _PENDING_RESTORE_DIR
    payload_dir = pending_dir / "payload" / "system"
    if not payload_dir.is_dir():
        return False
    for source in payload_dir.iterdir():
        target = base_dir / source.name
        if target.exists():
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
        if source.is_dir():
            shutil.copytree(source, target)
        else:
            shutil.copy2(source, target)
    shutil.rmtree(pending_dir)
    return True


def backup_filename(scope: str) -> str:
    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    return f"tg-flowpulse-{scope}-backup-{timestamp}.zip"
