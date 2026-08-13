from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine


def migrate_schema(engine: Engine) -> None:
    """Apply the small, idempotent SQLite migrations required by this release."""
    if engine.dialect.name != "sqlite":
        return

    with engine.begin() as connection:
        user_columns = {
            row[1] for row in connection.execute(text("PRAGMA table_info(users)"))
        }
        if "is_admin" not in user_columns:
            connection.execute(
                text("ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT 0")
            )
        if "is_active" not in user_columns:
            connection.execute(
                text(
                    "ALTER TABLE users ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT 1"
                )
            )

        admin_id = connection.execute(
            text("SELECT id FROM users ORDER BY id ASC LIMIT 1")
        ).scalar_one_or_none()
        if admin_id is not None:
            connection.execute(text("UPDATE users SET is_admin = 0"))
            connection.execute(
                text("UPDATE users SET is_admin = 1 WHERE id = :user_id"),
                {"user_id": admin_id},
            )

        connection.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_users_single_admin "
                "ON users(is_admin) WHERE is_admin = 1"
            )
        )

        for table in ("accounts", "tasks", "task_logs"):
            columns = {
                row[1]
                for row in connection.execute(text(f"PRAGMA table_info({table})"))
            }
            if columns and "user_id" not in columns:
                connection.execute(
                    text(f"ALTER TABLE {table} ADD COLUMN user_id INTEGER")
                )

        if admin_id is not None:
            connection.execute(
                text("UPDATE accounts SET user_id = :user_id WHERE user_id IS NULL"),
                {"user_id": admin_id},
            )
            connection.execute(
                text("UPDATE tasks SET user_id = :user_id WHERE user_id IS NULL"),
                {"user_id": admin_id},
            )
            connection.execute(
                text("UPDATE task_logs SET user_id = :user_id WHERE user_id IS NULL"),
                {"user_id": admin_id},
            )

        for table in ("accounts", "tasks", "task_logs"):
            connection.execute(
                text(
                    f"CREATE INDEX IF NOT EXISTS ix_{table}_user_id "
                    f"ON {table}(user_id)"
                )
            )
