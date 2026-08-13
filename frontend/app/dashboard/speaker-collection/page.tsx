"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  DownloadSimple,
  MagnifyingGlass,
  Pause,
  PencilSimple,
  Play,
  Plus,
  Spinner,
  Trash,
  Users,
} from "@phosphor-icons/react";
import { getToken } from "../../../lib/auth";
import {
  AccountInfo,
  ChatInfo,
  SpeakerCollectionConfig,
  SpeakerCollectionRecord,
  deleteSpeakerCollection,
  exportSpeakerCollectionRecords,
  getAccountChats,
  getSpeakerCollectionRecords,
  listAccounts,
  listSpeakerCollections,
  resolveSpeakerCollectionChat,
  saveSpeakerCollection,
  scanSpeakerCollection,
  setSpeakerCollectionEnabled,
} from "../../../lib/api";
import { ToastContainer, useToast } from "../../../components/ui/toast";
import {
  ChatPickerList,
  formatChatSubtitle,
} from "../../../components/ui/chat-picker";
import {
  configuredDateTimeLocalToIso,
  formatConfiguredDateTime,
  formatConfiguredLegacyLocalDateTime,
  toConfiguredDateTimeLocal,
  useConfiguredTimezone,
} from "../../../lib/time";

const parseProfileKeywords = (value: string) =>
  value
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);

const chatLabel = (chat: ChatInfo) => {
  const title = chat.title || chat.username || String(chat.id);
  return chat.username ? `${title} (@${chat.username})` : title;
};

const publicChatUsername = (value: string) => {
  let text = value.trim();
  if (/^(?:https?:\/\/)?t\.me\//i.test(text)) {
    try {
      const url = new URL(text.includes("://") ? text : `https://${text}`);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0]?.toLowerCase() === "s") parts.shift();
      text = parts[0] || "";
    } catch {
      return null;
    }
  }
  text = text.replace(/^@/, "");
  return /^[A-Za-z][A-Za-z0-9_]{2,31}$/.test(text) ? text : null;
};

const monitorStatus = (config: SpeakerCollectionConfig) => {
  switch (config.monitor_status) {
    case "running":
      return {
        label: "后台监控中",
        className: "bg-emerald-500/10 text-emerald-400",
      };
    case "waiting":
      return { label: "等待开始", className: "bg-amber-500/10 text-amber-400" };
    case "completed":
      return { label: "监控已结束", className: "bg-main/5 text-main/40" };
    case "paused":
      return { label: "已暂停", className: "bg-amber-500/10 text-amber-400" };
    default:
      return { label: "单次执行", className: "bg-cyan-500/10 text-cyan-400" };
  }
};

