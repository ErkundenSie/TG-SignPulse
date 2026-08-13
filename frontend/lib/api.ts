import { Account, CurrentUser, Task, TaskLog, TokenResponse } from "./types";
import { LEGACY_TOKEN_KEY, TOKEN_KEY } from "./auth";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api";

const pathSegment = (value: string | number) =>
  encodeURIComponent(String(value));

const toRecord = (headers?: HeadersInit): Record<string, string> => {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return headers as Record<string, string>;
};

const hasHeader = (headers: Record<string, string>, name: string) =>
  Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());

async function parseErrorResponse(res: Response) {
  let errorMessage = "请求失败";
  let errorCode: string | undefined;
  try {
    const errorData = await res.json();
    if (errorData && typeof errorData === "object") {
      const detail = errorData.detail || errorData.message;
      if (Array.isArray(detail)) {
        errorMessage = detail
          .map((item) => {
            const loc = Array.isArray(item?.loc) ? item.loc.join(".") : "";
            const msg = item?.msg || JSON.stringify(item);
            return loc ? `${loc}: ${msg}` : msg;
          })
          .join("; ");
      } else if (detail && typeof detail === "object") {
        errorMessage = JSON.stringify(detail);
      } else {
        errorMessage = detail || JSON.stringify(errorData);
      }
      errorCode = errorData.code;
    } else {
      errorMessage = JSON.stringify(errorData);
    }
  } catch {
    try {
      errorMessage = (await res.text()) || "请求失败";
    } catch {
      // ignore
    }
  }
  return { errorMessage, errorCode };
}

function handleUnauthorized(status: number, token?: string | null) {
  if (status !== 401 || !token || typeof window === "undefined") return;
  const currentToken =
    localStorage.getItem(TOKEN_KEY) || localStorage.getItem(LEGACY_TOKEN_KEY);
  if (currentToken === token) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    window.location.href = "/";
  }
}

async function fetchApi(
  path: string,
  options: RequestInit = {},
  token?: string | null,
) {
  const mergedHeaders: Record<string, string> = toRecord(options.headers);
  const hasFormBody =
    typeof FormData !== "undefined" && options.body instanceof FormData;
  if (
    options.body !== undefined &&
    !hasFormBody &&
    !hasHeader(mergedHeaders, "Content-Type")
  ) {
    mergedHeaders["Content-Type"] = "application/json";
  }
  if (token) {
    mergedHeaders["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: mergedHeaders,
    cache: "no-store",
  });

  if (!res.ok) {
    const { errorMessage, errorCode } = await parseErrorResponse(res);
    handleUnauthorized(res.status, token);
    const err: any = new Error(errorMessage);
    err.status = res.status;
    if (errorCode) err.code = errorCode;
    throw err;
  }

  return res;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  token?: string | null,
): Promise<T> {
  const res = await fetchApi(path, options, token);
  if (res.status === 204) return {} as T;
  const text = await res.text();
  return text ? JSON.parse(text) : ({} as T);
}

const requestText = async (
  path: string,
  options: RequestInit = {},
  token?: string | null,
) => (await fetchApi(path, options, token)).text();

const requestBlob = async (
  path: string,
  options: RequestInit = {},
  token?: string | null,
) => (await fetchApi(path, options, token)).blob();

const downloadBlob = (blob: Blob, filename: string) => {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
};

