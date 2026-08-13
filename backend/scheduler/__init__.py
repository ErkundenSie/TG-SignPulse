from __future__ import annotations

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger
from datetime import datetime

from sqlalchemy.orm import Session

from backend.core.database import get_session_local
from backend.models.task import Task
from backend.models.user import User
from backend.core.workspace import (
    activate_workspace,
    get_workspace_context,
    reset_workspace,
)
from backend.services.tasks import run_task_once

scheduler: AsyncIOScheduler | None = None


def get_scheduler_timezone() -> str:
    from backend.core.config import get_settings

    settings = get_settings()
    return settings.timezone


def create_cron_trigger(cron_str: str) -> CronTrigger:
    """自动解析格式并创建 CronTrigger，支持 5位和6位 cron 表达式以及 HH:MM 或 HH:MM:SS"""
    if ":" in cron_str:
        parts = cron_str.split(":")
        try:
            if len(parts) == 2:
                hour, minute = parts
                cron_str = f"0 {int(minute)} {int(hour)} * * *"
            elif len(parts) == 3:
                hour, minute, second = parts
                cron_str = f"{int(second)} {int(minute)} {int(hour)} * * *"
        except ValueError:
            pass

    parts = cron_str.split()
    if len(parts) == 6:
        return CronTrigger(
            second=parts[0],
            minute=parts[1],
            hour=parts[2],
            day=parts[3],
            month=parts[4],
            day_of_week=parts[5],
        )
    return CronTrigger.from_crontab(cron_str)


def _parse_hhmm(value: str):
    from datetime import datetime

    return datetime.strptime(value, "%H:%M").time()


def _range_window_for_now(range_start: str, range_end: str, now):
    from datetime import timedelta

    start_time = _parse_hhmm(range_start)
    end_time = _parse_hhmm(range_end)

    start_today = now.replace(
        hour=start_time.hour,
        minute=start_time.minute,
        second=0,
        microsecond=0,
    )
    end_today = now.replace(
        hour=end_time.hour,
        minute=end_time.minute,
        second=0,
        microsecond=0,
    )

    if end_today <= start_today:
        end_after_start = end_today + timedelta(days=1)
        if start_today <= now <= end_after_start:
            return start_today, end_after_start

        start_yesterday = start_today - timedelta(days=1)
        if start_yesterday <= now <= end_today:
            return start_yesterday, end_today

        return start_today, end_after_start

    return start_today, end_today


def _task_ran_in_window(task_config: dict, window_start, window_end) -> bool:
    from datetime import datetime

    last_run = task_config.get("last_run") if isinstance(task_config, dict) else None
    if not isinstance(last_run, dict):
        return False

    raw_time = last_run.get("time")
    if not raw_time:
        return False

    try:
        run_at = datetime.fromisoformat(str(raw_time))
    except ValueError:
        return False

    if run_at.tzinfo is None:
        run_at = run_at.replace(tzinfo=window_start.tzinfo)
    else:
        run_at = run_at.astimezone(window_start.tzinfo)

    return window_start <= run_at <= window_end


def _schedule_range_catchup_if_needed(task_config: dict) -> None:
    import logging
    from zoneinfo import ZoneInfo

    global scheduler
    if scheduler is None:
        return

    if not isinstance(task_config, dict):
        return
    if task_config.get("execution_mode") != "range":
        return
    if not task_config.get("enabled", True):
        return

    account_name = str(task_config.get("account_name") or "").strip()
    task_name = str(task_config.get("name") or "").strip()
    range_start = str(task_config.get("range_start") or "").strip()
    range_end = str(task_config.get("range_end") or "").strip()
    if not account_name or not task_name or not range_start or not range_end:
        return

    logger = logging.getLogger("backend.scheduler")
    try:
        tz = ZoneInfo(get_scheduler_timezone())
        now = __import__("datetime").datetime.now(tz)
        window_start, window_end = _range_window_for_now(range_start, range_end, now)
    except Exception as exc:
        logger.warning(
            "Scheduler: 无法计算随机时间段补跑窗口 %s/%s: %s",
            account_name,
            task_name,
            exc,
        )
        return

    if not (window_start <= now <= window_end):
        return
    if _task_ran_in_window(task_config, window_start, window_end):
        return

    workspace = get_workspace_context()
    if workspace is None:
        return
    user_id = workspace.user_id
    job_id = f"range-catchup-{user_id}-{account_name}-{task_name}"
    existing = scheduler.get_job(job_id)
    if existing and existing.next_run_time and existing.next_run_time >= now:
        return

    try:
        scheduler.add_job(
            _job_run_sign_task,
            trigger=DateTrigger(run_date=now, timezone=tz),
            id=job_id,
            args=[user_id, account_name, task_name],
            replace_existing=True,
        )
        logger.info(
            "Scheduler: 任务 %s/%s 当前位于随机时间段内，已安排补跑：%s",
            account_name,
            task_name,
            now.isoformat(),
        )
    except Exception as exc:
        logger.error(
            "Scheduler: 安排随机时间段补跑失败 %s/%s: %s",
            account_name,
            task_name,
            exc,
        )


