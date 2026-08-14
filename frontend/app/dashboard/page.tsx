"use client";

import { useEffect, useState, useCallback, useRef, ChangeEvent } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getToken } from "../../lib/auth";
import {
  listAccounts,
  startAccountLogin,
  startQrLogin,
  getQrLoginStatus,
  cancelQrLogin,
  submitQrPassword,
  updateAccount,
  verifyAccountLogin,
  deleteAccount,
  downloadChatMigrationJson,
  getImportAccountChatsJob,
  getAccountChatsExport,
  importAccountChats,
  startImportAccountChatsJob,
  cancelImportAccountChatsJob,
  getAccountLogs,
  clearAccountLogs,
  listSignTasks,
  AccountInfo,
  AccountStatusItem,
  AccountLog,
  ChatMigrationExportScope,
  ChatMigrationExportPayload,
  ChatMigrationItem,
  ChatMigrationImportJobResponse,
  ChatMigrationImportResponse,
  SignTask,
} from "../../lib/api";
import {
  Lightning,
  Plus,
  ListDashes,
  Clock,
  Spinner,
  X,
  Play,
  PencilSimple,
  PaperPlaneRight,
  Trash,
  ChatCircleText,
  DownloadSimple,
  UploadSimple,
  WarningCircle,
  ArrowsOutSimple,
  Stop,
  Robot,
  SignIn,
} from "@phosphor-icons/react";
import { ToastContainer, useToast } from "../../components/ui/toast";
import { ThemeLanguageToggle } from "../../components/ThemeLanguageToggle";
import {
  CHAT_IMPORT_JOB_HISTORY_STORAGE_KEY,
  CHAT_IMPORT_JOB_STORAGE_KEY,
  loadChatImportJobHistory,
  saveChatImportJobToHistory,
} from "../../lib/chat-import-jobs";
import { useLanguage } from "../../context/LanguageContext";
import {
  formatConfiguredDateTime,
  formatConfiguredLegacyLocalDateTime,
  useConfiguredTimezone,
} from "../../lib/time";

type ChatMigrationSummary = Record<string, number>;
const CHAT_IMPORT_BATCH_SIZE = 30;

const EMPTY_LOGIN_DATA = {
  account_name: "",
  phone_number: "",
  proxy: "",
  phone_code: "",
  password: "",
  phone_code_hash: "",
};