const safeFilenamePart = (value: string) =>
  value.replace(/[\\/:*?"<>|]+/g, "_");

// ============ 认证 ============

export const login = (payload: {
  username: string;
  password: string;
  totp_code?: string;
}) =>
  request<TokenResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const getMe = (token: string) =>
  request<CurrentUser>("/auth/me", {}, token);

export const listManagedUsers = (token: string) =>
  request<CurrentUser[]>("/admin/users", {}, token);

export const createManagedUser = (
  token: string,
  payload: { username: string; password: string },
) =>
  request<CurrentUser>(
    "/admin/users",
    { method: "POST", body: JSON.stringify(payload) },
    token,
  );

export const updateManagedUser = (
  token: string,
  userId: number,
  payload: { username?: string; password?: string; is_active?: boolean },
) =>
  request<CurrentUser>(
    `/admin/users/${pathSegment(userId)}`,
    { method: "PATCH", body: JSON.stringify(payload) },
    token,
  );

export const deleteManagedUser = (token: string, userId: number) =>
  request<void>(
    `/admin/users/${pathSegment(userId)}`,
    { method: "DELETE" },
    token,
  );

export const resetManagedUserTOTP = (token: string, userId: number) =>
  request<CurrentUser>(
    `/admin/users/${pathSegment(userId)}/reset-totp`,
    { method: "POST" },
    token,
  );

export const exportAllManagedUsersData = async (token: string) => {
  const blob = await requestBlob("/admin/users/export-all", {}, token);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadBlob(blob, `tg-flowpulse-system-backup-${timestamp}.zip`);
};

export const importAllManagedUsersData = (token: string, backup: File) => {
  const form = new FormData();
  form.append("backup", backup);
  form.append("confirm_replace", "true");
  return request<{
    success: boolean;
    message: string;
    restart_required: boolean;
  }>("/admin/users/import-all", { method: "POST", body: form }, token);
};

export const resetTOTP = (
  token: string,
  payload: { username?: string; password: string },
) =>
  request<{ success: boolean; message: string }>(
    "/auth/reset-totp",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    token,
  );

// ============ 账号管理（重构版）============

export interface LoginStartRequest {
  account_name: string;
  phone_number: string;
  proxy?: string;
}

export interface LoginStartResponse {
  phone_code_hash: string;
  phone_number: string;
  account_name: string;
  message: string;
}

export interface LoginVerifyRequest {
  account_name: string;
  phone_number: string;
  phone_code: string;
  phone_code_hash: string;
  password?: string;
  proxy?: string;
}

export interface LoginVerifyResponse {
  success: boolean;
  user_id?: number;
  first_name?: string;
  username?: string;
  message: string;
}

export interface QrLoginStartRequest {
  account_name: string;
  proxy?: string;
}

export interface QrLoginStartResponse {
  login_id: string;
  qr_uri: string;
  qr_image?: string | null;
  expires_at: string;
}

export interface QrLoginStatusResponse {
  status: string;
  expires_at?: string;
  message?: string;
  account?: AccountInfo | null;
  user_id?: number;
  first_name?: string;
  username?: string;
}

export interface QrLoginCancelResponse {
  success: boolean;
  message: string;
}

export interface QrLoginPasswordRequest {
  login_id: string;
  password: string;
}

export interface QrLoginPasswordResponse {
  success: boolean;
  message: string;
  account?: AccountInfo | null;
  user_id?: number;
  first_name?: string;
  username?: string;
}

export interface AccountInfo {
  name: string;
  session_file: string;
  exists: boolean;
  size: number;
  remark?: string | null;
  proxy?: string | null;
  status?: "connected" | "invalid" | "checking" | "error" | string;
  status_message?: string | null;
  status_code?: string | null;
  status_checked_at?: string | null;
  needs_relogin?: boolean;
}

export interface AccountStatusCheckRequest {
  account_names?: string[];
  timeout_seconds?: number;
}

export interface AccountStatusItem {
  account_name: string;
  ok: boolean;
  status: "connected" | "invalid" | "error" | "not_found" | string;
  message?: string;
  code?: string;
  checked_at?: string;
  needs_relogin?: boolean;
  user_id?: number;
}

export interface AccountStatusCheckResponse {
  results: AccountStatusItem[];
}

export interface ChatMigrationResult {
  id?: number | null;
  title: string;
  username?: string | null;
  type?: string | null;
  status:
    | "joined"
    | "already_member"
    | "request_sent"
    | "manual_required"
    | "failed"
    | "flood_wait"
    | "skipped"
    | "ready"
    | string;
  message: string;
  needs_manual_check?: boolean;
  join_ref?: string | null;
  wait_seconds?: number | null;
}

export interface ChatMigrationItem {
  id?: number | null;
  title: string;
  username?: string | null;
  type?: string | null;
  invite_link?: string | null;
  join?: {
    type?: string | null;
    value?: string | null;
    url?: string | null;
  } | null;
  export_note?: string | null;
}

export interface ChatMigrationExportPayload {
  kind?: string;
  version?: number;
  source_account?: string | null;
  scope?: string | null;
  exported_at?: string;
  items: ChatMigrationItem[];
  summary?: Record<string, number>;
  warning?: string | null;
}

export interface ChatMigrationImportResponse {
  success: boolean;
  dry_run: boolean;
  source_account?: string | null;
  target_account: string;
  imported_at: string;
  summary: Record<string, number>;
  results: ChatMigrationResult[];
  notice?: string | null;
}

export interface ChatMigrationImportJobResponse {
  job_id: string;
  status:
    | "running"
    | "canceling"
    | "canceled"
    | "completed"
    | "failed"
    | string;
  account_name: string;
  dry_run: boolean;
  delay_seconds: number;
  created_at: string;
  updated_at: string;
  finished_at?: string | null;
  progress: { done: number; total: number };
  summary: Record<string, number>;
  results: ChatMigrationResult[];
  items?: ChatMigrationItem[];
  error?: string | null;
  notice?: string | null;
}

export type BulkGroupMembershipMode =
  | "join"
  | "leave_selected"
  | "leave_all_groups";

export interface BulkGroupItem {
  id: number;
  title: string;
  username?: string | null;
  type: "group" | "supergroup" | "channel" | string;
}

export interface BulkGroupMembershipLog {
  time: string;
  level: "info" | "success" | "warning" | "error" | string;
  message: string;
  ref?: string | null;
}

export interface BulkGroupMembershipResult {
  ref?: string | null;
  title?: string | null;
  chat_id?: number | string | null;
  status: string;
  message: string;
  wait_seconds?: number | null;
  needs_manual_check?: boolean;
}

export interface BulkGroupMembershipJob {
  job_id: string;
  status: "running" | "canceling" | "canceled" | "completed" | "failed";
  mode: BulkGroupMembershipMode;
  account_name: string;
  min_delay_seconds: number;
  max_delay_seconds: number;
  auto_wait_flood: boolean;
  created_at: string;
  updated_at: string;
  finished_at?: string | null;
  progress: { done: number; total: number };
  summary: Record<string, number>;
  results: BulkGroupMembershipResult[];
  logs: BulkGroupMembershipLog[];
  error?: string | null;
}

export type ChatMigrationExportScope = "all" | "groups" | "channels";

export interface MemberScanRequest {
  chat_id: string;
  keywords?: string[];
  limit?: number;
  include_bots?: boolean;
}

export const startAccountLogin = (token: string, data: LoginStartRequest) =>
  request<LoginStartResponse>(
    "/accounts/login/start",
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    token,
  );

export const verifyAccountLogin = (token: string, data: LoginVerifyRequest) =>
  request<LoginVerifyResponse>(
    "/accounts/login/verify",
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    token,
  );

export const listAccounts = (token: string) =>
  request<{ accounts: AccountInfo[]; total: number }>("/accounts", {}, token);

export const checkAccountsStatus = (
  token: string,
  data: AccountStatusCheckRequest,
) =>
  request<AccountStatusCheckResponse>(
    "/accounts/status/check",
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    token,
  );

export const exportAccountChats = async (
  token: string,
  accountName: string,
  scope: ChatMigrationExportScope = "all",
) => {
  const params = new URLSearchParams();
  params.append("scope", scope);
  const blob = await requestBlob(
    `/accounts/${pathSegment(accountName)}/chats/export?${params.toString()}`,
    {},
    token,
  );
  downloadBlob(blob, `tg_chats_${safeFilenamePart(accountName)}_${scope}.json`);
};

export const exportMatchedChatMembers = async (
  token: string,
  accountName: string,
  data: MemberScanRequest,
) => {
  const blob = await requestBlob(
    `/accounts/${pathSegment(accountName)}/members/scan`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    token,
  );
  downloadBlob(
    blob,
    `tg_members_${safeFilenamePart(accountName)}_${safeFilenamePart(data.chat_id)}.xlsx`,
  );
};

export const getAccountChatsExport = (
  token: string,
  accountName: string,
  scope: ChatMigrationExportScope = "all",
) => {
  const params = new URLSearchParams();
  params.append("scope", scope);
  return request<ChatMigrationExportPayload>(
    `/accounts/${pathSegment(accountName)}/chats/export?${params.toString()}`,
    {},
    token,
  );
};

export const downloadChatMigrationJson = (
  payload: ChatMigrationExportPayload,
  accountName: string,
  scope: string = "selected",
) => {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  downloadBlob(
    blob,
    `tg_chats_${safeFilenamePart(accountName)}_${safeFilenamePart(scope)}.json`,
  );
};

export const importAccountChats = (
  token: string,
  accountName: string,
  data: {
    config_json?: string;
    migration?: Record<string, unknown>;
    dry_run?: boolean;
    delay_seconds?: number;
  },
) =>
  request<ChatMigrationImportResponse>(
    `/accounts/${pathSegment(accountName)}/chats/import`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    token,
  );

export const startImportAccountChatsJob = (
  token: string,
  accountName: string,
  data: {
    config_json?: string;
    migration?: Record<string, unknown>;
    dry_run?: boolean;
    delay_seconds?: number;
  },
) =>
  request<ChatMigrationImportJobResponse>(
    `/accounts/${pathSegment(accountName)}/chats/import-jobs`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    token,
  );

export const getImportAccountChatsJob = (token: string, jobId: string) =>
  request<ChatMigrationImportJobResponse>(
    `/accounts/chats/import-jobs/${pathSegment(jobId)}`,
    {},
    token,
  );

export const cancelImportAccountChatsJob = (token: string, jobId: string) =>
  request<ChatMigrationImportJobResponse>(
    `/accounts/chats/import-jobs/${pathSegment(jobId)}/cancel`,
    { method: "POST" },
    token,
  );

export const listBulkGroupMembershipJobs = (token: string, limit = 20) =>
  request<BulkGroupMembershipJob[]>(
    `/bulk-group-membership/jobs?limit=${Math.max(1, Math.min(limit, 50))}`,
    {},
    token,
  );

export const listBulkGroupMembershipGroups = (
  token: string,
  accountName: string,
) =>
  request<BulkGroupItem[]>(
    `/bulk-group-membership/accounts/${pathSegment(accountName)}/groups`,
    {},
    token,
  );

export const startBulkGroupMembershipJob = (
  token: string,
  data: {
    account_name: string;
    mode: BulkGroupMembershipMode;
    links: string[];
    selected_chat_ids: number[];
    min_delay_seconds: number;
    max_delay_seconds: number;
    auto_wait_flood: boolean;
  },
) =>
  request<BulkGroupMembershipJob>(
    "/bulk-group-membership/jobs",
    { method: "POST", body: JSON.stringify(data) },
    token,
  );

export const getBulkGroupMembershipJob = (token: string, jobId: string) =>
  request<BulkGroupMembershipJob>(
    `/bulk-group-membership/jobs/${pathSegment(jobId)}`,
    {},
    token,
  );

export const cancelBulkGroupMembershipJob = (token: string, jobId: string) =>
  request<BulkGroupMembershipJob>(
    `/bulk-group-membership/jobs/${pathSegment(jobId)}/cancel`,
    { method: "POST" },
    token,
  );

export const deleteAccount = (token: string, accountName: string) =>
  request<{ success: boolean; message: string }>(
    `/accounts/${pathSegment(accountName)}`,
    {
      method: "DELETE",
    },
    token,
  );

export const checkAccountExists = (token: string, accountName: string) =>
  request<{ exists: boolean; account_name: string }>(
    `/accounts/${pathSegment(accountName)}/exists`,
    {},
    token,
  );

export const updateAccount = (
  token: string,
  accountName: string,
  data: { remark?: string | null; proxy?: string | null },
) =>
  request<{ success: boolean; message: string; account?: AccountInfo | null }>(
    `/accounts/${pathSegment(accountName)}`,
    {
      method: "PATCH",
      body: JSON.stringify(data),
    },
    token,
  );

export const startQrLogin = (token: string, data: QrLoginStartRequest) =>
  request<QrLoginStartResponse>(
    "/accounts/qr/start",
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    token,
  );

export const getQrLoginStatus = (token: string, loginId: string) =>
  request<QrLoginStatusResponse>(
    `/accounts/qr/status?login_id=${encodeURIComponent(loginId)}`,
    {},
    token,
  );

export const cancelQrLogin = (token: string, loginId: string) =>
  request<QrLoginCancelResponse>(
    "/accounts/qr/cancel",
    {
      method: "POST",
      body: JSON.stringify({ login_id: loginId }),
    },
    token,
  );

export const submitQrPassword = (token: string, data: QrLoginPasswordRequest) =>
  request<QrLoginPasswordResponse>(
    "/accounts/qr/password",
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    token,
  );

// ============ 任务管理 ============

export const fetchTasks = (token: string) =>
  request<Task[]>("/tasks", {}, token);

export const createTask = (
  token: string,
  payload: { name: string; cron: string; account_id: number; enabled: boolean },
) =>
  request<Task>(
    "/tasks",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    token,
  );

export const updateTask = (
  token: string,
  id: number,
  payload: Partial<{
    name: string;
    cron: string;
    enabled: boolean;
    account_id: number;
  }>,
) =>
  request<Task>(
    `/tasks/${id}`,
    {
      method: "PUT",
      body: JSON.stringify(payload),
    },
    token,
  );

export const deleteTask = (token: string, id: number) =>
  request(`/tasks/${id}`, { method: "DELETE" }, token);

export const runTask = (token: string, id: number) =>
  request<TaskLog>(`/tasks/${id}/run`, { method: "POST" }, token);

export const fetchTaskLogs = (token: string, id: number, limit = 50) =>
  request<TaskLog[]>(`/tasks/${id}/logs?limit=${limit}`, {}, token);

// ============ 配置管理 ============

export const listConfigTasks = (token: string) =>
  request<{ sign_tasks: string[]; monitor_tasks: string[]; total: number }>(
    "/config/tasks",
    {},
    token,
  );

export const exportSignTask = (
  token: string,
  taskName: string,
  accountName?: string,
) => {
  const params = new URLSearchParams();
  if (accountName) params.append("account_name", accountName);
  return requestText(
    `/config/export/sign/${pathSegment(taskName)}${params.toString() ? `?${params.toString()}` : ""}`,
    {},
    token,
  );
};

export const importSignTask = (
  token: string,
  configJson: string,
  taskName?: string,
  accountName?: string,
  overwrite = true,
  taskKind: SignTaskKind | string = "sign",
) =>
  request<{ success: boolean; task_name: string; message: string }>(
    "/config/import/sign",
    {
      method: "POST",
      body: JSON.stringify({
        config_json: configJson,
        task_name: taskName,
        account_name: accountName,
        task_kind: taskKind,
        overwrite,
      }),
    },
    token,
  );

export const exportAllConfigs = (token: string, includeSecrets = false) =>
  requestText(
    `/config/export/all${includeSecrets ? "?include_secrets=true" : ""}`,
    {},
    token,
  );

export const importAllConfigs = (
  token: string,
  configJson: string,
  overwrite = false,
) =>
  request<{
    signs_imported: number;
    signs_skipped: number;
    monitors_imported: number;
    monitors_skipped: number;
    settings_imported: number;
    errors: string[];
    message: string;
  }>(
    "/config/import/all",
    {
      method: "POST",
      body: JSON.stringify({ config_json: configJson, overwrite }),
    },
    token,
  );

export const exportFullWorkspaceBackup = async (token: string) => {
  const blob = await requestBlob("/config/backup/full", {}, token);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadBlob(blob, `tg-flowpulse-workspace-backup-${timestamp}.zip`);
};

export const importFullWorkspaceBackup = (token: string, backup: File) => {
  const form = new FormData();
  form.append("backup", backup);
  form.append("confirm_replace", "true");
  return request<{
    success: boolean;
    message: string;
    restart_required: boolean;
  }>("/config/backup/full/import", { method: "POST", body: form }, token);
};

export const deleteSignConfig = (
  token: string,
  taskName: string,
  accountName?: string,
) => {
  const params = new URLSearchParams();
  if (accountName) params.append("account_name", accountName);
  const url = `/config/sign/${pathSegment(taskName)}${params.toString() ? `?${params.toString()}` : ""}`;
  return request<{ success: boolean; message: string }>(
    url,
    {
      method: "DELETE",
    },
    token,
  );
};

// ============ 用户设置 ============

export const changePassword = (
  token: string,
  oldPassword: string,
  newPassword: string,
) =>
  request<{ success: boolean; message: string }>(
    "/user/password",
    {
      method: "PUT",
      body: JSON.stringify({
        old_password: oldPassword,
        new_password: newPassword,
      }),
    },
    token,
  );

export const getTOTPStatus = (token: string) =>
  request<{ enabled: boolean; secret?: string }>(
    "/user/totp/status",
    {},
    token,
  );

export const setupTOTP = (token: string) =>
  request<{ enabled: boolean; secret: string }>(
    "/user/totp/setup",
    {
      method: "POST",
    },
    token,
  );

export const getTOTPQRCode = (token: string) =>
  requestBlob("/user/totp/qrcode", {}, token);

export const enableTOTP = (token: string, totpCode: string) =>
  request<{ success: boolean; message: string }>(
    "/user/totp/enable",
    {
      method: "POST",
      body: JSON.stringify({ totp_code: totpCode }),
    },
    token,
  );

export const disableTOTP = (token: string, totpCode: string) =>
  request<{ success: boolean; message: string }>(
    "/user/totp/disable",
    {
      method: "POST",
      body: JSON.stringify({ totp_code: totpCode }),
    },
    token,
  );

export const changeUsername = (
  token: string,
  newUsername: string,
  password: string,
) =>
  request<ChangeUsernameResponse>(
    "/user/username",
    {
      method: "PUT",
      body: JSON.stringify({ new_username: newUsername, password: password }),
    },
    token,
  );

// ============ AI 配置 ============

export interface AIConfig {
  has_config: boolean;
  base_url?: string;
  model?: string;
  api_key_masked?: string;
}

export interface ChangeUsernameResponse {
  success: boolean;
  message: string;
  access_token?: string;
}

export interface AITestResult {
  success: boolean;
  message: string;
  model_used?: string;
}

export const getAIConfig = (token: string) =>
  request<AIConfig>("/config/ai", {}, token);

export const saveAIConfig = (
  token: string,
  config: { api_key?: string; base_url?: string; model?: string },
) =>
  request<{ success: boolean; message: string }>(
    "/config/ai",
    {
      method: "POST",
      body: JSON.stringify(config),
    },
    token,
  );

export const testAIConnection = (token: string) =>
  request<AITestResult>(
    "/config/ai/test",
    {
      method: "POST",
    },
    token,
  );

export const deleteAIConfig = (token: string) =>
  request<{ success: boolean; message: string }>(
    "/config/ai",
    {
      method: "DELETE",
    },
    token,
  );

// ============ 全局设置 ============

export interface GlobalSettings {
  sign_interval?: number | null; // null 表示随机 1-120 秒
  log_retention_days?: number; // 日志保留天数，默认 7
  timezone?: string;
  data_dir?: string | null;
  global_proxy?: string | null;
  telegram_bot_notify_enabled?: boolean;
  telegram_bot_login_notify_enabled?: boolean;
  telegram_bot_task_failure_enabled?: boolean;
  telegram_bot_token?: string | null;
  telegram_bot_token_masked?: string | null;
  telegram_bot_chat_id?: string | null;
  telegram_bot_message_thread_id?: number | null;
}

export const getGlobalSettings = (token: string) =>
  request<GlobalSettings>("/config/settings", {}, token);

export const saveGlobalSettings = (token: string, settings: GlobalSettings) =>
  request<{ success: boolean; message: string }>(
    "/config/settings",
    {
      method: "POST",
      body: JSON.stringify(settings),
    },
    token,
  );

// ============ Telegram API 配置 ============

export interface TelegramConfig {
  api_id: string;
  api_hash?: string;
  api_hash_masked?: string;
  is_custom: boolean;
  default_api_id: string;
  default_api_hash?: string;
  default_api_hash_masked?: string;
}

export const getTelegramConfig = (token: string) =>
  request<TelegramConfig>("/config/telegram", {}, token);

export const saveTelegramConfig = (
  token: string,
  config: { api_id: string; api_hash: string },
) =>
  request<{ success: boolean; message: string }>(
    "/config/telegram",
    {
      method: "POST",
      body: JSON.stringify(config),
    },
    token,
  );

export const resetTelegramConfig = (token: string) =>
  request<{ success: boolean; message: string }>(
    "/config/telegram",
    {
      method: "DELETE",
    },
    token,
  );

// ============ 账号日志 ============

export interface AccountLog {
  id: number;
  account_name: string;
  task_name: string;
  message: string;
  summary?: string;
  bot_message?: string;
  success: boolean;
  created_at: string;
}

export const getAccountLogs = (
  token: string,
  accountName: string,
  limit: number = 100,
) =>
  request<AccountLog[]>(
    `/accounts/${pathSegment(accountName)}/logs?limit=${limit}`,
    {},
    token,
  );

export const clearAccountLogs = (token: string, accountName: string) =>
  request<{
    success: boolean;
    cleared: number;
    message: string;
    code?: string;
  }>(
    `/accounts/${pathSegment(accountName)}/logs/clear`,
    { method: "POST" },
    token,
  );

export const exportAccountLogs = async (token: string, accountName: string) => {
  const blob = await requestBlob(
    `/accounts/${pathSegment(accountName)}/logs/export`,
    {},
    token,
  );
  downloadBlob(blob, `logs_${safeFilenamePart(accountName)}.txt`);
};

export interface SystemLogsResponse {
  path: string;
  lines: string[];
  line_count?: number | null;
  file_size: number;
  updated_at?: string | null;
  exists: boolean;
}

export const getSystemLogs = (token: string, limit: number = 500) =>
  request<SystemLogsResponse>(`/system-logs?limit=${limit}`, {}, token);

export const clearSystemLogs = (token: string) =>
  request<{ success: boolean; message: string }>(
    "/system-logs",
    {
      method: "DELETE",
    },
    token,
  );

export const exportSystemLogs = async (token: string) => {
  const blob = await requestBlob("/system-logs/export", {}, token);
  downloadBlob(blob, "tg-flowpulse-system.log");
};

// ============ 签到任务管理 ============

export interface SignTaskChat {
  chat_id: number;
  name: string;
  actions: any[];
  delete_after?: number;
  action_interval: number;
  message_thread_id?: number;
}

export interface LastRunInfo {
  time: string;
  success: boolean;
  message?: string;
}

export type SignTaskKind = "sign" | "broadcast";

export interface SignTask {
  name: string;
  account_name: string;
  group?: string;
  task_kind?: SignTaskKind | string;
  sign_at: string;
  chats: SignTaskChat[];
  random_seconds: number;
  sign_interval: number;
  enabled: boolean;
  last_run?: LastRunInfo | null;
  execution_mode?: "fixed" | "range";
  range_start?: string;
  range_end?: string;
  notify_on_failure?: boolean;
}

export interface CreateSignTaskRequest {
  name: string;
  account_name: string;
  group?: string;
  task_kind?: SignTaskKind | string;
  sign_at: string;
  chats: SignTaskChat[];
  random_seconds?: number;
  sign_interval?: number;
  execution_mode?: "fixed" | "range";
  range_start?: string;
  range_end?: string;
  enabled?: boolean;
  notify_on_failure?: boolean;
}

export interface UpdateSignTaskRequest {
  name?: string;
  group?: string;
  task_kind?: SignTaskKind | string;
  sign_at?: string;
  chats?: SignTaskChat[];
  random_seconds?: number;
  sign_interval?: number;
  execution_mode?: "fixed" | "range";
  range_start?: string;
  range_end?: string;
  enabled?: boolean;
  notify_on_failure?: boolean;
}

export interface ChatInfo {
  id: number;
  title?: string;
  username?: string;
  type: string;
  first_name?: string;
}

export interface ChatSearchResponse {
  items: ChatInfo[];
  total: number;
  limit: number;
  offset: number;
}

export async function listSignTasks(
  token: string,
  accountName?: string,
  forceRefresh?: boolean,
  taskKind: SignTaskKind | string = "sign",
): Promise<SignTask[]> {
  const params = new URLSearchParams();
  if (accountName) params.append("account_name", accountName);
  if (forceRefresh) params.append("force_refresh", "true");
  if (taskKind) params.append("task_kind", String(taskKind));
  const url = `/sign-tasks${params.toString() ? `?${params.toString()}` : ""}`;
  return request<SignTask[]>(url, {}, token);
}

export const getSignTask = (
  token: string,
  name: string,
  accountName?: string,
  taskKind?: SignTaskKind | string,
) => {
  const params = new URLSearchParams();
  if (accountName) params.append("account_name", accountName);
  if (taskKind) params.append("task_kind", String(taskKind));
  const url = `/sign-tasks/${pathSegment(name)}${params.toString() ? `?${params.toString()}` : ""}`;
  return request<SignTask>(url, {}, token);
};

export const createSignTask = (token: string, data: CreateSignTaskRequest) =>
  request<SignTask>(
    "/sign-tasks",
    {
      method: "POST",
      body: JSON.stringify({ task_kind: "sign", ...data }),
    },
    token,
  );

export const updateSignTask = (
  token: string,
  name: string,
  data: UpdateSignTaskRequest,
  accountName?: string,
  taskKind?: SignTaskKind | string,
) => {
  const params = new URLSearchParams();
  if (accountName) params.append("account_name", accountName);
  if (taskKind) params.append("task_kind", String(taskKind));
  const query = params.toString() ? `?${params.toString()}` : "";
  return request<SignTask>(
    `/sign-tasks/${pathSegment(name)}${query}`,
    {
      method: "PUT",
      body: JSON.stringify(data),
    },
    token,
  );
};

export const deleteSignTask = (
  token: string,
  name: string,
  accountName?: string,
  taskKind?: SignTaskKind | string,
) => {
  const params = new URLSearchParams();
  if (accountName) params.append("account_name", accountName);
  if (taskKind) params.append("task_kind", String(taskKind));
  const query = params.toString() ? `?${params.toString()}` : "";
  return request<{ ok: boolean }>(
    `/sign-tasks/${pathSegment(name)}${query}`,
    {
      method: "DELETE",
    },
    token,
  );
};

export const runSignTask = (
  token: string,
  name: string,
  accountName: string,
  taskKind: SignTaskKind | string = "sign",
) =>
  request<{ success: boolean; output: string; error: string }>(
    `/sign-tasks/${pathSegment(name)}/run?account_name=${encodeURIComponent(accountName)}&task_kind=${encodeURIComponent(taskKind)}`,
    {
      method: "POST",
    },
    token,
  );

export const getAccountChats = (
  token: string,
  accountName: string,
  forceRefresh?: boolean,
) =>
  request<ChatInfo[]>(
    `/sign-tasks/chats/${pathSegment(accountName)}${forceRefresh ? "?force_refresh=true" : ""}`,
    {},
    token,
  );

export const searchAccountChats = (
  token: string,
  accountName: string,
  query: string,
  limit: number = 50,
  offset: number = 0,
) => {
  const params = new URLSearchParams();
  params.append("q", query);
  params.append("limit", String(limit));
  params.append("offset", String(offset));
  return request<ChatSearchResponse>(
    `/sign-tasks/chats/${pathSegment(accountName)}/search?${params.toString()}`,
    {},
    token,
  );
};

export const getSignTaskLogs = (
  token: string,
  name: string,
  accountName?: string,
  taskKind: SignTaskKind | string = "sign",
) => {
  const params = new URLSearchParams();
  if (accountName) params.append("account_name", accountName);
  params.append("task_kind", String(taskKind));
  const url = `/sign-tasks/${pathSegment(name)}/logs${params.toString() ? `?${params.toString()}` : ""}`;
  return request<string[]>(url, {}, token);
};

export interface SignTaskHistoryItem {
  time: string;
  success: boolean;
  message?: string;
  flow_logs?: string[];
  flow_truncated?: boolean;
  flow_line_count?: number;
}

export const getSignTaskHistory = (
  token: string,
  name: string,
  accountName: string,
  limit: number = 20,
  taskKind: SignTaskKind | string = "sign",
) => {
  const params = new URLSearchParams();
  params.append("account_name", accountName);
  params.append("limit", String(limit));
  params.append("task_kind", String(taskKind));
  return request<SignTaskHistoryItem[]>(
    `/sign-tasks/${pathSegment(name)}/history?${params.toString()}`,
    {},
    token,
  );
};

// ============ Monitor task management ============

export type MonitorChatId = number | string;

export interface MonitorRule {
  id?: string;
  account_name?: string;
  chat_id?: MonitorChatId | null;
  chat_name?: string;
  message_thread_id?: number | null;
  message_thread_ids?: number[];
  monitor_scope?: "selected" | "private";
  keywords: string[];
  match_mode: "contains" | "exact" | "regex";
  ignore_case: boolean;
  include_self_messages?: boolean;
  time_window_enabled?: boolean;
  active_time_start?: string | null;
  active_time_end?: string | null;
  match_all?: boolean;
  push_channel: "telegram" | "forward" | "bark" | "custom" | "continue";
  bark_url?: string | null;
  custom_url?: string | null;
  forward_chat_id?: MonitorChatId | null;
  forward_message_thread_id?: number | null;
  auto_reply_text?: string | null;
  ai_auto_reply?: boolean;
  ai_prompt?: string | null;
  ai_persona?: string | null;
  ai_context_messages?: number;
  ai_whitelist_users?: string[];
  ai_blacklist_users?: string[];
  ai_daily_limit?: number | null;
  continue_chat_id?: MonitorChatId | null;
  continue_message_thread_id?: number | null;
  continue_action_interval?: number;
  continue_actions?: any[];
}

export interface MonitorTask {
  name: string;
  account_name: string;
  group?: string;
  enabled: boolean;
  rules: MonitorRule[];
}

export interface MonitorStatus {
  time: string;
  active: boolean;
  message: string;
  logs: string[];
}

export interface MonitorMatchRecord {
  fingerprint: string;
  account_name: string;
  task_name: string;
  chat_id?: MonitorChatId | null;
  chat_name: string;
  message_thread_id?: number | null;
  matched_keyword: string;
  match_mode: string;
  message_text: string;
  message_preview: string;
  sender: string;
  sender_id: string;
  sender_username: string;
  message_url: string;
  hit_count: number;
  first_seen_at: string;
  last_seen_at: string;
  first_message_id?: number | null;
  last_message_id?: number | null;
}

export interface CreateMonitorTaskRequest {
  name: string;
  account_name: string;
  group?: string;
  enabled?: boolean;
  rules: MonitorRule[];
}

export interface UpdateMonitorTaskRequest {
  name?: string;
  account_name?: string;
  group?: string;
  enabled?: boolean;
  rules?: MonitorRule[];
}

export const listMonitorTasks = (token: string, accountName?: string) => {
  const params = new URLSearchParams();
  if (accountName) params.append("account_name", accountName);
  return request<MonitorTask[]>(
    `/monitors${params.toString() ? `?${params.toString()}` : ""}`,
    {},
    token,
  );
};

export const createMonitorTask = (
  token: string,
  data: CreateMonitorTaskRequest,
) =>
  request<MonitorTask>(
    "/monitors",
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    token,
  );

export const updateMonitorTask = (
  token: string,
  name: string,
  data: UpdateMonitorTaskRequest,
  accountName?: string,
) => {
  const params = new URLSearchParams();
  if (accountName) params.append("account_name", accountName);
  return request<MonitorTask>(
    `/monitors/${pathSegment(name)}${params.toString() ? `?${params.toString()}` : ""}`,
    {
      method: "PUT",
      body: JSON.stringify(data),
    },
    token,
  );
};

export const deleteMonitorTask = (
  token: string,
  name: string,
  accountName?: string,
) => {
  const params = new URLSearchParams();
  if (accountName) params.append("account_name", accountName);
  return request<{ ok: boolean }>(
    `/monitors/${pathSegment(name)}${params.toString() ? `?${params.toString()}` : ""}`,
    { method: "DELETE" },
    token,
  );
};

export const getMonitorStatus = (
  token: string,
  name: string,
  accountName?: string,
) => {
  const params = new URLSearchParams();
  if (accountName) params.append("account_name", accountName);
  return request<MonitorStatus>(
    `/monitors/${pathSegment(name)}/status${params.toString() ? `?${params.toString()}` : ""}`,
    {},
    token,
  );
};

export const getMonitorRecords = (
  token: string,
  name: string,
  accountName?: string,
  limit: number = 200,
) => {
  const params = new URLSearchParams();
  if (accountName) params.append("account_name", accountName);
  params.append("limit", String(limit));
  return request<MonitorMatchRecord[]>(
    `/monitors/${pathSegment(name)}/records?${params.toString()}`,
    {},
    token,
  );
};

export const exportMonitorRecords = async (
  token: string,
  name: string,
  accountName?: string,
) => {
  const params = new URLSearchParams();
  if (accountName) params.append("account_name", accountName);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const blob = await requestBlob(
    `/monitors/${pathSegment(name)}/records/export${suffix}`,
    {},
    token,
  );
  const filenameBase = ["monitor_records", accountName || "account", name]
    .filter(Boolean)
    .map(safeFilenamePart)
    .join("_");
  downloadBlob(blob, `${filenameBase}.xlsx`);
};

export interface SpeakerCollectionConfig {
  id?: string;
  name: string;
  account_name: string;
  chat_id: MonitorChatId;
  chat_name?: string;
  start_at?: string | null;
  end_at?: string | null;
  profile_keywords?: string[];
  continuous?: boolean;
  enabled?: boolean;
  history_limit?: number;
  last_scan_at?: string | null;
  last_scan_summary?: Record<string, number>;
  monitor_status?: "one_time" | "running" | "waiting" | "paused" | "completed";
  completed_at?: string | null;
}

export interface SpeakerCollectionRecord {
  id: string;
  sender_id: string;
  sender: string;
  sender_username: string;
  profile_url: string;
  bio: string;
  websites?: string[];
  matched_keywords?: string[];
  message_count: number;
  first_message_at: string;
  last_message_at: string;
  sample_message: string;
}

export const listSpeakerCollections = (token: string, accountName?: string) =>
  request<SpeakerCollectionConfig[]>(
    `/speaker-collections${accountName ? `?account_name=${pathSegment(accountName)}` : ""}`,
    {},
    token,
  );
export const resolveSpeakerCollectionChat = (
  token: string,
  accountName: string,
  query: string,
) => {
  const params = new URLSearchParams({ account_name: accountName, q: query });
  return request<ChatInfo>(
    `/speaker-collections/resolve-chat?${params.toString()}`,
    {},
    token,
  );
};
export const saveSpeakerCollection = (
  token: string,
  data: SpeakerCollectionConfig,
) =>
  request<SpeakerCollectionConfig>(
    "/speaker-collections",
    { method: "POST", body: JSON.stringify(data) },
    token,
  );
export const scanSpeakerCollection = (token: string, id: string) =>
  request<Record<string, number>>(
    `/speaker-collections/${pathSegment(id)}/scan`,
    { method: "POST" },
    token,
  );
export const setSpeakerCollectionEnabled = (
  token: string,
  id: string,
  enabled: boolean,
) =>
  request<SpeakerCollectionConfig>(
    `/speaker-collections/${pathSegment(id)}/enabled`,
    { method: "PATCH", body: JSON.stringify({ enabled }) },
    token,
  );
export const getSpeakerCollectionRecords = (token: string, id: string) =>
  request<SpeakerCollectionRecord[]>(
    `/speaker-collections/${pathSegment(id)}/records`,
    {},
    token,
  );
export const deleteSpeakerCollection = (token: string, id: string) =>
  request<{ ok: boolean }>(
    `/speaker-collections/${pathSegment(id)}`,
    { method: "DELETE" },
    token,
  );
export const exportSpeakerCollectionRecords = async (
  token: string,
  id: string,
) => {
  const blob = await requestBlob(
    `/speaker-collections/${pathSegment(id)}/records/export`,
    {},
    token,
  );
  downloadBlob(blob, "speaker_collection.xlsx");
};

export type AutomationTriggerType = "message" | "timer" | "startup";

export interface AutomationTrigger {
  id?: string;
  type: AutomationTriggerType;
  params: Record<string, any>;
}

export interface AutomationFilter {
  chat_id?: string | number | null;
  chat_ids?: Array<string | number>;
  from_user_ids?: Array<string | number>;
  text_rule?: "all" | "exact" | "contains" | "regex";
  text_value?: string | null;
  ignore_case?: boolean;
}

export interface AutomationHandler {
  handler: string;
  params: Record<string, any>;
}

export interface AutomationRule {
  id?: string;
  name: string;
  account_name: string;
  group?: string;
  enabled?: boolean;
  drop_if_running?: boolean;
  triggers: AutomationTrigger[];
  filters?: AutomationFilter | null;
  handlers: AutomationHandler[];
  vars?: Record<string, any>;
  created_at?: string;
  updated_at?: string;
}

export interface AutomationLog {
  time: string;
  level: string;
  trigger?: string;
  message: string;
  context?: Record<string, any>;
}

export interface AutomationStatus {
  enabled: boolean;
  running: boolean;
  listener_active: boolean;
  scheduled_jobs: Array<{ id: string; next_run_time?: string | null }>;
  last_log?: AutomationLog | null;
}

export const listAutomationRules = (token: string, accountName?: string) =>
  request<AutomationRule[]>(
    `/automation-rules${accountName ? `?account_name=${pathSegment(accountName)}` : ""}`,
    {},
    token,
  );

export const createAutomationRule = (token: string, data: AutomationRule) =>
  request<AutomationRule>(
    "/automation-rules",
    { method: "POST", body: JSON.stringify(data) },
    token,
  );

export const updateAutomationRule = (
  token: string,
  id: string,
  data: AutomationRule,
) =>
  request<AutomationRule>(
    `/automation-rules/${pathSegment(id)}`,
    { method: "PUT", body: JSON.stringify(data) },
    token,
  );

export const deleteAutomationRule = (token: string, id: string) =>
  request<{ ok: boolean }>(
    `/automation-rules/${pathSegment(id)}`,
    { method: "DELETE" },
    token,
  );

export const setAutomationRuleEnabled = (
  token: string,
  id: string,
  enabled: boolean,
) =>
  request<AutomationRule>(
    `/automation-rules/${pathSegment(id)}/enabled`,
    { method: "PATCH", body: JSON.stringify({ enabled }) },
    token,
  );

export const runAutomationRule = (token: string, id: string) =>
  request<Record<string, any>>(
    `/automation-rules/${pathSegment(id)}/run`,
    { method: "POST" },
    token,
  );

export const getAutomationRuleStatus = (token: string, id: string) =>
  request<AutomationStatus>(
    `/automation-rules/${pathSegment(id)}/status`,
    {},
    token,
  );

export const getAutomationRuleLogs = (
  token: string,
  id: string,
  limit: number = 200,
) =>
  request<AutomationLog[]>(
    `/automation-rules/${pathSegment(id)}/logs?limit=${limit}`,
    {},
    token,
  );

export const getAutomationRuleState = (token: string, id: string) =>
  request<Record<string, any>>(
    `/automation-rules/${pathSegment(id)}/state`,
    {},
    token,
  );

export const clearAutomationRuleState = (token: string, id: string) =>
  request<{ ok: boolean }>(
    `/automation-rules/${pathSegment(id)}/state`,
    { method: "DELETE" },
    token,
  );