def _activate_user_workspace(db: Session, user_id: int):
    user = db.query(User).filter(User.id == user_id, User.is_active.is_(True)).first()
    return activate_workspace(user.id, user.is_admin) if user else None


async def _job_run_task(task_id: int, user_id: int) -> None:
    db: Session = get_session_local()()
    workspace_token = None
    try:
        workspace_token = _activate_user_workspace(db, user_id)
        if workspace_token is None:
            return
        # 这里的查询是同步的，对于 SQLite 且任务量不大可以接受
        task = (
            db.query(Task).filter(Task.id == task_id, Task.user_id == user_id).first()
        )
        if not task or not task.enabled:
            return
        # run_task_once 将被改为 async
        await run_task_once(db, task)
    finally:
        if workspace_token is not None:
            reset_workspace(workspace_token)
        db.close()


async def _job_run_sign_task(user_id: int, account_name: str, task_name: str) -> None:
    """运行签到任务的 Job 包装器"""
    import asyncio
    import logging
    import random
    from zoneinfo import ZoneInfo

    from backend.services.sign_tasks import get_sign_task_service

    logger = logging.getLogger("backend.scheduler")
    db: Session = get_session_local()()
    workspace_token = None
    try:
        workspace_token = _activate_user_workspace(db, user_id)
        if workspace_token is None:
            return
        logger.info(f"Scheduler: 正在运行签到任务 {task_name} (账号: {account_name})")

        # 获取任务配置，检查是否为随机时间段模式
        sign_task_service = get_sign_task_service()
        task_config = sign_task_service.get_task(task_name, account_name)
        if task_config:
            try:
                random_seconds = max(0, int(task_config.get("random_seconds") or 0))
            except (TypeError, ValueError):
                random_seconds = 0

            if random_seconds > 0 and task_config.get("execution_mode") != "range":
                delay_seconds = random.uniform(0, random_seconds)
                logger.info(
                    "Scheduler: task %s/%s random jitter %.1fs of %ss before run",
                    account_name,
                    task_name,
                    delay_seconds,
                    random_seconds,
                )
                await asyncio.sleep(delay_seconds)

        if task_config and task_config.get("execution_mode") == "range":
            range_start_str = task_config.get("range_start")
            range_end_str = task_config.get("range_end")

            if range_start_str and range_end_str:
                try:
                    now = datetime.now(ZoneInfo(get_scheduler_timezone()))
                    start_dt, end_dt = _range_window_for_now(
                        range_start_str,
                        range_end_str,
                        now,
                    )

                    if now > start_dt:
                        start_dt = now

                    remaining_seconds = (end_dt - start_dt).total_seconds()
                    if remaining_seconds > 0:
                        # 生成随机延迟
                        delay_seconds = random.uniform(0, remaining_seconds)
                        logger.info(
                            f"Scheduler: 任务 {task_name} 设置为随机时间段模式 ({range_start_str} - {range_end_str})"
                        )
                        logger.info(
                            f"Scheduler: 将随机等待 {int(delay_seconds)} 秒 ({delay_seconds / 60:.2f} 分钟) 后执行"
                        )

                        await asyncio.sleep(delay_seconds)

                except Exception as e:
                    logger.error(f"Scheduler: 计算随机时间段延迟失败: {e}，将立即执行")

        # run_task_with_logs 是 async 的，我们使用它
        sign_task_service = get_sign_task_service()
        result = await sign_task_service.run_task_with_logs(account_name, task_name)
        if result.get("success"):
            logger.info(f"Scheduler: 任务 {task_name} 执行成功")
        else:
            logger.error(f"Scheduler: 任务 {task_name} 执行失败: {result.get('error')}")
    except Exception as e:
        logger.error(f"Scheduler: 运行签到任务 {task_name} 失败: {e}", exc_info=True)
    finally:
        if workspace_token is not None:
            reset_workspace(workspace_token)
        db.close()


