"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getToken, setToken } from "../../../lib/auth";
import {
  changePassword,
  changeUsername,
  exportAllManagedUsersData,
  getMe,
  getTOTPStatus,
  setupTOTP,
  getTOTPQRCode,
  enableTOTP,
  disableTOTP,
  exportAllConfigs,
  exportFullWorkspaceBackup,
  importAllConfigs,
  importAllManagedUsersData,
  importFullWorkspaceBackup,
  getAIConfig,
  saveAIConfig,
  testAIConnection,
  deleteAIConfig,
  AIConfig,
  getGlobalSettings,
  saveGlobalSettings,
  GlobalSettings,
  getTelegramConfig,
  saveTelegramConfig,
  resetTelegramConfig,
  TelegramConfig,
  getSystemLogs,
  clearSystemLogs,
  exportSystemLogs,
  SystemLogsResponse,
} from "../../../lib/api";
import type { CurrentUser } from "../../../lib/types";
import {
  User,
  Lock,
  ShieldCheck,
  Gear,
  Cpu,
  DownloadSimple,
  ArrowClockwise,
  SignOut,
  Spinner,
  ArrowUDownLeft,
  FloppyDisk,
  WarningCircle,
  Trash,
  Robot as BotIcon,
  Terminal,
  GithubLogo,
  type Icon,
} from "@phosphor-icons/react";
import { ToastContainer, useToast } from "../../../components/ui/toast";
import { ThemeLanguageToggle } from "../../../components/ThemeLanguageToggle";
import { useLanguage } from "../../../context/LanguageContext";
import { TelegramBotNotificationSettings } from "./TelegramBotNotificationSettings";

const TIMEZONE_OPTIONS = [
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Taipei",
  "Asia/Tokyo",
  "Asia/Singapore",
  "UTC",
  "America/Los_Angeles",
  "America/New_York",
  "Europe/London",
] as const;

type SettingsSection =
  | "account"
  | "global"
  | "notify"
  | "ai"
  | "telegram"
  | "logs"
  | "backup";

const SETTINGS_SECTIONS: SettingsSection[] = [
  "account",
  "global",
  "notify",
  "ai",
  "telegram",
  "logs",
  "backup",
];

function parseSettingsSection(value: string | null): SettingsSection {
  if (value && SETTINGS_SECTIONS.includes(value as SettingsSection)) {
    return value as SettingsSection;
  }
  return "account";
}

function SettingsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useLanguage();
  const { toasts, addToast, removeToast } = useToast();
  const [token, setLocalToken] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [userLoading, setUserLoading] = useState(false);
  const [pwdLoading, setPwdLoading] = useState(false);
  const [totpLoading, setTotpLoading] = useState(false);
  const [configLoading, setConfigLoading] = useState(false);
  const [telegramLoading, setTelegramLoading] = useState(false);
  const [systemLogsLoading, setSystemLogsLoading] = useState(false);
  const [systemLogs, setSystemLogs] = useState<SystemLogsResponse | null>(null);
  const [systemLogLimit, setSystemLogLimit] = useState(800);
  const activeSection = parseSettingsSection(searchParams.get("section"));

  // Username change form
  const [usernameForm, setUsernameForm] = useState({
    newUsername: "",
    password: "",
  });

  // Password change form
  const [passwordForm, setPasswordForm] = useState({
    oldPassword: "",
    newPassword: "",
    confirmPassword: "",
  });

  // 2FA 鐘舵€?
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [totpSecret, setTotpSecret] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [showTotpSetup, setShowTotpSetup] = useState(false);
  const [totpQrUrl, setTotpQrUrl] = useState("");

  // Config import/export
  const [importConfig, setImportConfig] = useState("");
  const [overwriteConfig, setOverwriteConfig] = useState(false);
  const [fullBackupLoading, setFullBackupLoading] = useState(false);
  const [systemBackupLoading, setSystemBackupLoading] = useState(false);

  // AI config
  const [aiConfig, setAIConfigState] = useState<AIConfig | null>(null);
  const [aiForm, setAIForm] = useState({
    api_key: "",
    base_url: "",
    model: "gpt-4o",
  });
  const [aiTestResult, setAITestResult] = useState<string | null>(null);
  const [aiTestStatus, setAITestStatus] = useState<"success" | "error" | null>(
    null,
  );
  const [aiTesting, setAITesting] = useState(false);

  // Global settings
  const [globalSettings, setGlobalSettings] = useState<GlobalSettings>({
    sign_interval: null,
    log_retention_days: 7,
    timezone: "Asia/Shanghai",
    data_dir: null,
    global_proxy: null,
    telegram_bot_notify_enabled: false,
    telegram_bot_login_notify_enabled: false,
    telegram_bot_task_failure_enabled: true,
    telegram_bot_token: null,
    telegram_bot_token_masked: null,
    telegram_bot_chat_id: null,
    telegram_bot_message_thread_id: null,
  });

  // Telegram API config
  const [telegramConfig, setTelegramConfig] = useState<TelegramConfig | null>(
    null,
  );
  const [telegramForm, setTelegramForm] = useState({
    api_id: "",
    api_hash: "",
  });

  const [checking, setChecking] = useState(true);

  const formatErrorMessage = useCallback(
    (key: string, err?: any) => {
      const base = t(key);
      const code = err?.code;
      return code ? `${base} (${code})` : base;
    },
    [t],
  );

  const formatBytes = (size: number) => {
    if (!Number.isFinite(size) || size <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let value = size;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
  };

  const formatDateTime = (value?: string | null) => {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
  };

  const shortSectionDesc: Record<SettingsSection, string> = {
    account: t("username") + " / 2FA",
    global: t("timezone") + " / " + t("global_proxy"),
    notify: "Bot " + t("settings_notify_desc").replace(/^Telegram Bot\s*/i, ""),
    ai: "API / Model",
    telegram: "API ID / Hash",
    logs: t("logs"),
    backup: t("import_config") + " / " + t("export_config"),
  };

  useEffect(() => {
    const tokenStr = getToken();
    if (!tokenStr) {
      window.location.replace("/");
      return;
    }
    setLocalToken(tokenStr);
    setChecking(false);
    getMe(tokenStr)
      .then(setCurrentUser)
      .catch(() => setCurrentUser(null));
    loadTOTPStatus(tokenStr);
    loadAIConfig(tokenStr);
    loadGlobalSettings(tokenStr);
    loadTelegramConfig(tokenStr);
  }, []);

  const loadTOTPStatus = async (tokenStr: string) => {
    try {
      const res = await getTOTPStatus(tokenStr);
      setTotpEnabled(res.enabled);
    } catch (err) {}
  };

  const loadAIConfig = async (tokenStr: string) => {
    try {
      const config = await getAIConfig(tokenStr);
      setAIConfigState(config);
      if (config) {
        setAIForm({
          api_key: "", // Do not echo the saved secret
          base_url: config.base_url || "",
          model: config.model || "gpt-4o",
        });
      }
    } catch (err) {}
  };

  const loadGlobalSettings = async (tokenStr: string) => {
    try {
      const settings = await getGlobalSettings(tokenStr);
      setGlobalSettings(settings);
    } catch (err) {}
  };

  const loadTelegramConfig = async (tokenStr: string) => {
    try {
      const config = await getTelegramConfig(tokenStr);
      setTelegramConfig(config);
      if (config) {
        setTelegramForm({
          api_id: config.api_id?.toString() || "",
          api_hash: "",
        });
      }
    } catch (err) {}
  };

  const handleChangeUsername = async () => {
    if (!token) return;
    if (!usernameForm.newUsername || !usernameForm.password) {
      addToast(t("form_incomplete"), "error");
      return;
    }
    try {
      setUserLoading(true);
      const res = await changeUsername(
        token,
        usernameForm.newUsername,
        usernameForm.password,
      );
      addToast(t("username_changed"), "success");
      if (res.access_token) {
        setToken(res.access_token);
        setLocalToken(res.access_token);
      }
      setUsernameForm({ newUsername: "", password: "" });
    } catch (err: any) {
      addToast(formatErrorMessage("change_failed", err), "error");
    } finally {
      setUserLoading(false);
    }
  };

  const handleChangePassword = async () => {
    if (!token) return;
    if (!passwordForm.oldPassword || !passwordForm.newPassword) {
      addToast(t("form_incomplete"), "error");
      return;
    }
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      addToast(t("password_mismatch"), "error");
      return;
    }
    if (passwordForm.newPassword.length < 8) {
      addToast(t("password_too_short"), "error");
      return;
    }
    try {
      setPwdLoading(true);
      await changePassword(
        token,
        passwordForm.oldPassword,
        passwordForm.newPassword,
      );
      addToast(t("password_changed"), "success");
      setPasswordForm({
        oldPassword: "",
        newPassword: "",
        confirmPassword: "",
      });
    } catch (err: any) {
      addToast(formatErrorMessage("change_failed", err), "error");
    } finally {
      setPwdLoading(false);
    }
  };

  const handleSetupTOTP = async () => {
    if (!token) return;
    try {
      setTotpLoading(true);
      const res = await setupTOTP(token);
      setTotpSecret(res.secret);
      setShowTotpSetup(true);
      if (totpQrUrl) {
        URL.revokeObjectURL(totpQrUrl);
        setTotpQrUrl("");
      }
      const qrBlob = await getTOTPQRCode(token);
      setTotpQrUrl(URL.createObjectURL(qrBlob));
    } catch (err: any) {
      addToast(formatErrorMessage("setup_failed", err), "error");
    } finally {
      setTotpLoading(false);
    }
  };

  const handleEnableTOTP = async () => {
    if (!token) return;
    if (!totpCode) {
      addToast(t("login_code_required"), "error");
      return;
    }
    try {
      setTotpLoading(true);
      await enableTOTP(token, totpCode);
      addToast(t("two_factor_enabled"), "success");
      setTotpEnabled(true);
      setShowTotpSetup(false);
      setTotpCode("");
      if (totpQrUrl) {
        URL.revokeObjectURL(totpQrUrl);
        setTotpQrUrl("");
      }
    } catch (err: any) {
      addToast(formatErrorMessage("enable_failed", err), "error");
    } finally {
      setTotpLoading(false);
    }
  };

  const handleDisableTOTP = async () => {
    if (!token) return;
    const msg = t("two_factor_disable_prompt");
    const code = prompt(msg);
    if (!code) return;
    try {
      setTotpLoading(true);
      await disableTOTP(token, code);
      addToast(t("two_factor_disabled"), "success");
      setTotpEnabled(false);
      if (totpQrUrl) {
        URL.revokeObjectURL(totpQrUrl);
        setTotpQrUrl("");
      }
    } catch (err: any) {
      addToast(formatErrorMessage("disable_failed", err), "error");
    } finally {
      setTotpLoading(false);
    }
  };

  const handleExport = async () => {
    if (!token) return;
    try {
      setConfigLoading(true);
      const includeSecrets = window.confirm(t("export_full_backup_confirm"));
      const config = await exportAllConfigs(token, includeSecrets);
      const blob = new Blob([config], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = includeSecrets
        ? "tg-flowpulse-config-full.json"
        : "tg-flowpulse-config-redacted.json";
      a.click();
      addToast(t("export_success"), "success");
    } catch (err: any) {
      addToast(formatErrorMessage("export_failed", err), "error");
    } finally {
      setConfigLoading(false);
    }
  };

  const handleImport = async () => {
    if (!token) return;
    if (!importConfig) {
      addToast(t("import_empty"), "error");
      return;
    }
    try {
      setConfigLoading(true);
      await importAllConfigs(token, importConfig, overwriteConfig);
      addToast(t("import_success"), "success");
      setImportConfig("");
      loadAIConfig(token);
      loadGlobalSettings(token);
      loadTelegramConfig(token);
    } catch (err: any) {
      addToast(formatErrorMessage("import_failed", err), "error");
    } finally {
      setConfigLoading(false);
    }
  };

  const handleFullBackupExport = async () => {
    if (!token) return;
    try {
      setFullBackupLoading(true);
      await exportFullWorkspaceBackup(token);
      addToast(
        "完整工作区备份已下载，包含 Telegram 会话、密钥、任务和历史数据。",
        "success",
      );
    } catch (err: any) {
      addToast(err?.message || "导出完整工作区备份失败", "error");
    } finally {
      setFullBackupLoading(false);
    }
  };

  const handleFullBackupImport = async (file: File) => {
    if (!token) return;
    if (
      !window.confirm(
        "恢复将覆盖当前用户的 Telegram 会话、密钥、配置、任务和历史数据；当前平台的用户名、密码和 2FA 不会改变。确认继续？",
      )
    ) {
      return;
    }
    try {
      setFullBackupLoading(true);
      const result = await importFullWorkspaceBackup(token, file);
      addToast(`${result.message} 请重启服务以加载恢复后的会话。`, "success");
    } catch (err: any) {
      addToast(err?.message || "导入完整工作区备份失败", "error");
    } finally {
      setFullBackupLoading(false);
    }
  };

  const handleSystemBackupExport = async () => {
    if (!token) return;
    try {
      setSystemBackupLoading(true);
      await exportAllManagedUsersData(token);
      addToast(
        "完整系统备份已下载，包含全部用户、会话、密钥、2FA 和数据库数据。",
        "success",
      );
    } catch (err: any) {
      addToast(err?.message || "导出完整系统备份失败", "error");
    } finally {
      setSystemBackupLoading(false);
    }
  };

  const handleSystemBackupImport = async (file: File) => {
    if (!token) return;
    if (
      !window.confirm(
        "恢复将覆盖当前整个系统：所有用户的用户名、密码哈希、2FA、Telegram 会话、密钥、数据库和工作区数据。确认继续？",
      )
    ) {
      return;
    }
    try {
      setSystemBackupLoading(true);
      const result = await importAllManagedUsersData(token, file);
      addToast(`${result.message} 请重启服务以完成恢复。`, "success");
    } catch (err: any) {
      addToast(err?.message || "导入完整系统备份失败", "error");
    } finally {
      setSystemBackupLoading(false);
    }
  };

  const handleSaveAI = async () => {
    if (!token) return;
    try {
      setConfigLoading(true);
      const payload: { api_key?: string; base_url?: string; model?: string } = {
        base_url: aiForm.base_url.trim() || undefined,
        model: aiForm.model.trim() || undefined,
      };
      const nextApiKey = aiForm.api_key.trim();
      if (nextApiKey) {
        payload.api_key = nextApiKey;
      }
      await saveAIConfig(token, payload);
      addToast(t("ai_save_success"), "success");
      loadAIConfig(token);
    } catch (err: any) {
      addToast(formatErrorMessage("save_failed", err), "error");
    } finally {
      setConfigLoading(false);
    }
  };

  const handleTestAI = async () => {
    if (!token) return;
    try {
      setAITesting(true);
      setAITestResult(null);
      setAITestStatus(null);
      const res = await testAIConnection(token);
      if (res.success) {
        setAITestStatus("success");
        setAITestResult(res.message || t("connect_success"));
      } else {
        setAITestStatus("error");
        setAITestResult(res.message || t("connect_failed"));
      }
    } catch (err: any) {
      setAITestStatus("error");
      setAITestResult(formatErrorMessage("test_failed", err));
    } finally {
      setAITesting(false);
    }
  };

  const handleDeleteAI = async () => {
    if (!token) return;
    if (!confirm(t("confirm_delete_ai"))) return;
    try {
      setConfigLoading(true);
      await deleteAIConfig(token);
      addToast(t("ai_delete_success"), "success");
      setAIConfigState(null);
      setAIForm({ api_key: "", base_url: "", model: "gpt-4o" });
    } catch (err: any) {
      addToast(formatErrorMessage("delete_failed", err), "error");
    } finally {
      setConfigLoading(false);
    }
  };

  const handleSaveGlobal = async () => {
    if (!token) return;
    try {
      setConfigLoading(true);
      const { telegram_bot_token_masked, ...settingsToSave } = globalSettings;
      await saveGlobalSettings(token, settingsToSave);
      addToast(t("global_save_success"), "success");
    } catch (err: any) {
      addToast(formatErrorMessage("save_failed", err), "error");
    } finally {
      setConfigLoading(false);
    }
  };

  const handleSaveTelegram = async () => {
    if (!token) return;
    if (!telegramForm.api_id || !telegramForm.api_hash) {
      addToast(t("form_incomplete"), "error");
      return;
    }
    try {
      setTelegramLoading(true);
      await saveTelegramConfig(token, {
        api_id: telegramForm.api_id,
        api_hash: telegramForm.api_hash,
      });
      addToast(t("telegram_save_success"), "success");
      loadTelegramConfig(token);
    } catch (err: any) {
      addToast(formatErrorMessage("save_failed", err), "error");
    } finally {
      setTelegramLoading(false);
    }
  };

  const handleResetTelegram = async () => {
    if (!token) return;
    if (!confirm(t("confirm_reset_telegram"))) return;
    try {
      setTelegramLoading(true);
      await resetTelegramConfig(token);
      addToast(t("config_reset"), "success");
      loadTelegramConfig(token);
    } catch (err: any) {
      addToast(formatErrorMessage("operation_failed", err), "error");
    } finally {
      setTelegramLoading(false);
    }
  };

  const loadSystemLogs = useCallback(async () => {
    if (!token) return;
    try {
      setSystemLogsLoading(true);
      const data = await getSystemLogs(token, systemLogLimit);
      setSystemLogs(data);
    } catch (err: any) {
      addToast(formatErrorMessage("logs_fetch_failed", err), "error");
    } finally {
      setSystemLogsLoading(false);
    }
  }, [addToast, formatErrorMessage, systemLogLimit, token]);

  const handleClearSystemLogs = async () => {
    if (!token) return;
    if (!confirm(t("system_logs_clear_confirm"))) return;
    try {
      setSystemLogsLoading(true);
      await clearSystemLogs(token);
      const data = await getSystemLogs(token, systemLogLimit);
      setSystemLogs(data);
      addToast(t("system_logs_cleared"), "success");
    } catch (err: any) {
      addToast(formatErrorMessage("clear_logs_failed", err), "error");
    } finally {
      setSystemLogsLoading(false);
    }
  };

  const handleExportSystemLogs = async () => {
    if (!token) return;
    try {
      await exportSystemLogs(token);
      addToast(t("export_success"), "success");
    } catch (err: any) {
      addToast(formatErrorMessage("operation_failed", err), "error");
    }
  };

  useEffect(() => {
    if (
      activeSection === "logs" &&
      token &&
      !systemLogs &&
      !systemLogsLoading
    ) {
      loadSystemLogs();
    }
  }, [activeSection, token, systemLogs, systemLogsLoading, loadSystemLogs]);

  useEffect(() => {
    return () => {
      if (totpQrUrl) {
        URL.revokeObjectURL(totpQrUrl);
      }
    };
  }, [totpQrUrl]);

  if (!token || checking) {
    return null;
  }

  const settingsSections: Array<{
    id: SettingsSection;
    label: string;
    description: string;
    icon: Icon;
    color: string;
  }> = [
    {
      id: "account",
      label: t("settings_account_security"),
      description: shortSectionDesc.account,
      icon: ShieldCheck,
      color: "text-emerald-400 bg-emerald-500/10",
    },
    {
      id: "global",
      label: t("global_settings"),
      description: shortSectionDesc.global,
      icon: Gear,
      color: "text-violet-400 bg-violet-500/10",
    },
    {
      id: "notify",
      label: t("telegram_bot_notify"),
      description: shortSectionDesc.notify,
      icon: BotIcon,
      color: "text-cyan-400 bg-cyan-500/10",
    },
    {
      id: "ai",
      label: t("ai_config"),
      description: shortSectionDesc.ai,
      icon: BotIcon,
      color: "text-indigo-400 bg-indigo-500/10",
    },
    {
      id: "telegram",
      label: t("tg_api_config"),
      description: shortSectionDesc.telegram,
      icon: Cpu,
      color: "text-sky-400 bg-sky-500/10",
    },
    {
      id: "logs",
      label: t("system_logs"),
      description: shortSectionDesc.logs,
      icon: Terminal,
      color: "text-slate-400 bg-slate-500/10",
    },
    {
      id: "backup",
      label: t("backup_migration"),
      description: shortSectionDesc.backup,
      icon: DownloadSimple,
      color: "text-pink-400 bg-pink-500/10",
    },
  ];

  const activeSectionMeta =
    settingsSections.find((section) => section.id === activeSection) ||
    settingsSections[0];
  const ActiveSectionIcon = activeSectionMeta.icon;

  return (
    <div id="settings-view" className="w-full h-full flex flex-col">
      <nav className="navbar">
        <div className="nav-brand min-w-0">
          <div className="flex items-center min-w-0">
            <div className="navbar-title-block">
              <h1 className="nav-title">{t("sidebar_settings")}</h1>
              <p className="nav-subtitle">
                {t("settings_account_security_desc")}
              </p>
            </div>
          </div>
        </div>
        <div className="top-right-actions">
          <a
            href="https://github.com/ErkundenSie/TG-FlowPulse"
            target="_blank"
            rel="noreferrer"
            className="action-btn"
            title={t("github_repo")}
          >
            <GithubLogo weight="bold" />
          </a>
          <button
            type="button"
            className="action-btn !text-rose-500 hover:!bg-rose-500/10"
            title={t("logout")}
            onClick={() => {
              const { logout } = require("../../../lib/auth");
              logout();
              router.push("/");
            }}
          >
            <SignOut weight="bold" />
          </button>
        </div>
      </nav>

      <main className="main-content settings-main !pt-6">
        <div className="settings-shell settings-shell-single animate-float-up pb-10">
          <section className="settings-content min-w-0 space-y-4">
            <div className="settings-section-header flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className={`settings-icon flex items-center justify-center shrink-0 ${activeSectionMeta.color}`}
                >
                  <ActiveSectionIcon weight="fill" size={20} />
                </div>
                <div className="min-w-0">
                  <h2 className="text-lg font-bold truncate">
                    {activeSectionMeta.label}
                  </h2>
                  <p className="text-[11px] text-main/50 mt-0.5 truncate">
                    {activeSectionMeta.description}
                  </p>
                </div>
              </div>
            </div>

            {activeSection === "account" && (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <div className="settings-panel">
                  <div className="settings-panel-header">
                    <div className="settings-panel-title">
                      <div className="settings-panel-icon bg-blue-500/10 text-blue-400">
                        <User weight="bold" size={18} />
                      </div>
                      <h3 className="text-base font-bold">{t("username")}</h3>
                    </div>
                  </div>

                  <div className="settings-field-grid">
                    <div>
                      <label className="text-[12px] mb-1.5">
                        {t("new_username")}
                      </label>
                      <input
                        type="text"
                        className="!py-2.5 !px-4"
                        placeholder={t("new_username_placeholder")}
                        value={usernameForm.newUsername}
                        onChange={(e) =>
                          setUsernameForm({
                            ...usernameForm,
                            newUsername: e.target.value,
                          })
                        }
                      />
                    </div>
                    <div>
                      <label className="text-[12px] mb-1.5">
                        {t("current_password")}
                      </label>
                      <input
                        type="password"
                        className="!py-2.5 !px-4"
                        placeholder={t("current_password_placeholder")}
                        value={usernameForm.password}
                        onChange={(e) =>
                          setUsernameForm({
                            ...usernameForm,
                            password: e.target.value,
                          })
                        }
                      />
                    </div>
                  </div>
                  <div className="settings-actions">
                    <button
                      className="btn-gradient"
                      onClick={handleChangeUsername}
                      disabled={userLoading}
                    >
                      {userLoading ? (
                        <Spinner className="animate-spin" />
                      ) : (
                        t("change_username")
                      )}
                    </button>
                  </div>
                </div>

                <div className="settings-panel">
                  <div className="settings-panel-header">
                    <div className="settings-panel-title">
                      <div className="settings-panel-icon bg-amber-500/10 text-amber-400">
                        <Lock weight="bold" size={18} />
                      </div>
                      <h3 className="text-base font-bold">
                        {t("change_password")}
                      </h3>
                    </div>
                  </div>

                  <div className="settings-field-grid cols-3">
                    <div>
                      <label className="text-[12px] mb-1.5">
                        {t("old_password")}
                      </label>
                      <input
                        type="password"
                        className="!py-2.5 !px-4"
                        value={passwordForm.oldPassword}
                        onChange={(e) =>
                          setPasswordForm({
                            ...passwordForm,
                            oldPassword: e.target.value,
                          })
                        }
                      />
                    </div>
                    <div>
                      <label className="text-[12px] mb-1.5">
                        {t("new_password")}
                      </label>
                      <input
                        type="password"
                        className="!py-2.5 !px-4"
                        value={passwordForm.newPassword}
                        onChange={(e) =>
                          setPasswordForm({
                            ...passwordForm,
                            newPassword: e.target.value,
                          })
                        }
                      />
                    </div>
                    <div>
                      <label className="text-[12px] mb-1.5">
                        {t("confirm_new_password")}
                      </label>
                      <input
                        type="password"
                        className="!py-2.5 !px-4"
                        value={passwordForm.confirmPassword}
                        onChange={(e) =>
                          setPasswordForm({
                            ...passwordForm,
                            confirmPassword: e.target.value,
                          })
                        }
                      />
                    </div>
                  </div>
                  <div className="settings-actions">
                    <button
                      className="btn-gradient"
                      onClick={handleChangePassword}
                      disabled={pwdLoading}
                    >
                      {pwdLoading ? (
                        <Spinner className="animate-spin" />
                      ) : (
                        t("change_password")
                      )}
                    </button>
                  </div>
                </div>

                <div className="settings-panel overflow-hidden xl:col-span-2">
                  <div className="settings-panel-header">
                    <div className="settings-panel-title">
                      <div className="settings-panel-icon bg-emerald-500/10 text-emerald-400">
                        <ShieldCheck weight="bold" size={18} />
                      </div>
                      <h3 className="text-base font-bold">
                        {t("2fa_settings")}
                      </h3>
                    </div>
                    <div
                      className={`settings-status-badge ${totpEnabled ? "is-success" : "is-danger"}`}
                    >
                      {totpEnabled ? t("status_enabled") : t("status_disabled")}
                    </div>
                  </div>

                  {!totpEnabled && !showTotpSetup && (
                    <div className="settings-callout flex gap-4 items-start">
                      <div className="settings-panel-icon bg-emerald-500/10 text-emerald-400">
                        <WarningCircle weight="bold" size={18} />
                      </div>
                      <div>
                        <p className="text-[11px] text-main/70 leading-relaxed max-w-2xl">
                          {t("2fa_enable_desc")}
                        </p>
                        <button
                          onClick={handleSetupTOTP}
                          className="btn-secondary mt-3 w-fit h-8 px-4 text-[11px]"
                          disabled={totpLoading}
                        >
                          {totpLoading ? (
                            <Spinner className="animate-spin" />
                          ) : (
                            t("start_setup")
                          )}
                        </button>
                      </div>
                    </div>
                  )}

                  {showTotpSetup && (
                    <div className="animate-float-up space-y-4">
                      <div className="settings-callout flex flex-col md:flex-row gap-4 items-center md:items-start">
                        <div className="bg-white p-2 rounded-lg shrink-0">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={totpQrUrl}
                            alt={t("qr_alt")}
                            className="w-28 h-28"
                          />
                        </div>
                        <div className="flex-1 space-y-3">
                          <div>
                            <h4 className="font-bold text-xs text-main mb-1">
                              {t("scan_qr")}
                            </h4>
                            <p className="text-[10px] text-[#9496a1]">
                              {t("scan_qr_desc")}
                            </p>
                          </div>
                          <div>
                            <h4 className="font-bold text-xs text-main mb-1">
                              {t("backup_secret")}
                            </h4>
                            <input
                              readOnly
                              value={totpSecret}
                              className="!p-2.5 !bg-white/2 !border-white/8 !rounded-lg !text-[10px] break-all !font-mono !text-[#b57dff] !mb-0 cursor-text"
                              onClick={(e) =>
                                (e.target as HTMLInputElement).select()
                              }
                            />
                          </div>
                        </div>
                      </div>
                      <div className="space-y-3 w-full max-w-2xl">
                        <label className="text-[12px] font-bold text-main/60 uppercase tracking-widest">
                          {t("verify_code")}
                        </label>
                        <div className="flex flex-col sm:flex-row gap-3">
                          <input
                            value={totpCode}
                            onChange={(e) => setTotpCode(e.target.value)}
                            placeholder={t("totp_code_placeholder")}
                            className="text-center text-2xl sm:text-3xl tracking-[0.6em] h-14 !py-0 w-full min-w-0 flex-[2] border-2 border-black/10 dark:border-white/10 focus:border-[#8a3ffc]/50 bg-white/5 dark:bg-white/5 rounded-2xl font-bold transition-all shadow-inner"
                          />
                          <button
                            onClick={handleEnableTOTP}
                            className="btn-gradient px-8 shrink-0 h-14 !text-sm font-bold shadow-lg sm:flex-1"
                            disabled={totpLoading}
                          >
                            {totpLoading ? (
                              <Spinner className="animate-spin" />
                            ) : (
                              t("verify")
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {totpEnabled && (
                    <div className="settings-actions">
                      <button
                        onClick={handleDisableTOTP}
                        className="btn-secondary !text-rose-400 hover:bg-rose-500/10"
                        disabled={totpLoading}
                      >
                        {totpLoading ? (
                          <Spinner className="animate-spin" />
                        ) : (
                          t("disable_2fa")
                        )}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeSection === "global" && (
              <div className="settings-panel">
                <div className="settings-field-grid">
                  <div>
                    <label className="text-[11px] mb-1">
                      {t("sign_interval")}
                    </label>
                    <input
                      type="number"
                      className="!py-2 !px-4"
                      value={
                        globalSettings.sign_interval === null
                          ? ""
                          : globalSettings.sign_interval
                      }
                      onChange={(e) =>
                        setGlobalSettings({
                          ...globalSettings,
                          sign_interval: e.target.value
                            ? parseInt(e.target.value)
                            : null,
                        })
                      }
                      placeholder={t("sign_interval_placeholder")}
                    />
                    <p className="settings-hint">{t("sign_interval_desc")}</p>
                  </div>
                  <div>
                    <label className="text-[11px] mb-1">
                      {t("log_retention")}
                    </label>
                    <input
                      type="number"
                      className="!py-2 !px-4"
                      value={globalSettings.log_retention_days}
                      onChange={(e) =>
                        setGlobalSettings({
                          ...globalSettings,
                          log_retention_days: parseInt(e.target.value) || 0,
                        })
                      }
                    />
                  </div>
                  <div>
                    <label className="text-[11px] mb-1">{t("timezone")}</label>
                    <select
                      className="!py-2 !px-4"
                      value={globalSettings.timezone || "Asia/Shanghai"}
                      onChange={(e) =>
                        setGlobalSettings({
                          ...globalSettings,
                          timezone: e.target.value,
                        })
                      }
                    >
                      {TIMEZONE_OPTIONS.map((timezone) => (
                        <option key={timezone} value={timezone}>
                          {timezone}
                        </option>
                      ))}
                    </select>
                    <p className="settings-hint">{t("timezone_desc")}</p>
                  </div>
                  <div>
                    <label className="text-[11px] mb-1">
                      {t("global_proxy")}
                    </label>
                    <input
                      className="!py-2 !px-4"
                      value={globalSettings.global_proxy || ""}
                      onChange={(e) =>
                        setGlobalSettings({
                          ...globalSettings,
                          global_proxy: e.target.value || null,
                        })
                      }
                      placeholder={t("global_proxy_placeholder")}
                    />
                    <p className="settings-hint">{t("global_proxy_desc")}</p>
                  </div>
                  <div className="settings-field-full">
                    <label className="text-[11px] mb-1">{t("data_dir")}</label>
                    <input
                      className="!py-2 !px-4"
                      value={globalSettings.data_dir || ""}
                      onChange={(e) =>
                        setGlobalSettings({
                          ...globalSettings,
                          data_dir: e.target.value || null,
                        })
                      }
                      placeholder={t("data_dir_placeholder")}
                    />
                    <p className="settings-hint">{t("data_dir_desc")}</p>
                    <p className="settings-hint !text-amber-400">
                      {t("data_dir_restart_hint")}
                    </p>
                  </div>
                </div>
                <div className="settings-actions">
                  <button
                    className="btn-gradient"
                    onClick={handleSaveGlobal}
                    disabled={configLoading}
                  >
                    {configLoading ? (
                      <Spinner className="animate-spin" />
                    ) : (
                      t("save_global_params")
                    )}
                  </button>
                </div>
              </div>
            )}

            {activeSection === "notify" && (
              <TelegramBotNotificationSettings
                settings={globalSettings}
                setSettings={setGlobalSettings}
                loading={configLoading}
                onSave={handleSaveGlobal}
                t={t}
              />
            )}

            {activeSection === "ai" && (
              <div className="settings-panel">
                <div className="settings-panel-header">
                  <div className="settings-panel-title">
                    <div className="settings-panel-icon bg-indigo-500/10 text-indigo-400">
                      <BotIcon weight="bold" size={18} />
                    </div>
                    <h3 className="text-base font-bold">{t("ai_config")}</h3>
                  </div>
                  {aiConfig && (
                    <button
                      onClick={handleDeleteAI}
                      className="action-btn !w-8 !h-8 !text-rose-400"
                      title={t("delete_ai_config")}
                    >
                      <Trash weight="bold" size={16} />
                    </button>
                  )}
                </div>

                <div className="settings-field-grid">
                  <div className="settings-field-full">
                    <label className="text-[11px] mb-1">{t("api_key")}</label>
                    <input
                      type="password"
                      className="!py-2 !px-4"
                      value={aiForm.api_key}
                      onChange={(e) =>
                        setAIForm({ ...aiForm, api_key: e.target.value })
                      }
                      placeholder={aiConfig?.api_key_masked || t("api_key")}
                    />
                    {aiConfig?.api_key_masked && (
                      <p className="settings-hint">{t("api_key_keep_hint")}</p>
                    )}
                  </div>
                  <div>
                    <label className="text-[11px] mb-1">{t("base_url")}</label>
                    <input
                      className="!py-2 !px-4"
                      value={aiForm.base_url}
                      onChange={(e) =>
                        setAIForm({ ...aiForm, base_url: e.target.value })
                      }
                      placeholder={t("ai_base_url_placeholder")}
                    />
                  </div>
                  <div>
                    <label className="text-[11px] mb-1">{t("model")}</label>
                    <input
                      className="!py-2 !px-4"
                      value={aiForm.model}
                      onChange={(e) =>
                        setAIForm({ ...aiForm, model: e.target.value })
                      }
                    />
                  </div>
                </div>

                <div className="settings-actions">
                  <button
                    onClick={handleSaveAI}
                    className="btn-gradient"
                    disabled={configLoading}
                  >
                    {configLoading ? (
                      <Spinner className="animate-spin" />
                    ) : (
                      t("save")
                    )}
                  </button>
                  <button
                    onClick={handleTestAI}
                    className="btn-secondary"
                    disabled={aiTesting || configLoading}
                  >
                    {aiTesting ? (
                      <Spinner className="animate-spin" />
                    ) : (
                      t("test_connection")
                    )}
                  </button>
                </div>

                {aiTestResult && (
                  <div
                    className={`mt-4 p-3 rounded-xl text-[11px] border ${aiTestStatus === "success" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20" : "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20"} animate-float-up`}
                  >
                    <div className="flex items-center gap-2 font-bold mb-0.5 uppercase tracking-wider text-[9px]">
                      {aiTestStatus === "success"
                        ? t("process_successful")
                        : t("process_error")}
                    </div>
                    {aiTestResult}
                  </div>
                )}
              </div>
            )}

            {activeSection === "telegram" && (
              <div className="settings-panel">
                <div className="settings-panel-header">
                  <div className="settings-panel-title">
                    <div className="settings-panel-icon bg-sky-500/10 text-sky-400">
                      <Cpu weight="bold" size={18} />
                    </div>
                    <h3 className="text-base font-bold">
                      {t("tg_api_config")}
                    </h3>
                  </div>
                  <button
                    onClick={handleResetTelegram}
                    className="action-btn !w-8 !h-8"
                    title={t("restore_default")}
                    disabled={telegramLoading}
                  >
                    {telegramLoading ? (
                      <Spinner className="animate-spin" size={14} />
                    ) : (
                      <ArrowUDownLeft weight="bold" size={16} />
                    )}
                  </button>
                </div>

                <div className="settings-field-grid">
                  <div>
                    <label className="text-[11px] mb-1">{t("api_id")}</label>
                    <input
                      className="!py-2 !px-4"
                      value={telegramForm.api_id}
                      onChange={(e) =>
                        setTelegramForm({
                          ...telegramForm,
                          api_id: e.target.value,
                        })
                      }
                      placeholder={t("tg_api_id_placeholder")}
                    />
                  </div>
                  <div>
                    <label className="text-[11px] mb-1">{t("api_hash")}</label>
                    <input
                      className="!py-2 !px-4"
                      value={telegramForm.api_hash}
                      onChange={(e) =>
                        setTelegramForm({
                          ...telegramForm,
                          api_hash: e.target.value,
                        })
                      }
                      placeholder={
                        telegramConfig?.api_hash_masked ||
                        t("tg_api_hash_placeholder")
                      }
                    />
                  </div>
                </div>
                <div className="settings-actions">
                  <button
                    className="btn-gradient"
                    onClick={handleSaveTelegram}
                    disabled={telegramLoading}
                  >
                    {telegramLoading ? (
                      <Spinner className="animate-spin" />
                    ) : (
                      t("apply_api_config")
                    )}
                  </button>
                </div>
                <div className="settings-callout mt-4 text-[10px] text-amber-700 dark:text-amber-200/70 leading-relaxed font-medium">
                  <div className="flex items-center gap-2 mb-1.5">
                    <Terminal
                      weight="bold"
                      className="text-amber-600 dark:text-amber-400"
                      size={12}
                    />
                    <span className="font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                      {t("warning_notice")}
                    </span>
                  </div>
                  {t("tg_config_warning")}
                </div>
              </div>
            )}

            {activeSection === "logs" && (
              <div className="settings-panel">
                <div className="settings-panel-header">
                  <div className="settings-panel-title">
                    <div className="settings-panel-icon bg-slate-500/10 text-slate-400">
                      <Terminal weight="bold" size={18} />
                    </div>
                    <div>
                      <h3 className="text-base font-bold">
                        {t("system_logs")}
                      </h3>
                      <p className="text-[10px] text-main/40 mt-0.5">
                        {systemLogs?.path || "/data/logs/app.log"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    <select
                      className="!min-h-9 !h-9 !w-auto !px-3 !py-1 !text-xs"
                      value={systemLogLimit}
                      onChange={(e) => {
                        setSystemLogLimit(parseInt(e.target.value, 10));
                        setSystemLogs(null);
                      }}
                    >
                      {[200, 500, 800, 1500, 3000, 5000].map((limit) => (
                        <option key={limit} value={limit}>
                          {limit}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={loadSystemLogs}
                      className="action-btn !w-9 !h-9"
                      title={t("refresh_list")}
                      disabled={systemLogsLoading}
                    >
                      {systemLogsLoading ? (
                        <Spinner className="animate-spin" size={15} />
                      ) : (
                        <ArrowClockwise weight="bold" size={15} />
                      )}
                    </button>
                    <button
                      onClick={handleExportSystemLogs}
                      className="action-btn !w-9 !h-9"
                      title={t("export_logs")}
                    >
                      <DownloadSimple weight="bold" size={15} />
                    </button>
                    <button
                      onClick={handleClearSystemLogs}
                      className="action-btn !w-9 !h-9 !text-rose-400"
                      title={t("clear_logs")}
                      disabled={systemLogsLoading}
                    >
                      <Trash weight="bold" size={15} />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
                  <div className="settings-callout">
                    <div className="text-[10px] uppercase tracking-wider text-main/35 font-bold">
                      {t("system_logs_lines")}
                    </div>
                    <div className="mt-1 text-lg font-bold text-main">
                      {systemLogs?.lines.length ?? 0}
                    </div>
                  </div>
                  <div className="settings-callout">
                    <div className="text-[10px] uppercase tracking-wider text-main/35 font-bold">
                      {t("system_logs_size")}
                    </div>
                    <div className="mt-1 text-lg font-bold text-main">
                      {formatBytes(systemLogs?.file_size ?? 0)}
                    </div>
                  </div>
                  <div className="settings-callout">
                    <div className="text-[10px] uppercase tracking-wider text-main/35 font-bold">
                      {t("last_updated")}
                    </div>
                    <div className="mt-1 text-sm font-bold text-main truncate">
                      {formatDateTime(systemLogs?.updated_at)}
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-white/10 dark:border-white/10 bg-[#0f172a] text-slate-100 overflow-hidden">
                  <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2 bg-white/[0.04]">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      {systemLogs?.exists
                        ? `${systemLogs.lines.length} ${t("logs")}`
                        : "app.log"}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      {systemLogsLoading ? t("loading") : t("logs")}
                    </div>
                  </div>
                  <div className="h-[520px] overflow-auto custom-scrollbar p-4 font-mono text-[11px] leading-relaxed">
                    {systemLogsLoading && !systemLogs ? (
                      <div className="h-full flex items-center justify-center text-slate-500">
                        <Spinner className="animate-spin mr-2" size={16} />
                        {t("loading")}
                      </div>
                    ) : systemLogs && systemLogs.lines.length > 0 ? (
                      <div className="space-y-1">
                        {systemLogs.lines.map((line, index) => (
                          <div
                            key={`${index}-${line.slice(0, 24)}`}
                            className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-3 hover:bg-white/[0.035] rounded px-2 py-0.5"
                          >
                            <span className="select-none text-right text-slate-600">
                              {index + 1}
                            </span>
                            <span className="whitespace-pre-wrap break-words">
                              {line}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="h-full flex flex-col items-center justify-center text-slate-500">
                        <Terminal
                          weight="bold"
                          size={24}
                          className="mb-2 opacity-60"
                        />
                        <div className="text-sm font-bold">{t("no_logs")}</div>
                        <div className="text-[11px] mt-1 opacity-70">
                          /data/logs/app.log
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeSection === "backup" && (
              <div className="space-y-4">
                <div
                  className={`grid grid-cols-1 gap-4 ${currentUser?.is_admin ? "xl:grid-cols-2" : ""}`}
                >
                  <div className="settings-panel">
                    <div className="settings-panel-header">
                      <div className="settings-panel-title">
                        <div className="settings-panel-icon bg-rose-500/10 text-rose-400">
                          <FloppyDisk weight="bold" size={18} />
                        </div>
                        <div>
                          <h3 className="text-base font-bold">
                            完整工作区迁移
                          </h3>
                          <p className="text-[10px] text-main/45 mt-0.5">
                            ZIP 包包含 Telegram 登录会话、API
                            密钥、代理、任务、日志和当前用户的全部工作区数据；不包含平台登录资料。
                          </p>
                        </div>
                      </div>
                    </div>
                    <div className="settings-callout !border-amber-500/30 text-[11px] text-amber-700 dark:text-amber-200/80">
                      恢复会覆盖当前用户的工作区数据，但不会修改平台用户名、密码或
                      2FA。
                    </div>
                    <div className="settings-actions">
                      <button
                        onClick={handleFullBackupExport}
                        className="btn-secondary"
                        disabled={fullBackupLoading}
                      >
                        {fullBackupLoading ? (
                          <Spinner className="animate-spin" />
                        ) : (
                          <DownloadSimple weight="bold" />
                        )}
                        下载
                      </button>
                      <label
                        className={`btn-gradient cursor-pointer ${fullBackupLoading ? "pointer-events-none opacity-50" : ""}`}
                      >
                        {fullBackupLoading ? (
                          <Spinner className="animate-spin" />
                        ) : (
                          <ArrowUDownLeft weight="bold" />
                        )}
                        恢复
                        <input
                          type="file"
                          accept=".zip,application/zip"
                          className="hidden"
                          disabled={fullBackupLoading}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.currentTarget.value = "";
                            if (file) void handleFullBackupImport(file);
                          }}
                        />
                      </label>
                    </div>
                  </div>

                  {currentUser?.is_admin && (
                    <div className="settings-panel">
                      <div className="settings-panel-header">
                        <div className="settings-panel-title">
                          <div className="settings-panel-icon bg-violet-500/10 text-violet-400">
                            <ShieldCheck weight="bold" size={18} />
                          </div>
                          <div>
                            <h3 className="text-base font-bold">
                              完整系统迁移
                            </h3>
                            <p className="text-[10px] text-main/45 mt-0.5">
                              仅管理员可用，包含全部用户、全局配置、数据库、会话和系统密钥。
                            </p>
                          </div>
                        </div>
                      </div>
                      <div className="settings-callout !border-rose-500/30 text-[11px] text-rose-700 dark:text-rose-200/80">
                        恢复完整系统备份会覆盖当前所有用户和全部系统数据，恢复完成后需重启服务。
                      </div>
                      <div className="settings-actions">
                        <button
                          onClick={handleSystemBackupExport}
                          className="btn-secondary"
                          disabled={systemBackupLoading}
                        >
                          {systemBackupLoading ? (
                            <Spinner className="animate-spin" />
                          ) : (
                            <DownloadSimple weight="bold" />
                          )}
                          下载
                        </button>
                        <label
                          className={`btn-gradient cursor-pointer ${systemBackupLoading ? "pointer-events-none opacity-50" : ""}`}
                        >
                          {systemBackupLoading ? (
                            <Spinner className="animate-spin" />
                          ) : (
                            <ArrowUDownLeft weight="bold" />
                          )}
                          恢复
                          <input
                            type="file"
                            accept=".zip,application/zip"
                            className="hidden"
                            disabled={systemBackupLoading}
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              event.currentTarget.value = "";
                              if (file) void handleSystemBackupImport(file);
                            }}
                          />
                        </label>
                      </div>
                    </div>
                  )}
                </div>

                <div className="settings-panel">
                  <div className="settings-panel-header">
                    <div className="settings-panel-title">
                      <div className="settings-panel-icon bg-slate-500/10 text-slate-400">
                        <FloppyDisk weight="bold" size={18} />
                      </div>
                      <div>
                        <h3 className="text-base font-bold">轻量配置 JSON</h3>
                        <p className="text-[10px] text-main/45 mt-0.5">
                          仅用于导入导出任务和配置，不包含会话或完整账户资料。
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="settings-callout">
                      <label className="mb-2 text-[11px]">
                        {t("export_config")}
                      </label>
                      <p className="settings-hint mb-3">{t("export_desc")}</p>
                      <div className="settings-actions !mt-3 !pt-3">
                        <button
                          onClick={handleExport}
                          className="btn-secondary"
                          disabled={configLoading}
                        >
                          {configLoading ? (
                            <Spinner className="animate-spin" />
                          ) : (
                            <FloppyDisk weight="bold" />
                          )}
                          下载
                        </button>
                      </div>
                    </div>

                    <div className="settings-callout flex flex-col">
                      <div className="flex justify-between items-center mb-2">
                        <label className="text-[11px]">
                          {t("import_config")}
                        </label>
                        <label className="text-[10px] text-[#8a3ffc] dark:text-[#b57dff] cursor-pointer hover:underline font-bold">
                          {t("upload_json")}
                          <input
                            type="file"
                            accept=".json"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) {
                                const reader = new FileReader();
                                reader.onload = (ev) => {
                                  const content = ev.target?.result as string;
                                  setImportConfig(content);
                                };
                                reader.readAsText(file);
                              }
                            }}
                          />
                        </label>
                      </div>
                      <textarea
                        className="w-full flex-1 min-h-[120px] p-3 text-[10px] font-mono text-main/60 outline-none transition-all placeholder:text-main/20 custom-scrollbar"
                        placeholder={t("paste_json")}
                        value={importConfig}
                        onChange={(e) => setImportConfig(e.target.value)}
                      ></textarea>

                      <div
                        className="flex items-center gap-3 mt-3 mb-4 group cursor-pointer"
                        onClick={() => setOverwriteConfig(!overwriteConfig)}
                      >
                        <div
                          className={`w-12 h-7 rounded-full relative transition-all shadow-sm border-2 ${overwriteConfig ? "bg-[#8a3ffc] border-[#8a3ffc]" : "bg-black/20 dark:bg-white/10 border-black/10 dark:border-white/30"}`}
                        >
                          <div
                            className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all shadow-md ${overwriteConfig ? "left-6" : "left-0.5"}`}
                          ></div>
                        </div>
                        <span
                          className={`text-[13px] cursor-pointer select-none transition-colors ${overwriteConfig ? "text-main font-bold" : "text-main/40"}`}
                        >
                          {t("overwrite_conflict")}
                        </span>
                      </div>

                      <div className="settings-actions !mt-3 !pt-3">
                        <button
                          onClick={handleImport}
                          className="btn-gradient"
                          disabled={configLoading}
                        >
                          {configLoading ? (
                            <Spinner className="animate-spin" />
                          ) : (
                            t("execute_import")
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>

      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsPageContent />
    </Suspense>
  );
}