export default function SpeakerCollectionPage() {
  const { toasts, addToast, removeToast } = useToast();
  const timezone = useConfiguredTimezone();
  const [token, setToken] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [chats, setChats] = useState<ChatInfo[]>([]);
  const [chatSearch, setChatSearch] = useState("");
  const [chatPickerOpen, setChatPickerOpen] = useState(false);
  const [resolvingChat, setResolvingChat] = useState(false);
  const [resolvedQuery, setResolvedQuery] = useState("");
  const [profileKeywordsText, setProfileKeywordsText] = useState("");
  const chatPickerRef = useRef<HTMLDivElement>(null);
  const [configs, setConfigs] = useState<SpeakerCollectionConfig[]>([]);
  const [records, setRecords] = useState<SpeakerCollectionRecord[]>([]);
  const [recordsPage, setRecordsPage] = useState(1);
  const [recordsPageSize, setRecordsPageSize] = useState(10);
  const [selectedId, setSelectedId] = useState("");
  const [saving, setSaving] = useState(false);
  const [scanningId, setScanningId] = useState("");
  const [togglingId, setTogglingId] = useState("");
  const [recordsLoadingId, setRecordsLoadingId] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const [tasksCollapsed, setTasksCollapsed] = useState(false);
  const [form, setForm] = useState<SpeakerCollectionConfig>({
    name: "发言者采集",
    account_name: "",
    chat_id: "",
    history_limit: 1000,
    continuous: false,
    enabled: true,
    profile_keywords: [],
  });

  const resetForm = () => {
    setForm({
      name: "发言者采集",
      account_name: form.account_name || accounts[0]?.name || "",
      chat_id: "",
      history_limit: 1000,
      continuous: false,
      enabled: true,
      profile_keywords: [],
    });
    setChatSearch("");
    setProfileKeywordsText("");
    setSelectedId("");
    setRecords([]);
    setRecordsPage(1);
  };

  const refresh = useCallback(async (auth: string) => {
    const [accountData, configData] = await Promise.all([
      listAccounts(auth),
      listSpeakerCollections(auth),
    ]);
    setAccounts(accountData.accounts);
    setConfigs(configData);
    const firstConfig = configData[0];
    if (firstConfig?.id) {
      setForm({
        ...firstConfig,
        profile_keywords: firstConfig.profile_keywords || [],
      });
      setProfileKeywordsText((firstConfig.profile_keywords || []).join("\n"));
      setSelectedId(firstConfig.id);
      setRecords(await getSpeakerCollectionRecords(auth, firstConfig.id));
      setRecordsPage(1);
    } else if (accountData.accounts[0]) {
      setForm((current) =>
        current.account_name
          ? current
          : { ...current, account_name: accountData.accounts[0].name },
      );
    }
  }, []);
  useEffect(() => {
    const auth = getToken();
    if (!auth) {
      window.location.replace("/");
      return;
    }
    setToken(auth);
    refresh(auth).catch((e) => addToast(e.message || "加载失败", "error"));
  }, [addToast, refresh]);
  useEffect(() => {
    if (token && form.account_name) {
      setChats([]);
      getAccountChats(token, form.account_name, true)
        .then(setChats)
        .catch(() => setChats([]));
    }
  }, [token, form.account_name]);
  useEffect(() => {
    const username = publicChatUsername(chatSearch);
    setResolvedQuery("");
    if (!token || !form.account_name || !username) {
      setResolvingChat(false);
      return;
    }
    const normalized = username.toLowerCase();
    const alreadyLoaded = chats.some(
      (chat) => chat.username?.toLowerCase() === normalized,
    );
    if (alreadyLoaded) {
      setResolvingChat(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setResolvingChat(true);
      try {
        const chat = await resolveSpeakerCollectionChat(
          token,
          form.account_name,
          username,
        );
        if (cancelled) return;
        setChats((current) =>
          current.some((item) => String(item.id) === String(chat.id))
            ? current
            : [chat, ...current],
        );
      } catch {
        if (!cancelled) setResolvedQuery(normalized);
      } finally {
        if (!cancelled) setResolvingChat(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [chatSearch, chats, form.account_name, token]);
  useEffect(() => {
    const closePicker = (event: MouseEvent) => {
      if (!chatPickerRef.current?.contains(event.target as Node)) {
        setChatPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", closePicker);
    return () => document.removeEventListener("mousedown", closePicker);
  }, []);
  const loadRecords = async (id: string, notify = false) => {
    if (!token) return;
    try {
      setRecordsLoadingId(id);
      setSelectedId(id);
      const latestRecords = await getSpeakerCollectionRecords(token, id);
      setRecords(latestRecords);
      setRecordsPage(1);
      if (notify) addToast("下方发言者列表已刷新", "success");
    } catch (e: any) {
      addToast(e.message || "刷新发言者列表失败", "error");
    } finally {
      setRecordsLoadingId("");
    }
  };
  const selectConfig = async (
    config: SpeakerCollectionConfig,
    notify = false,
  ) => {
    setForm({ ...config, profile_keywords: config.profile_keywords || [] });
    setProfileKeywordsText((config.profile_keywords || []).join("\n"));
    await loadRecords(config.id || "", notify);
  };
  const save = async () => {
    if (!token || !form.account_name || !form.chat_id)
      return addToast("请选择账号和群组", "error");
    try {
      setSaving(true);
      const saved = await saveSpeakerCollection(token, {
        ...form,
        profile_keywords: parseProfileKeywords(profileKeywordsText),
        enabled: form.enabled !== false,
        start_at: form.start_at || null,
        end_at: form.end_at || null,
      });
      addToast("采集配置已保存", "success");
      setConfigs((items) => [
        saved,
        ...items.filter((item) => item.id !== saved.id),
      ]);
      setSelectedId(saved.id || "");
      setForm(saved);
      setProfileKeywordsText((saved.profile_keywords || []).join("\n"));
      setRecords([]);
      setRecordsPage(1);
    } catch (e: any) {
      addToast(e.message || "保存失败", "error");
    } finally {
      setSaving(false);
    }
  };
  const scan = async (id: string) => {
    if (!token) return;
    try {
      setScanningId(id);
      const result = await scanSpeakerCollection(token, id);
      addToast(
        `已扫描 ${result.scanned_messages || 0} 条消息，读取到 ${result.unique_speakers || 0} 位发言者，新增 ${result.new_speakers || 0} 位`,
        "success",
      );
      setConfigs((items) =>
        items.map((item) =>
          item.id === id
            ? {
                ...item,
                last_scan_summary: result,
                last_scan_at: new Date().toISOString(),
              }
            : item,
        ),
      );
      await loadRecords(id);
    } catch (e: any) {
      addToast(e.message || "扫描失败", "error");
    } finally {
      setScanningId("");
    }
  };
  const toggleMonitoring = async (config: SpeakerCollectionConfig) => {
    if (!token || !config.id || !config.continuous) return;
    const enabled = config.enabled === false;
    try {
      setTogglingId(config.id);
      const updated = await setSpeakerCollectionEnabled(
        token,
        config.id,
        enabled,
      );
      setConfigs((items) =>
        items.map((item) => (item.id === updated.id ? updated : item)),
      );
      if (form.id === updated.id) setForm(updated);
      addToast(enabled ? "持续监控已恢复" : "持续监控已暂停", "success");
    } catch (e: any) {
      addToast(e.message || (enabled ? "恢复失败" : "暂停失败"), "error");
    } finally {
      setTogglingId("");
    }
  };
  const remove = async (id: string) => {
    if (!token || !confirm("删除配置及已收集的发言者记录？")) return;
    try {
      setDeletingId(id);
      await deleteSpeakerCollection(token, id);
      setSelectedId("");
      setRecords([]);
      setRecordsPage(1);
      await refresh(token);
    } catch (e: any) {
      addToast(e.message || "删除失败", "error");
    } finally {
      setDeletingId("");
    }
  };
  const searchedUsername = publicChatUsername(chatSearch);
  const normalizedChatSearch = (
    searchedUsername || chatSearch.trim()
  ).toLowerCase();
  const filteredChats = normalizedChatSearch
    ? chats.filter((chat) =>
        [chat.title, chat.username, String(chat.id)].some((value) =>
          value?.toLowerCase().includes(normalizedChatSearch),
        ),
      )
    : chats;
  const selectedChat = chats.find(
    (chat) => String(chat.id) === String(form.chat_id),
  );
  const recordsPageCount = Math.max(
    1,
    Math.ceil(records.length / recordsPageSize),
  );
  const pagedRecords = useMemo(() => {
    const start = (recordsPage - 1) * recordsPageSize;
    return records.slice(start, start + recordsPageSize);
  }, [records, recordsPage, recordsPageSize]);
  const recordsRangeStart = records.length
    ? (recordsPage - 1) * recordsPageSize + 1
    : 0;
  const recordsRangeEnd = Math.min(
    recordsPage * recordsPageSize,
    records.length,
  );

  return (
    <div className="w-full min-h-full flex flex-col">
      <nav className="navbar">
        <div className="nav-brand">
          <div className="navbar-title-block">
            <h1 className="nav-title">群发言者筛选</h1>
            <div className="nav-subtitle">
              扫描历史消息并持续收集新发言者的公开简介
            </div>
          </div>
        </div>
      </nav>
      <main className="main-content !max-w-none !overflow-visible !pt-7">
        <div className="grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-[minmax(340px,420px)_minmax(0,1fr)]">
          <section className="glass-panel p-5 space-y-4">
            <div className="flex items-center gap-2 font-bold">
              <Users weight="fill" className="text-cyan-400" />
              {form.id ? "编辑采集任务" : "新建采集任务"}
            </div>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="采集名称"
            />
            <select
              value={form.account_name}
              onChange={(e) => {
                setChatSearch("");
                setForm({ ...form, account_name: e.target.value, chat_id: "" });
              }}
            >
              <option value="">选择账号</option>
              {accounts.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
            <div className="chat-picker" ref={chatPickerRef}>
              <div className="chat-picker-label">搜索群/频道</div>
              <div className="relative">
                <MagnifyingGlass
                  className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none z-10"
                  size={16}
                />
                <input
                  className="chat-picker-search-input speaker-chat-search"
                  value={chatSearch}
                  onChange={(e) => {
                    setChatSearch(e.target.value);
                    setChatPickerOpen(true);
                  }}
                  onFocus={() => setChatPickerOpen(true)}
                  placeholder="输入群名称、用户名或 ID 查询"
                  autoComplete="off"
                />
              </div>
              <div className="speaker-chat-select-wrap">
                <button
                  type="button"
                  className={`speaker-chat-select${chatPickerOpen ? " is-open" : ""}`}
                  onClick={() => setChatPickerOpen((open) => !open)}
                  aria-expanded={chatPickerOpen}
                >
                  <span className="truncate">
                    {selectedChat ? chatLabel(selectedChat) : "选择群/频道"}
                  </span>
                  <CaretDown
                    weight="bold"
                    size={14}
                    className={chatPickerOpen ? "rotate-180" : ""}
                  />
                </button>
                {chatPickerOpen && (
                  <div className="speaker-chat-dropdown">
                    <ChatPickerList
                      items={filteredChats.map((chat) => ({
                        id: chat.id,
                        title: chat.title || chat.username || String(chat.id),
                        subtitle: formatChatSubtitle(chat),
                        selected: String(chat.id) === String(form.chat_id),
                      }))}
                      loading={resolvingChat}
                      loadingText="正在通过 Telegram 查询..."
                      emptyText={
                        searchedUsername &&
                        resolvedQuery === searchedUsername.toLowerCase()
                          ? "当前账号在 Telegram 中也未找到该公开群组或频道"
                          : searchedUsername
                            ? "正在等待查询公开群组或频道"
                            : "未找到匹配项；可输入完整的 @用户名或 t.me 链接"
                      }
                      maxHeight="min(360px, 48vh)"
                      multi={false}
                      onSelect={(id) => {
                        const chat = chats.find(
                          (item) => String(item.id) === String(id),
                        );
                        setForm({
                          ...form,
                          chat_id: String(id),
                          chat_name:
                            chat?.title || chat?.username || String(id),
                        });
                        setChatSearch("");
                        setChatPickerOpen(false);
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs">
                开始时间（可选）
                <input
                  type="datetime-local"
                  value={toConfiguredDateTimeLocal(form.start_at, timezone)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      start_at: e.target.value
                        ? configuredDateTimeLocalToIso(e.target.value, timezone)
                        : null,
                    })
                  }
                />
              </label>
              <label className="text-xs">
                结束时间（可选）
                <input
                  type="datetime-local"
                  value={toConfiguredDateTimeLocal(form.end_at, timezone)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      end_at: e.target.value
                        ? configuredDateTimeLocalToIso(e.target.value, timezone)
                        : null,
                    })
                  }
                />
              </label>
            </div>
            <label className="text-xs">
              每次历史消息数
              <input
                type="number"
                min="1"
                max="5000"
                value={form.history_limit || 1000}
                onChange={(e) =>
                  setForm({ ...form, history_limit: Number(e.target.value) })
                }
              />
            </label>
            <label className="text-xs">
              简介关键词（逗号或换行分隔，留空则收集全部发言者）
              <textarea
                className="!mb-0 min-h-[84px]"
                value={profileKeywordsText}
                onChange={(e) => setProfileKeywordsText(e.target.value)}
                placeholder="例如：招聘, 代理, 采购"
              />
            </label>
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={!!form.continuous}
                onChange={(e) =>
                  setForm({
                    ...form,
                    continuous: e.target.checked,
                    enabled: e.target.checked ? true : form.enabled,
                  })
                }
              />
              持续监控新发言（每 30 秒）
            </label>
            <div className="rounded-xl border border-white/8 bg-main/[0.025] px-3 py-2.5 text-xs leading-5 text-main/50">
              {form.continuous
                ? "保存后自动在后台监控。未设置开始时间则立即开始，未设置结束时间则持续运行；到达结束时间后自动停止。"
                : "当前为单次模式。保存任务后，点击任务卡片中的“运行一次”完成一次采集。"}
            </div>
            <button
              className="btn-gradient w-full"
              onClick={save}
              disabled={saving}
            >
              {saving ? (
                <Spinner className="animate-spin" />
              ) : form.id ? (
                <PencilSimple weight="bold" />
              ) : (
                <Plus weight="bold" />
              )}
              {form.id ? "更新配置" : "保存配置"}
            </button>
            <p className="text-xs text-main/45">
              仅收集当前账号已可见消息的发言者，并按群组和用户 ID
              自动去重；不会获取 Telegram 隐藏成员。
            </p>
          </section>
          <section className="min-w-0 space-y-5">
            <div className="glass-panel p-4">
              <div
                className={`flex items-center justify-between gap-3 ${tasksCollapsed ? "" : "mb-3"}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div className="font-bold">采集任务</div>
                  <span className="rounded-full bg-cyan-500/10 px-2 py-0.5 text-[10px] font-bold text-cyan-400">
                    {configs.length}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    className="btn-secondary !px-3 !py-1.5 !text-xs"
                    onClick={() => setTasksCollapsed((collapsed) => !collapsed)}
                  >
                    {tasksCollapsed ? (
                      <CaretDown weight="bold" />
                    ) : (
                      <CaretUp weight="bold" />
                    )}
                    {tasksCollapsed ? "展开任务" : "收起任务"}
                  </button>
                  <button
                    className="btn-secondary !px-3 !py-1.5 !text-xs"
                    onClick={resetForm}
                  >
                    <Plus weight="bold" />
                    新建任务
                  </button>
                </div>
              </div>
              {!tasksCollapsed && (
                <div className="custom-scrollbar grid max-h-[270px] min-w-0 grid-cols-1 gap-2 overflow-y-auto pr-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {configs.map((c) => {
                    const status = monitorStatus(c);
                    const summary = c.last_scan_summary || {};
                    return (
                      <article
                        key={c.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => selectConfig(c)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            selectConfig(c);
                          }
                        }}
                        className={`rounded-xl border p-3 min-w-0 flex flex-col gap-2 transition-colors cursor-pointer ${
                          selectedId === c.id
                            ? "border-cyan-500/35 bg-cyan-500/[0.035]"
                            : "border-white/8 bg-main/[0.02] hover:border-white/15"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <button
                            className="text-left min-w-0 flex-1"
                            onClick={(event) => {
                              event.stopPropagation();
                              selectConfig(c);
                            }}
                          >
                            <div className="truncate text-sm font-bold">
                              {c.name}
                            </div>
                            <div className="mt-0.5 truncate text-[10px] text-main/40">
                              {c.account_name} · {c.chat_name || c.chat_id}
                            </div>
                          </button>
                          <span
                            className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold ${status.className}`}
                          >
                            {status.label}
                          </span>
                        </div>

                        <div className="flex items-center gap-3 rounded-lg bg-main/[0.03] px-2.5 py-1.5 text-[10px]">
                          <span className="text-main/40">
                            消息{" "}
                            <b className="text-main/75">
                              {summary.scanned_messages || 0}
                            </b>
                          </span>
                          <span className="text-main/40">
                            发言者{" "}
                            <b className="text-main/75">
                              {summary.unique_speakers || 0}
                            </b>
                          </span>
                        </div>

                        <div className="truncate text-[10px] text-main/35">
                          最近扫描：
                          {formatConfiguredDateTime(c.last_scan_at, timezone)} ·
                          关键词：
                          {(c.profile_keywords || []).join("、") || "全部"}
                        </div>

                        <div className="mt-auto flex gap-1.5 border-t border-white/5 pt-1.5">
                          <button
                            className="btn-secondary flex-1 !h-8 !py-0 !text-[11px]"
                            onClick={(event) => {
                              event.stopPropagation();
                              scan(c.id || "");
                            }}
                            disabled={
                              !!scanningId || !!togglingId || !!deletingId
                            }
                            title="立即执行一次采集"
                          >
                            {scanningId === c.id ? (
                              <Spinner className="animate-spin" />
                            ) : c.continuous ? (
                              <ArrowClockwise weight="bold" />
                            ) : (
                              <Play weight="bold" />
                            )}
                            运行一次
                          </button>
                          {c.continuous && c.monitor_status !== "completed" && (
                            <button
                              className={`action-btn !h-8 !w-8 ${
                                c.enabled === false
                                  ? "!text-emerald-400"
                                  : "!text-amber-400"
                              }`}
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleMonitoring(c);
                              }}
                              disabled={
                                !!scanningId || !!togglingId || !!deletingId
                              }
                              title={
                                c.enabled === false
                                  ? "恢复持续监控"
                                  : "暂停持续监控"
                              }
                            >
                              {togglingId === c.id ? (
                                <Spinner className="animate-spin" />
                              ) : c.enabled === false ? (
                                <Play weight="bold" />
                              ) : (
                                <Pause weight="bold" />
                              )}
                            </button>
                          )}
                          <button
                            className="action-btn !h-8 !w-8 !text-cyan-400"
                            onClick={(event) => {
                              event.stopPropagation();
                              selectConfig(c, true);
                            }}
                            disabled={!!recordsLoadingId || !!deletingId}
                            title="刷新下方发言者列表"
                          >
                            <ArrowClockwise
                              weight="bold"
                              className={
                                recordsLoadingId === c.id ? "animate-spin" : ""
                              }
                            />
                          </button>
                          <button
                            className="action-btn !h-8 !w-8 !text-rose-400"
                            onClick={(event) => {
                              event.stopPropagation();
                              remove(c.id || "");
                            }}
                            disabled={
                              !!scanningId || !!togglingId || !!deletingId
                            }
                            title="删除任务"
                          >
                            {deletingId === c.id ? (
                              <Spinner className="animate-spin" />
                            ) : (
                              <Trash weight="bold" />
                            )}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                  {!configs.length && (
                    <button
                      className="md:col-span-2 2xl:col-span-3 rounded-xl border border-dashed border-white/10 py-12 text-sm text-main/40 hover:border-cyan-500/30 hover:text-cyan-400 transition-colors"
                      onClick={resetForm}
                    >
                      暂无采集任务，点击新建
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="glass-panel p-0 overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-white/5">
                <div className="min-w-0">
                  <div className="font-bold">
                    已去重发言者 {selectedId ? `(${records.length})` : ""}
                  </div>
                  {selectedId && records.length > 0 && (
                    <div className="text-[10px] text-main/40 mt-1">
                      当前显示第 {recordsRangeStart}–{recordsRangeEnd} 条
                    </div>
                  )}
                </div>
                {selectedId && (
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 text-[11px] text-main/45">
                      每页
                      <select
                        className="!m-0 !h-8 !w-[72px] !px-2 !py-0 text-xs"
                        value={recordsPageSize}
                        onChange={(event) => {
                          setRecordsPageSize(Number(event.target.value));
                          setRecordsPage(1);
                        }}
                      >
                        <option value={10}>10</option>
                        <option value={20}>20</option>
                        <option value={50}>50</option>
                      </select>
                    </label>
                    <button
                      className="action-btn"
                      onClick={() => loadRecords(selectedId, true)}
                      disabled={!!recordsLoadingId}
                      title="刷新列表"
                    >
                      <ArrowClockwise
                        className={recordsLoadingId ? "animate-spin" : ""}
                      />
                    </button>
                    <button
                      className="action-btn"
                      onClick={() =>
                        exportSpeakerCollectionRecords(token!, selectedId)
                      }
                      title="导出 XLSX"
                    >
                      <DownloadSimple />
                    </button>
                  </div>
                )}
              </div>
              <div className="max-w-full overflow-x-auto">
                <table className="w-full min-w-[760px] table-fixed text-xs">
                  <colgroup>
                    <col className="w-[13%]" />
                    <col className="w-[13%]" />
                    <col className="w-[25%]" />
                    <col className="w-[11%]" />
                    <col className="w-[7%]" />
                    <col className="w-[16%]" />
                    <col className="w-[15%]" />
                  </colgroup>
                  <thead className="bg-main/[0.025]">
                    <tr className="text-left text-main/45">
                      <th className="whitespace-nowrap px-5 py-3 font-semibold">
                        发言者
                      </th>
                      <th className="whitespace-nowrap px-3 py-3 font-semibold">
                        用户名
                      </th>
                      <th className="whitespace-nowrap px-3 py-3 font-semibold">
                        简介
                      </th>
                      <th className="whitespace-nowrap px-3 py-3 font-semibold">
                        命中关键词
                      </th>
                      <th className="whitespace-nowrap px-3 py-3 font-semibold text-center">
                        消息数
                      </th>
                      <th className="whitespace-nowrap px-3 py-3 font-semibold">
                        最近发言
                      </th>
                      <th className="whitespace-nowrap px-3 py-3 pr-5 font-semibold">
                        示例消息
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRecords.map((r) => (
                      <tr
                        key={r.id}
                        className="border-t border-white/5 hover:bg-main/[0.025] transition-colors"
                      >
                        <td
                          className="truncate px-5 py-2.5 font-medium"
                          title={r.sender}
                        >
                          {r.profile_url ? (
                            <a
                              className="text-cyan-400"
                              href={r.profile_url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {r.sender}
                            </a>
                          ) : (
                            r.sender
                          )}
                        </td>
                        <td
                          className="truncate px-3 py-2.5"
                          title={r.sender_username || ""}
                        >
                          {r.sender_username ? `@${r.sender_username}` : "--"}
                        </td>
                        <td
                          className="truncate px-3 py-2.5 text-main/65"
                          title={r.bio || ""}
                        >
                          {r.bio || "--"}
                        </td>
                        <td
                          className="truncate px-3 py-2.5"
                          title={(r.matched_keywords || []).join(", ")}
                        >
                          {(r.matched_keywords || []).join(", ") || "--"}
                        </td>
                        <td className="px-3 py-2.5 text-center font-mono">
                          {r.message_count}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-main/55">
                          {formatConfiguredLegacyLocalDateTime(
                            r.last_message_at,
                            timezone,
                          )}
                        </td>
                        <td
                          className="truncate px-3 py-2.5 pr-5 text-main/55"
                          title={r.sample_message || ""}
                        >
                          {r.sample_message}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {selectedId && !records.length && (
                  <div className="py-6 text-center text-main/40">
                    尚未收集到发言者
                  </div>
                )}
              </div>
              {selectedId && records.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-t border-white/5 bg-main/[0.015]">
                  <div className="text-[11px] text-main/40">
                    共 {records.length} 条 · 第 {recordsPage}/{recordsPageCount}{" "}
                    页
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      className="action-btn !w-8 !h-8"
                      onClick={() =>
                        setRecordsPage((page) => Math.max(1, page - 1))
                      }
                      disabled={recordsPage <= 1}
                      title="上一页"
                    >
                      <CaretLeft weight="bold" />
                    </button>
                    <span className="min-w-16 text-center text-xs font-semibold text-main/60">
                      {recordsPage} / {recordsPageCount}
                    </span>
                    <button
                      className="action-btn !w-8 !h-8"
                      onClick={() =>
                        setRecordsPage((page) =>
                          Math.min(recordsPageCount, page + 1),
                        )
                      }
                      disabled={recordsPage >= recordsPageCount}
                      title="下一页"
                    >
                      <CaretRight weight="bold" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </div>
  );
}