async def _job_run_automation_rule(
    user_id: int, rule_id: str, trigger_index: int
) -> None:
    """运行自动化规则定时触发器。"""
    import logging

    from backend.services.automation_rules import get_automation_rule_service

    logger = logging.getLogger("backend.scheduler")
    db: Session = get_session_local()()
    workspace_token = None
    try:
        workspace_token = _activate_user_workspace(db, user_id)
        if workspace_token is None:
            return
        await get_automation_rule_service().execute(
            rule_id,
            trigger_type="timer",
            trigger_index=trigger_index,
        )
    except Exception as exc:
        logger.error(
            "Scheduler: 自动化规则 %s 执行失败: %s",
            rule_id,
            exc,
            exc_info=True,
        )
    finally:
        if workspace_token is not None:
            reset_workspace(workspace_token)
        db.close()


async def _job_maintenance() -> None:
    """每日维护任务：清理旧日志等"""
    db: Session = get_session_local()()
    try:
        from backend.services.sign_tasks import get_sign_task_service
        from backend.services.tasks import cleanup_old_logs

        # 清理数据库任务日志
        count = cleanup_old_logs(db, days=3)
        print(f"Maintenance: 已清理 {count} 条数据库任务日志")

        for user in db.query(User).filter(User.is_active.is_(True)).all():
            workspace_token = activate_workspace(user.id, user.is_admin)
            try:
                get_sign_task_service()._cleanup_old_logs()
            finally:
                reset_workspace(workspace_token)
    finally:
        db.close()


async def sync_jobs(user_id: int | None = None) -> None:
    """
    Sync APScheduler jobs from DB tasks table and file-based sign tasks.
    """
    if scheduler is None:
        return

    db: Session = get_session_local()()
    try:
        workspace = get_workspace_context()
        target_user_ids = (
            [user_id]
            if user_id is not None
            else (
                [workspace.user_id]
                if workspace is not None
                else [
                    row.id
                    for row in db.query(User).filter(User.is_active.is_(True)).all()
                ]
            )
        )

        for current_user_id in target_user_ids:
            workspace_token = _activate_user_workspace(db, current_user_id)
            if workspace_token is None:
                continue
            try:
                from backend.services.sign_tasks import get_sign_task_service

                # 1. 同步数据库任务
                tasks = (
                    db.query(Task)
                    .filter(Task.enabled, Task.user_id == current_user_id)
                    .all()
                )
                existing_ids = {
                    job.id
                    for job in scheduler.get_jobs()
                    if job.id.startswith(f"db-{current_user_id}-")
                    or job.id.startswith(f"sign-{current_user_id}-")
                    or job.id.startswith(f"range-catchup-{current_user_id}-")
                }
                desired_ids = set()

                for task in tasks:
                    job_id = f"db-{current_user_id}-{task.id}"
                    desired_ids.add(job_id)

                    try:
                        trigger = create_cron_trigger(task.cron)
                        if job_id in existing_ids:
                            scheduler.reschedule_job(job_id, trigger=trigger)
                        else:
                            scheduler.add_job(
                                _job_run_task,
                                trigger=trigger,
                                id=job_id,
                                args=[task.id, current_user_id],
                                replace_existing=True,
                            )
                    except Exception as e:
                        print(f"Error scheduling DB task {task.id}: {e}")

                # 2. 同步签到任务 (SignTask)
                # 使用缓存的任务列表，减少 I/O
                sign_task_service = get_sign_task_service()
                sign_tasks = sign_task_service.list_tasks(force_refresh=False)
                for st in sign_tasks:
                    account_name = str(st.get("account_name") or "").strip()
                    task_name = str(st.get("name") or "").strip()
                    if not account_name or not task_name:
                        print(
                            f"Skip scheduling sign task with missing account/name: {st}"
                        )
                        continue
                    if st.get("monitor_only"):
                        job_id = f"sign-{current_user_id}-{account_name}-{task_name}"
                        desired_ids.discard(job_id)
                        if job_id in existing_ids:
                            scheduler.remove_job(job_id)
                        continue

                    job_id = f"sign-{current_user_id}-{account_name}-{task_name}"
                    desired_ids.add(job_id)

                    # SignTask 目前默认都是启用的，或者根据 st['enabled']
                    if not st.get("enabled", True):
                        if job_id in existing_ids:
                            scheduler.remove_job(job_id)
                        continue

                    try:
                        trigger = create_cron_trigger(st["sign_at"])
                        if st.get("execution_mode") == "range" and st.get(
                            "range_start"
                        ):
                            trigger = create_cron_trigger(st["range_start"])

                        if job_id in existing_ids:
                            scheduler.reschedule_job(job_id, trigger=trigger)
                        else:
                            # 使用新的 job wrapper
                            scheduler.add_job(
                                _job_run_sign_task,
                                trigger=trigger,
                                id=job_id,
                                args=[current_user_id, account_name, task_name],
                                replace_existing=True,
                            )
                    except Exception as e:
                        print(f"Error scheduling sign task {task_name}: {e}")
                    else:
                        _schedule_range_catchup_if_needed(st)

                # remove obsolete jobs
                for job_id in existing_ids - desired_ids:
                    scheduler.remove_job(job_id)

                from backend.services.automation_rules import (
                    get_automation_rule_service,
                )

                await get_automation_rule_service().sync_schedules()
            finally:
                reset_workspace(workspace_token)
    finally:
        db.close()


