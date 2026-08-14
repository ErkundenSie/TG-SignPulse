"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ArrowClockwise,
  ChatCircleText,
  Check,
  Copy,
  DownloadSimple,
  Eye,
  Lightning,
  PaperPlaneTilt,
  PencilSimple,
  Plus,
  Robot,
  Spinner,
  Trash,
  X,
} from "@phosphor-icons/react";
import { getToken } from "../../../lib/auth";
import {
  AccountInfo,
  ChatInfo,
  MonitorMatchRecord,
  MonitorRule,
  MonitorStatus,
  MonitorTask,
  createMonitorTask,
  deleteMonitorTask,
  exportMonitorRecords,
  getMonitorStatus,
  getMonitorRecords,
  getAccountChats,
  listAccounts,
  listMonitorTasks,
  searchAccountChats,
  updateMonitorTask,
} from "../../../lib/api";
import { ToastContainer, useToast } from "../../../components/ui/toast";
import {
  ChatPickerField,
  ChatPickerList,
  formatChatSubtitle,
} from "../../../components/ui/chat-picker";
import { useLanguage } from "../../../context/LanguageContext";
import {
  formatConfiguredLegacyLocalDateTime,
  useConfiguredTimezone,
} from "../../../lib/time";

const emptyRule = (): MonitorRule => ({
  chat_id: "",
  chat_name: "",
  message_thread_id: null,
  message_thread_ids: [],
  monitor_scope: "selected",
  keywords: [],
  match_mode: "contains",
  ignore_case: true,
  include_self_messages: false,
  time_window_enabled: false,
  active_time_start: "",
  active_time_end: "",
  match_all: false,
  push_channel: "telegram",
  forward_chat_id: "",
  forward_message_thread_id: null,
  auto_reply_text: "",
  ai_auto_reply: false,
  ai_prompt: "",
  ai_persona: "",
  ai_context_messages: 0,
  ai_whitelist_users: [],
  ai_blacklist_users: [],
  ai_daily_limit: null,
  continue_action_interval: 1,
  continue_actions: [],
});

const getChatTitle = (chat: ChatInfo) =>
  chat.title || chat.username || chat.first_name || String(chat.id);

const splitKeywords = (value: string, mode: MonitorRule["match_mode"]) => {
  const splitter = mode === "regex" ? /\n/ : /\n|,/;
  return value
    .split(splitter)
    .map((item) => item.trim())
    .filter(Boolean);
};

const parseOptionalInt = (value: string) => {
  const text = value.trim();
  if (!text) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isNaN(parsed) ? null : parsed;
};

const splitTopicIds = (value: string) => {
  return value
    .split(/\n|,|，/)
    .map((item) => parseOptionalInt(item))
    .filter((item): item is number => typeof item === "number");
};

const splitUserList = (value: string) => {
  return value
    .split(/\n|,|，/)
    .map((item) => item.trim())
    .filter(Boolean);
};

const normalizeChatIdInput = (value: string) => {
  const text = value.trim();
  if (!text) return "";
  if (text.startsWith("@")) return text;
  const parsed = Number.parseInt(text, 10);
  return Number.isNaN(parsed) ? text : parsed;
};

const sanitizeTaskName = (raw: string) =>
  raw
    .trim()
    .replace(/[<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);

const buildUniqueTaskName = (baseName: string, existingNames: string[]) => {
  const cleanBase = sanitizeTaskName(baseName) || "monitor";
  const existing = new Set(existingNames.map((name) => name.toLowerCase()));
  if (!existing.has(cleanBase.toLowerCase())) return cleanBase;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = sanitizeTaskName(`${cleanBase}_copy_${index}`);
    if (candidate && !existing.has(candidate.toLowerCase())) return candidate;
  }
  return `${cleanBase}_${Date.now()}`;
};

type SelectedMonitorChat = {
  chat_id: NonNullable<MonitorRule["chat_id"]>;
  chat_name: string;
};

type RuleDraft = MonitorRule & {
  keywordsText: string;
  topicIdsText: string;
  aiWhitelistText: string;
  aiBlacklistText: string;
  selectedChats: SelectedMonitorChat[];
};

const toDraftRule = (
  rule?: MonitorRule,
  allRules?: MonitorRule[],
): RuleDraft => ({
  ...emptyRule(),
  ...(rule || {}),
  keywordsText: (rule?.keywords || []).join("\n"),
  topicIdsText: (rule?.message_thread_ids?.length
    ? rule.message_thread_ids
    : rule?.message_thread_id
      ? [rule.message_thread_id]
      : []
  ).join("\n"),
  aiWhitelistText: (rule?.ai_whitelist_users || []).join("\n"),
  aiBlacklistText: (rule?.ai_blacklist_users || []).join("\n"),
  selectedChats: (allRules || (rule ? [rule] : []))
    .filter(
      (item) =>
        (item.monitor_scope || "selected") === "selected" &&
        item.chat_id !== undefined &&
        item.chat_id !== null &&
        item.chat_id !== "",
    )
    .map((item) => ({
      chat_id: item.chat_id as NonNullable<MonitorRule["chat_id"]>,
      chat_name: item.chat_name || String(item.chat_id),
    })),
});

