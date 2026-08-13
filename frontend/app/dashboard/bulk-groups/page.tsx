"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  CheckCircle,
  Clock,
  LinkSimple,
  MagnifyingGlass,
  Play,
  ShieldWarning,
  SignIn,
  SignOut,
  Spinner,
  Stop,
  UsersThree,
  WarningCircle,
} from "@phosphor-icons/react";
import { ToastContainer, useToast } from "../../../components/ui/toast";
import { getToken } from "../../../lib/auth";
import {
  AccountInfo,
  BulkGroupMembershipJob,
  BulkGroupMembershipMode,
  BulkGroupItem,
  cancelBulkGroupMembershipJob,
  getBulkGroupMembershipJob,
  listAccounts,
  listBulkGroupMembershipJobs,
  listBulkGroupMembershipGroups,
  startBulkGroupMembershipJob,
} from "../../../lib/api";
import {
  formatConfiguredDateTime,
  useConfiguredTimezone,
} from "../../../lib/time";

const statusLabels: Record<string, string> = {
  running: "运行中",
  canceling: "正在停止",
  canceled: "已停止",
  completed: "已完成",
  failed: "失败",
  joined: "已加入",
  left: "已退出",
  already_member: "已在群内",
  request_sent: "等待审批",
  not_member: "已不在群内",
  manual_required: "需人工处理",
};

const statusClass = (status: string) => {
  if (["completed", "joined", "left", "already_member"].includes(status))
    return "text-emerald-400 bg-emerald-500/10 border-emerald-500/15";
  if (["failed"].includes(status))
    return "text-rose-400 bg-rose-500/10 border-rose-500/15";
  if (["running"].includes(status))
    return "text-cyan-400 bg-cyan-500/10 border-cyan-500/15";
  return "text-amber-400 bg-amber-500/10 border-amber-500/15";
};

