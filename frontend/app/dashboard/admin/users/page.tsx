"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import {
  CheckCircle,
  Key,
  Plus,
  Spinner,
  Trash,
  UserMinus,
  UserPlus,
  X,
} from "@phosphor-icons/react";
import { getToken } from "../../../../lib/auth";
import {
  createManagedUser,
  deleteManagedUser,
  getMe,
  getGlobalSettings,
  listManagedUsers,
  resetManagedUserTOTP,
  updateManagedUser,
} from "../../../../lib/api";
import type { CurrentUser } from "../../../../lib/types";

export default function AdminUsersPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [users, setUsers] = useState<CurrentUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [form, setForm] = useState({ username: "", password: "" });
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ username: "", password: "" });
  const [timezone, setTimezone] = useState("Asia/Shanghai");

  const formatTime = (value: string) => {
    const timestamp = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
      ? value
      : `${value}Z`;
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(timestamp));
  };

  const loadUsers = useCallback(
    async (accessToken: string) => {
      setLoading(true);
      try {
        const current = await getMe(accessToken);
        if (!current.is_admin) {
          router.replace("/dashboard");
          return;
        }
        const [managedUsers, globalSettings] = await Promise.all([
          listManagedUsers(accessToken),
          getGlobalSettings(accessToken),
        ]);
        setUsers(managedUsers);
        setTimezone(globalSettings.timezone || "Asia/Shanghai");
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载用户失败");
      } finally {
        setLoading(false);
      }
    },
    [router],
  );

  useEffect(() => {
    const accessToken = getToken();
    if (!accessToken) {
      router.replace("/");
      return;
    }
    setToken(accessToken);
    void loadUsers(accessToken);
  }, [loadUsers, router]);

  const createUser = async (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const user = await createManagedUser(token, form);
      setUsers((items) => [user, ...items]);
      setForm({ username: "", password: "" });
      setCreateDialogOpen(false);
      setMessage("普通用户已创建，工作区已初始化。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建用户失败");
    } finally {
      setSaving(false);
    }
  };

  const saveUser = async (userId: number) => {
    if (!token) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const payload = {
        username: editForm.username,
        ...(editForm.password ? { password: editForm.password } : {}),
      };
      const updated = await updateManagedUser(token, userId, payload);
      setUsers((items) =>
        items.map((item) => (item.id === userId ? updated : item)),
      );
      setEditingId(null);
      setEditForm({ username: "", password: "" });
      setMessage("用户信息已更新。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新用户失败");
    } finally {
      setSaving(false);
    }
  };

  const toggleUser = async (user: CurrentUser) => {
    if (!token) return;
    setSaving(true);
    setError("");
    try {
      const updated = await updateManagedUser(token, user.id, {
        is_active: !user.is_active,
      });
      setUsers((items) =>
        items.map((item) => (item.id === user.id ? updated : item)),
      );
      setMessage(
        updated.is_active
          ? "用户已启用。"
          : "用户已停用。该用户现有登录令牌将失效。",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新用户状态失败");
    } finally {
      setSaving(false);
    }
  };

  const resetTotp = async (user: CurrentUser) => {
    if (!token || !window.confirm(`确认重置 ${user.username} 的两步验证？`))
      return;
    setSaving(true);
    setError("");
    try {
      await resetManagedUserTOTP(token, user.id);
      setMessage(`${user.username} 的两步验证已重置。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "重置两步验证失败");
    } finally {
      setSaving(false);
    }
  };

  const deleteUser = async (user: CurrentUser) => {
    if (
      !token ||
      !window.confirm(
        `确认永久删除用户 ${user.username} 吗？该用户的 Telegram 会话、任务、日志和工作区数据将一并删除。`,
      )
    ) {
      return;
    }
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await deleteManagedUser(token, user.id);
      setUsers((items) => items.filter((item) => item.id !== user.id));
      setEditingId((current) => (current === user.id ? null : current));
      setMessage(`${user.username} 及其独立工作区数据已删除。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除用户失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div id="settings-view" className="w-full h-full flex flex-col">
      <header className="navbar">
        <div className="nav-brand min-w-0">
          <div className="navbar-title-block">
            <h1 className="nav-title">用户管理</h1>
            <p className="nav-subtitle">
              单管理员模式 · 集中管理普通用户及其独立工作区
            </p>
          </div>
        </div>
        <div className="top-right-actions shrink-0">
          <button
            className="navbar-text-action"
            type="button"
            onClick={() => {
              setError("");
              setMessage("");
              setCreateDialogOpen(true);
            }}
          >
            <Plus weight="bold" size={14} /> 创建用户
          </button>
        </div>
      </header>

      <main className="main-content settings-main !pt-6">
        <div className="settings-shell settings-shell-single animate-float-up pb-10">
          <section className="settings-content min-w-0 space-y-4">
            {(message || error) && (
              <div
                className={`settings-callout ${error ? "!border-rose-500/40 !text-rose-300" : ""}`}
              >
                {error || message}
              </div>
            )}

            <section className="settings-panel !p-0 overflow-hidden">
              <div className="flex items-center justify-between gap-4 border-b border-white/10 px-5 py-4">
                <div>
                  <h2 className="text-base font-bold">普通用户列表</h2>
                  <p className="mt-0.5 text-[11px] text-main/45">
                    用户数据与 Telegram 会话均独立存放。
                  </p>
                </div>
                <span className="settings-status-badge is-success">
                  {users.length} 个用户
                </span>
              </div>
              {loading ? (
                <div className="py-12 text-center text-main/50">
                  <Spinner className="inline animate-spin mr-2" />
                  加载中
                </div>
              ) : users.length === 0 ? (
                <div className="py-12 text-center text-main/50">
                  还没有普通用户。
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-left text-sm">
                    <thead className="bg-main/[0.025] text-[11px] uppercase tracking-wider text-main/40">
                      <tr>
                        <th className="px-5 py-3 font-semibold">用户</th>
                        <th className="px-4 py-3 font-semibold">状态</th>
                        <th className="px-4 py-3 font-semibold">创建时间</th>
                        <th className="px-5 py-3 text-right font-semibold">
                          操作
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((user) => (
                        <tr
                          className="border-b border-white/5 transition-colors last:border-b-0 hover:bg-violet-500/[0.035]"
                          key={user.id}
                        >
                          <td className="px-5 py-3">
                            {editingId === user.id ? (
                              <div className="flex flex-col gap-2 sm:flex-row">
                                <input
                                  className="!py-1.5 !px-2"
                                  value={editForm.username}
                                  minLength={3}
                                  maxLength={50}
                                  onChange={(event) =>
                                    setEditForm((value) => ({
                                      ...value,
                                      username: event.target.value,
                                    }))
                                  }
                                />
                                <input
                                  className="!py-1.5 !px-2"
                                  type="password"
                                  placeholder="留空不改密码"
                                  value={editForm.password}
                                  minLength={8}
                                  onChange={(event) =>
                                    setEditForm((value) => ({
                                      ...value,
                                      password: event.target.value,
                                    }))
                                  }
                                />
                              </div>
                            ) : (
                              <div className="flex items-center gap-3">
                                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-violet-500/10 text-xs font-bold text-violet-400">
                                  {user.username.slice(0, 1).toUpperCase()}
                                </div>
                                <div>
                                  <div className="font-semibold text-main">
                                    {user.username}
                                  </div>
                                  <div className="mt-0.5 text-[11px] text-main/40">
                                    独立工作区
                                  </div>
                                </div>
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={
                                user.is_active
                                  ? "settings-status-badge is-success"
                                  : "settings-status-badge is-danger"
                              }
                            >
                              {user.is_active ? "已启用" : "已停用"}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-main/55">
                            {formatTime(user.created_at)}
                          </td>
                          <td className="px-5 py-3">
                            <div className="flex flex-wrap justify-end gap-1.5">
                              {editingId === user.id ? (
                                <>
                                  <button
                                    className="btn-secondary h-8 px-3 text-xs"
                                    type="button"
                                    disabled={saving}
                                    onClick={() => void saveUser(user.id)}
                                  >
                                    <CheckCircle size={15} /> 保存
                                  </button>
                                  <button
                                    className="btn-secondary h-8 px-3 text-xs"
                                    type="button"
                                    onClick={() => setEditingId(null)}
                                  >
                                    取消
                                  </button>
                                </>
                              ) : (
                                <button
                                  className="btn-secondary h-8 px-3 text-xs"
                                  type="button"
                                  onClick={() => {
                                    setEditingId(user.id);
                                    setEditForm({
                                      username: user.username,
                                      password: "",
                                    });
                                  }}
                                >
                                  编辑
                                </button>
                              )}
                              <button
                                className="btn-secondary h-8 px-3 text-xs"
                                type="button"
                                disabled={saving}
                                onClick={() => void resetTotp(user)}
                              >
                                <Key size={14} /> 重置 2FA
                              </button>
                              <button
                                className={`btn-secondary h-8 px-3 text-xs ${user.is_active ? "!text-rose-400" : "!text-emerald-400"}`}
                                type="button"
                                disabled={saving}
                                onClick={() => void toggleUser(user)}
                              >
                                {user.is_active ? (
                                  <UserMinus size={14} />
                                ) : (
                                  <UserPlus size={14} />
                                )}
                                {user.is_active ? "停用" : "启用"}
                              </button>
                              <button
                                className="btn-secondary h-8 px-3 text-xs !text-rose-400"
                                type="button"
                                disabled={saving}
                                onClick={() => void deleteUser(user)}
                              >
                                <Trash size={14} /> 删除
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {createDialogOpen &&
              createPortal(
                <div
                  className="modal-overlay active admin-user-modal-overlay"
                  onMouseDown={() => !saving && setCreateDialogOpen(false)}
                >
                  <form
                    className="glass-panel modal-content admin-user-modal-content !max-w-md !p-0 overflow-hidden"
                    onSubmit={createUser}
                    onMouseDown={(event) => event.stopPropagation()}
                  >
                    <div className="modal-header !mb-0 border-b border-white/5 px-6 py-4">
                      <div className="settings-panel-title">
                        <div>
                          <div className="modal-title">创建普通用户</div>
                          <div className="mt-1 text-xs text-main/45">
                            用户数据与 Telegram 会话将独立存放。
                          </div>
                        </div>
                      </div>
                      <button
                        className="action-btn"
                        type="button"
                        disabled={saving}
                        onClick={() => setCreateDialogOpen(false)}
                        aria-label="关闭"
                      >
                        <X weight="bold" />
                      </button>
                    </div>
                    <div className="space-y-4 px-6 py-5">
                      <div>
                        <label className="text-[12px] mb-1.5">用户名</label>
                        <input
                          className="!py-2.5 !px-4"
                          value={form.username}
                          minLength={3}
                          maxLength={50}
                          required
                          autoFocus
                          onChange={(event) =>
                            setForm((value) => ({
                              ...value,
                              username: event.target.value,
                            }))
                          }
                        />
                      </div>
                      <div>
                        <label className="text-[12px] mb-1.5">初始密码</label>
                        <input
                          className="!py-2.5 !px-4"
                          type="password"
                          value={form.password}
                          minLength={8}
                          required
                          onChange={(event) =>
                            setForm((value) => ({
                              ...value,
                              password: event.target.value,
                            }))
                          }
                        />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2 border-t border-white/5 px-6 py-4">
                      <button
                        className="btn-secondary"
                        type="button"
                        disabled={saving}
                        onClick={() => setCreateDialogOpen(false)}
                      >
                        取消
                      </button>
                      <button
                        className="btn-gradient"
                        disabled={saving}
                        type="submit"
                      >
                        {saving ? (
                          <Spinner className="animate-spin" />
                        ) : (
                          <Plus weight="bold" />
                        )}{" "}
                        创建用户
                      </button>
                    </div>
                  </form>
                </div>,
                document.body,
              )}
          </section>
        </div>
      </main>
    </div>
  );
}