const withTimeout = async <T,>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export default function MonitorTasksPage() {
  const { t, language } = useLanguage();
  const searchParams = useSearchParams();
  const selectedAccountName = searchParams.get("account_name") || "";
  const isZh = language === "zh";
  const timezone = useConfiguredTimezone();
  const { toasts, addToast, removeToast } = useToast();
  const addToastRef = useRef(addToast);
  const translateRef = useRef(t);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [tasks, setTasks] = useState<MonitorTask[]>([]);
  const [availableChats, setAvailableChats] = useState<ChatInfo[]>([]);
  const [chatSearch, setChatSearch] = useState("");
  const [chatSearchResults, setChatSearchResults] = useState<ChatInfo[]>([]);
  const [chatSearchLoading, setChatSearchLoading] = useState(false);
  const [editing, setEditing] = useState<MonitorTask | null>(null);
  const [cloneDialog, setCloneDialog] = useState<{
    source: MonitorTask;
    name: string;
  } | null>(null);
  const [statusTask, setStatusTask] = useState<MonitorTask | null>(null);
  const [statusInfo, setStatusInfo] = useState<MonitorStatus | null>(null);
  const [statusRecords, setStatusRecords] = useState<MonitorMatchRecord[]>([]);
  const [statusLoading, setStatusLoading] = useState(false);
  const [exportingRecords, setExportingRecords] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [form, setForm] = useState({
    name: "",
    account_name: "",
    group: "monitors",
    enabled: true,
    rule: toDraftRule(),
  });

  const labels = useMemo(
    () => ({
      title: isZh ? "消息监控" : "Message Monitors",
      subtitle: isZh
        ? "实时监听私聊、群组和频道消息，支持关键词匹配、转发与自动回复"
        : "Monitor private, group, and channel messages with keyword matching, forwarding, and auto replies",
      add: isZh ? "新增监控" : "New Monitor",
      edit: isZh ? "编辑监控" : "Edit Monitor",
      noTasks: isZh ? "还没有监控任务" : "No monitor tasks yet",
      noTasksDesc: isZh
        ? "添加一个监听来源，配置关键词、转发或自动回复。"
        : "Add a source chat, then configure keywords, forwarding, or auto replies.",
      source: isZh ? "监听来源" : "Source",
      handling: isZh ? "命中处理" : "Match Handling",
      account: isZh ? "监听账号" : "Account",
      group: isZh ? "分组" : "Group",
      monitorName: isZh ? "监控名称" : "Monitor Name",
      chatSearch: isZh ? "搜索最近会话" : "Search recent chats",
      manualChat: isZh
        ? "手动 Chat ID / @username"
        : "Manual Chat ID / @username",
      topic: isZh ? "话题 / Thread IDs" : "Topic / Thread IDs",
      keywords: isZh ? "关键词 / 正则" : "Keywords / Regex",
      keywordsHint: isZh
        ? "每行或逗号分隔一个关键词；正则模式建议每行一个表达式。"
        : "Use one keyword per line or comma; regex mode should use one expression per line.",
      matchMode: isZh ? "匹配方式" : "Match Mode",
      ignoreCase: isZh ? "忽略大小写" : "Ignore Case",
      includeSelf: isZh ? "监听自己发送的消息" : "Include My Own Messages",
      includeSelfHint: isZh
        ? "默认关闭，避免自动回复自己触发循环。"
        : "Off by default to avoid self-trigger loops.",
      pushChannel: isZh ? "处理方式" : "Action",
      forwardChat: isZh
        ? "转发目标 Chat ID / @username"
        : "Forward Target Chat ID / @username",
      forwardTopic: isZh ? "转发目标话题 ID" : "Forward Topic ID",
      autoReply: isZh ? "自动回复文本" : "Auto Reply Text",
      aiAutoReply: isZh ? "AI 自动回复" : "AI Auto Reply",
      aiPrompt: isZh ? "AI 回复提示词" : "AI Reply Prompt",
      aiPromptPlaceholder: isZh
        ? "可选：例如“你是客服助手，回答要简短友好。”"
        : "Optional: e.g. You are a support assistant. Keep replies short and friendly.",
      aiPersona: isZh ? "账号独立 Persona" : "Account Persona",
      aiPersonaPlaceholder: isZh
        ? "可选：例如“你是小明，语气轻松，只回答业务相关问题。”"
        : "Optional: e.g. You are Alex, casual tone, answer business questions only.",
      aiContextMessages: isZh ? "最近上下文条数" : "Recent Context",
      aiContextHint: isZh
        ? "0=不带历史，建议 4-10；最多 20 条。"
        : "0=no history; 4-10 recommended; max 20.",
      aiWhitelist: isZh ? "白名单联系人" : "Contact Allowlist",
      aiWhitelistPlaceholder: isZh
        ? "留空=不限；每行一个 user_id / username"
        : "Blank = all; one user_id / username per line",
      aiBlacklist: isZh ? "黑名单联系人" : "Contact Blocklist",
      aiBlacklistPlaceholder: isZh
        ? "每行一个 user_id / username，命中后不回复"
        : "One user_id / username per line; matched users are skipped",
      aiDailyLimit: isZh ? "每日回复上限" : "Daily Reply Limit",
      aiDailyLimitHint: isZh
        ? "留空=不限；0=今天不自动回复。"
        : "Blank = unlimited; 0 = do not auto reply today.",
      barkUrl: "Bark URL",
      customUrl: isZh ? "自定义推送 URL" : "Custom Push URL",
      enabled: isZh ? "启用监听" : "Enabled",
      save: isZh ? "保存监控" : "Save Monitor",
      deleteConfirm: isZh
        ? "确定删除这个监控任务吗？"
        : "Delete this monitor task?",
      saved: isZh
        ? "监控已保存，后台监听已刷新"
        : "Monitor saved and background listener refreshed",
      deleted: isZh ? "监控已删除" : "Monitor deleted",
      selectChat: isZh ? "选择会话" : "Select Chat",
      telegramNotify: isZh ? "Telegram Bot 通知" : "Telegram Bot Notify",
      forward: isZh ? "转发消息" : "Forward",
      bark: "Bark",
      custom: isZh ? "自定义 URL" : "Custom URL",
      reply: isZh ? "自动回复" : "Auto Reply",
      status: isZh ? "运行状态" : "Runtime Status",
      statusEmpty: isZh
        ? "暂无运行日志，保存后请稍等几秒再刷新。"
        : "No runtime logs yet. Wait a few seconds after saving, then refresh.",
      viewStatus: isZh ? "查看运行状态" : "View Runtime Status",
      exportRecords: isZh ? "导出命中记录" : "Export Match Records",
      recordsTitle: isZh ? "去重命中记录" : "Deduplicated Match Records",
      recordsEmpty: isZh ? "还没有命中记录。" : "No matched records yet.",
      recordsCount: isZh ? "去重条数" : "Unique Records",
      hitCount: isZh ? "命中次数" : "Hits",
      latestHit: isZh ? "最近命中" : "Latest Hit",
      firstHit: isZh ? "首次命中" : "First Hit",
      recordKeyword: isZh ? "关键词" : "Keyword",
      recordSender: isZh ? "发送人" : "Sender",
      openLink: isZh ? "打开链接" : "Open Link",
      clone: isZh ? "克隆监控" : "Clone Monitor",
      cloneName: isZh ? "新监控名称" : "New Monitor Name",
      cloneDesc: isZh
        ? "将复制当前监控的监听来源、关键词和处理方式。"
        : "Copies the source, keywords, and match handling.",
      cloned: isZh ? "监控已克隆" : "Monitor cloned",
      cloneFailed: isZh ? "克隆监控失败" : "Clone monitor failed",
      cloneNameExists: isZh
        ? "该监控名称已存在"
        : "A monitor with this name already exists",
      cloneNameRequired: isZh
        ? "请填写新监控名称"
        : "New monitor name is required",
    }),
    [isZh],
  );

  const extraLabels = useMemo(
    () => ({
      scope: isZh ? "监听范围" : "Scope",
      selectedScope: isZh ? "指定会话" : "Selected Chat",
      privateScope: isZh ? "私聊监控" : "Private Chats",
      privateHint: isZh
        ? "只监听该账号的私人对话消息。"
        : "Only monitor private one-to-one conversations for this account.",
      topicPlaceholder: isZh
        ? "留空=全部话题；多个用逗号或换行，例如 1, 3, 8"
        : "Blank = all topics; use commas or new lines, e.g. 1, 3, 8",
      timeWindow: isZh ? "限定监控时间段" : "Limit Active Time",
      timeWindowHint: isZh
        ? "关闭时全天实时监控；开启后只在这个时间段内处理命中消息，支持跨午夜。"
        : "Off means always realtime; when enabled, matches only during this time window, including overnight ranges.",
      startTime: isZh ? "开始时间" : "Start Time",
      endTime: isZh ? "结束时间" : "End Time",
      matchAll: isZh ? "任意私聊消息都触发" : "Trigger on any private message",
      matchAllHint: isZh
        ? "适合私聊自动回复；开启后可不填写关键词，仍受时间段限制。"
        : "Useful for private auto replies; keywords become optional and active time still applies.",
    }),
    [isZh],
  );

  const matchModeHelp = useMemo(
    () => ({
      contains: isZh
        ? "contains：消息里包含关键词就命中，例如关键词 test 可匹配 hello test。"
        : "contains: matches when the message contains a keyword, e.g. test matches hello test.",
      exact: isZh
        ? "exact：整条消息必须和关键词完全一致，适合口令类消息。"
        : "exact: the whole message must equal the keyword, useful for command-like messages.",
      regex: isZh
        ? "regex：使用正则表达式匹配，每行一个表达式，例如 ^订单\\d+$。"
        : "regex: match with regular expressions, one expression per line, e.g. ^order\\d+$.",
    }),
    [isZh],
  );

  const formatError = useCallback((fallback: string, err: any) => {
    return err?.message ? `${fallback}: ${err.message}` : fallback;
  }, []);

  useEffect(() => {
    addToastRef.current = addToast;
    translateRef.current = t;
  }, [addToast, t]);

  const loadData = useCallback(
    async (tokenStr: string) => {
      setLoading(true);
      try {
        const monitorData = await withTimeout(
          listMonitorTasks(tokenStr),
          12000,
          "monitor list",
        );
        setTasks(monitorData);
      } catch (err: any) {
        addToastRef.current(
          formatError(translateRef.current("load_failed"), err),
          "error",
        );
      } finally {
        setLoading(false);
      }

      try {
        const accountData = await withTimeout(
          listAccounts(tokenStr),
          12000,
          "account list",
        );
        setAccounts(accountData.accounts);
        setForm((prev) =>
          prev.account_name ||
          !(selectedAccountName || accountData.accounts[0]?.name)
            ? prev
            : {
                ...prev,
                account_name:
                  selectedAccountName || accountData.accounts[0].name,
              },
        );
      } catch (err: any) {
        addToastRef.current(
          formatError(translateRef.current("load_failed"), err),
          "error",
        );
      }
    },
    [formatError, selectedAccountName],
  );

  const loadChats = useCallback(
    async (tokenStr: string, accountName: string) => {
      if (!accountName) return;
      try {
        const chats = await getAccountChats(tokenStr, accountName);
        setAvailableChats(chats);
      } catch {
        setAvailableChats([]);
      }
    },
    [],
  );

  useEffect(() => {
    const tokenStr = getToken();
    if (!tokenStr) {
      window.location.replace("/");
      return;
    }
    setToken(tokenStr);
    loadData(tokenStr);
  }, [loadData]);

  useEffect(() => {
    if (token && form.account_name && showEditor) {
      loadChats(token, form.account_name);
    }
  }, [token, form.account_name, showEditor, loadChats]);

  useEffect(() => {
    if (!token || !form.account_name || !showEditor) return;
    const query = chatSearch.trim();
    if (!query) {
      setChatSearchResults([]);
      setChatSearchLoading(false);
      return;
    }
    let cancelled = false;
    setChatSearchLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await searchAccountChats(
          token,
          form.account_name,
          query,
          30,
          0,
        );
        if (!cancelled) setChatSearchResults(res.items || []);
      } catch {
        if (!cancelled) setChatSearchResults([]);
      } finally {
        if (!cancelled) setChatSearchLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [chatSearch, token, form.account_name, showEditor]);

  const openCreate = () => {
    setEditing(null);
    setChatSearch("");
    setForm({
      name: "",
      account_name: selectedAccountName || accounts[0]?.name || "",
      group: "monitors",
      enabled: true,
      rule: toDraftRule(),
    });
    setShowEditor(true);
  };

  const openEdit = (task: MonitorTask) => {
    setEditing(task);
    setChatSearch("");
    setForm({
      name: task.name,
      account_name: task.account_name,
      group: task.group || "monitors",
      enabled: task.enabled,
      rule: toDraftRule(task.rules[0], task.rules),
    });
    setShowEditor(true);
  };

  const updateRule = (patch: Partial<RuleDraft>) => {
    setForm((prev) => ({ ...prev, rule: { ...prev.rule, ...patch } }));
  };

  const setManualChat = (value: string) => {
    const text = value.trim();
    const chatId = normalizeChatIdInput(text);
    updateRule({
      chat_id: text,
      chat_name: text,
      selectedChats: chatId ? [{ chat_id: chatId, chat_name: text }] : [],
    });
  };

  const selectChat = (chat: ChatInfo) => {
    const chatName = getChatTitle(chat);
    const chatId = chat.id;
    const exists = currentRule.selectedChats.some(
      (item) => String(item.chat_id) === String(chatId),
    );
    const selectedChats = exists
      ? currentRule.selectedChats.filter(
          (item) => String(item.chat_id) !== String(chatId),
        )
      : [
          ...currentRule.selectedChats,
          { chat_id: chatId, chat_name: chatName },
        ];
    updateRule({
      selectedChats,
      chat_id: selectedChats[0]?.chat_id || "",
      chat_name: selectedChats[0]?.chat_name || "",
      monitor_scope: "selected",
    });
  };

  const saveMonitor = async () => {
    if (!token) return;
    const name = sanitizeTaskName(form.name);
    const accountName = form.account_name.trim();
    const groupName = form.group.trim() || "monitors";
    const monitorScope = form.rule.monitor_scope || "selected";
    const topicIds = splitTopicIds(form.rule.topicIdsText || "");
    const sourceChatId = normalizeChatIdInput(String(form.rule.chat_id || ""));
    const sourceChatName =
      form.rule.chat_name || String(form.rule.chat_id || "");
    const selectedChats =
      monitorScope === "selected"
        ? form.rule.selectedChats.length > 0
          ? form.rule.selectedChats
          : sourceChatId
            ? [{ chat_id: sourceChatId, chat_name: sourceChatName }]
            : []
        : [];
    const aiContextMessages = Math.min(
      Math.max(Number(form.rule.ai_context_messages || 0), 0),
      20,
    );
    const rawDailyLimit = String(form.rule.ai_daily_limit ?? "").trim();
    const parsedDailyLimit = rawDailyLimit
      ? Number.parseInt(rawDailyLimit, 10)
      : null;
    const aiDailyLimit =
      parsedDailyLimit === null || Number.isNaN(parsedDailyLimit)
        ? null
        : Math.max(parsedDailyLimit, 0);
    const aiWhitelistUsers = splitUserList(form.rule.aiWhitelistText || "");
    const aiBlacklistUsers = splitUserList(form.rule.aiBlacklistText || "");
    const baseRule: MonitorRule = {
      ...form.rule,
      monitor_scope: monitorScope,
      chat_id: monitorScope === "selected" ? sourceChatId : monitorScope,
      chat_name:
        monitorScope === "private"
          ? isZh
            ? "私聊监控"
            : "Private Chats"
          : sourceChatName,
      message_thread_id: topicIds[0] ?? null,
      message_thread_ids: topicIds,
      keywords: splitKeywords(form.rule.keywordsText, form.rule.match_mode),
      include_self_messages: Boolean(form.rule.include_self_messages),
      time_window_enabled: Boolean(form.rule.time_window_enabled),
      active_time_start: form.rule.time_window_enabled
        ? String(form.rule.active_time_start || "").trim() || null
        : null,
      active_time_end: form.rule.time_window_enabled
        ? String(form.rule.active_time_end || "").trim() || null
        : null,
      match_all: Boolean(form.rule.match_all),
      forward_chat_id:
        normalizeChatIdInput(String(form.rule.forward_chat_id || "")) || null,
      forward_message_thread_id: parseOptionalInt(
        String(form.rule.forward_message_thread_id || ""),
      ),
      bark_url: String(form.rule.bark_url || "").trim() || null,
      custom_url: String(form.rule.custom_url || "").trim() || null,
      auto_reply_text: String(form.rule.auto_reply_text || "").trim() || null,
      ai_auto_reply: Boolean(form.rule.ai_auto_reply),
      ai_prompt: String(form.rule.ai_prompt || "").trim() || null,
      ai_persona: String(form.rule.ai_persona || "").trim() || null,
      ai_context_messages: aiContextMessages,
      ai_whitelist_users: aiWhitelistUsers,
      ai_blacklist_users: aiBlacklistUsers,
      ai_daily_limit: aiDailyLimit,
      continue_actions:
        form.rule.push_channel === "continue"
          ? form.rule.ai_auto_reply
            ? [
                {
                  action: 11,
                  prompt: String(form.rule.ai_prompt || "").trim() || undefined,
                  persona:
                    String(form.rule.ai_persona || "").trim() || undefined,
                  context_messages: aiContextMessages,
                  whitelist_users: aiWhitelistUsers,
                  blacklist_users: aiBlacklistUsers,
                  daily_limit: aiDailyLimit ?? undefined,
                },
              ]
            : String(form.rule.auto_reply_text || "").trim()
              ? [
                  {
                    action: 1,
                    text: String(form.rule.auto_reply_text || "").trim(),
                  },
                ]
              : []
          : [],
    };
    const rules: MonitorRule[] =
      monitorScope === "selected"
        ? selectedChats.map((chat) => ({
            ...baseRule,
            chat_id: chat.chat_id,
            chat_name: chat.chat_name,
          }))
        : [baseRule];
    if (
      !name ||
      !accountName ||
      (monitorScope === "selected" && selectedChats.length === 0) ||
      (!baseRule.match_all && baseRule.keywords.length === 0)
    ) {
      addToast(
        isZh
          ? "请填写名称、账号、监听来源；未开启任意消息触发时还需要关键词"
          : "Name, account, source chat are required; keywords are required unless trigger-any is enabled",
        "error",
      );
      return;
    }
    if (
      baseRule.time_window_enabled &&
      (!baseRule.active_time_start || !baseRule.active_time_end)
    ) {
      addToast(
        isZh
          ? "请填写完整的监控开始和结束时间"
          : "Start and end time are required for active time window",
        "error",
      );
      return;
    }
    if (baseRule.push_channel === "forward" && !baseRule.forward_chat_id) {
      addToast(
        isZh ? "请填写转发目标 Chat ID" : "Forward target Chat ID is required",
        "error",
      );
      return;
    }
    if (
      baseRule.push_channel === "continue" &&
      !baseRule.ai_auto_reply &&
      !baseRule.auto_reply_text
    ) {
      addToast(
        isZh
          ? "请填写自动回复文本，或开启 AI 自动回复"
          : "Auto reply text is required, or enable AI auto reply",
        "error",
      );
      return;
    }
    try {
      setLoading(true);
      if (editing) {
        await updateMonitorTask(
          token,
          editing.name,
          {
            name,
            account_name: accountName,
            enabled: form.enabled,
            group: groupName,
            rules,
          },
          editing.account_name,
        );
      } else {
        await createMonitorTask(token, {
          name,
          account_name: accountName,
          group: groupName,
          enabled: form.enabled,
          rules,
        });
      }
      addToast(labels.saved, "success");
      setShowEditor(false);
      await loadData(token);
    } catch (err: any) {
      addToast(formatError(t("save_failed"), err), "error");
    } finally {
      setLoading(false);
    }
  };

  const openCloneDialog = (task: MonitorTask) => {
    const defaultName = buildUniqueTaskName(
      `${task.name}_copy`,
      tasks.map((item) => item.name),
    );
    setCloneDialog({ source: task, name: defaultName });
  };

  const cloneMonitor = async () => {
    if (!token) return;
    if (!cloneDialog) return;
    const task = cloneDialog.source;
    const name = sanitizeTaskName(cloneDialog.name);
    if (!name) {
      addToast(labels.cloneNameRequired, "error");
      return;
    }
    if (tasks.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
      addToast(labels.cloneNameExists, "error");
      return;
    }
    try {
      setLoading(true);
      await createMonitorTask(token, {
        name,
        account_name: task.account_name,
        group: task.group || "monitors",
        enabled: task.enabled,
        rules: task.rules,
      });
      addToast(labels.cloned, "success");
      setCloneDialog(null);
      await loadData(token);
    } catch (err: any) {
      addToast(formatError(labels.cloneFailed, err), "error");
    } finally {
      setLoading(false);
    }
  };

  const removeMonitor = async (task: MonitorTask) => {
    if (!token || !confirm(labels.deleteConfirm)) return;
    try {
      setLoading(true);
      await deleteMonitorTask(token, task.name, task.account_name);
      addToast(labels.deleted, "success");
      await loadData(token);
    } catch (err: any) {
      addToast(formatError(t("delete_failed"), err), "error");
    } finally {
      setLoading(false);
    }
  };

  const openStatus = async (task: MonitorTask) => {
    if (!token) return;
    setStatusTask(task);
    setStatusInfo(null);
    setStatusRecords([]);
    setStatusLoading(true);
    try {
      const [info, records] = await Promise.all([
        getMonitorStatus(token, task.name, task.account_name),
        getMonitorRecords(token, task.name, task.account_name, 200),
      ]);
      setStatusInfo(info);
      setStatusRecords(records);
    } catch (err: any) {
      addToast(formatError(t("load_failed"), err), "error");
    } finally {
      setStatusLoading(false);
    }
  };

  const downloadRecords = async (task: MonitorTask) => {
    if (!token) return;
    try {
      setExportingRecords(true);
      await exportMonitorRecords(token, task.name, task.account_name);
    } catch (err: any) {
      addToast(formatError(labels.exportRecords, err), "error");
    } finally {
      setExportingRecords(false);
    }
  };

  const visibleChats = chatSearch.trim()
    ? chatSearchResults
    : availableChats.slice(0, 80);
  const currentRule = form.rule;
  const statusLogs = Array.isArray(statusInfo?.logs) ? statusInfo.logs : [];
  const groupedTasks = useMemo(() => {
    const groups = new Map<string, MonitorTask[]>();
    for (const task of tasks) {
      const groupName = (task.group || "monitors").trim() || "monitors";
      const label =
        groupName === "monitors" ? (isZh ? "默认分组" : "Default") : groupName;
      groups.set(label, [...(groups.get(label) || []), task]);
    }
    return Array.from(groups.entries());
  }, [isZh, tasks]);

  if (!token) return null;

  return (
    <div id="monitor-view" className="w-full h-full flex flex-col">
      <nav className="navbar">
        <div className="nav-brand min-w-0">
          <div className="flex items-center min-w-0">
            <div className="navbar-title-block">
              <h1 className="nav-title">{labels.title}</h1>
              <p className="nav-subtitle">{labels.subtitle}</p>
            </div>
          </div>
        </div>
        <div className="top-right-actions shrink-0">
          <button
            type="button"
            onClick={() => loadData(token)}
            disabled={loading}
            className="action-btn"
            title={t("refresh_list")}
          >
            <ArrowClockwise
              weight="bold"
              className={loading ? "animate-spin" : ""}
            />
          </button>
          <button
            type="button"
            onClick={openCreate}
            className="action-btn !text-primary hover:!bg-primary/10"
            title={labels.add}
          >
            <Plus weight="bold" />
          </button>
        </div>
      </nav>

      <main className="main-content dashboard-module-content !pt-6">
        {loading && tasks.length === 0 ? (
          <div className="py-20 flex justify-center text-main/30">
            <Spinner className="animate-spin" size={32} />
          </div>
        ) : tasks.length === 0 ? (
          <div
            className="glass-panel p-12 flex flex-col items-center text-center border-dashed border-2 cursor-pointer"
            onClick={openCreate}
          >
            <div className="w-16 h-16 rounded-2xl bg-cyan-500/10 text-cyan-400 flex items-center justify-center mb-4">
              <Plus weight="bold" size={30} />
            </div>
            <h3 className="text-xl font-bold mb-2">{labels.noTasks}</h3>
            <p className="text-sm text-main/45">{labels.noTasksDesc}</p>
          </div>
        ) : (
          <div className="space-y-7">
            {groupedTasks.map(([groupName, groupTasks]) => (
              <section key={groupName} className="space-y-3">
                <div className="flex items-center gap-3">
                  <h3 className="text-sm font-bold text-main/70">
                    {groupName}
                  </h3>
                  <span className="text-[10px] text-main/35">
                    {groupTasks.length}
                  </span>
                </div>
                <div className="dashboard-module-grid">
                  {groupTasks.map((task) => {
                    const rule = task.rules[0];
                    const channel = rule?.push_channel || "telegram";
                    const scope = rule?.monitor_scope || "selected";
                    const sourceLabel =
                      scope === "private"
                        ? extraLabels.privateScope
                        : task.rules.length > 1
                          ? `${task.rules.length} ${isZh ? "个会话" : "chats"}`
                          : rule?.chat_name || rule?.chat_id;
                    return (
                      <div
                        key={`${task.account_name}-${task.name}`}
                        className="dashboard-module-card glass-panel p-4 flex flex-col gap-3"
                      >
                        <div className="flex justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span
                                className={`text-[9px] font-bold px-2 py-0.5 rounded-full border ${task.enabled ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-white/5 text-main/30 border-white/10"}`}
                              >
                                {task.enabled
                                  ? t("status_active")
                                  : t("status_paused")}
                              </span>
                              <span className="text-[10px] text-main/35 font-mono truncate">
                                {task.account_name}
                              </span>
                            </div>
                            <h3 className="font-bold text-base truncate">
                              {task.name}
                            </h3>
                          </div>
                          <div className="w-9 h-9 rounded-lg bg-cyan-500/10 text-cyan-400 flex items-center justify-center shrink-0">
                            <ChatCircleText weight="fill" size={18} />
                          </div>
                        </div>
                        <div className="space-y-2 text-xs">
                          <div className="flex justify-between gap-3 rounded-lg bg-white/5 border border-white/5 px-3 py-1.5">
                            <span className="text-main/40">
                              {labels.source}
                            </span>
                            <span className="font-mono text-main/75 truncate">
                              {sourceLabel}
                            </span>
                          </div>
                          {rule?.time_window_enabled && (
                            <div className="flex justify-between gap-3 rounded-lg bg-white/5 border border-white/5 px-3 py-1.5">
                              <span className="text-main/40">
                                {extraLabels.timeWindow}
                              </span>
                              <span className="font-mono text-cyan-400">
                                {rule.active_time_start || "--:--"} -{" "}
                                {rule.active_time_end || "--:--"}
                              </span>
                            </div>
                          )}
                          <div className="flex justify-between gap-3 rounded-lg bg-white/5 border border-white/5 px-3 py-1.5">
                            <span className="text-main/40">
                              {labels.pushChannel}
                            </span>
                            <span className="text-cyan-400 font-bold">
                              {channel}
                            </span>
                          </div>
                        </div>
                        <div className="mt-auto flex justify-end gap-2 border-t border-white/5 pt-3">
                          <button
                            onClick={() => openStatus(task)}
                            className="action-btn !text-emerald-400 hover:bg-emerald-500/10"
                            title={labels.viewStatus}
                          >
                            <Eye weight="bold" size={18} />
                          </button>
                          <button
                            onClick={() => openEdit(task)}
                            className="action-btn"
                            title={t("edit")}
                          >
                            <PencilSimple weight="bold" size={18} />
                          </button>
                          <button
                            onClick={() => openCloneDialog(task)}
                            className="action-btn !text-sky-400 hover:bg-sky-500/10"
                            title={labels.clone}
                          >
                            <Copy weight="bold" size={18} />
                          </button>
                          <button
                            onClick={() => removeMonitor(task)}
                            className="action-btn !text-rose-400 hover:bg-rose-500/10"
                            title={t("delete")}
                          >
                            <Trash weight="bold" size={18} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>

      {showEditor && (
        <div className="modal-overlay active">
          <div
            className="modal-content monitor-editor monitor-editor-shell !w-[min(96vw,1120px)] !max-w-[1120px] !h-[min(92vh,900px)] !p-0 overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="monitor-editor-header p-5 border-b flex justify-between items-center">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-xl bg-cyan-500/10 text-cyan-500 flex items-center justify-center shrink-0">
                  <Eye weight="bold" size={18} />
                </div>
                <div className="min-w-0">
                  <div className="font-bold text-[15px] truncate">
                    {editing ? labels.edit : labels.add}
                  </div>
                  <div className="text-[11px] text-main/45 mt-0.5 truncate">
                    {labels.subtitle}
                  </div>
                </div>
              </div>
              <button
                onClick={() => setShowEditor(false)}
                className="action-btn !w-8 !h-8"
              >
                <X weight="bold" />
              </button>
            </div>

            <div className="monitor-editor-body p-5 grid grid-cols-1 lg:grid-cols-[0.96fr_1.04fr] gap-5 flex-1 min-h-0 overflow-y-auto custom-scrollbar">
              <section>
                <div className="monitor-editor-card">
                  <div className="monitor-editor-card-title">
                    <Lightning weight="fill" className="text-violet-500" />
                    {isZh ? "基本信息" : "Basics"}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="monitor-editor-label">
                        {labels.monitorName}
                      </label>
                      <input
                        className="!mb-0"
                        value={form.name}
                        onChange={(e) =>
                          setForm({ ...form, name: e.target.value })
                        }
                        placeholder="monitor_gifts"
                      />
                    </div>
                    <div>
                      <label className="monitor-editor-label">
                        {labels.group}
                      </label>
                      <input
                        className="!mb-0"
                        value={form.group}
                        onChange={(e) =>
                          setForm({ ...form, group: e.target.value })
                        }
                        placeholder="monitors"
                      />
                    </div>
                  </div>
                  <div className="monitor-editor-meta mt-3">
                    <div className="min-w-0">
                      <div className="monitor-editor-meta-title">
                        {labels.account}
                      </div>
                      <div className="monitor-editor-meta-value truncate">
                        {form.account_name || "-"}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setForm({ ...form, enabled: !form.enabled })
                      }
                      className={`monitor-editor-toggle ${form.enabled ? "is-on" : ""}`}
                    >
                      {form.enabled ? labels.enabled : t("status_paused")}
                    </button>
                  </div>
                </div>

                <div className="monitor-editor-card">
                  <div className="monitor-editor-card-title">
                    <ChatCircleText weight="fill" className="text-cyan-500" />
                    {labels.source}
                  </div>
                  <div className="space-y-3">
                    <div>
                      <label className="monitor-editor-label">
                        {extraLabels.scope}
                      </label>
                      <div className="monitor-editor-choice-grid cols-2">
                        {(
                          [
                            ["selected", extraLabels.selectedScope],
                            ["private", extraLabels.privateScope],
                          ] as const
                        ).map(([scope, label]) => (
                          <button
                            key={scope}
                            type="button"
                            onClick={() => updateRule({ monitor_scope: scope })}
                            className={`monitor-editor-choice ${currentRule.monitor_scope === scope ? "is-active" : ""}`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      {currentRule.monitor_scope !== "selected" && (
                        <div className="monitor-editor-help mt-3">
                          {extraLabels.privateHint}
                        </div>
                      )}
                    </div>
                    {currentRule.monitor_scope === "selected" && (
                      <ChatPickerField
                        searchValue={chatSearch}
                        onSearchChange={setChatSearch}
                        searchPlaceholder={labels.chatSearch}
                      >
                        <ChatPickerList
                          maxHeight={192}
                          loading={chatSearchLoading}
                          loadingText={t("loading")}
                          emptyText={labels.selectChat}
                          items={visibleChats.map((chat) => ({
                            id: chat.id,
                            title: getChatTitle(chat),
                            subtitle: formatChatSubtitle(chat),
                            selected: currentRule.selectedChats.some(
                              (item) =>
                                String(item.chat_id) === String(chat.id),
                            ),
                          }))}
                          onSelect={(id) => {
                            const chat = visibleChats.find(
                              (item) => item.id === id,
                            );
                            if (chat) selectChat(chat);
                          }}
                        />
                      </ChatPickerField>
                    )}
                    {currentRule.monitor_scope === "selected" &&
                      currentRule.selectedChats.length > 0 && (
                        <div className="chat-picker-chips">
                          {currentRule.selectedChats.map((chat) => (
                            <button
                              key={String(chat.chat_id)}
                              type="button"
                              onClick={() => {
                                const selectedChats =
                                  currentRule.selectedChats.filter(
                                    (item) =>
                                      String(item.chat_id) !==
                                      String(chat.chat_id),
                                  );
                                updateRule({
                                  selectedChats,
                                  chat_id: selectedChats[0]?.chat_id || "",
                                  chat_name: selectedChats[0]?.chat_name || "",
                                });
                              }}
                              className="chat-picker-chip"
                            >
                              <span className="chat-picker-chip-text">
                                {chat.chat_name}
                              </span>
                              <span aria-hidden>×</span>
                            </button>
                          ))}
                        </div>
                      )}
                    {currentRule.monitor_scope === "selected" && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className="monitor-editor-label">
                            {labels.manualChat}
                          </label>
                          <input
                            className="!mb-0"
                            value={String(currentRule.chat_id || "")}
                            onChange={(e) => setManualChat(e.target.value)}
                            placeholder="-1001234567890 / @channel"
                          />
                        </div>
                        <div>
                          <label className="monitor-editor-label">
                            {labels.topic}
                          </label>
                          <input
                            className="!mb-0"
                            value={currentRule.topicIdsText || ""}
                            onChange={(e) =>
                              updateRule({ topicIdsText: e.target.value })
                            }
                            placeholder={extraLabels.topicPlaceholder}
                          />
                        </div>
                      </div>
                    )}
                    <div className="monitor-editor-help space-y-3">
                      <label className="inline-flex items-start gap-2 text-xs cursor-pointer">
                        <input
                          type="checkbox"
                          checked={Boolean(currentRule.time_window_enabled)}
                          onChange={(e) =>
                            updateRule({
                              time_window_enabled: e.target.checked,
                            })
                          }
                          className="accent-cyan-500 mt-0.5"
                        />
                        <span>
                          <span className="block font-bold text-[12px] text-main">
                            {extraLabels.timeWindow}
                          </span>
                          <span className="block text-[11px] text-main/45 mt-0.5">
                            {extraLabels.timeWindowHint}
                          </span>
                        </span>
                      </label>
                      {currentRule.time_window_enabled && (
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="monitor-editor-label">
                              {extraLabels.startTime}
                            </label>
                            <input
                              className="!mb-0"
                              type="time"
                              value={currentRule.active_time_start || ""}
                              onChange={(e) =>
                                updateRule({
                                  active_time_start: e.target.value,
                                })
                              }
                            />
                          </div>
                          <div>
                            <label className="monitor-editor-label">
                              {extraLabels.endTime}
                            </label>
                            <input
                              className="!mb-0"
                              type="time"
                              value={currentRule.active_time_end || ""}
                              onChange={(e) =>
                                updateRule({
                                  active_time_end: e.target.value,
                                })
                              }
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </section>

              <section>
                <div className="monitor-editor-card">
                  <div className="monitor-editor-card-title">
                    <Lightning weight="fill" className="text-violet-500" />
                    {labels.matchMode}
                  </div>
                  <div className="monitor-editor-choice-grid cols-3">
                    {(["contains", "exact", "regex"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => updateRule({ match_mode: mode })}
                        className={`monitor-editor-choice is-violet ${currentRule.match_mode === mode ? "is-active" : ""}`}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                  <div className="monitor-editor-help mt-3">
                    {matchModeHelp[currentRule.match_mode]}
                  </div>
                  <div className="mt-3">
                    <label className="monitor-editor-label">
                      {labels.keywords}
                    </label>
                    <textarea
                      className="!mb-0 min-h-[120px] custom-scrollbar"
                      value={currentRule.keywordsText}
                      onChange={(e) =>
                        updateRule({ keywordsText: e.target.value })
                      }
                      placeholder={labels.keywords}
                    />
                    <div className="monitor-editor-hint">
                      {labels.keywordsHint}
                    </div>
                  </div>
                  <div className="mt-3 space-y-3">
                    <label className="inline-flex items-start gap-2 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(currentRule.match_all)}
                        onChange={(e) =>
                          updateRule({ match_all: e.target.checked })
                        }
                        className="accent-violet-500 mt-0.5"
                      />
                      <span>
                        <span className="block font-semibold text-[12px]">
                          {extraLabels.matchAll}
                        </span>
                        <span className="block text-[11px] text-main/45 mt-0.5">
                          {extraLabels.matchAllHint}
                        </span>
                      </span>
                    </label>
                    <label className="inline-flex items-center gap-2 text-xs cursor-pointer font-semibold">
                      <input
                        type="checkbox"
                        checked={currentRule.ignore_case}
                        onChange={(e) =>
                          updateRule({ ignore_case: e.target.checked })
                        }
                        className="accent-violet-500"
                      />
                      {labels.ignoreCase}
                    </label>
                    <label className="inline-flex items-start gap-2 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(currentRule.include_self_messages)}
                        onChange={(e) =>
                          updateRule({
                            include_self_messages: e.target.checked,
                          })
                        }
                        className="accent-violet-500 mt-0.5"
                      />
                      <span>
                        <span className="block font-semibold text-[12px]">
                          {labels.includeSelf}
                        </span>
                        <span className="block text-[11px] text-main/45 mt-0.5">
                          {labels.includeSelfHint}
                        </span>
                      </span>
                    </label>
                  </div>
                </div>

                <div className="monitor-editor-card">
                  <div className="monitor-editor-card-title">
                    <PaperPlaneTilt
                      weight="fill"
                      className="text-emerald-500"
                    />
                    {labels.handling}
                  </div>
                  <div>
                    <label className="monitor-editor-label">
                      {labels.pushChannel}
                    </label>
                    <select
                      className="!mb-0"
                      value={currentRule.push_channel}
                      onChange={(e) =>
                        updateRule({
                          push_channel: e.target
                            .value as MonitorRule["push_channel"],
                        })
                      }
                    >
                      <option value="telegram">{labels.telegramNotify}</option>
                      <option value="forward">{labels.forward}</option>
                      <option value="continue">{labels.reply}</option>
                      <option value="bark">{labels.bark}</option>
                      <option value="custom">{labels.custom}</option>
                    </select>
                  </div>

                  {currentRule.push_channel === "forward" && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                      <div>
                        <label className="monitor-editor-label">
                          {labels.forwardChat}
                        </label>
                        <input
                          className="!mb-0"
                          value={String(currentRule.forward_chat_id || "")}
                          onChange={(e) =>
                            updateRule({ forward_chat_id: e.target.value })
                          }
                          placeholder="-1009876543210 / @target"
                        />
                      </div>
                      <div>
                        <label className="monitor-editor-label">
                          {labels.forwardTopic}
                        </label>
                        <input
                          className="!mb-0"
                          inputMode="numeric"
                          value={currentRule.forward_message_thread_id || ""}
                          onChange={(e) =>
                            updateRule({
                              forward_message_thread_id: parseOptionalInt(
                                e.target.value,
                              ),
                            })
                          }
                        />
                      </div>
                    </div>
                  )}

                  {currentRule.push_channel === "continue" && (
                    <div className="space-y-3 mt-3">
                      <label className="inline-flex items-center gap-2 text-xs cursor-pointer">
                        <input
                          type="checkbox"
                          checked={Boolean(currentRule.ai_auto_reply)}
                          onChange={(e) =>
                            updateRule({ ai_auto_reply: e.target.checked })
                          }
                          className="accent-emerald-500"
                        />
                        <span className="font-bold flex items-center gap-1">
                          <Robot weight="bold" />
                          {labels.aiAutoReply}
                        </span>
                      </label>
                      {currentRule.ai_auto_reply ? (
                        <div className="space-y-3">
                          <div>
                            <label className="monitor-editor-label flex items-center gap-1">
                              <Robot weight="bold" />
                              {labels.aiPrompt}
                            </label>
                            <textarea
                              className="!mb-0 min-h-[96px] custom-scrollbar"
                              value={currentRule.ai_prompt || ""}
                              onChange={(e) =>
                                updateRule({ ai_prompt: e.target.value })
                              }
                              placeholder={labels.aiPromptPlaceholder}
                            />
                          </div>
                          <div>
                            <label className="monitor-editor-label">
                              {labels.aiPersona}
                            </label>
                            <textarea
                              className="!mb-0 min-h-[88px] custom-scrollbar"
                              value={currentRule.ai_persona || ""}
                              onChange={(e) =>
                                updateRule({ ai_persona: e.target.value })
                              }
                              placeholder={labels.aiPersonaPlaceholder}
                            />
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div>
                              <label className="monitor-editor-label">
                                {labels.aiContextMessages}
                              </label>
                              <input
                                className="!mb-0"
                                type="number"
                                min={0}
                                max={20}
                                value={currentRule.ai_context_messages ?? 0}
                                onChange={(e) =>
                                  updateRule({
                                    ai_context_messages: Math.min(
                                      Math.max(Number(e.target.value || 0), 0),
                                      20,
                                    ),
                                  })
                                }
                              />
                              <div className="text-[10px] text-main/35 mt-1">
                                {labels.aiContextHint}
                              </div>
                            </div>
                            <div>
                              <label className="monitor-editor-label">
                                {labels.aiDailyLimit}
                              </label>
                              <input
                                className="!mb-0"
                                type="number"
                                min={0}
                                value={currentRule.ai_daily_limit ?? ""}
                                onChange={(e) =>
                                  updateRule({
                                    ai_daily_limit:
                                      e.target.value === ""
                                        ? null
                                        : Math.max(
                                            Number(e.target.value || 0),
                                            0,
                                          ),
                                  })
                                }
                                placeholder={isZh ? "不限" : "Unlimited"}
                              />
                              <div className="text-[10px] text-main/35 mt-1">
                                {labels.aiDailyLimitHint}
                              </div>
                            </div>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div>
                              <label className="monitor-editor-label">
                                {labels.aiWhitelist}
                              </label>
                              <textarea
                                className="!mb-0 min-h-[88px] custom-scrollbar"
                                value={currentRule.aiWhitelistText || ""}
                                onChange={(e) =>
                                  updateRule({
                                    aiWhitelistText: e.target.value,
                                  })
                                }
                                placeholder={labels.aiWhitelistPlaceholder}
                              />
                            </div>
                            <div>
                              <label className="monitor-editor-label">
                                {labels.aiBlacklist}
                              </label>
                              <textarea
                                className="!mb-0 min-h-[88px] custom-scrollbar"
                                value={currentRule.aiBlacklistText || ""}
                                onChange={(e) =>
                                  updateRule({
                                    aiBlacklistText: e.target.value,
                                  })
                                }
                                placeholder={labels.aiBlacklistPlaceholder}
                              />
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <label className="monitor-editor-label flex items-center gap-1">
                            <Robot weight="bold" />
                            {labels.autoReply}
                          </label>
                          <textarea
                            className="!mb-0 min-h-[96px] custom-scrollbar"
                            value={currentRule.auto_reply_text || ""}
                            onChange={(e) =>
                              updateRule({ auto_reply_text: e.target.value })
                            }
                            placeholder="{keyword}"
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {currentRule.push_channel === "bark" && (
                    <div className="mt-3">
                      <label className="monitor-editor-label">
                        {labels.barkUrl}
                      </label>
                      <input
                        className="!mb-0"
                        value={currentRule.bark_url || ""}
                        onChange={(e) =>
                          updateRule({ bark_url: e.target.value })
                        }
                        placeholder="https://api.day.app/key"
                      />
                    </div>
                  )}

                  {currentRule.push_channel === "custom" && (
                    <div className="mt-3">
                      <label className="monitor-editor-label">
                        {labels.customUrl}
                      </label>
                      <input
                        className="!mb-0"
                        value={currentRule.custom_url || ""}
                        onChange={(e) =>
                          updateRule({ custom_url: e.target.value })
                        }
                        placeholder="https://example.com/tg"
                      />
                    </div>
                  )}
                </div>
              </section>
            </div>

            <div className="monitor-editor-footer p-5 border-t flex gap-3 shrink-0">
              <button
                onClick={() => setShowEditor(false)}
                className="btn-secondary flex-1"
              >
                {t("cancel")}
              </button>
              <button
                onClick={saveMonitor}
                disabled={loading}
                className="btn-gradient flex-1"
              >
                {loading ? (
                  <Spinner className="animate-spin" />
                ) : (
                  <Check weight="bold" />
                )}
                {labels.save}
              </button>
            </div>
          </div>
        </div>
      )}

      {cloneDialog && (
        <div className="modal-overlay active">
          <div
            className="glass-panel modal-content !max-w-md !p-0 overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 border-b border-white/5 flex justify-between items-center bg-white/2">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-xl bg-sky-500/10 text-sky-400 flex items-center justify-center shrink-0">
                  <Copy weight="bold" size={18} />
                </div>
                <div className="min-w-0">
                  <div className="font-bold">{labels.clone}</div>
                  <div className="text-[10px] text-main/40 truncate">
                    {cloneDialog.source.name}
                  </div>
                </div>
              </div>
              <button
                onClick={() => setCloneDialog(null)}
                className="action-btn !w-8 !h-8"
                disabled={loading}
              >
                <X weight="bold" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-xs text-main/60">{labels.cloneDesc}</p>
              <div className="rounded-xl border border-white/5 bg-black/[0.03] px-3 py-2">
                <div className="text-[10px] text-main/35 font-bold uppercase tracking-wider">
                  {cloneDialog.source.account_name}
                </div>
                <div className="mt-1 text-xs text-main/50 truncate">
                  {cloneDialog.source.group || "monitors"}
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase tracking-wider text-main/40 mb-1 block">
                  {labels.cloneName}
                </label>
                <input
                  className="!mb-0"
                  autoFocus
                  value={cloneDialog.name}
                  onChange={(e) =>
                    setCloneDialog({ ...cloneDialog, name: e.target.value })
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      cloneMonitor();
                    }
                  }}
                />
                {sanitizeTaskName(cloneDialog.name) &&
                  tasks.some(
                    (task) =>
                      task.name.toLowerCase() ===
                      sanitizeTaskName(cloneDialog.name).toLowerCase(),
                  ) && (
                    <p className="text-[11px] text-rose-400">
                      {labels.cloneNameExists}
                    </p>
                  )}
              </div>
            </div>
            <div className="p-5 border-t border-white/5 bg-black/10 flex gap-3">
              <button
                onClick={() => setCloneDialog(null)}
                disabled={loading}
                className="btn-secondary flex-1"
              >
                {t("cancel")}
              </button>
              <button
                onClick={cloneMonitor}
                disabled={
                  loading ||
                  !sanitizeTaskName(cloneDialog.name) ||
                  tasks.some(
                    (task) =>
                      task.name.toLowerCase() ===
                      sanitizeTaskName(cloneDialog.name).toLowerCase(),
                  )
                }
                className="btn-gradient flex-1"
              >
                {loading ? (
                  <Spinner className="animate-spin" />
                ) : (
                  <Copy weight="bold" />
                )}
                {labels.clone}
              </button>
            </div>
          </div>
        </div>
      )}

      {statusTask && (
        <div className="modal-overlay active">
          <div
            className="glass-panel modal-content !max-w-5xl !p-0 overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 border-b border-white/5 flex justify-between items-center bg-white/2">
              <div>
                <div className="text-lg font-bold">{labels.status}</div>
                <div className="text-xs text-main/40 font-mono">
                  {statusTask.account_name} / {statusTask.name}
                </div>
              </div>
              <button
                onClick={() => setStatusTask(null)}
                className="action-btn"
              >
                <X weight="bold" />
              </button>
            </div>
            <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto custom-scrollbar">
              {statusLoading ? (
                <div className="py-12 flex justify-center text-main/35">
                  <Spinner className="animate-spin" size={28} />
                </div>
              ) : statusInfo ? (
                <>
                  <div
                    className={`rounded-xl border px-4 py-3 ${statusInfo.active ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300" : "border-amber-500/20 bg-amber-500/10 text-amber-300"}`}
                  >
                    <div className="text-sm font-bold">
                      {statusInfo.message || labels.statusEmpty}
                    </div>
                    {statusInfo.time && (
                      <div className="text-[10px] opacity-70 mt-1">
                        {formatConfiguredLegacyLocalDateTime(
                          statusInfo.time,
                          timezone,
                        )}
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_0.9fr] gap-4">
                    <div className="rounded-xl border border-white/5 bg-black/20 p-4 font-mono text-xs leading-6 text-main/70 whitespace-pre-wrap">
                      {statusLogs.length > 0
                        ? statusLogs.join("\n")
                        : labels.statusEmpty}
                    </div>
                    <div className="rounded-xl border border-white/5 bg-black/20 p-4">
                      <div className="flex items-center justify-between gap-3 mb-3">
                        <div>
                          <div className="text-sm font-bold">
                            {labels.recordsTitle}
                          </div>
                          <div className="text-[10px] text-main/40">
                            {labels.recordsCount}: {statusRecords.length}
                          </div>
                        </div>
                        <button
                          onClick={() => downloadRecords(statusTask)}
                          disabled={exportingRecords}
                          className="action-btn !text-cyan-400 hover:bg-cyan-500/10"
                          title={labels.exportRecords}
                        >
                          {exportingRecords ? (
                            <Spinner className="animate-spin" size={16} />
                          ) : (
                            <DownloadSimple weight="bold" size={18} />
                          )}
                        </button>
                      </div>
                      {statusRecords.length > 0 ? (
                        <div className="space-y-3 max-h-[48vh] overflow-y-auto custom-scrollbar pr-1">
                          {statusRecords.map((record) => (
                            <div
                              key={record.fingerprint}
                              className="rounded-xl border border-white/5 bg-white/[0.03] p-3"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="font-bold text-sm truncate">
                                    {record.chat_name || record.chat_id || "-"}
                                  </div>
                                  <div className="text-[10px] text-main/35 font-mono truncate">
                                    {labels.recordKeyword}:{" "}
                                    {record.matched_keyword || "-"}
                                  </div>
                                </div>
                                <div className="text-right shrink-0">
                                  <div className="text-xs font-bold text-cyan-400">
                                    {labels.hitCount}: {record.hit_count}
                                  </div>
                                  <div className="text-[10px] text-main/35">
                                    {record.match_mode}
                                  </div>
                                </div>
                              </div>
                              <div className="mt-2 text-[11px] text-main/45 space-y-1">
                                <div>
                                  {labels.recordSender}:{" "}
                                  {record.sender ||
                                    record.sender_username ||
                                    record.sender_id ||
                                    "-"}
                                </div>
                                <div>
                                  {labels.firstHit}:{" "}
                                  {formatConfiguredLegacyLocalDateTime(
                                    record.first_seen_at,
                                    timezone,
                                  )}
                                </div>
                                <div>
                                  {labels.latestHit}:{" "}
                                  {formatConfiguredLegacyLocalDateTime(
                                    record.last_seen_at,
                                    timezone,
                                  )}
                                </div>
                              </div>
                              <div className="mt-3 rounded-lg bg-black/20 border border-white/5 p-2 text-xs text-main/70 whitespace-pre-wrap break-words">
                                {record.message_text ||
                                  record.message_preview ||
                                  "-"}
                              </div>
                              {record.message_url && (
                                <div className="mt-2">
                                  <a
                                    href={record.message_url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-[11px] text-cyan-400 hover:text-cyan-300 break-all"
                                  >
                                    {labels.openLink}
                                  </a>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="py-8 text-center text-xs text-main/35">
                          {labels.recordsEmpty}
                        </div>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <div className="py-12 text-center text-main/35">
                  {labels.statusEmpty}
                </div>
              )}
            </div>
            <div className="p-5 border-t border-white/5 bg-black/10 flex gap-3">
              <button
                onClick={() => openStatus(statusTask)}
                disabled={statusLoading}
                className="btn-gradient flex-1"
              >
                {statusLoading ? (
                  <Spinner className="animate-spin" />
                ) : (
                  <ArrowClockwise weight="bold" />
                )}
                {t("refresh_list")}
              </button>
              <button
                onClick={() => downloadRecords(statusTask)}
                disabled={exportingRecords}
                className="btn-secondary flex-1"
              >
                {exportingRecords ? (
                  <Spinner className="animate-spin" />
                ) : (
                  <DownloadSimple weight="bold" />
                )}
                {labels.exportRecords}
              </button>
              <button
                onClick={() => setStatusTask(null)}
                className="btn-secondary flex-1"
              >
                {t("close")}
              </button>
            </div>
          </div>
        </div>
      )}

      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </div>
  );
}