export default function BulkGroupsPage() {
  const { toasts, addToast, removeToast } = useToast();
  const timezone = useConfiguredTimezone();
  const [token, setToken] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [jobs, setJobs] = useState<BulkGroupMembershipJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<BulkGroupMembershipJob | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [accountName, setAccountName] = useState("");
  const [mode, setMode] = useState<BulkGroupMembershipMode>("join");
  const [linksText, setLinksText] = useState("");
  const [minDelay, setMinDelay] = useState(5);
  const [maxDelay, setMaxDelay] = useState(10);
  const [autoWaitFlood, setAutoWaitFlood] = useState(true);
  const [groups, setGroups] = useState<BulkGroupItem[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupSearch, setGroupSearch] = useState("");
  const [selectedGroupIds, setSelectedGroupIds] = useState<number[]>([]);

  const loadInitial = useCallback(async (auth: string) => {
    setLoading(true);
    try {
      const [accountData, jobData] = await Promise.all([
        listAccounts(auth),
        listBulkGroupMembershipJobs(auth),
      ]);
      const nextAccounts = accountData.accounts || [];
      setAccounts(nextAccounts);
      const requested =
        new URLSearchParams(window.location.search).get("account_name") || "";
      setAccountName(
        (current) =>
          current ||
          (nextAccounts.some((account) => account.name === requested)
            ? requested
            : nextAccounts[0]?.name || ""),
      );
      setJobs(jobData);
      setSelectedJob(
        jobData.find((job) => ["running", "canceling"].includes(job.status)) ||
          jobData[0] ||
          null,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const auth = getToken();
    if (!auth) {
      window.location.replace("/");
      return;
    }
    setToken(auth);
    loadInitial(auth).catch((error) =>
      addToast(error.message || "加载批量加退群/频道模块失败", "error"),
    );
  }, [addToast, loadInitial]);

  useEffect(() => {
    if (
      !token ||
      !selectedJob ||
      !["running", "canceling"].includes(selectedJob.status)
    )
      return;
    const timer = window.setInterval(async () => {
      try {
        const updated = await getBulkGroupMembershipJob(
          token,
          selectedJob.job_id,
        );
        setSelectedJob(updated);
        setJobs((items) => [
          updated,
          ...items.filter((item) => item.job_id !== updated.job_id),
        ]);
      } catch (error: any) {
        addToast(error.message || "刷新任务状态失败", "error");
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [addToast, selectedJob?.job_id, selectedJob?.status, token]);

  const loadGroups = useCallback(
    async (auth: string, account: string) => {
      if (!account) return;
      setGroupsLoading(true);
      try {
        const data = await listBulkGroupMembershipGroups(auth, account);
        setGroups(data);
        setSelectedGroupIds((current) =>
          current.filter((id) => data.some((group) => group.id === id)),
        );
      } catch (error: any) {
        setGroups([]);
        setSelectedGroupIds([]);
        addToast(error.message || "读取账号群组和频道失败", "error");
      } finally {
        setGroupsLoading(false);
      }
    },
    [addToast],
  );

  useEffect(() => {
    if (!token || !accountName || mode !== "leave_selected") return;
    loadGroups(token, accountName);
  }, [accountName, loadGroups, mode, token]);

  const parsedLinks = useMemo(
    () =>
      linksText
        .split(/[\r\n]+/)
        .map((item) => item.trim())
        .filter(
          (item, index, values) => item && values.indexOf(item) === index,
        ),
    [linksText],
  );
  const filteredGroups = useMemo(() => {
    const query = groupSearch.trim().toLowerCase();
    if (!query) return groups;
    return groups.filter((group) =>
      `${group.title} ${group.username || ""} ${group.id}`
        .toLowerCase()
        .includes(query),
    );
  }, [groupSearch, groups]);

  const active = Boolean(
    selectedJob && ["running", "canceling"].includes(selectedJob.status),
  );
  const progressPercent = selectedJob?.progress.total
    ? Math.round((selectedJob.progress.done / selectedJob.progress.total) * 100)
    : 0;

  const start = async () => {
    if (!token || !accountName) {
      addToast("请先选择 Telegram 账号", "error");
      return;
    }
    if (mode === "join" && !parsedLinks.length) {
      addToast("请至少输入一个群组或频道链接", "error");
      return;
    }
    if (mode === "leave_selected" && !selectedGroupIds.length) {
      addToast("请至少选择一个需要退出的群组或频道", "error");
      return;
    }
    if (minDelay < 1 || maxDelay < minDelay || maxDelay > 3600) {
      addToast("间隔必须满足 1 ≤ 最小秒数 ≤ 最大秒数 ≤ 3600", "error");
      return;
    }
    if (
      mode === "leave_selected" &&
      !window.confirm(
        `确认让账号“${accountName}”退出选中的 ${selectedGroupIds.length} 个群组或频道？`,
      )
    ) {
      return;
    }
    try {
      setSubmitting(true);
      const job = await startBulkGroupMembershipJob(token, {
        account_name: accountName,
        mode,
        links: mode === "join" ? parsedLinks : [],
        selected_chat_ids: mode === "leave_selected" ? selectedGroupIds : [],
        min_delay_seconds: minDelay,
        max_delay_seconds: maxDelay,
        auto_wait_flood: autoWaitFlood,
      });
      setSelectedJob(job);
      setJobs((items) => [
        job,
        ...items.filter((item) => item.job_id !== job.job_id),
      ]);
      addToast("批量加退群/频道任务已启动", "success");
    } catch (error: any) {
      addToast(error.message || "启动任务失败", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const stop = async () => {
    if (!token || !selectedJob) return;
    try {
      setStopping(true);
      const updated = await cancelBulkGroupMembershipJob(
        token,
        selectedJob.job_id,
      );
      setSelectedJob(updated);
      setJobs((items) => [
        updated,
        ...items.filter((item) => item.job_id !== updated.job_id),
      ]);
      addToast("停止请求已提交", "success");
    } catch (error: any) {
      addToast(error.message || "停止任务失败", "error");
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="w-full min-h-full flex flex-col">
      <header className="navbar">
        <div className="nav-brand">
          <div className="navbar-title-block">
            <h1 className="nav-title">批量加退群/频道</h1>
            <p className="nav-subtitle">
              按随机间隔批量加入指定群组或频道，或选择退出账号上的群组和频道
            </p>
          </div>
        </div>
        <div className="top-right-actions">
          <button
            className="navbar-text-action"
            onClick={() => token && loadInitial(token)}
            disabled={loading}
          >
            <ArrowClockwise
              className={loading ? "animate-spin" : ""}
              weight="bold"
            />
            刷新
          </button>
        </div>
      </header>

      <main className="main-content !max-w-[1180px] !px-6 !pb-4 !pt-4">
        {loading ? (
          <div className="flex min-h-[50vh] items-center justify-center text-main/35">
            <Spinner className="animate-spin" size={30} />
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(420px,1.1fr)]">
            <section className="glass-panel p-4">
              <div className="mb-3 flex items-center gap-3">
                <div className="grid h-9 w-9 place-items-center rounded-lg bg-violet-500/10 text-violet-400">
                  <UsersThree size={20} weight="duotone" />
                </div>
                <div>
                  <h2 className="font-bold">任务设置</h2>
                  <p className="mt-1 text-xs text-main/40">
                    每个账号同一时间只运行一个加退群/频道任务
                  </p>
                </div>
              </div>

              <label className="text-xs font-semibold">
                Telegram 账号
                <select
                  value={accountName}
                  onChange={(event) => {
                    setAccountName(event.target.value);
                    setSelectedGroupIds([]);
                    setGroupSearch("");
                  }}
                  disabled={active}
                >
                  <option value="">请选择账号</option>
                  {accounts.map((account) => (
                    <option key={account.name} value={account.name}>
                      {account.remark
                        ? `${account.name} · ${account.remark}`
                        : account.name}
                    </option>
                  ))}
                </select>
              </label>

              <div className="mt-3">
                <div className="mb-2 text-xs font-semibold">工作模式</div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    className={`rounded-xl border p-3 text-left transition-all ${mode === "join" ? "border-violet-500/45 bg-violet-500/10" : "border-white/8 bg-main/[0.02] hover:border-white/15"}`}
                    onClick={() => setMode("join")}
                    disabled={active}
                  >
                    <SignIn
                      className="mb-1 text-violet-400"
                      size={19}
                      weight="duotone"
                    />
                    <div className="text-sm font-bold">批量加入</div>
                    <div className="mt-0.5 text-[10px] leading-4 text-main/45">
                      加入公开或私密群组、频道
                    </div>
                  </button>
                  <button
                    type="button"
                    className={`rounded-xl border p-3 text-left transition-all ${mode === "leave_selected" ? "border-rose-500/45 bg-rose-500/10" : "border-white/8 bg-main/[0.02] hover:border-white/15"}`}
                    onClick={() => setMode("leave_selected")}
                    disabled={active}
                  >
                    <SignOut
                      className="mb-1 text-rose-400"
                      size={19}
                      weight="duotone"
                    />
                    <div className="text-sm font-bold">选择退出</div>
                    <div className="mt-0.5 text-[10px] leading-4 text-main/45">
                      从账号已加入的群组、频道中勾选目标
                    </div>
                  </button>
                </div>
              </div>

              {mode === "join" ? (
                <label className="mt-3 block text-xs font-semibold">
                  <span className="flex items-center justify-between">
                    <span>群组或频道链接</span>
                    <span className="font-normal text-main/35">
                      已识别 {parsedLinks.length} 条
                    </span>
                  </span>
                  <div className="relative mt-2">
                    <LinkSimple
                      className="absolute left-3 top-3 text-main/30"
                      size={17}
                    />
                    <textarea
                      className="!mb-2 !mt-0 min-h-[118px] !pl-10 font-mono text-xs leading-5"
                      value={linksText}
                      onChange={(event) => setLinksText(event.target.value)}
                      disabled={active}
                      placeholder={
                        "https://t.me/public_group\nhttps://t.me/public_channel\nhttps://t.me/+privateInviteHash"
                      }
                    />
                  </div>
                  <span className="text-[11px] font-normal leading-5 text-main/40">
                    支持群组或频道的 t.me 链接、@用户名、t.me/+
                    私密邀请链接，每行一个。
                  </span>
                </label>
              ) : (
                <div className="mt-3 rounded-xl border border-rose-500/15 bg-rose-500/[0.04] p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs font-bold text-rose-400">
                      <ShieldWarning size={17} />
                      选择退出群组或频道
                    </div>
                    <button
                      type="button"
                      className="text-[10px] font-semibold text-violet-400 hover:text-violet-300"
                      onClick={() => token && loadGroups(token, accountName)}
                      disabled={groupsLoading || active}
                    >
                      {groupsLoading ? "读取中…" : "刷新列表"}
                    </button>
                  </div>
                  <div className="relative">
                    <MagnifyingGlass
                      className="absolute left-3 top-3 text-main/30"
                      size={15}
                    />
                    <input
                      className="!mb-2 !min-h-9 !pl-9 !text-xs"
                      value={groupSearch}
                      onChange={(event) => setGroupSearch(event.target.value)}
                      placeholder="搜索群组/频道名称、用户名或 ID"
                      disabled={active}
                    />
                  </div>
                  <div className="mb-2 flex items-center justify-between text-[10px] text-main/40">
                    <span>
                      已选择 {selectedGroupIds.length} / {groups.length}
                    </span>
                    <button
                      type="button"
                      className="font-semibold text-violet-400 hover:text-violet-300"
                      disabled={active || !filteredGroups.length}
                      onClick={() => {
                        const visibleIds = filteredGroups.map(
                          (group) => group.id,
                        );
                        const allVisibleSelected = visibleIds.every((id) =>
                          selectedGroupIds.includes(id),
                        );
                        setSelectedGroupIds((current) =>
                          allVisibleSelected
                            ? current.filter((id) => !visibleIds.includes(id))
                            : Array.from(new Set([...current, ...visibleIds])),
                        );
                      }}
                    >
                      {filteredGroups.length > 0 &&
                      filteredGroups.every((group) =>
                        selectedGroupIds.includes(group.id),
                      )
                        ? "取消当前结果"
                        : "全选当前结果"}
                    </button>
                  </div>
                  <div className="custom-scrollbar max-h-[132px] overflow-y-auto rounded-lg border border-white/6 bg-main/[0.02]">
                    {groupsLoading ? (
                      <div className="flex items-center justify-center gap-2 py-8 text-xs text-main/35">
                        <Spinner className="animate-spin" />
                        正在读取群组
                      </div>
                    ) : filteredGroups.length ? (
                      filteredGroups.map((group) => (
                        <label
                          key={group.id}
                          className="!mb-0 flex cursor-pointer items-center gap-2 border-b border-white/5 px-3 py-2 last:border-0 hover:bg-main/[0.03]"
                        >
                          <input
                            type="checkbox"
                            checked={selectedGroupIds.includes(group.id)}
                            onChange={(event) =>
                              setSelectedGroupIds((current) =>
                                event.target.checked
                                  ? [...current, group.id]
                                  : current.filter((id) => id !== group.id),
                              )
                            }
                            disabled={active}
                          />
                          <span className="min-w-0 flex-1">
                            <b className="block truncate text-[11px] text-main/75">
                              {group.title}
                            </b>
                            <span className="block truncate text-[9px] font-normal text-main/35">
                              <span className="mr-1 rounded bg-main/5 px-1 py-0.5">
                                {group.type === "channel" ? "频道" : "群组"}
                              </span>
                              {group.username ? `@${group.username}` : group.id}
                            </span>
                          </span>
                        </label>
                      ))
                    ) : (
                      <div className="py-8 text-center text-xs text-main/35">
                        {groups.length
                          ? "没有匹配的群组或频道"
                          : "当前账号没有可退出的群组或频道"}
                      </div>
                    )}
                  </div>
                  <p className="mt-2 text-[9px] leading-4 text-rose-300/70">
                    仅退出勾选的群组或频道，私聊不会显示在列表中。
                  </p>
                </div>
              )}

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="text-xs font-semibold">
                  最小间隔（秒）
                  <input
                    type="number"
                    min="1"
                    max="3600"
                    value={minDelay}
                    onChange={(event) =>
                      setMinDelay(Number(event.target.value))
                    }
                    disabled={active}
                  />
                </label>
                <label className="text-xs font-semibold">
                  最大间隔（秒）
                  <input
                    type="number"
                    min="1"
                    max="3600"
                    value={maxDelay}
                    onChange={(event) =>
                      setMaxDelay(Number(event.target.value))
                    }
                    disabled={active}
                  />
                </label>
              </div>
              <p className="-mt-1 text-[10px] leading-4 text-main/40">
                每完成一项，会在设定区间内随机等待。间隔过短更容易触发 Telegram
                频率限制。
              </p>

              <label className="mt-3 flex items-start gap-3 rounded-xl border border-white/7 bg-main/[0.02] p-3 text-xs">
                <input
                  type="checkbox"
                  checked={autoWaitFlood}
                  onChange={(event) => setAutoWaitFlood(event.target.checked)}
                  disabled={active}
                />
                <span>
                  <b className="block text-main/75">频繁自动等待</b>
                  <span className="mt-0.5 block text-[10px] leading-4 text-main/40">
                    触发 FloodWait
                    后按服务器指定时间暂停，并自动重试当前项，最多重试 3 次。
                  </span>
                </span>
              </label>

              <div className="mt-3 flex gap-3">
                {active ? (
                  <button
                    className="btn-secondary flex-1 !border-rose-500/25 !text-rose-400"
                    onClick={stop}
                    disabled={stopping || selectedJob?.status === "canceling"}
                  >
                    {stopping || selectedJob?.status === "canceling" ? (
                      <Spinner className="animate-spin" />
                    ) : (
                      <Stop weight="fill" />
                    )}
                    {selectedJob?.status === "canceling"
                      ? "正在安全停止"
                      : "停止任务"}
                  </button>
                ) : (
                  <button
                    className="btn-gradient flex-1"
                    onClick={start}
                    disabled={submitting || !accounts.length}
                  >
                    {submitting ? (
                      <Spinner className="animate-spin" />
                    ) : (
                      <Play weight="fill" />
                    )}
                    开始执行
                  </button>
                )}
              </div>
            </section>

            <div className="space-y-4">
              <section className="glass-panel overflow-hidden">
                <div className="flex items-center justify-between border-b border-white/6 px-4 py-3">
                  <div>
                    <h2 className="text-sm font-bold">执行状态</h2>
                    <p className="mt-1 text-[11px] text-main/35">
                      进度和日志约每 1.5 秒刷新
                    </p>
                  </div>
                  {selectedJob && (
                    <span
                      className={`rounded-full border px-2.5 py-1 text-[10px] font-bold ${statusClass(selectedJob.status)}`}
                    >
                      {statusLabels[selectedJob.status] || selectedJob.status}
                    </span>
                  )}
                </div>

                {selectedJob ? (
                  <div className="p-4">
                    <div className="grid grid-cols-3 gap-2">
                      <Metric label="账号" value={selectedJob.account_name} />
                      <Metric
                        label="已处理"
                        value={`${selectedJob.progress.done}/${selectedJob.progress.total}`}
                      />
                      <Metric
                        label="执行成功"
                        value={String(
                          (selectedJob.summary.joined || 0) +
                            (selectedJob.summary.left || 0) +
                            (selectedJob.summary.already_member || 0),
                        )}
                      />
                    </div>
                    <div className="mt-4 h-2 overflow-hidden rounded-full bg-main/5">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-all duration-500"
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                    <div className="mt-2 flex justify-between text-[10px] text-main/35">
                      <span>
                        {formatConfiguredDateTime(
                          selectedJob.created_at,
                          timezone,
                        )}
                      </span>
                      <span>{progressPercent}%</span>
                    </div>
                    {selectedJob.error && (
                      <div className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-400">
                        {selectedJob.error}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="px-5 py-9 text-center text-main/35">
                    <Clock className="mx-auto mb-3" size={28} />
                    <div className="text-sm">暂无执行任务</div>
                  </div>
                )}
              </section>

              <section className="glass-panel overflow-hidden">
                <div className="border-b border-white/6 px-4 py-3 text-sm font-bold">
                  实时日志
                </div>
                <div className="custom-scrollbar h-[248px] overflow-y-auto">
                  {selectedJob?.logs.length ? (
                    selectedJob.logs.map((log, index) => (
                      <div
                        key={`${log.time}-${index}`}
                        className="border-b border-white/5 px-4 py-3 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          {log.level === "success" ? (
                            <CheckCircle className="text-emerald-400" />
                          ) : log.level === "error" ? (
                            <WarningCircle className="text-rose-400" />
                          ) : (
                            <Clock
                              className={
                                log.level === "warning"
                                  ? "text-amber-400"
                                  : "text-cyan-400"
                              }
                            />
                          )}
                          <span className="font-mono text-[10px] text-main/30">
                            {formatConfiguredDateTime(log.time, timezone)}
                          </span>
                        </div>
                        <div className="mt-1.5 break-words pl-6 leading-5 text-main/65">
                          {log.ref && (
                            <span className="mr-2 text-violet-400">
                              [{log.ref}]
                            </span>
                          )}
                          {log.message}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-main/30">
                      任务启动后将在这里显示执行过程
                    </div>
                  )}
                </div>
              </section>
            </div>

            {jobs.length > 0 && (
              <section className="glass-panel overflow-hidden xl:col-span-2">
                <div className="flex items-center justify-between border-b border-white/6 px-5 py-4">
                  <div className="text-sm font-bold">任务记录</div>
                  <span className="text-[10px] text-main/35">
                    最近 {jobs.length} 条
                  </span>
                </div>
                {jobs.length ? (
                  <div className="custom-scrollbar overflow-x-auto">
                    <table className="w-full min-w-[760px] text-left text-xs">
                      <thead className="bg-main/[0.025] text-main/40">
                        <tr>
                          <th className="px-4 py-3">创建时间</th>
                          <th className="px-4 py-3">账号</th>
                          <th className="px-4 py-3">模式</th>
                          <th className="px-4 py-3">进度</th>
                          <th className="px-4 py-3">状态</th>
                          <th className="px-4 py-3 text-right">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {jobs.map((job) => (
                          <tr
                            key={job.job_id}
                            className={`border-t border-white/5 ${selectedJob?.job_id === job.job_id ? "bg-violet-500/[0.05]" : ""}`}
                          >
                            <td className="px-4 py-3 text-main/45">
                              {formatConfiguredDateTime(
                                job.created_at,
                                timezone,
                              )}
                            </td>
                            <td className="px-4 py-3 font-semibold">
                              {job.account_name}
                            </td>
                            <td className="px-4 py-3">
                              {job.mode === "join"
                                ? "批量加入"
                                : job.mode === "leave_selected"
                                  ? "选择退出"
                                  : "退出所有群组/频道"}
                            </td>
                            <td className="px-4 py-3">
                              {job.progress.done}/{job.progress.total}
                            </td>
                            <td className="px-4 py-3">
                              <span
                                className={`rounded-full border px-2 py-1 text-[10px] font-bold ${statusClass(job.status)}`}
                              >
                                {statusLabels[job.status] || job.status}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <button
                                className="btn-secondary !h-8 !px-3 !py-0 !text-[11px]"
                                onClick={() => setSelectedJob(job)}
                              >
                                查看
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="py-12 text-center text-xs text-main/30">
                    暂无任务记录
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </main>
      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/5 bg-main/[0.02] px-3 py-3">
      <div className="text-[10px] text-main/35">{label}</div>
      <div className="mt-1 truncate text-sm font-bold">{value}</div>
    </div>
  );
}