export default function Dashboard() {
  const router = useRouter();
  const { t } = useLanguage();
  const timezone = useConfiguredTimezone();
  const { toasts, addToast, removeToast } = useToast();
  const [token, setLocalToken] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [tasks, setTasks] = useState<SignTask[]>([]);
  const [loading, setLoading] = useState(false);

  // 日志弹窗
  const [showLogsDialog, setShowLogsDialog] = useState(false);
  const [logsAccountName, setLogsAccountName] = useState("");
  const [accountLogs, setAccountLogs] = useState<AccountLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  // 添加账号对话框
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [loginData, setLoginData] = useState({ ...EMPTY_LOGIN_DATA });
  const [reloginAccountName, setReloginAccountName] = useState<string | null>(
    null,
  );
  const [loginMode, setLoginMode] = useState<"phone" | "qr">("phone");
  const [qrLogin, setQrLogin] = useState<{
    login_id: string;
    qr_uri: string;
    qr_image?: string | null;
    expires_at: string;
  } | null>(null);
  type QrPhase =
    | "idle"
    | "loading"
    | "ready"
    | "scanning"
    | "password"
    | "success"
    | "expired"
    | "error";
  const [qrStatus, setQrStatus] = useState<
    | "waiting_scan"
    | "scanned_wait_confirm"
    | "password_required"
    | "success"
    | "expired"
    | "failed"
  >("waiting_scan");
  const [qrPhase, setQrPhase] = useState<QrPhase>("idle");
  const [qrMessage, setQrMessage] = useState<string>("");
  const [qrCountdown, setQrCountdown] = useState<number>(0);
  const [qrLoading, setQrLoading] = useState(false);
  const [qrPassword, setQrPassword] = useState("");
  const [qrPasswordLoading, setQrPasswordLoading] = useState(false);
  const qrPasswordRef = useRef("");
  const qrPasswordLoadingRef = useRef(false);

  const qrPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrCountdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const qrPollDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qrActiveLoginIdRef = useRef<string | null>(null);
  const qrPollSeqRef = useRef(0);
  const qrToastShownRef = useRef<
    Record<string, { expired?: boolean; error?: boolean }>
  >({});
  const qrPollingActiveRef = useRef(false);
  const qrRestartingRef = useRef(false);
  const qrAutoRefreshRef = useRef(0);

  useEffect(() => {
    qrPasswordRef.current = qrPassword;
  }, [qrPassword]);

  useEffect(() => {
    qrPasswordLoadingRef.current = qrPasswordLoading;
  }, [qrPasswordLoading]);

  // 编辑账号对话框
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editData, setEditData] = useState({
    account_name: "",
    remark: "",
    proxy: "",
  });
  const [showChatExportDialog, setShowChatExportDialog] = useState(false);
  const [chatExportAccount, setChatExportAccount] = useState("");
  const [chatExportScope, setChatExportScope] =
    useState<ChatMigrationExportScope>("all");
  const [chatExportLoading, setChatExportLoading] = useState(false);
  const [chatExportError, setChatExportError] = useState("");
  const [chatExportPayload, setChatExportPayload] =
    useState<ChatMigrationExportPayload | null>(null);
  const [chatExportSelectedIds, setChatExportSelectedIds] = useState<
    Record<string, boolean>
  >({});
  const [chatExportSearch, setChatExportSearch] = useState("");
  const [showChatImportDialog, setShowChatImportDialog] = useState(false);
  const [chatImportAccount, setChatImportAccount] = useState("");
  const [chatImportJson, setChatImportJson] = useState("");
  const [chatImportShowJson, setChatImportShowJson] = useState(true);
  const [chatImportPayload, setChatImportPayload] = useState<Record<
    string,
    any
  > | null>(null);
  const [chatImportExistingPayload, setChatImportExistingPayload] =
    useState<ChatMigrationExportPayload | null>(null);
  const [chatImportSelectedIds, setChatImportSelectedIds] = useState<
    Record<string, boolean>
  >({});
  const [chatImportSearch, setChatImportSearch] = useState("");
  const [chatImportDryRun, setChatImportDryRun] = useState(false);
  const [chatImportDelay, setChatImportDelay] = useState(5);
  const [chatImportLoading, setChatImportLoading] = useState(false);
  const [chatImportProgress, setChatImportProgress] = useState("");
  const [chatImportError, setChatImportError] = useState("");
  const [chatImportResult, setChatImportResult] =
    useState<ChatMigrationImportResponse | null>(null);
  const [chatImportJob, setChatImportJob] =
    useState<ChatMigrationImportJobResponse | null>(null);
  const [chatImportJobHistory, setChatImportJobHistory] = useState<
    ChatMigrationImportJobResponse[]
  >([]);
  const [chatImportJobActionLoading, setChatImportJobActionLoading] =
    useState(false);

  const normalizeAccountName = useCallback((name: string) => name.trim(), []);

  const sanitizeAccountName = (name: string) =>
    name.replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, "");

  const isDuplicateAccountName = useCallback(
    (name: string, allowedSameName?: string | null) => {
      const normalized = normalizeAccountName(name).toLowerCase();
      if (!normalized) return false;
      const allow = normalizeAccountName(allowedSameName || "").toLowerCase();
      return accounts.some((acc) => {
        const current = acc.name.toLowerCase();
        if (allow && current === allow && normalized === allow) {
          return false;
        }
        return current === normalized;
      });
    },
    [accounts, normalizeAccountName],
  );

  const [checking, setChecking] = useState(true);
  const [accountStatusMap, setAccountStatusMap] = useState<
    Record<string, AccountStatusItem>
  >({});

  const addToastRef = useRef(addToast);
  const tRef = useRef(t);

  useEffect(() => {
    addToastRef.current = addToast;
  }, [addToast]);

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const formatErrorMessage = useCallback(
    (key: string, err?: any, detail = false) => {
      const base = tRef.current ? tRef.current(key) : key;
      const code = err?.code;
      const errorDetail = detail ? err?.message : "";
      const suffix = errorDetail ? `: ${errorDetail}` : "";
      return code ? `${base} (${code})${suffix}` : `${base}${suffix}`;
    },
    [],
  );

  const getChatMigrationItemKey = useCallback(
    (
      item: Pick<ChatMigrationItem, "id" | "title" | "username" | "type">,
      index: number,
    ) =>
      `${item.id ?? item.username ?? item.title ?? "chat"}-${item.type ?? "unknown"}-${index}`,
    [],
  );

  const getChatJoinType = useCallback(
    (item: Pick<ChatMigrationItem, "join">) => {
      const joinType = item.join?.type;
      if (joinType === "username" || joinType === "invite_link")
        return joinType;
      return "none";
    },
    [],
  );

  const getChatMembershipKeys = useCallback((item: ChatMigrationItem) => {
    const keys: string[] = [];
    if (item.id !== undefined && item.id !== null) keys.push(`id:${item.id}`);

    const addUsername = (value?: string | null) => {
      const normalized = String(value || "")
        .trim()
        .replace(/^@/, "")
        .toLowerCase();
      if (normalized) keys.push(`username:${normalized}`);
    };

    addUsername(item.username);
    if (item.join?.type === "username") {
      addUsername(item.join.value || item.join.url);
    }
    return keys;
  }, []);

  const getExistingChatMembershipKeys = useCallback(() => {
    const keys = new Set<string>();
    const items = (chatImportExistingPayload?.items ||
      []) as ChatMigrationItem[];
    for (const item of items) {
      getChatMembershipKeys(item).forEach((key) => keys.add(key));
    }
    return keys;
  }, [chatImportExistingPayload, getChatMembershipKeys]);

  const isChatAlreadyJoined = useCallback(
    (item: ChatMigrationItem) => {
      const existingKeys = getExistingChatMembershipKeys();
      return getChatMembershipKeys(item).some((key) => existingKeys.has(key));
    },
    [getChatMembershipKeys, getExistingChatMembershipKeys],
  );

  const summarizeMigrationItems = useCallback(
    (items: Pick<ChatMigrationItem, "join">[]): ChatMigrationSummary => {
      const total = items.length;
      const joinable = items.filter((item) =>
        ["username", "invite_link"].includes(getChatJoinType(item)),
      ).length;
      return {
        total,
        joinable,
        manual_required: total - joinable,
      };
    },
    [getChatJoinType],
  );

  const countSelectedChats = useCallback(
    (selected: Record<string, boolean>) =>
      Object.values(selected).filter(Boolean).length,
    [],
  );

  const getSelectedMigrationItems = useCallback(
    <T extends ChatMigrationItem>(
      items: T[],
      selected: Record<string, boolean>,
    ) =>
      items.filter((item, index) =>
        Boolean(selected[getChatMigrationItemKey(item, index)]),
      ),
    [getChatMigrationItemKey],
  );

  const filterMigrationItems = useCallback(
    <T extends ChatMigrationItem>(items: T[], search: string) => {
      const keyword = search.trim().toLowerCase();
      if (!keyword) return items.map((item, index) => ({ item, index }));
      return items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => {
          const text = [
            item.title,
            item.username,
            item.type,
            item.export_note,
            item.join?.url,
            item.join?.value,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return text.includes(keyword);
        });
    },
    [],
  );

  const getMigrationStatCards = useCallback(
    (items: ChatMigrationItem[], selected: Record<string, boolean>) => {
      const selectedItems = getSelectedMigrationItems(items, selected);
      const selectedSummary = summarizeMigrationItems(selectedItems);
      return [
        ["total", t("chat_migration_total"), items.length],
        ["selected", t("chat_migration_selected"), selectedItems.length],
        ["joinable", t("chat_migration_joinable"), selectedSummary.joinable],
        ["manual", t("chat_migration_manual"), selectedSummary.manual_required],
      ];
    },
    [getSelectedMigrationItems, summarizeMigrationItems, t],
  );

  const renderMigrationItem = useCallback(
    (
      item: ChatMigrationItem,
      index: number,
      selected: Record<string, boolean>,
      onToggle: (key: string) => void,
      disabled = false,
      isItemDisabled?: (item: ChatMigrationItem) => boolean,
    ) => {
      const key = getChatMigrationItemKey(item, index);
      const joinType = getChatJoinType(item);
      const itemDisabled = Boolean(isItemDisabled?.(item));
      const isSelected = Boolean(selected[key]);
      return (
        <label
          key={key}
          className={`flex items-start gap-3 p-3 border-b border-white/5 last:border-0 hover:bg-white/3 ${
            isSelected ? "bg-white/3" : ""
          } ${itemDisabled ? "cursor-not-allowed opacity-55" : "cursor-pointer"}`}
        >
          <input
            type="checkbox"
            className="mt-1"
            checked={isSelected}
            onChange={() => {
              if (!itemDisabled) onToggle(key);
            }}
            disabled={disabled || itemDisabled}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <div className="font-semibold truncate">{item.title}</div>
              <div className="flex shrink-0 items-center gap-2">
                {itemDisabled ? (
                  <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-500">
                    {t("chat_migration_already")}
                  </span>
                ) : null}
                <div className="text-[10px] text-main/35 uppercase">
                  {item.type || "-"} / {joinType}
                </div>
              </div>
            </div>
            <div className="text-xs text-main/45 mt-1 truncate">
              {item.username
                ? `@${item.username}`
                : item.export_note || t("chat_migration_manual")}
            </div>
          </div>
        </label>
      );
    },
    [getChatJoinType, getChatMigrationItemKey, t],
  );

  const loadData = useCallback(
    async (tokenStr: string) => {
      try {
        setLoading(true);
        const [accountsData, tasksData] = await Promise.all([
          listAccounts(tokenStr),
          listSignTasks(tokenStr),
        ]);
        setAccounts(accountsData.accounts);
        setAccountStatusMap(() => {
          const next: Record<string, AccountStatusItem> = {};
          for (const acc of accountsData.accounts) {
            const rawStatus = acc.status || "connected";
            const needsRelogin =
              Boolean(acc.needs_relogin) ||
              rawStatus === "invalid" ||
              rawStatus === "not_found";
            const status = needsRelogin ? "invalid" : "connected";
            next[acc.name] = {
              account_name: acc.name,
              ok: !needsRelogin,
              status,
              message: acc.status_message || "",
              code: acc.status_code || undefined,
              checked_at: acc.status_checked_at || undefined,
              needs_relogin: needsRelogin,
            };
          }
          return next;
        });
        setTasks(tasksData);
      } catch (err: any) {
        addToastRef.current(formatErrorMessage("load_failed", err), "error");
      } finally {
        setLoading(false);
      }
    },
    [formatErrorMessage],
  );

  useEffect(() => {
    const tokenStr = getToken();
    if (!tokenStr) {
      window.location.replace("/");
      return;
    }
    setLocalToken(tokenStr);
    setChecking(false);
    loadData(tokenStr);
  }, [loadData]);

  const getAccountTaskCount = (accountName: string) => {
    return tasks.filter((task) => task.account_name === accountName).length;
  };

  const openAddDialog = () => {
    setReloginAccountName(null);
    setLoginMode("phone");
    setLoginData({ ...EMPTY_LOGIN_DATA });
    setShowAddDialog(true);
  };

  const handleStartLogin = async () => {
    if (!token) return;
    const trimmedAccountName = normalizeAccountName(loginData.account_name);
    if (!trimmedAccountName || !loginData.phone_number) {
      addToast(t("account_name_phone_required"), "error");
      return;
    }
    if (isDuplicateAccountName(trimmedAccountName, reloginAccountName)) {
      addToast(t("account_name_duplicate"), "error");
      return;
    }
    try {
      setLoading(true);
      const res = await startAccountLogin(token, {
        phone_number: loginData.phone_number,
        account_name: trimmedAccountName,
        proxy: loginData.proxy || undefined,
      });
      setLoginData({
        ...loginData,
        account_name: trimmedAccountName,
        phone_code_hash: res.phone_code_hash,
      });
      addToast(t("code_sent"), "success");
    } catch (err: any) {
      addToast(formatErrorMessage("send_code_failed", err), "error");
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyLogin = useCallback(async () => {
    if (!token) return;
    if (!loginData.phone_code_hash) {
      addToast("请先点击发送验证码", "error");
      return;
    }
    if (!loginData.phone_code) {
      addToast(t("login_code_required"), "error");
      return;
    }
    const trimmedAccountName = normalizeAccountName(loginData.account_name);
    if (!trimmedAccountName) {
      addToast(t("account_name_required"), "error");
      return;
    }
    if (isDuplicateAccountName(trimmedAccountName, reloginAccountName)) {
      addToast(t("account_name_duplicate"), "error");
      return;
    }
    try {
      setLoading(true);
      await verifyAccountLogin(token, {
        account_name: trimmedAccountName,
        phone_number: loginData.phone_number,
        phone_code: loginData.phone_code,
        phone_code_hash: loginData.phone_code_hash,
        password: loginData.password || undefined,
        proxy: loginData.proxy || undefined,
      });
      addToast(t("login_success"), "success");
      setAccountStatusMap((prev) => ({
        ...prev,
        [trimmedAccountName]: {
          account_name: trimmedAccountName,
          ok: true,
          status: "connected",
          message: "",
          code: "OK",
          checked_at: new Date().toISOString(),
          needs_relogin: false,
        },
      }));
      setReloginAccountName(null);
      setLoginData({ ...EMPTY_LOGIN_DATA });
      setShowAddDialog(false);
      loadData(token);
    } catch (err: any) {
      addToast(formatErrorMessage("verify_failed", err, true), "error");
      const message = String(err?.message || "");
      if (/验证码错误|验证码已过期|登录会话已过期|2FA 密码错误/.test(message)) {
        setLoginData((current) => ({
          ...current,
          phone_code: "",
          phone_code_hash: "",
        }));
      }
    } finally {
      setLoading(false);
    }
  }, [
    token,
    loginData.account_name,
    loginData.phone_number,
    loginData.phone_code,
    loginData.phone_code_hash,
    loginData.password,
    loginData.proxy,
    addToast,
    formatErrorMessage,
    isDuplicateAccountName,
    loadData,
    normalizeAccountName,
    reloginAccountName,
    t,
  ]);

  const handleDeleteAccount = async (name: string) => {
    if (!token) return;
    if (!confirm(t("confirm_delete_account").replace("{name}", name))) return;
    try {
      setLoading(true);
      await deleteAccount(token, name);
      addToast(t("account_deleted"), "success");
      loadData(token);
    } catch (err: any) {
      addToast(formatErrorMessage("delete_failed", err), "error");
    } finally {
      setLoading(false);
    }
  };

  const handleEditAccount = (acc: AccountInfo) => {
    setEditData({
      account_name: acc.name,
      remark: acc.remark || "",
      proxy: acc.proxy || "",
    });
    setShowEditDialog(true);
  };

  const handleSaveEdit = async () => {
    if (!token) return;
    if (!editData.account_name) return;
    try {
      setLoading(true);
      await updateAccount(token, editData.account_name, {
        remark: editData.remark || "",
        proxy: editData.proxy || "",
      });
      addToast(t("save_changes"), "success");
      setShowEditDialog(false);
      loadData(token);
    } catch (err: any) {
      addToast(formatErrorMessage("save_failed", err), "error");
    } finally {
      setLoading(false);
    }
  };

  const openChatExportDialog = (accountName: string) => {
    setChatExportAccount(accountName);
    setChatExportScope("all");
    setChatExportLoading(false);
    setChatExportError("");
    setChatExportPayload(null);
    setChatExportSelectedIds({});
    setChatExportSearch("");
    setShowChatExportDialog(true);
  };

  const loadChatExportPreview = useCallback(
    async (scope: ChatMigrationExportScope = chatExportScope) => {
      if (!token) return;
      if (!chatExportAccount) return;
      try {
        setChatExportLoading(true);
        setChatExportError("");
        const payload = await getAccountChatsExport(
          token,
          chatExportAccount,
          scope,
        );
        const selected: Record<string, boolean> = {};
        (payload.items || []).forEach((item, index) => {
          selected[getChatMigrationItemKey(item, index)] = true;
        });
        setChatExportPayload(payload);
        setChatExportSelectedIds(selected);
      } catch (err: any) {
        const message = formatErrorMessage(
          "chat_migration_export_failed",
          err,
          true,
        );
        setChatExportError(message);
        addToast(message, "error");
      } finally {
        setChatExportLoading(false);
      }
    },
    [
      addToast,
      chatExportAccount,
      chatExportScope,
      formatErrorMessage,
      getChatMigrationItemKey,
      token,
    ],
  );

  const handleExportScopeChange = (scope: ChatMigrationExportScope) => {
    setChatExportScope(scope);
    setChatExportPayload(null);
    setChatExportSelectedIds({});
    setChatExportError("");
  };

  const handleToggleChatExportItem = (key: string) => {
    setChatExportSelectedIds((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const setAllChatExportItems = (checked: boolean) => {
    if (!chatExportPayload) return;
    const next: Record<string, boolean> = {};
    chatExportPayload.items.forEach((item, index) => {
      next[getChatMigrationItemKey(item, index)] = checked;
    });
    setChatExportSelectedIds(next);
  };

  const handleExportChats = async () => {
    if (!chatExportPayload || !chatExportAccount) {
      await loadChatExportPreview();
      return;
    }

    const selectedItems = getSelectedMigrationItems(
      chatExportPayload.items || [],
      chatExportSelectedIds,
    );
    if (!selectedItems.length) {
      addToast(t("chat_migration_select_required"), "error");
      return;
    }

    try {
      setChatExportLoading(true);
      const payload: ChatMigrationExportPayload = {
        ...chatExportPayload,
        scope: `${chatExportPayload.scope || chatExportScope}_selected`,
        exported_at: new Date().toISOString(),
        items: selectedItems,
        summary: summarizeMigrationItems(selectedItems),
      };
      downloadChatMigrationJson(
        payload,
        chatExportAccount,
        payload.scope || "selected",
      );
      addToast(t("chat_migration_export_success"), "success");
      setShowChatExportDialog(false);
    } catch (err: any) {
      addToast(
        formatErrorMessage("chat_migration_export_failed", err, true),
        "error",
      );
    } finally {
      setChatExportLoading(false);
    }
  };

  const openChatImportDialog = (accountName: string) => {
    setChatImportAccount(accountName);
    setChatImportJson("");
    setChatImportShowJson(true);
    setChatImportPayload(null);
    setChatImportExistingPayload(null);
    setChatImportSelectedIds({});
    setChatImportSearch("");
    setChatImportDryRun(false);
    setChatImportDelay(5);
    setChatImportProgress("");
    setChatImportError("");
    setChatImportResult(null);
    setChatImportJob(null);
    setChatImportJobHistory(loadChatImportJobHistory());
    setShowChatImportDialog(true);
  };

  useEffect(() => {
    if (!showChatImportDialog) return;
    const loadHistory = () => {
      setChatImportJobHistory(loadChatImportJobHistory());
    };
    loadHistory();
    const refreshHistory = () => {
      loadHistory();
    };
    window.addEventListener("chat-import-job-history-updated", refreshHistory);
    window.addEventListener("storage", refreshHistory);
    return () => {
      window.removeEventListener(
        "chat-import-job-history-updated",
        refreshHistory,
      );
      window.removeEventListener("storage", refreshHistory);
    };
  }, [showChatImportDialog]);

  useEffect(() => {
    if (!showChatImportDialog || !token || !chatImportAccount) return;
    let canceled = false;
    getAccountChatsExport(token, chatImportAccount, "all")
      .then((payload) => {
        if (!canceled) setChatImportExistingPayload(payload);
      })
      .catch(() => {
        if (!canceled) setChatImportExistingPayload(null);
      });
    return () => {
      canceled = true;
    };
  }, [chatImportAccount, showChatImportDialog, token]);

  const parseChatImportJson = useCallback(
    (text: string) => {
      let payload: Record<string, any>;
      try {
        payload = JSON.parse(text);
      } catch (err: any) {
        throw new Error(err?.message || t("chat_migration_import_empty"));
      }

      const items = Array.isArray(payload.items)
        ? payload.items.filter((item) => item && typeof item === "object")
        : [];
      if (!items.length) {
        throw new Error("迁移 JSON 缺少 items 列表或列表为空");
      }

      const selected: Record<string, boolean> = {};
      items.forEach((item, index) => {
        selected[getChatMigrationItemKey(item, index)] =
          !isChatAlreadyJoined(item);
      });

      return {
        payload: {
          ...payload,
          items,
          summary: summarizeMigrationItems(items),
        } as Record<string, any>,
        selected,
      };
    },
    [getChatMigrationItemKey, isChatAlreadyJoined, summarizeMigrationItems, t],
  );

  const loadChatImportPreview = useCallback(
    (text: string) => {
      const parsed = parseChatImportJson(text);
      setChatImportPayload(parsed.payload);
      setChatImportSelectedIds(parsed.selected);
      setChatImportShowJson(false);
      setChatImportError("");
      setChatImportResult(null);
      setChatImportProgress("");
      return parsed.payload;
    },
    [parseChatImportJson],
  );

  useEffect(() => {
    if (!showChatExportDialog || !token || !chatExportAccount) return;
    if (chatExportPayload || chatExportLoading) return;
    loadChatExportPreview(chatExportScope);
  }, [
    showChatExportDialog,
    token,
    chatExportAccount,
    chatExportPayload,
    chatExportLoading,
    chatExportScope,
    loadChatExportPreview,
  ]);

  const handleChatImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setChatImportJson(text);
      loadChatImportPreview(text);
    } catch {
      addToast(t("chat_migration_file_read_failed"), "error");
    } finally {
      event.target.value = "";
    }
  };

  const handleToggleChatImportItem = (key: string) => {
    const item = ((chatImportPayload?.items || []) as ChatMigrationItem[]).find(
      (candidate, index) => getChatMigrationItemKey(candidate, index) === key,
    );
    if (item && isChatAlreadyJoined(item)) return;
    setChatImportSelectedIds((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleClearChatImportHistoryItem = (jobId: string) => {
    const nextHistory = chatImportJobHistory.filter(
      (item) => item.job_id !== jobId,
    );
    setChatImportJobHistory(nextHistory);
    localStorage.setItem(
      CHAT_IMPORT_JOB_HISTORY_STORAGE_KEY,
      JSON.stringify(nextHistory),
    );
    if (chatImportJob?.job_id === jobId) {
      setChatImportJob(null);
      setChatImportResult(null);
      setChatImportProgress("");
      setChatImportLoading(false);
    }
    if (localStorage.getItem(CHAT_IMPORT_JOB_STORAGE_KEY) === jobId) {
      localStorage.removeItem(CHAT_IMPORT_JOB_STORAGE_KEY);
    }
    window.dispatchEvent(new CustomEvent("chat-import-job-history-updated"));
  };

  const getChatImportResumeItems = (job: ChatMigrationImportJobResponse) => {
    if (!job.items?.length) return [];
    const doneKeys = new Set(
      (job.results || [])
        .filter((item) => item.status !== "failed")
        .map(
          (item) =>
            `${item.id ?? item.username ?? item.title ?? "chat"}-${item.type ?? "unknown"}`,
        ),
    );
    return job.items.filter((item) => {
      const key = `${item.id ?? item.username ?? item.title ?? "chat"}-${item.type ?? "unknown"}`;
      return !doneKeys.has(key);
    });
  };

  const handleResumeChatImportHistoryItem = async (
    job: ChatMigrationImportJobResponse,
  ) => {
    if (!token) return;
    const resumeItems = getChatImportResumeItems(job);
    if (!resumeItems.length) return;
    try {
      setChatImportJobActionLoading(true);
      const nextJob = await startImportAccountChatsJob(
        token,
        job.account_name,
        {
          migration: {
            kind: "tg-flowpulse-chat-migration",
            version: 1,
            source_account: job.account_name,
            items: resumeItems,
          },
          dry_run: job.dry_run,
          delay_seconds: job.delay_seconds,
        },
      );
      syncImportJobToDialog({ ...nextJob, items: resumeItems });
      localStorage.setItem(CHAT_IMPORT_JOB_STORAGE_KEY, nextJob.job_id);
      window.dispatchEvent(
        new CustomEvent("chat-import-job-started", {
          detail: { jobId: nextJob.job_id },
        }),
      );
      setChatImportJobHistory(loadChatImportJobHistory());
      addToast(t("chat_migration_background_started"), "success");
    } catch (err: any) {
      addToast(
        formatErrorMessage("chat_migration_import_failed", err),
        "error",
      );
    } finally {
      setChatImportJobActionLoading(false);
    }
  };

  const handleInspectChatImportHistoryItem = async (
    historyItem: ChatMigrationImportJobResponse,
  ) => {
    if (!token) return;
    try {
      setChatImportJobActionLoading(true);
      let job = historyItem;
      if (["running", "canceling"].includes(historyItem.status)) {
        job = await getImportAccountChatsJob(token, historyItem.job_id);
      }
      const mergedJob = {
        ...job,
        items: job.items?.length ? job.items : historyItem.items,
      };
      syncImportJobToDialog(mergedJob);
      if (["running", "canceling"].includes(mergedJob.status)) {
        localStorage.setItem(CHAT_IMPORT_JOB_STORAGE_KEY, mergedJob.job_id);
      } else {
        localStorage.removeItem(CHAT_IMPORT_JOB_STORAGE_KEY);
        saveChatImportJobToHistory(mergedJob);
      }
      setChatImportJobHistory(loadChatImportJobHistory());
    } catch (err: any) {
      addToast(
        formatErrorMessage("chat_migration_import_failed", err),
        "error",
      );
    } finally {
      setChatImportJobActionLoading(false);
    }
  };

  const handleStopChatImportJob = async (
    job: ChatMigrationImportJobResponse,
  ) => {
    if (!token) return;
    try {
      setChatImportJobActionLoading(true);
      const nextJob = await cancelImportAccountChatsJob(token, job.job_id);
      const mergedJob = {
        ...nextJob,
        items: nextJob.items?.length ? nextJob.items : job.items,
      };
      syncImportJobToDialog(mergedJob);
      saveChatImportJobToHistory(mergedJob);
      setChatImportJobHistory(loadChatImportJobHistory());
    } catch (err: any) {
      addToast(
        formatErrorMessage("chat_migration_import_failed", err),
        "error",
      );
    } finally {
      setChatImportJobActionLoading(false);
    }
  };

  const setAllChatImportItems = (checked: boolean) => {
    if (!chatImportPayload) return;
    const next: Record<string, boolean> = {};
    (chatImportPayload.items || []).forEach(
      (item: ChatMigrationItem, index: number) => {
        next[getChatMigrationItemKey(item, index)] =
          checked && !isChatAlreadyJoined(item);
      },
    );
    setChatImportSelectedIds(next);
  };

  const summarizeChatImportResults = (
    results: ChatMigrationImportResponse["results"],
  ) => {
    const summary: Record<string, number> = {
      total: results.length,
      joined: 0,
      already_member: 0,
      request_sent: 0,
      manual_required: 0,
      failed: 0,
      flood_wait: 0,
      skipped: 0,
      ready: 0,
    };
    results.forEach((item) => {
      const status = item.status || "failed";
      summary[status] = (summary[status] || 0) + 1;
    });
    return summary;
  };

  const buildChatImportPayload = (
    source: Record<string, any>,
    items: Record<string, any>[],
  ) => ({
    ...source,
    items,
    summary: {
      ...(source.summary || {}),
      total: items.length,
      joinable: items.filter((item) =>
        ["username", "invite_link"].includes(item?.join?.type),
      ).length,
      manual_required: items.filter(
        (item) => !["username", "invite_link"].includes(item?.join?.type),
      ).length,
    },
  });

  const handleImportChats = async () => {
    if (!token || !chatImportAccount) return;
    if (!chatImportJson.trim()) {
      addToast(t("chat_migration_import_empty"), "error");
      return;
    }
    try {
      setChatImportLoading(true);
      setChatImportError("");
      setChatImportResult(null);
      setChatImportProgress("");

      const migration =
        chatImportPayload || loadChatImportPreview(chatImportJson.trim());
      const items = getSelectedMigrationItems(
        (migration.items || []) as ChatMigrationItem[],
        chatImportSelectedIds,
      ).filter((item) => !isChatAlreadyJoined(item));
      if (!items.length) {
        throw new Error(t("chat_migration_select_required"));
      }

      const requestedDelay = Number.isFinite(chatImportDelay)
        ? Math.max(0, chatImportDelay)
        : 0;
      const batchSize = chatImportDryRun
        ? items.length
        : Math.max(
            1,
            Math.min(
              CHAT_IMPORT_BATCH_SIZE,
              Math.floor(30 / Math.max(1, requestedDelay)),
            ),
          );
      const allResults: ChatMigrationImportResponse["results"] = [];
      let lastResult: ChatMigrationImportResponse | null = null;

      for (let start = 0; start < items.length; start += batchSize) {
        const batch = items.slice(start, start + batchSize);
        setChatImportProgress(
          t("chat_migration_import_progress")
            .replace("{done}", start.toString())
            .replace("{total}", items.length.toString()),
        );

        const result = await importAccountChats(token, chatImportAccount, {
          migration: buildChatImportPayload(migration, batch),
          dry_run: chatImportDryRun,
          delay_seconds: requestedDelay,
        });
        lastResult = result;
        allResults.push(...(result.results || []));

        const summary = summarizeChatImportResults(allResults);
        setChatImportResult({
          ...result,
          success: !allResults.some((item) => item.status === "failed"),
          summary,
          results: allResults,
        });
      }

      const finalSummary = summarizeChatImportResults(allResults);
      const result: ChatMigrationImportResponse = {
        ...(lastResult as ChatMigrationImportResponse),
        success: !allResults.some((item) => item.status === "failed"),
        dry_run: chatImportDryRun,
        source_account: migration.source_account || null,
        target_account: chatImportAccount,
        imported_at: lastResult?.imported_at || new Date().toISOString(),
        summary: finalSummary,
        results: allResults,
        notice: lastResult?.notice || null,
      };
      setChatImportResult(result);
      setChatImportProgress(
        t("chat_migration_import_progress")
          .replace("{done}", allResults.length.toString())
          .replace("{total}", items.length.toString()),
      );
      const summary = result.summary || {};
      const joined = summary.joined || 0;
      const requestSent = summary.request_sent || 0;
      const manual = summary.manual_required || 0;
      const failed = summary.failed || 0;
      addToast(
        t("chat_migration_import_summary")
          .replace("{joined}", joined.toString())
          .replace("{request}", requestSent.toString())
          .replace("{manual}", manual.toString())
          .replace("{failed}", failed.toString()),
        failed > 0 ? "error" : "success",
      );
    } catch (err: any) {
      const message = formatErrorMessage(
        "chat_migration_import_failed",
        err,
        true,
      );
      setChatImportError(message);
      addToast(message, "error");
    } finally {
      setChatImportLoading(false);
    }
  };

  const syncImportJobToDialog = useCallback(
    (job: ChatMigrationImportJobResponse) => {
      setChatImportJob(job);
      setChatImportResult({
        success: job.status === "completed",
        dry_run: job.dry_run,
        source_account: null,
        target_account: job.account_name,
        imported_at: job.finished_at || job.updated_at,
        summary: job.summary || {},
        results: job.results || [],
        notice: job.notice || null,
      });
      setChatImportProgress(
        t("chat_migration_import_progress")
          .replace("{done}", String(job.progress?.done || 0))
          .replace("{total}", String(job.progress?.total || 0)),
      );
      setChatImportLoading(["running", "canceling"].includes(job.status));
      if (job.error) {
        setChatImportError(job.error);
      }
    },
    [t],
  );

  useEffect(() => {
    if (!showChatImportDialog || !token) return;
    const jobId = localStorage.getItem(CHAT_IMPORT_JOB_STORAGE_KEY);
    if (!jobId) return;
    let canceled = false;
    getImportAccountChatsJob(token, jobId)
      .then((job) => {
        if (canceled) return;
        syncImportJobToDialog(job);
        if (["running", "canceling"].includes(job.status)) {
          setChatImportJobHistory((history) => [
            job,
            ...history.filter((item) => item.job_id !== job.job_id),
          ]);
          return;
        }
        localStorage.removeItem(CHAT_IMPORT_JOB_STORAGE_KEY);
        saveChatImportJobToHistory(job);
        setChatImportJobHistory(loadChatImportJobHistory());
      })
      .catch(() => {
        if (!canceled) localStorage.removeItem(CHAT_IMPORT_JOB_STORAGE_KEY);
      });
    return () => {
      canceled = true;
    };
  }, [showChatImportDialog, syncImportJobToDialog, token]);

  const handleImportChatsInBackground = async () => {
    if (!token || !chatImportAccount) return;
    if (!chatImportJson.trim()) {
      addToast(t("chat_migration_import_empty"), "error");
      return;
    }
    try {
      setChatImportJobActionLoading(true);
      setChatImportError("");
      const migration =
        chatImportPayload || loadChatImportPreview(chatImportJson.trim());
      const items = getSelectedMigrationItems(
        (migration.items || []) as ChatMigrationItem[],
        chatImportSelectedIds,
      ).filter((item) => !isChatAlreadyJoined(item));
      if (!items.length) {
        throw new Error(t("chat_migration_select_required"));
      }
      const requestedDelay = Number.isFinite(chatImportDelay)
        ? Math.max(0, chatImportDelay)
        : 0;
      const job = await startImportAccountChatsJob(token, chatImportAccount, {
        migration: buildChatImportPayload(migration, items),
        dry_run: chatImportDryRun,
        delay_seconds: requestedDelay,
      });
      syncImportJobToDialog(job);
      localStorage.setItem(CHAT_IMPORT_JOB_STORAGE_KEY, job.job_id);
      setChatImportJobHistory((history) => [
        job,
        ...history.filter((item) => item.job_id !== job.job_id),
      ]);
      window.dispatchEvent(
        new CustomEvent("chat-import-job-started", {
          detail: { jobId: job.job_id },
        }),
      );
      addToast(t("chat_migration_background_started"), "success");
    } catch (err: any) {
      const message = formatErrorMessage(
        "chat_migration_import_failed",
        err,
        true,
      );
      setChatImportError(message);
      addToast(message, "error");
    } finally {
      setChatImportJobActionLoading(false);
    }
  };

  useEffect(() => {
    if (!token || !chatImportJob) return;
    if (!["running", "canceling"].includes(chatImportJob.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const job = await getImportAccountChatsJob(token, chatImportJob.job_id);
        syncImportJobToDialog(job);
        if (!["running", "canceling"].includes(job.status)) {
          localStorage.removeItem(CHAT_IMPORT_JOB_STORAGE_KEY);
          saveChatImportJobToHistory(job);
          setChatImportJobHistory(loadChatImportJobHistory());
          const summary = job.summary || {};
          const failed = summary.failed || 0;
          addToast(
            job.status === "canceled"
              ? t("chat_migration_background_canceled")
              : t("chat_migration_import_summary")
                  .replace("{joined}", String(summary.joined || 0))
                  .replace("{request}", String(summary.request_sent || 0))
                  .replace("{manual}", String(summary.manual_required || 0))
                  .replace("{failed}", String(failed)),
            failed > 0 || job.status === "failed" ? "error" : "success",
          );
          return;
        }
        setChatImportJobHistory((history) => [
          job,
          ...history.filter((item) => item.job_id !== job.job_id),
        ]);
      } catch {
        // Keep last known status; the next poll may succeed.
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [addToast, chatImportJob, syncImportJobToDialog, t, token]);

  const chatExportVisibleItems = chatExportPayload
    ? filterMigrationItems(chatExportPayload.items || [], chatExportSearch)
    : [];
  const chatImportVisibleItems = chatImportPayload
    ? filterMigrationItems(
        (chatImportPayload.items || []) as ChatMigrationItem[],
        chatImportSearch,
      )
    : [];
  const chatImportSelectedTotal = countSelectedChats(chatImportSelectedIds);
  const chatImportProcessedTotal = chatImportResult?.summary?.total || 0;
  const chatImportProgressPercent = Math.min(
    100,
    Math.round(
      (chatImportProcessedTotal / Math.max(1, chatImportSelectedTotal)) * 100,
    ),
  );
  const chatImportJobProgressPercent = chatImportJob
    ? Math.min(
        100,
        Math.round(
          ((chatImportJob.progress?.done || 0) /
            Math.max(1, chatImportJob.progress?.total || 0)) *
            100,
        ),
      )
    : 0;
  const chatImportJobActive = Boolean(
    chatImportJob && ["running", "canceling"].includes(chatImportJob.status),
  );

  const debugQr = useCallback((payload: Record<string, any>) => {
    if (process.env.NODE_ENV !== "production") {
      console.debug("[qr-login]", payload);
    }
  }, []);

  const clearQrPollingTimers = useCallback(() => {
    if (qrPollTimerRef.current) {
      clearInterval(qrPollTimerRef.current);
      qrPollTimerRef.current = null;
    }
    if (qrPollDelayRef.current) {
      clearTimeout(qrPollDelayRef.current);
      qrPollDelayRef.current = null;
    }
    qrPollingActiveRef.current = false;
  }, []);

  const clearQrCountdownTimer = useCallback(() => {
    if (qrCountdownTimerRef.current) {
      clearInterval(qrCountdownTimerRef.current);
      qrCountdownTimerRef.current = null;
    }
  }, []);

  const clearQrTimers = useCallback(() => {
    clearQrPollingTimers();
    clearQrCountdownTimer();
  }, [clearQrPollingTimers, clearQrCountdownTimer]);

  const setQrPhaseSafe = useCallback(
    (next: QrPhase, reason: string, extra?: Record<string, any>) => {
      setQrPhase((prev) => {
        if (prev !== next) {
          debugQr({
            login_id: qrActiveLoginIdRef.current,
            prev,
            next,
            reason,
            ...extra,
          });
        }
        return next;
      });
    },
    [debugQr],
  );

  const markToastShown = useCallback(
    (loginId: string, kind: "expired" | "error") => {
      if (!loginId) return;
      if (!qrToastShownRef.current[loginId]) {
        qrToastShownRef.current[loginId] = {};
      }
      qrToastShownRef.current[loginId][kind] = true;
    },
    [],
  );

  const hasToastShown = useCallback(
    (loginId: string, kind: "expired" | "error") => {
      if (!loginId) return false;
      return Boolean(qrToastShownRef.current[loginId]?.[kind]);
    },
    [],
  );

  const resetQrState = useCallback(() => {
    clearQrTimers();
    qrActiveLoginIdRef.current = null;
    qrRestartingRef.current = false;
    qrAutoRefreshRef.current = 0;
    setQrLogin(null);
    setQrStatus("waiting_scan");
    setQrPhase("idle");
    setQrMessage("");
    setQrCountdown(0);
    setQrLoading(false);
    setQrPassword("");
    setQrPasswordLoading(false);
  }, [clearQrTimers]);

  const openReloginDialog = useCallback(
    (acc: AccountInfo, showToast: boolean = true) => {
      resetQrState();
      setReloginAccountName(acc.name);
      setLoginMode("phone");
      setLoginData({
        ...EMPTY_LOGIN_DATA,
        account_name: acc.name,
        proxy: acc.proxy || "",
      });
      setShowAddDialog(true);
      if (showToast) {
        addToast(t("account_relogin_required"), "error");
      }
    },
    [addToast, resetQrState, t],
  );

  const handleAccountCardClick = useCallback(
    (acc: AccountInfo) => {
      const statusInfo = accountStatusMap[acc.name];
      const needsRelogin = Boolean(
        statusInfo?.needs_relogin || acc.needs_relogin,
      );
      const status = statusInfo?.status || acc.status;
      if (needsRelogin || status === "invalid") {
        openReloginDialog(acc);
        return;
      }
      router.push(`/dashboard/sign-tasks?name=${encodeURIComponent(acc.name)}`);
    },
    [accountStatusMap, openReloginDialog, router],
  );

  const performQrLoginStart = useCallback(
    async (options?: {
      autoRefresh?: boolean;
      silent?: boolean;
      reason?: string;
    }) => {
      if (!token) return null;
      const trimmedAccountName = normalizeAccountName(loginData.account_name);
      if (!trimmedAccountName) {
        if (!options?.silent) {
          addToast(t("account_name_required"), "error");
        }
        return null;
      }
      if (isDuplicateAccountName(trimmedAccountName, reloginAccountName)) {
        if (!options?.silent) {
          addToast(t("account_name_duplicate"), "error");
        }
        return null;
      }
      try {
        if (options?.autoRefresh) {
          qrRestartingRef.current = true;
        }
        clearQrTimers();
        setQrLoading(true);
        setQrPhaseSafe("loading", options?.reason ?? "start");
        const res = await startQrLogin(token, {
          account_name: trimmedAccountName,
          proxy: loginData.proxy || undefined,
        });
        setLoginData((prev) => ({ ...prev, account_name: trimmedAccountName }));
        setQrLogin(res);
        qrActiveLoginIdRef.current = res.login_id;
        qrToastShownRef.current[res.login_id] = {};
        setQrStatus("waiting_scan");
        setQrPhaseSafe("ready", "qr_ready", { expires_at: res.expires_at });
        setQrMessage("");
        return res;
      } catch (err: any) {
        setQrPhaseSafe("error", "start_failed");
        if (!options?.silent) {
          addToast(formatErrorMessage("qr_create_failed", err), "error");
        }
        return null;
      } finally {
        setQrLoading(false);
        qrRestartingRef.current = false;
      }
    },
    [
      token,
      loginData.account_name,
      loginData.proxy,
      addToast,
      clearQrTimers,
      formatErrorMessage,
      isDuplicateAccountName,
      normalizeAccountName,
      reloginAccountName,
      setQrPhaseSafe,
      t,
    ],
  );

  const handleSubmitQrPassword = useCallback(
    async (passwordOverride?: string) => {
      if (!token || !qrLogin?.login_id) return;
      const passwordValue = passwordOverride ?? qrPasswordRef.current;
      if (!passwordValue) {
        const msg = t("qr_password_missing");
        addToast(msg, "error");
        setQrMessage(msg);
        return;
      }
      try {
        setQrPasswordLoading(true);
        await submitQrPassword(token, {
          login_id: qrLogin.login_id,
          password: passwordValue,
        });
        addToast(t("login_success"), "success");
        const doneAccount = normalizeAccountName(loginData.account_name);
        if (doneAccount) {
          setAccountStatusMap((prev) => ({
            ...prev,
            [doneAccount]: {
              account_name: doneAccount,
              ok: true,
              status: "connected",
              message: "",
              code: "OK",
              checked_at: new Date().toISOString(),
              needs_relogin: false,
            },
          }));
        }
        setReloginAccountName(null);
        setLoginData({ ...EMPTY_LOGIN_DATA });
        resetQrState();
        setShowAddDialog(false);
        loadData(token);
      } catch (err: any) {
        const errMsg = err?.message ? String(err.message) : "";
        const fallback = formatErrorMessage("qr_login_failed", err);
        let message = errMsg || fallback;
        const lowerMsg = errMsg.toLowerCase();
        if (
          errMsg.includes("\u5bc6\u7801") ||
          errMsg.includes("\u4e24\u6b65\u9a8c\u8bc1") ||
          errMsg.includes("\u4e8c\u6b65\u9a8c\u8bc1") ||
          lowerMsg.includes("2fa") ||
          lowerMsg.includes("password")
        ) {
          message = t("qr_password_invalid");
        }
        addToast(message, "error");
        if (message === t("qr_password_invalid")) {
          resetQrState();
          return;
        }
        setQrMessage(message);
      } finally {
        setQrPasswordLoading(false);
      }
    },
    [
      token,
      qrLogin?.login_id,
      addToast,
      resetQrState,
      loadData,
      t,
      formatErrorMessage,
      loginData.account_name,
      normalizeAccountName,
    ],
  );

  const startQrPolling = useCallback(
    (loginId: string, reason: string = "effect") => {
      if (!token || !loginId) return;
      if (loginMode !== "qr" || !showAddDialog) return;
      if (
        qrPollingActiveRef.current &&
        qrActiveLoginIdRef.current === loginId
      ) {
        debugQr({ login_id: loginId, poll: "skip", reason });
        return;
      }

      clearQrPollingTimers();
      qrActiveLoginIdRef.current = loginId;
      qrPollingActiveRef.current = true;
      qrPollSeqRef.current += 1;
      const seq = qrPollSeqRef.current;
      let stopped = false;

      const stopPolling = () => {
        if (stopped) return;
        stopped = true;
        clearQrPollingTimers();
      };

      const shouldAutoRefresh = () => {
        const now = Date.now();
        if (now - qrAutoRefreshRef.current < 1200) {
          return false;
        }
        qrAutoRefreshRef.current = now;
        return true;
      };

      const poll = async () => {
        try {
          if (qrRestartingRef.current) return;
          const res = await getQrLoginStatus(token, loginId);
          if (stopped) return;
          if (qrActiveLoginIdRef.current !== loginId) return;
          if (qrPollSeqRef.current !== seq) return;

          const status = res.status as
            | "waiting_scan"
            | "scanned_wait_confirm"
            | "password_required"
            | "success"
            | "expired"
            | "failed";
          debugQr({
            login_id: loginId,
            pollResult: status,
            message: res.message || "",
          });
          setQrStatus(status);
          if (status !== "password_required") {
            setQrMessage("");
          }
          if (res.expires_at) {
            setQrLogin((prev) =>
              prev ? { ...prev, expires_at: res.expires_at } : prev,
            );
          }

          if (status === "success") {
            setQrPhaseSafe("success", "poll_success", { status });
            addToast(t("login_success"), "success");
            const doneAccount = normalizeAccountName(loginData.account_name);
            if (doneAccount) {
              setAccountStatusMap((prev) => ({
                ...prev,
                [doneAccount]: {
                  account_name: doneAccount,
                  ok: true,
                  status: "connected",
                  message: "",
                  code: "OK",
                  checked_at: new Date().toISOString(),
                  needs_relogin: false,
                },
              }));
            }
            setReloginAccountName(null);
            setLoginData({ ...EMPTY_LOGIN_DATA });
            stopPolling();
            resetQrState();
            setShowAddDialog(false);
            loadData(token);
            return;
          }

          if (status === "password_required") {
            setQrPhaseSafe("password", "poll_password_required", { status });
            stopPolling();
            setQrMessage(t("qr_password_required"));
            return;
          }

          if (status === "scanned_wait_confirm") {
            setQrPhaseSafe("scanning", "poll_scanned", { status });
            return;
          }

          if (status === "waiting_scan") {
            setQrPhaseSafe("ready", "poll_waiting", { status });
            return;
          }

          if (status === "expired") {
            stopPolling();
            setQrPhaseSafe("loading", "auto_refresh", { status });
            if (!shouldAutoRefresh()) {
              return;
            }
            const refreshed = await performQrLoginStart({
              autoRefresh: true,
              silent: true,
              reason: "auto_refresh",
            });
            if (refreshed?.login_id) {
              startQrPolling(refreshed.login_id, "auto_refresh");
              return;
            }
            setQrPhaseSafe("expired", "auto_refresh_failed", { status });
            if (!hasToastShown(loginId, "expired")) {
              addToast(t("qr_expired_not_found"), "error");
              markToastShown(loginId, "expired");
            }
            return;
          }

          if (status === "failed") {
            setQrPhaseSafe("error", "poll_terminal", { status });
            stopPolling();
            if (!hasToastShown(loginId, "error")) {
              addToast(t("qr_login_failed"), "error");
              markToastShown(loginId, "error");
            }
          }
        } catch (err: any) {
          if (stopped) return;
          if (qrActiveLoginIdRef.current !== loginId) return;
          if (qrPollSeqRef.current !== seq) return;
          debugQr({
            login_id: loginId,
            pollError: err?.message || String(err),
          });
          if (!hasToastShown(loginId, "error")) {
            addToast(formatErrorMessage("qr_status_failed", err), "error");
            markToastShown(loginId, "error");
          }
        }
      };

      qrPollDelayRef.current = setTimeout(() => {
        poll();
        qrPollTimerRef.current = setInterval(poll, 1500);
      }, 0);

      return stopPolling;
    },
    [
      token,
      loginMode,
      showAddDialog,
      addToast,
      clearQrPollingTimers,
      debugQr,
      formatErrorMessage,
      hasToastShown,
      loadData,
      markToastShown,
      loginData.account_name,
      normalizeAccountName,
      performQrLoginStart,
      resetQrState,
      setQrPhaseSafe,
      t,
    ],
  );

  const handleStartQrLogin = async () => {
    const res = await performQrLoginStart();
    if (res?.login_id) {
      startQrPolling(res.login_id, "start_success");
    }
  };

  const handleCancelQrLogin = async () => {
    if (!token || !qrLogin?.login_id) {
      resetQrState();
      return;
    }
    try {
      setQrLoading(true);
      await cancelQrLogin(token, qrLogin.login_id);
    } catch (err: any) {
      addToast(formatErrorMessage("cancel_failed", err), "error");
    } finally {
      setQrLoading(false);
      resetQrState();
    }
  };

  // 手动提交 2FA（避免自动重试导致重复请求）

  const handleCloseAddDialog = () => {
    if (qrLogin?.login_id) {
      handleCancelQrLogin();
    }
    setReloginAccountName(null);
    setLoginData({ ...EMPTY_LOGIN_DATA });
    setLoginMode("phone");
    setShowAddDialog(false);
  };

  const handleShowLogs = async (name: string) => {
    if (!token) return;
    setLogsAccountName(name);
    setShowLogsDialog(true);
    setLogsLoading(true);
    try {
      const logs = await getAccountLogs(token, name, 100);
      setAccountLogs(logs);
    } catch (err: any) {
      addToast(formatErrorMessage("logs_fetch_failed", err), "error");
    } finally {
      setLogsLoading(false);
    }
  };

  const handleClearLogs = async () => {
    if (!token || !logsAccountName) return;
    if (!confirm(t("clear_logs_confirm").replace("{name}", logsAccountName)))
      return;
    try {
      setLoading(true);
      await clearAccountLogs(token, logsAccountName);
      addToast(t("clear_logs_success"), "success");
      setLogsLoading(true);
      const logs = await getAccountLogs(token, logsAccountName, 100);
      setAccountLogs(logs);
    } catch (err: any) {
      addToast(formatErrorMessage("clear_logs_failed", err), "error");
    } finally {
      setLogsLoading(false);
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!qrLogin?.expires_at || !qrActiveLoginIdRef.current) {
      setQrCountdown(0);
      clearQrTimers();
      return;
    }
    if (!(qrPhase === "ready" || qrPhase === "scanning")) {
      setQrCountdown(0);
      if (qrCountdownTimerRef.current) {
        clearInterval(qrCountdownTimerRef.current);
        qrCountdownTimerRef.current = null;
      }
      return;
    }
    const update = () => {
      const expires = new Date(qrLogin.expires_at).getTime();
      const diff = Math.max(0, Math.floor((expires - Date.now()) / 1000));
      setQrCountdown(diff);
    };
    update();
    if (qrCountdownTimerRef.current) {
      clearInterval(qrCountdownTimerRef.current);
    }
    qrCountdownTimerRef.current = setInterval(update, 1000);
    return () => {
      if (qrCountdownTimerRef.current) {
        clearInterval(qrCountdownTimerRef.current);
        qrCountdownTimerRef.current = null;
      }
    };
  }, [qrLogin?.expires_at, qrPhase, clearQrTimers]);

  useEffect(() => {
    if (!token || !qrLogin?.login_id || loginMode !== "qr" || !showAddDialog)
      return;
    if (
      qrPhase === "success" ||
      qrPhase === "expired" ||
      qrPhase === "error" ||
      qrPhase === "password"
    )
      return;
    if (qrRestartingRef.current) return;
    const stop = startQrPolling(qrLogin.login_id, "effect");
    return () => {
      if (stop) stop();
    };
  }, [
    token,
    qrLogin?.login_id,
    loginMode,
    showAddDialog,
    qrPhase,
    startQrPolling,
  ]);

  if (!token || checking) {
    return null;
  }

  return (
    <div
      id="dashboard-view"
      className="w-full h-full flex flex-col relative z-10"
    >
      <header className="navbar">
        <div className="nav-brand">
          <div className="navbar-title-block">
            <h1 className="nav-title">{t("sidebar_accounts")}</h1>
            <p className="nav-subtitle">{t("settings_desc")}</p>
          </div>
        </div>
        <div className="top-right-actions shrink-0">
          <Link
            href="/dashboard/automation-rules"
            className="navbar-text-action hidden sm:inline-flex"
          >
            <Robot weight="bold" size={14} />
            <span>自动化规则</span>
          </Link>
          <button
            type="button"
            onClick={openAddDialog}
            className="navbar-text-action hidden sm:inline-flex"
          >
            <Plus weight="bold" size={14} />
            <span>{t("add_account")}</span>
          </button>
        </div>
      </header>

      <main className="main-content dashboard-module-content dashboard-home-content animate-fade-in">
        {loading && accounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
            <Spinner className="animate-spin mb-4 text-primary" size={32} />
            <p className="text-sm font-medium">{t("loading")}</p>
          </div>
        ) : (
          <div className="dashboard-module-grid relative z-10">
            {accounts.map((acc) => {
              const initial = acc.name.charAt(0).toUpperCase();
              const statusInfo = accountStatusMap[acc.name];
              const rawStatus = statusInfo?.status || acc.status || "connected";
              const needsRelogin = Boolean(
                statusInfo?.needs_relogin || acc.needs_relogin,
              );
              const isInvalid =
                needsRelogin ||
                rawStatus === "invalid" ||
                rawStatus === "not_found";
              const statusKey = isInvalid
                ? "account_status_invalid"
                : "connected";

              return (
                <div
                  key={acc.name}
                  className="dashboard-module-card group relative flex flex-col justify-between p-5 bg-card/70 backdrop-blur-xl border border-border/70 rounded-2xl shadow-soft transition-all duration-500 hover:-translate-y-1.5 hover:shadow-soft-hover hover:border-primary/40 cursor-pointer overflow-hidden"
                  onClick={() => handleAccountCardClick(acc)}
                >
                  <div className="absolute inset-0 bg-gradient-to-br from-primary/[0.12] via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
                  <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />

                  <div className="relative z-10 flex justify-between items-start gap-3 mb-5">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="shrink-0 w-11 h-11 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center text-white font-black text-base shadow-lg shadow-primary/25">
                        {initial}
                      </div>
                      <div className="min-w-0">
                        <div className="font-bold text-foreground truncate text-[15px]">
                          {acc.name}
                        </div>
                        {acc.remark && (
                          <div className="text-xs font-medium text-muted-foreground truncate mt-0.5">
                            {acc.remark}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0 px-2.5 py-1 rounded-full bg-primary/10 border border-primary/15 text-primary text-[10px] font-bold tracking-wide">
                      {getAccountTaskCount(acc.name)} {t("sidebar_tasks")}
                    </div>
                  </div>

                  <div className="relative z-10 flex items-center justify-between mt-auto">
                    <div
                      className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-[11px] font-bold border ${
                        isInvalid
                          ? "bg-destructive/10 text-destructive border-destructive/20"
                          : "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"
                      }`}
                      title={statusInfo?.message || acc.status_message || ""}
                    >
                      <span className="relative flex h-1.5 w-1.5">
                        <span
                          className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-60 ${
                            isInvalid ? "bg-destructive" : "bg-emerald-500"
                          }`}
                        />
                        <span
                          className={`relative inline-flex rounded-full h-1.5 w-1.5 ${
                            isInvalid ? "bg-destructive" : "bg-emerald-500"
                          }`}
                        />
                      </span>
                      <span>{t(statusKey)}</span>
                    </div>
                  </div>

                  <div
                    className="relative z-20 mt-5 pt-4 border-t border-border/60 flex items-center justify-end gap-1 opacity-70 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    {[
                      {
                        icon: Lightning,
                        title: "签到任务",
                        href: `/dashboard/sign-tasks?name=${encodeURIComponent(acc.name)}`,
                        color: "text-amber-500 hover:bg-amber-500/10",
                      },
                      {
                        icon: ChatCircleText,
                        title: "消息监控",
                        href: `/dashboard/monitors?account_name=${encodeURIComponent(acc.name)}`,
                        color: "text-cyan-500 hover:bg-cyan-500/10",
                      },
                      {
                        icon: Robot,
                        title: "自动化规则",
                        href: `/dashboard/automation-rules?account_name=${encodeURIComponent(acc.name)}`,
                        color: "text-violet-500 hover:bg-violet-500/10",
                      },
                      {
                        icon: SignIn,
                        title: "批量加退群/频道",
                        href: `/dashboard/bulk-groups?account_name=${encodeURIComponent(acc.name)}`,
                        color: "text-fuchsia-500 hover:bg-fuchsia-500/10",
                      },
                      {
                        icon: ListDashes,
                        title: "群成员导出",
                        onClick: () =>
                          router.push(
                            `/dashboard/member-export?account_name=${encodeURIComponent(acc.name)}`,
                          ),
                        color: "text-indigo-500 hover:bg-indigo-500/10",
                      },
                      {
                        icon: PencilSimple,
                        title: t("edit_account"),
                        onClick: () => handleEditAccount(acc),
                        color:
                          "text-muted-foreground hover:text-foreground hover:bg-muted",
                      },
                      {
                        icon: UploadSimple,
                        title: t("chat_migration_export"),
                        onClick: () => openChatExportDialog(acc.name),
                        color: "text-emerald-500 hover:bg-emerald-500/10",
                      },
                      {
                        icon: DownloadSimple,
                        title: t("chat_migration_import"),
                        onClick: () => openChatImportDialog(acc.name),
                        color: "text-sky-500 hover:bg-sky-500/10",
                      },
                      {
                        icon: Trash,
                        title: t("remove"),
                        onClick: () => handleDeleteAccount(acc.name),
                        color: "text-destructive hover:bg-destructive/10",
                      },
                    ].map((action, idx) =>
                      action.href ? (
                        <Link
                          key={idx}
                          href={action.href}
                          className={`flex items-center justify-center w-8 h-8 rounded-lg transition-all active:scale-90 ${action.color}`}
                          title={action.title}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            router.push(action.href);
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          <action.icon weight="bold" size={15} />
                        </Link>
                      ) : (
                        <button
                          key={idx}
                          type="button"
                          className={`flex items-center justify-center w-8 h-8 rounded-lg transition-all active:scale-90 ${action.color}`}
                          title={action.title}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            action.onClick?.();
                          }}
                        >
                          <action.icon weight="bold" size={15} />
                        </button>
                      ),
                    )}
                  </div>
                </div>
              );
            })}

            <button
              type="button"
              className="dashboard-module-card group relative flex flex-col items-center justify-center p-6 bg-card/40 backdrop-blur-md border-2 border-dashed border-border/70 rounded-2xl transition-all duration-500 hover:-translate-y-1 hover:bg-card/70 hover:border-primary/50 hover:shadow-soft-hover overflow-hidden"
              onClick={openAddDialog}
            >
              <div className="absolute inset-0 bg-gradient-to-br from-primary/[0.05] via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
              <div className="w-12 h-12 rounded-2xl bg-muted flex items-center justify-center text-muted-foreground group-hover:bg-primary group-hover:text-primary-foreground group-hover:shadow-lg group-hover:shadow-primary/25 transition-all duration-300 mb-3 group-active:scale-95">
                <Plus weight="bold" size={22} />
              </div>
              <span className="text-sm font-bold text-muted-foreground group-hover:text-foreground transition-colors">
                {t("add_account")}
              </span>
            </button>
          </div>
        )}
      </main>

      {showAddDialog && (
        <div className="modal-overlay active">
          <div
            className="glass-panel modal-content modal-content-fit !max-w-[420px] !p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header !mb-5">
              <div className="modal-title !text-lg">
                {reloginAccountName ? t("relogin_account") : t("add_account")}
              </div>
              <div className="modal-close" onClick={handleCloseAddDialog}>
                <X weight="bold" />
              </div>
            </div>

            <div className="animate-float-up space-y-4">
              <div className="flex gap-2">
                <button
                  className={`flex-1 h-9 text-xs font-bold rounded-lg ${loginMode === "phone" ? "btn-gradient" : "btn-secondary"}`}
                  onClick={() => {
                    if (loginMode !== "phone" && qrLogin?.login_id) {
                      handleCancelQrLogin();
                    }
                    setLoginMode("phone");
                  }}
                >
                  {t("login_method_phone")}
                </button>
                <button
                  className={`flex-1 h-9 text-xs font-bold rounded-lg ${loginMode === "qr" ? "btn-gradient" : "btn-secondary"}`}
                  onClick={() => setLoginMode("qr")}
                >
                  {t("login_method_qr")}
                </button>
              </div>

              {loginMode === "phone" ? (
                <>
                  <div>
                    <label className="text-[11px] mb-1">
                      {t("session_name")}
                    </label>
                    <input
                      type="text"
                      className="!py-2.5 !px-4 !mb-4"
                      placeholder={t("account_name_placeholder")}
                      value={loginData.account_name}
                      onChange={(e) => {
                        const cleaned = sanitizeAccountName(e.target.value);
                        setLoginData({ ...loginData, account_name: cleaned });
                      }}
                    />

                    <label className="text-[11px] mb-1">
                      {t("phone_number")}
                    </label>
                    <input
                      type="text"
                      className="!py-2.5 !px-4 !mb-4"
                      placeholder={t("phone_number_placeholder")}
                      value={loginData.phone_number}
                      onChange={(e) =>
                        setLoginData({
                          ...loginData,
                          phone_number: e.target.value,
                        })
                      }
                    />

                    <label className="text-[11px] mb-1">
                      {t("login_code")}
                    </label>
                    <div className="input-group !mb-4">
                      <input
                        type="text"
                        className="!py-2.5 !px-4"
                        placeholder={t("login_code_placeholder")}
                        value={loginData.phone_code}
                        onChange={(e) =>
                          setLoginData({
                            ...loginData,
                            phone_code: e.target.value,
                          })
                        }
                      />
                      <button
                        className="btn-code !h-[42px] !w-[42px] !text-lg"
                        onClick={handleStartLogin}
                        disabled={loading}
                        title={t("send_code")}
                      >
                        {loading ? (
                          <Spinner className="animate-spin" size={16} />
                        ) : (
                          <PaperPlaneRight weight="bold" />
                        )}
                      </button>
                    </div>

                    <label className="text-[11px] mb-1">
                      {t("two_step_pass")}
                    </label>
                    <input
                      type="password"
                      className="!py-2.5 !px-4 !mb-4"
                      placeholder={t("two_step_placeholder")}
                      value={loginData.password}
                      onChange={(e) =>
                        setLoginData({ ...loginData, password: e.target.value })
                      }
                    />

                    <label className="text-[11px] mb-1">{t("proxy")}</label>
                    <input
                      type="text"
                      className="!py-2.5 !px-4"
                      placeholder={t("proxy_placeholder")}
                      style={{ marginBottom: 0 }}
                      value={loginData.proxy}
                      onChange={(e) =>
                        setLoginData({ ...loginData, proxy: e.target.value })
                      }
                    />
                  </div>

                  <div className="flex gap-3 mt-6">
                    <button
                      className="btn-secondary flex-1 h-10 !py-0 !text-xs"
                      onClick={handleCloseAddDialog}
                    >
                      {t("cancel")}
                    </button>
                    <button
                      className="btn-gradient flex-1 h-10 !py-0 !text-xs"
                      onClick={handleVerifyLogin}
                      disabled={
                        loading ||
                        !loginData.phone_code.trim() ||
                        !loginData.phone_code_hash
                      }
                    >
                      {loading ? (
                        <Spinner className="animate-spin" />
                      ) : (
                        t("confirm_connect")
                      )}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="text-[11px] mb-1">
                      {t("session_name")}
                    </label>
                    <input
                      type="text"
                      className="!py-2.5 !px-4 !mb-4"
                      placeholder={t("account_name_placeholder")}
                      value={loginData.account_name}
                      onChange={(e) => {
                        const cleaned = sanitizeAccountName(e.target.value);
                        setLoginData({ ...loginData, account_name: cleaned });
                      }}
                    />

                    <label className="text-[11px] mb-1">
                      {t("two_step_pass")}
                    </label>
                    <input
                      type="password"
                      className="!py-2.5 !px-4 !mb-4"
                      placeholder={t("two_step_placeholder")}
                      value={qrPassword}
                      onChange={(e) => setQrPassword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        if (qrPhase !== "password") return;
                        if (!qrPassword || qrPasswordLoading) return;
                        e.preventDefault();
                        handleSubmitQrPassword(qrPassword);
                      }}
                    />
                    <label className="text-[11px] mb-1">{t("proxy")}</label>
                    <input
                      type="text"
                      className="!py-2.5 !px-4 !mb-4"
                      placeholder={t("proxy_placeholder")}
                      value={loginData.proxy}
                      onChange={(e) =>
                        setLoginData({ ...loginData, proxy: e.target.value })
                      }
                    />
                  </div>

                  <div className="glass-panel !bg-black/5 p-4 rounded-xl space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs text-main/60">{t("qr_tip")}</div>
                      <button
                        className="btn-secondary h-8 !px-3 !py-0 !text-[11px]"
                        onClick={handleStartQrLogin}
                        disabled={qrLoading}
                      >
                        {qrLoading ? (
                          <Spinner className="animate-spin" />
                        ) : qrLogin ? (
                          t("qr_refresh")
                        ) : (
                          t("qr_start")
                        )}
                      </button>
                    </div>
                    <div className="flex items-center justify-center">
                      {qrLogin?.qr_image ? (
                        <Image
                          src={qrLogin.qr_image}
                          alt={t("qr_alt")}
                          width={160}
                          height={160}
                          className="rounded-lg bg-white p-2"
                        />
                      ) : (
                        <div className="w-40 h-40 rounded-lg bg-white/5 flex items-center justify-center text-xs text-main/40">
                          {t("qr_start")}
                        </div>
                      )}
                    </div>
                    {qrLogin &&
                    (qrPhase === "ready" || qrPhase === "scanning") ? (
                      <div className="text-[11px] text-main/40 font-mono text-center">
                        {t("qr_expires_in").replace(
                          "{seconds}",
                          qrCountdown.toString(),
                        )}
                      </div>
                    ) : null}
                    <div className="text-xs text-center font-bold">
                      {(qrPhase === "loading" || qrPhase === "ready") &&
                        t("qr_waiting")}
                      {qrPhase === "scanning" && t("qr_scanned")}
                      {qrPhase === "password" && t("qr_password_required")}
                      {qrPhase === "success" && t("qr_success")}
                      {qrPhase === "expired" && t("qr_expired")}
                      {qrPhase === "error" && t("qr_failed")}
                    </div>
                    {qrMessage ? (
                      <div className="text-[11px] text-rose-400 text-center">
                        {qrMessage}
                      </div>
                    ) : null}
                  </div>

                  <div className="flex gap-3 mt-2">
                    <button
                      className="btn-secondary flex-1 h-10 !py-0 !text-xs"
                      onClick={handleCloseAddDialog}
                    >
                      {t("cancel")}
                    </button>
                    <button
                      className="btn-gradient flex-1 h-10 !py-0 !text-xs"
                      onClick={() => handleSubmitQrPassword(qrPassword)}
                      disabled={
                        qrPhase !== "password" ||
                        !qrPassword ||
                        qrPasswordLoading
                      }
                    >
                      {qrPasswordLoading ? (
                        <Spinner className="animate-spin" />
                      ) : (
                        t("confirm_connect")
                      )}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {showEditDialog && (
        <div className="modal-overlay active">
          <div
            className="glass-panel modal-content !max-w-[420px] !p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header !mb-5">
              <div className="modal-title !text-lg">{t("edit_account")}</div>
              <div
                className="modal-close"
                onClick={() => setShowEditDialog(false)}
              >
                <X weight="bold" />
              </div>
            </div>

            <div className="animate-float-up space-y-4">
              <div>
                <label className="text-[11px] mb-1">{t("session_name")}</label>
                <input
                  type="text"
                  className="!py-2.5 !px-4 !mb-4"
                  value={editData.account_name}
                  disabled
                />

                <label className="text-[11px] mb-1">{t("remark")}</label>
                <input
                  type="text"
                  className="!py-2.5 !px-4 !mb-4"
                  placeholder={t("remark_placeholder")}
                  value={editData.remark}
                  onChange={(e) =>
                    setEditData({ ...editData, remark: e.target.value })
                  }
                />

                <label className="text-[11px] mb-1">{t("proxy")}</label>
                <input
                  type="text"
                  className="!py-2.5 !px-4"
                  placeholder={t("proxy_placeholder")}
                  style={{ marginBottom: 0 }}
                  value={editData.proxy}
                  onChange={(e) =>
                    setEditData({ ...editData, proxy: e.target.value })
                  }
                />
              </div>

              <div className="flex gap-3 mt-6">
                <button
                  className="btn-secondary flex-1 h-10 !py-0 !text-xs !bg-amber-500/10 !text-amber-500 hover:!bg-amber-500/20"
                  onClick={() => {
                    setShowEditDialog(false);
                    openReloginDialog(
                      {
                        name: editData.account_name,
                        proxy: editData.proxy,
                      } as any,
                      false,
                    );
                  }}
                >
                  {t("relogin") || "Re-login"}
                </button>
                <button
                  className="btn-secondary flex-1 h-10 !py-0 !text-xs"
                  onClick={() => setShowEditDialog(false)}
                >
                  {t("cancel")}
                </button>
                <button
                  className="btn-gradient flex-1 h-10 !py-0 !text-xs"
                  onClick={handleSaveEdit}
                  disabled={loading}
                >
                  {loading ? <Spinner className="animate-spin" /> : t("save")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showChatExportDialog && (
        <div className="modal-overlay active">
          <div
            className="glass-panel modal-content !max-w-3xl max-h-[90vh] flex flex-col overflow-hidden !p-0"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 border-b border-white/5 flex justify-between items-center bg-white/2">
              <div className="min-w-0">
                <div className="font-bold text-lg truncate">
                  {t("chat_migration_export")}
                </div>
                <div className="text-xs text-main/40 truncate">
                  {chatExportAccount}
                </div>
              </div>
              <div
                className="modal-close"
                onClick={() => setShowChatExportDialog(false)}
              >
                <X weight="bold" />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4 custom-scrollbar">
              <div>
                <label className="text-[11px] mb-1">{t("session_name")}</label>
                <input
                  type="text"
                  className="!py-2.5 !px-4 !mb-4"
                  value={chatExportAccount}
                  disabled
                />

                <label className="text-[11px] mb-2">
                  {t("chat_migration_export_scope")}
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ["all", t("chat_migration_scope_all")],
                    ["groups", t("chat_migration_scope_groups")],
                    ["channels", t("chat_migration_scope_channels")],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      className={`h-10 text-xs font-bold rounded-lg ${
                        chatExportScope === value
                          ? "btn-gradient"
                          : "btn-secondary"
                      }`}
                      onClick={() =>
                        handleExportScopeChange(
                          value as ChatMigrationExportScope,
                        )
                      }
                      disabled={chatExportLoading}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="text-xs text-main/45 leading-relaxed rounded-xl bg-white/3 border border-white/5 p-3">
                {t("chat_migration_export_scope_hint")}
              </div>

              {chatExportPayload ? (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {getMigrationStatCards(
                    chatExportPayload.items || [],
                    chatExportSelectedIds,
                  ).map(([key, label, value]) => (
                    <div
                      key={key}
                      className="rounded-xl border border-white/5 bg-white/2 p-3"
                    >
                      <div className="text-lg font-bold">{value}</div>
                      <div className="text-[10px] text-main/40">{label}</div>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="rounded-xl border border-white/5 bg-white/2 overflow-hidden">
                <div className="p-3 border-b border-white/5 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-bold">
                      {t("chat_migration_export_preview")}
                    </div>
                    <div className="text-xs text-main/40">
                      {t("chat_migration_selected_count")
                        .replace(
                          "{selected}",
                          countSelectedChats(chatExportSelectedIds).toString(),
                        )
                        .replace(
                          "{total}",
                          (chatExportPayload?.items?.length || 0).toString(),
                        )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="btn-secondary h-8 !py-0 !px-3 !text-[11px]"
                      onClick={() => loadChatExportPreview()}
                      disabled={chatExportLoading}
                    >
                      {chatExportLoading ? (
                        <Spinner className="animate-spin" />
                      ) : (
                        t("chat_migration_load_list")
                      )}
                    </button>
                    <button
                      className="btn-secondary h-8 !py-0 !px-3 !text-[11px]"
                      onClick={() => setAllChatExportItems(true)}
                      disabled={!chatExportPayload || chatExportLoading}
                    >
                      {t("select_all")}
                    </button>
                    <button
                      className="btn-secondary h-8 !py-0 !px-3 !text-[11px]"
                      onClick={() => setAllChatExportItems(false)}
                      disabled={!chatExportPayload || chatExportLoading}
                    >
                      {t("clear")}
                    </button>
                  </div>
                </div>

                {chatExportPayload ? (
                  <div className="p-3 border-b border-white/5">
                    <input
                      type="search"
                      className="!mb-0 !py-2 !px-3 text-xs"
                      placeholder={t("chat_migration_search_placeholder")}
                      value={chatExportSearch}
                      onChange={(e) => setChatExportSearch(e.target.value)}
                    />
                  </div>
                ) : null}

                {chatExportError ? (
                  <div className="m-3 rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200 break-words">
                    {chatExportError}
                  </div>
                ) : null}

                {chatExportPayload ? (
                  <div className="max-h-[320px] overflow-y-auto custom-scrollbar">
                    {chatExportVisibleItems.length ? (
                      chatExportVisibleItems.map(({ item, index }) =>
                        renderMigrationItem(
                          item,
                          index,
                          chatExportSelectedIds,
                          handleToggleChatExportItem,
                        ),
                      )
                    ) : (
                      <div className="p-6 text-center text-xs text-main/40">
                        {t("chat_migration_no_matches")}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="p-6 text-center text-xs text-main/40">
                    {t("chat_migration_load_list_hint")}
                  </div>
                )}
              </div>
            </div>

            <div className="p-4 border-t border-white/5 flex gap-3 bg-white/2">
              <button
                className="btn-secondary flex-1 h-10 !py-0 !text-xs"
                onClick={() => setShowChatExportDialog(false)}
              >
                {t("cancel")}
              </button>
              <button
                className="btn-gradient flex-1 h-10 !py-0 !text-xs"
                onClick={handleExportChats}
                disabled={chatExportLoading}
              >
                {chatExportLoading ? (
                  <Spinner className="animate-spin" />
                ) : chatExportPayload ? (
                  t("chat_migration_export_selected").replace(
                    "{count}",
                    countSelectedChats(chatExportSelectedIds).toString(),
                  )
                ) : (
                  t("chat_migration_load_list")
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {showChatImportDialog && (
        <div className="modal-overlay active">
          <div
            className="glass-panel modal-content chat-import-modal !max-w-5xl max-h-[90vh] flex flex-col overflow-hidden !p-0"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="chat-import-header">
              <div className="flex items-center gap-3 min-w-0">
                <div className="chat-import-header-icon">
                  <UploadSimple weight="bold" size={18} />
                </div>
                <div className="min-w-0">
                  <div className="font-bold text-lg truncate">
                    {t("chat_migration_import")}
                  </div>
                  <div className="text-xs text-main/40 truncate">
                    {chatImportAccount}
                  </div>
                </div>
              </div>
              <div
                className="modal-close"
                onClick={() => setShowChatImportDialog(false)}
              >
                <X weight="bold" />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5 custom-scrollbar">
              <div className="chat-import-grid">
                <div className="chat-import-main space-y-4">
                  {chatImportJob ? (
                    <div className="chat-import-job-banner">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-black">
                            {t("chat_migration_background_title")}
                          </span>
                          <span className="chat-import-status-pill">
                            {t(`chat_migration_job_${chatImportJob.status}`)}
                          </span>
                        </div>
                        <div className="mt-2 text-xs text-main/60">
                          {t("chat_migration_import_progress")
                            .replace(
                              "{done}",
                              String(chatImportJob.progress?.done || 0),
                            )
                            .replace(
                              "{total}",
                              String(chatImportJob.progress?.total || 0),
                            )}
                        </div>
                        <div className="mt-3 h-2 rounded-full bg-white/60 dark:bg-white/10 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-sky-400 transition-all"
                            style={{
                              width: `${chatImportJobProgressPercent}%`,
                            }}
                          />
                        </div>
                      </div>
                      {chatImportJobActive ? (
                        <button
                          className="btn-secondary h-9 !py-0 !px-3 !text-xs !text-rose-500"
                          onClick={() => handleStopChatImportJob(chatImportJob)}
                          disabled={chatImportJobActionLoading}
                        >
                          {chatImportJobActionLoading ? (
                            <Spinner className="animate-spin" />
                          ) : (
                            <>
                              <Stop weight="bold" />
                              {t("chat_migration_stop_background")}
                            </>
                          )}
                        </button>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="chat-import-notice">
                    <WarningCircle
                      weight="bold"
                      size={18}
                      className="chat-import-notice-icon"
                    />
                    <div>
                      <div className="chat-import-notice-title">
                        {t("chat_migration_notice_title")}
                      </div>
                      <div className="chat-import-notice-text">
                        {t("chat_migration_notice")}
                      </div>
                    </div>
                  </div>

                  <div className="chat-import-controls">
                    <div className="min-w-0">
                      <label className="text-[11px] mb-1">
                        {t("upload_json")}
                      </label>
                      <input
                        type="file"
                        accept="application/json,.json"
                        className="!mb-0"
                        onChange={handleChatImportFile}
                      />
                    </div>
                    <div>
                      <label className="text-[11px] mb-1">
                        {t("chat_migration_delay")}
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={120}
                        className="!mb-0"
                        value={chatImportDelay}
                        onChange={(e) =>
                          setChatImportDelay(Number(e.target.value || 0))
                        }
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-3 mb-1">
                      <label className="text-[11px] !mb-0">
                        {t("chat_migration_json")}
                      </label>
                      <button
                        className="btn-secondary h-8 !py-0 !px-3 !text-[11px]"
                        onClick={() => setChatImportShowJson((prev) => !prev)}
                      >
                        {chatImportShowJson ? t("collapse") : t("expand")}
                      </button>
                    </div>
                    {chatImportShowJson ? (
                      <textarea
                        className="!mb-0 min-h-[150px] font-mono text-xs"
                        placeholder={t("chat_migration_json_placeholder")}
                        value={chatImportJson}
                        onChange={(e) => {
                          setChatImportJson(e.target.value);
                          try {
                            loadChatImportPreview(e.target.value);
                          } catch {
                            setChatImportPayload(null);
                            setChatImportSelectedIds({});
                            setChatImportError("");
                            setChatImportResult(null);
                            setChatImportProgress("");
                          }
                        }}
                      />
                    ) : null}
                  </div>

                  {chatImportPayload ? (
                    <>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                        {getMigrationStatCards(
                          (chatImportPayload.items ||
                            []) as ChatMigrationItem[],
                          chatImportSelectedIds,
                        ).map(([key, label, value]) => (
                          <div
                            key={key}
                            className="rounded-xl border border-white/5 bg-white/2 p-3"
                          >
                            <div className="text-lg font-bold">{value}</div>
                            <div className="text-[10px] text-main/40">
                              {label}
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="rounded-xl border border-white/5 bg-white/2 overflow-hidden">
                        <div className="p-3 border-b border-white/5 flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-bold">
                              {t("chat_migration_import_preview")}
                            </div>
                            <div className="text-xs text-main/40">
                              {t("chat_migration_selected_count")
                                .replace(
                                  "{selected}",
                                  countSelectedChats(
                                    chatImportSelectedIds,
                                  ).toString(),
                                )
                                .replace(
                                  "{total}",
                                  (
                                    chatImportPayload.items?.length || 0
                                  ).toString(),
                                )}
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <button
                              className="btn-secondary h-8 !py-0 !px-3 !text-[11px]"
                              onClick={() => setAllChatImportItems(true)}
                              disabled={
                                chatImportLoading || !chatImportExistingPayload
                              }
                            >
                              {t("select_all")}
                            </button>
                            <button
                              className="btn-secondary h-8 !py-0 !px-3 !text-[11px]"
                              onClick={() => setAllChatImportItems(false)}
                              disabled={chatImportLoading}
                            >
                              {t("clear")}
                            </button>
                          </div>
                        </div>
                        <div className="p-3 border-b border-white/5">
                          <input
                            type="search"
                            className="!mb-0 !py-2 !px-3 text-xs"
                            placeholder={t("chat_migration_search_placeholder")}
                            value={chatImportSearch}
                            onChange={(e) =>
                              setChatImportSearch(e.target.value)
                            }
                          />
                        </div>
                        <div className="max-h-[260px] overflow-y-auto custom-scrollbar">
                          {chatImportVisibleItems.length ? (
                            chatImportVisibleItems.map(({ item, index }) =>
                              renderMigrationItem(
                                item,
                                index,
                                chatImportSelectedIds,
                                handleToggleChatImportItem,
                                chatImportLoading,
                                isChatAlreadyJoined,
                              ),
                            )
                          ) : (
                            <div className="p-6 text-center text-xs text-main/40">
                              {t("chat_migration_no_matches")}
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  ) : null}

                  <label className="flex items-center gap-2 !mb-0 text-xs text-main/60">
                    <input
                      type="checkbox"
                      checked={chatImportDryRun}
                      onChange={(e) => setChatImportDryRun(e.target.checked)}
                    />
                    {t("chat_migration_dry_run")}
                  </label>

                  {chatImportPayload ? (
                    <div className="rounded-xl border border-sky-500/15 bg-sky-500/10 p-3 text-xs text-sky-200">
                      <div className="flex items-center justify-between gap-3">
                        <span>
                          {chatImportProgress ||
                            t("chat_migration_import_ready")}
                        </span>
                        <span>
                          {chatImportProcessedTotal}/{chatImportSelectedTotal}
                        </span>
                      </div>
                      <div className="mt-2 h-2 rounded-full bg-white/10 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-sky-400 transition-all"
                          style={{
                            width: `${chatImportProgressPercent}%`,
                          }}
                        />
                      </div>
                    </div>
                  ) : null}

                  {chatImportError ? (
                    <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200 break-words">
                      {chatImportError}
                    </div>
                  ) : null}

                  {chatImportResult ? (
                    <div className="rounded-xl border border-white/5 bg-white/2 overflow-hidden">
                      <div className="p-3 border-b border-white/5 grid grid-cols-2 md:grid-cols-5 gap-2 text-center">
                        {[
                          ["joined", t("chat_migration_joined")],
                          ["already_member", t("chat_migration_already")],
                          ["request_sent", t("chat_migration_request_sent")],
                          ["manual_required", t("chat_migration_manual")],
                          ["failed", t("failure")],
                        ].map(([key, label]) => (
                          <div key={key} className="rounded-lg bg-white/3 p-2">
                            <div className="text-base font-bold">
                              {key === "failed"
                                ? chatImportResult.summary?.failed || 0
                                : chatImportResult.summary?.[key] || 0}
                            </div>
                            <div className="text-[10px] text-main/40">
                              {label}
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="max-h-[260px] overflow-y-auto custom-scrollbar">
                        {chatImportResult.results.map((item, index) => {
                          const statusColor =
                            item.status === "joined" ||
                            item.status === "already_member"
                              ? "text-emerald-400"
                              : item.status === "request_sent" ||
                                  item.status === "manual_required" ||
                                  item.status === "ready"
                                ? "text-amber-300"
                                : "text-rose-400";
                          return (
                            <div
                              key={`${item.title}-${index}`}
                              className="p-3 border-b border-white/5 last:border-0"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="font-semibold truncate">
                                  {item.title}
                                </div>
                                <div
                                  className={`text-[10px] font-bold uppercase shrink-0 ${statusColor}`}
                                >
                                  {item.status}
                                </div>
                              </div>
                              <div className="text-xs text-main/45 mt-1 leading-relaxed break-words">
                                {item.message}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="chat-import-side">
                  {chatImportJobHistory.length ? (
                    <div className="rounded-xl border border-white/5 bg-white/2 overflow-hidden">
                      <div className="p-3 border-b border-white/5 flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-bold">
                            {t("chat_migration_recent_records")}
                          </div>
                          <div className="text-xs text-main/40">
                            {chatImportJobHistory.length}/5
                          </div>
                        </div>
                      </div>
                      <div className="max-h-[320px] overflow-y-auto custom-scrollbar">
                        {chatImportJobHistory.map(
                          (historyItem, historyIndex) => {
                            const failed = historyItem.summary?.failed || 0;
                            const resumeItems =
                              getChatImportResumeItems(historyItem);
                            const canResumeHistory =
                              ["canceled", "failed"].includes(
                                historyItem.status,
                              ) && resumeItems.length > 0;
                            const isHistoryActive = [
                              "running",
                              "canceling",
                            ].includes(historyItem.status);
                            const attentionItems = (
                              historyItem.results || []
                            ).filter((item) =>
                              [
                                "manual_required",
                                "failed",
                                "request_sent",
                              ].includes(item.status),
                            );
                            return (
                              <div
                                key={historyItem.job_id}
                                className="p-3 border-b border-white/5 last:border-0"
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <div className="text-xs font-bold truncate">
                                        #{historyIndex + 1} ·{" "}
                                        {historyItem.account_name}
                                      </div>
                                      <span className="chat-import-status-pill">
                                        {t(
                                          `chat_migration_job_${historyItem.status}`,
                                        )}
                                      </span>
                                    </div>
                                    <div className="mt-1 text-[11px] text-main/45">
                                      {formatConfiguredLegacyLocalDateTime(
                                        historyItem.finished_at ||
                                          historyItem.updated_at,
                                        timezone,
                                      )}
                                    </div>
                                  </div>
                                  <div className="flex shrink-0 flex-wrap justify-end gap-2">
                                    <button
                                      className="btn-secondary h-7 !py-0 !px-2 !text-[10px]"
                                      onClick={() =>
                                        handleInspectChatImportHistoryItem(
                                          historyItem,
                                        )
                                      }
                                      disabled={chatImportJobActionLoading}
                                    >
                                      {t("chat_migration_view_details")}
                                    </button>
                                    {isHistoryActive ? (
                                      <button
                                        className="btn-secondary h-7 !py-0 !px-2 !text-[10px] !text-rose-500"
                                        onClick={() =>
                                          handleStopChatImportJob(historyItem)
                                        }
                                        disabled={
                                          chatImportJobActionLoading ||
                                          historyItem.status === "canceling"
                                        }
                                      >
                                        <Stop weight="bold" size={12} />
                                        {t("chat_migration_stop_background")}
                                      </button>
                                    ) : null}
                                    {canResumeHistory ? (
                                      <button
                                        className="btn-secondary h-7 !py-0 !px-2 !text-[10px] !text-sky-500"
                                        onClick={() =>
                                          handleResumeChatImportHistoryItem(
                                            historyItem,
                                          )
                                        }
                                        disabled={chatImportJobActionLoading}
                                        title={t(
                                          "chat_migration_resume_background",
                                        )}
                                      >
                                        <Play weight="bold" size={12} />
                                        {t("chat_migration_resume_background")}
                                      </button>
                                    ) : null}
                                    <button
                                      className="btn-secondary h-7 !py-0 !px-2 !text-[10px] !text-rose-500"
                                      onClick={() =>
                                        handleClearChatImportHistoryItem(
                                          historyItem.job_id,
                                        )
                                      }
                                    >
                                      {t("chat_migration_clear_record")}
                                    </button>
                                  </div>
                                </div>
                                <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                                  {[
                                    ["joined", t("chat_migration_joined")],
                                    [
                                      "request_sent",
                                      t("chat_migration_request_sent"),
                                    ],
                                    [
                                      "manual_required",
                                      t("chat_migration_manual"),
                                    ],
                                    ["failed", t("failure")],
                                  ].map(([key, label]) => (
                                    <div
                                      key={key}
                                      className="rounded-lg bg-white/3 p-2"
                                    >
                                      <div className="text-sm font-bold">
                                        {key === "failed"
                                          ? failed
                                          : historyItem.summary?.[key] || 0}
                                      </div>
                                      <div className="text-[9px] text-main/40">
                                        {label}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                                {["canceled", "failed"].includes(
                                  historyItem.status,
                                ) && !canResumeHistory ? (
                                  <div className="mt-3 rounded-lg border border-slate-500/15 bg-slate-500/10 px-3 py-2 text-xs text-main/55">
                                    {t("chat_migration_resume_unavailable")}
                                  </div>
                                ) : null}
                                {attentionItems.length ? (
                                  <div className="mt-3 overflow-hidden rounded-lg border border-amber-500/15 bg-amber-500/10">
                                    <div className="px-3 py-2 text-xs font-bold text-amber-600 dark:text-amber-200">
                                      {t("chat_migration_attention_list")} ·{" "}
                                      {attentionItems.length}
                                    </div>
                                    <div className="max-h-40 overflow-y-auto custom-scrollbar">
                                      {attentionItems.map((item, index) => (
                                        <div
                                          key={`${historyItem.job_id}-${item.title}-${index}`}
                                          className="border-t border-amber-500/10 px-3 py-2"
                                        >
                                          <div className="flex items-center justify-between gap-2">
                                            <div className="min-w-0 truncate text-xs font-semibold">
                                              {item.title ||
                                                item.username ||
                                                item.join_ref ||
                                                "-"}
                                            </div>
                                            <div className="shrink-0 text-[10px] font-bold uppercase text-amber-600 dark:text-amber-300">
                                              {item.status}
                                            </div>
                                          </div>
                                          <div className="mt-1 truncate text-[11px] text-main/45">
                                            {item.username
                                              ? `@${item.username}`
                                              : item.join_ref ||
                                                item.type ||
                                                "-"}
                                          </div>
                                          <div className="mt-1 break-words text-[11px] text-main/60">
                                            {item.message ||
                                              t(
                                                "chat_migration_attention_hint",
                                              )}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                ) : (
                                  <div className="mt-3 rounded-lg border border-emerald-500/15 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-500">
                                    {t("chat_migration_no_attention")}
                                  </div>
                                )}
                              </div>
                            );
                          },
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-white/5 bg-white/2 p-5 text-center text-xs text-main/40">
                      {t("chat_migration_recent_records")}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="p-4 border-t border-white/5 bg-white/2">
              {chatImportJobActive ? (
                <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-sky-500/15 bg-sky-500/10 px-3 py-2 text-xs text-sky-600 dark:text-sky-200">
                  <span className="font-semibold">
                    {t("chat_migration_background_title")} ·{" "}
                    {chatImportJobProgressPercent}%
                  </span>
                </div>
              ) : null}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <button
                  className="btn-secondary h-10 !py-0 !text-xs"
                  onClick={() => setShowChatImportDialog(false)}
                >
                  {t("close")}
                </button>
                <button
                  className="btn-secondary h-10 !py-0 !text-xs !text-sky-500"
                  onClick={handleImportChatsInBackground}
                  disabled={
                    chatImportLoading ||
                    chatImportJobActionLoading ||
                    !chatImportJson.trim() ||
                    !chatImportSelectedTotal
                  }
                >
                  {chatImportJobActionLoading ? (
                    <Spinner className="animate-spin" />
                  ) : (
                    <>
                      <ArrowsOutSimple weight="bold" />
                      {t("chat_migration_run_background")}
                    </>
                  )}
                </button>
                <button
                  className="btn-gradient h-10 !py-0 !text-xs"
                  onClick={handleImportChats}
                  disabled={
                    chatImportLoading ||
                    !chatImportJson.trim() ||
                    !chatImportSelectedTotal
                  }
                >
                  {chatImportLoading ? (
                    <Spinner className="animate-spin" />
                  ) : chatImportDryRun ? (
                    t("chat_migration_preview_selected").replace(
                      "{count}",
                      chatImportSelectedTotal.toString(),
                    )
                  ) : (
                    t("chat_migration_import_selected").replace(
                      "{count}",
                      chatImportSelectedTotal.toString(),
                    )
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showLogsDialog && (
        <div className="modal-overlay active">
          <div
            className="glass-panel modal-content !max-w-4xl max-h-[90vh] flex flex-col overflow-hidden !p-0"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 border-b border-white/5 flex justify-between items-center bg-white/2">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-[#8a3ffc]/10 rounded-lg text-[#8a3ffc]">
                  <ListDashes weight="bold" size={18} />
                </div>
                <div className="font-bold text-lg">
                  {logsAccountName} {t("running_logs")}
                </div>
              </div>
              <div
                className="modal-close"
                onClick={() => setShowLogsDialog(false)}
              >
                <X weight="bold" />
              </div>
            </div>

            <div className="px-5 py-3 border-b border-white/5 flex justify-between items-center bg-white/2">
              <div className="text-[10px] text-main/30 font-bold uppercase tracking-wider">
                {t("logs_summary")
                  .replace("{count}", accountLogs.length.toString())
                  .replace("{days}", "3")}
              </div>
              {accountLogs.length > 0 && (
                <button
                  onClick={handleClearLogs}
                  disabled={loading}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/10 text-rose-400 text-[10px] font-bold hover:bg-rose-500/20 transition-all disabled:opacity-50"
                >
                  <Trash weight="bold" size={14} />
                  {t("clear_logs")}
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-5 font-mono text-[13px] bg-black/10 custom-scrollbar">
              {logsLoading ? (
                <div className="flex flex-col items-center justify-center py-20 text-main/30">
                  <Spinner className="animate-spin mb-4" size={32} />
                  {t("loading")}
                </div>
              ) : accountLogs.length === 0 ? (
                <div className="text-center py-20 text-main/20 font-sans">
                  {t("no_logs")}
                </div>
              ) : (
                <div className="space-y-3">
                  {accountLogs.map((log, i) => (
                    <div
                      key={i}
                      className="p-4 rounded-xl bg-white/2 border border-white/5 group hover:border-white/10 transition-colors"
                    >
                      <div className="flex justify-between items-center mb-2.5 text-[10px] uppercase tracking-wider font-bold">
                        <span className="text-main/20 group-hover:text-main/40 transition-colors">
                          {formatConfiguredDateTime(log.created_at, timezone)}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded-md ${log.success ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"}`}
                        >
                          {log.success ? t("success") : t("failure")}
                        </span>
                      </div>
                      <div className="text-main/70 font-semibold mb-2">
                        {`${t("task_label")}: ${log.task_name} ${log.success ? t("task_exec_success") : t("task_exec_failed")}`}
                      </div>
                      {log.bot_message ? (
                        <div className="text-main/60 leading-relaxed whitespace-pre-wrap break-words mb-2">
                          <span className="text-main/35">
                            {t("bot_reply")}:{" "}
                          </span>
                          {log.bot_message}
                        </div>
                      ) : null}
                      {log.message &&
                      ![
                        "Success",
                        "Failed",
                        t("task_exec_success"),
                        t("task_exec_failed"),
                      ].includes(log.message.trim()) ? (
                        <pre className="whitespace-pre-wrap text-main/45 leading-relaxed overflow-x-auto max-h-[120px] scrollbar-none font-medium">
                          {log.message}
                        </pre>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="p-4 border-t border-white/5 text-center bg-white/2">
              <button
                className="btn-secondary px-8 h-9 !py-0 mx-auto !text-xs"
                onClick={() => setShowLogsDialog(false)}
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