async def init_scheduler(sync_on_startup: bool = True) -> AsyncIOScheduler:
    global scheduler
    if scheduler is None:
        scheduler = AsyncIOScheduler(
            timezone=get_scheduler_timezone(),
            job_defaults={
                "misfire_grace_time": 3600,  # 允许任务延迟 1 小时执行
                "coalesce": True,  # 合并积压的执行
                "max_instances": 10,  # 增加并发实例数，避免多账号任务相互阻塞
            },
        )
        scheduler.start()

        # 添加每日凌晨 3 点执行的维护任务
        scheduler.add_job(
            _job_maintenance,
            trigger=CronTrigger.from_crontab("0 3 * * *"),
            id="system-maintenance",
            replace_existing=True,
        )

        if sync_on_startup:
            await sync_jobs()
    return scheduler


def shutdown_scheduler() -> None:
    global scheduler
    if scheduler:
        scheduler.shutdown(wait=False)
        scheduler = None


async def reload_scheduler() -> None:
    shutdown_scheduler()
    await init_scheduler(sync_on_startup=True)


def add_or_update_sign_task_job(
    account_name: str, task_name: str, cron_expression: str, enabled: bool = True
) -> None:
    """动态添加或更新签到任务 Job"""
    global scheduler
    if not scheduler:
        return

    workspace = get_workspace_context()
    if workspace is None:
        return
    user_id = workspace.user_id
    job_id = f"sign-{user_id}-{account_name}-{task_name}"

    if not enabled:
        remove_sign_task_job(account_name, task_name)
        return

    try:
        cron = cron_expression
        trigger = create_cron_trigger(cron)

        # 总是使用 replace_existing=True 来覆盖旧的
        scheduler.add_job(
            _job_run_sign_task,
            trigger=trigger,
            id=job_id,
            args=[user_id, account_name, task_name],
            replace_existing=True,
        )
        try:
            from backend.services.sign_tasks import get_sign_task_service

            task_config = get_sign_task_service().get_task(
                task_name,
                account_name=account_name,
            )
            if task_config:
                _schedule_range_catchup_if_needed(task_config)
        except Exception:
            pass
        print(f"Scheduler: 已添加/更新任务 {job_id} -> {cron}")
    except Exception as e:
        print(f"Scheduler: 添加任务 {job_id} 失败: {e}")


def remove_sign_task_job(account_name: str, task_name: str) -> None:
    """动态移除签到任务 Job"""
    global scheduler
    if not scheduler:
        return

    workspace = get_workspace_context()
    if workspace is None:
        return
    job_id = f"sign-{workspace.user_id}-{account_name}-{task_name}"
    try:
        if scheduler.get_job(job_id):
            scheduler.remove_job(job_id)
            print(f"Scheduler: 已移除任务 {job_id}")
    except Exception as e:
        print(f"Scheduler: 移除任务 {job_id} 失败: {e}")
