"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  CaretDown,
  CaretUp,
  Clock,
  Code,
  FloppyDisk,
  ListChecks,
  Pause,
  PencilSimple,
  Play,
  Plus,
  Robot,
  Spinner,
  Trash,
  X,
} from "@phosphor-icons/react";
import { ToastContainer, useToast } from "../../../components/ui/toast";
import { getToken } from "../../../lib/auth";
import {
  AccountInfo,
  AutomationFilter,
  AutomationHandler,
  AutomationLog,
  AutomationRule,
  AutomationStatus,
  AutomationTrigger,
  createAutomationRule,
  deleteAutomationRule,
  getAutomationRuleLogs,
  getAutomationRuleState,
  getAutomationRuleStatus,
  listAccounts,
  listAutomationRules,
  runAutomationRule,
  setAutomationRuleEnabled,
  updateAutomationRule,
} from "../../../lib/api";
import {
  formatConfiguredDateTime,
  useConfiguredTimezone,
} from "../../../lib/time";

const triggerLabels: Record<string, string> = {
  message: "收到消息",
  timer: "定时触发",
  startup: "服务启动",
};

const handlerLabels: Record<string, string> = {
  send_text: "发送文本",
  reply_text: "回复消息",
  extract_regex: "正则提取变量",
  ai_reply: "AI 回复",
  blacklist_filter: "黑名单拦截",
  delay: "延迟执行",
  forward: "转发原消息",
  http_callback: "HTTP 回调",
  external_forward: "外部 HTTP 转发",
  server_chan: "Server 酱通知",
  schedule_next: "调整下次运行",
  store_state: "保存状态",
  load_state: "读取状态",
  random_pick: "随机选择",
};

const handlerOptions = Object.entries(handlerLabels);

const splitReferences = (value: string): Array<string | number> =>
  value
    .split(/[\n,，]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) =>
      item.startsWith("-")
        ? Number(item) || item
        : /^\d+$/.test(item)
          ? Number(item)
          : item,
    );

const joinReferences = (value?: Array<string | number> | string) =>
  Array.isArray(value) ? value.join("\n") : String(value || "");

const normalizeRuleInputs = (rule: AutomationRule): AutomationRule => {
  const next = JSON.parse(JSON.stringify(rule)) as AutomationRule;
  next.triggers.forEach((trigger) => {
    if (typeof trigger.params.chat_ids === "string") {
      trigger.params.chat_ids = splitReferences(trigger.params.chat_ids);
    }
    if (typeof trigger.params.from_user_ids === "string") {
      trigger.params.from_user_ids = splitReferences(
        trigger.params.from_user_ids,
      );
    }
  });
  if (next.filters) {
    if (typeof next.filters.chat_ids === "string")
      next.filters.chat_ids = splitReferences(next.filters.chat_ids);
    if (typeof next.filters.from_user_ids === "string")
      next.filters.from_user_ids = splitReferences(next.filters.from_user_ids);
  }
  next.handlers.forEach((handler) => {
    if (
      handler.handler === "blacklist_filter" &&
      typeof handler.params.values === "string"
    ) {
      handler.params.values = handler.params.values
        .split(/\n+/)
        .map((item: string) => item.trim())
        .filter(Boolean);
    }
    if (
      handler.handler === "random_pick" &&
      typeof handler.params.items === "string"
    ) {
      handler.params.items = handler.params.items
        .split(/\n+/)
        .map((item: string) => item.trim())
        .filter(Boolean);
    }
  });
  return next;
};

const defaultTrigger = (
  type: AutomationTrigger["type"] = "message",
): AutomationTrigger => ({
  type,
  params:
    type === "message"
      ? {
          chat_ids: [],
          from_user_ids: [],
          include_outgoing: false,
          reply_to_me: false,
        }
      : type === "timer"
        ? { cron: "0 8 * * *", random_seconds: 0, chat_id: "" }
        : { chat_id: "" },
});

const defaultHandler = (handler = "send_text"): AutomationHandler => {
  const defaults: Record<string, Record<string, any>> = {
    send_text: { chat_id: "", text: "" },
    reply_text: { text: "" },
    extract_regex: {
      pattern: "",
      var: "extracted",
      required: true,
      ignore_case: true,
    },
    ai_reply: {
      prompt: "你是一个简洁、准确的 Telegram 自动回复助手。",
      query: "{text}",
      send: true,
      reply: true,
    },
    blacklist_filter: { values: [], ignore_case: true },
    delay: { seconds: 1 },
    forward: { to_chat_id: "" },
    http_callback: {
      url: "",
      method: "post",
      payload: '{"text":"{text}","chat_id":"{chat_id}"}',
    },
    external_forward: { targets: [{ type: "http", url: "", method: "post" }] },
    server_chan: { send_key: "", title: "Automation", body: "{text}" },
    schedule_next: {
      delay_seconds: 300,
      from_var: "",
      from_var_unit: "seconds",
      offset_seconds: 0,
      target_trigger_id: "",
    },
    store_state: { key: "last_value", from_var: "extracted" },
    load_state: { key: "last_value", var: "last_value", default: "" },
    random_pick: { items: ["选项 A", "选项 B"], var: "picked" },
  };
  return { handler, params: defaults[handler] || {} };
};

const emptyRule = (accountName = ""): AutomationRule => ({
  name: "新自动化规则",
  account_name: accountName,
  group: "默认分组",
  enabled: true,
  drop_if_running: true,
  triggers: [defaultTrigger()],
  filters: {
    text_rule: "all",
    text_value: "",
    ignore_case: true,
    chat_ids: [],
    from_user_ids: [],
  },
  handlers: [defaultHandler()],
  vars: {},
});

export default function AutomationRulesPage() {
  const { toasts, addToast, removeToast } = useToast();
  const timezone = useConfiguredTimezone();
  const [token, setToken] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<AutomationRule>(emptyRule());
  const [varsText, setVarsText] = useState("{}");
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState("");
  const [togglingId, setTogglingId] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const [detailRule, setDetailRule] = useState<AutomationRule | null>(null);
  const [detailStatus, setDetailStatus] = useState<AutomationStatus | null>(
    null,
  );
  const [detailLogs, setDetailLogs] = useState<AutomationLog[]>([]);
  const [detailState, setDetailState] = useState<Record<string, any>>({});
  const [detailLoading, setDetailLoading] = useState(false);

  const refresh = useCallback(async (auth: string) => {
    setLoading(true);
    try {
      const [accountData, ruleData] = await Promise.all([
        listAccounts(auth),
        listAutomationRules(auth),
      ]);
      setAccounts(accountData.accounts);
      setRules(ruleData);
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
    refresh(auth).catch((error) =>
      addToast(error.message || "加载自动化规则失败", "error"),
    );
  }, [addToast, refresh]);

  const groupedRules = useMemo(() => {
    const groups = new Map<string, AutomationRule[]>();
    rules.forEach((rule) => {
      const group = rule.group || "默认分组";
      groups.set(group, [...(groups.get(group) || []), rule]);
    });
    return Array.from(groups.entries());
  }, [rules]);

  const openCreate = () => {
    const requestedAccount =
      typeof window === "undefined"
        ? ""
        : new URLSearchParams(window.location.search).get("account_name") || "";
    const accountName = accounts.some(
      (account) => account.name === requestedAccount,
    )
      ? requestedAccount
      : accounts[0]?.name || "";
    const next = emptyRule(accountName);
    setForm(next);
    setVarsText("{}");
    setEditorOpen(true);
  };

  const openEdit = (rule: AutomationRule) => {
    setForm(JSON.parse(JSON.stringify(rule)));
    setVarsText(JSON.stringify(rule.vars || {}, null, 2));
    setEditorOpen(true);
  };

  const updateTrigger = (index: number, next: AutomationTrigger) => {
    setForm((current) => ({
      ...current,
      triggers: current.triggers.map((item, itemIndex) =>
        itemIndex === index ? next : item,
      ),
    }));
  };

  const updateHandler = (index: number, next: AutomationHandler) => {
    setForm((current) => ({
      ...current,
      handlers: current.handlers.map((item, itemIndex) =>
        itemIndex === index ? next : item,
      ),
    }));
  };

  const moveHandler = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= form.handlers.length) return;
    const next = [...form.handlers];
    [next[index], next[target]] = [next[target], next[index]];
    setForm({ ...form, handlers: next });
  };

  const save = async () => {
    if (!token) return;
    let vars: Record<string, any>;
    try {
      vars = JSON.parse(varsText || "{}");
      if (!vars || Array.isArray(vars) || typeof vars !== "object")
        throw new Error();
    } catch {
      addToast("初始变量必须是有效的 JSON 对象", "error");
      return;
    }
    if (!form.name.trim() || !form.account_name) {
      addToast("请填写规则名称并选择账号", "error");
      return;
    }
    try {
      setSaving(true);
      const payload = normalizeRuleInputs({ ...form, vars });
      const saved = form.id
        ? await updateAutomationRule(token, form.id, payload)
        : await createAutomationRule(token, payload);
      setRules((items) => [
        saved,
        ...items.filter((item) => item.id !== saved.id),
      ]);
      setEditorOpen(false);
      addToast(form.id ? "自动化规则已更新" : "自动化规则已创建", "success");
    } catch (error: any) {
      addToast(error.message || "保存自动化规则失败", "error");
    } finally {
      setSaving(false);
    }
  };

  const runRule = async (rule: AutomationRule) => {
    if (!token || !rule.id) return;
    try {
      setRunningId(rule.id);
      await runAutomationRule(token, rule.id);
      addToast("规则执行完成", "success");
    } catch (error: any) {
      addToast(error.message || "规则执行失败", "error");
    } finally {
      setRunningId("");
    }
  };

  const toggleRule = async (rule: AutomationRule) => {
    if (!token || !rule.id) return;
    try {
      setTogglingId(rule.id);
      const updated = await setAutomationRuleEnabled(
        token,
        rule.id,
        rule.enabled === false,
      );
      setRules((items) =>
        items.map((item) => (item.id === updated.id ? updated : item)),
      );
      addToast(updated.enabled ? "规则已启用" : "规则已停用", "success");
    } catch (error: any) {
      addToast(error.message || "切换规则状态失败", "error");
    } finally {
      setTogglingId("");
    }
  };

  const removeRule = async (rule: AutomationRule) => {
    if (!token || !rule.id || !confirm(`删除自动化规则“${rule.name}”？`))
      return;
    try {
      setDeletingId(rule.id);
      await deleteAutomationRule(token, rule.id);
      setRules((items) => items.filter((item) => item.id !== rule.id));
      addToast("自动化规则已删除", "success");
    } catch (error: any) {
      addToast(error.message || "删除自动化规则失败", "error");
    } finally {
      setDeletingId("");
    }
  };

  const openDetails = async (rule: AutomationRule) => {
    if (!token || !rule.id) return;
    setDetailRule(rule);
    setDetailLoading(true);
    try {
      const [status, logs, state] = await Promise.all([
        getAutomationRuleStatus(token, rule.id),
        getAutomationRuleLogs(token, rule.id),
        getAutomationRuleState(token, rule.id),
      ]);
      setDetailStatus(status);
      setDetailLogs(logs);
      setDetailState(state);
    } catch (error: any) {
      addToast(error.message || "加载规则状态失败", "error");
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <div className="w-full min-h-full flex flex-col" id="automation-rules-view">
      <nav className="navbar">
        <div className="nav-brand">
          <div className="navbar-title-block">
            <h1 className="nav-title">自动化规则</h1>
            <div className="nav-subtitle">
              通过消息、定时或启动事件触发多步动作链
            </div>
          </div>
        </div>
        <div className="top-right-actions">
          <button className="navbar-text-action" onClick={openCreate}>
            <Plus weight="bold" size={14} />
            新建规则
          </button>
        </div>
      </nav>

      <main className="main-content dashboard-module-content !pt-6">
        {loading ? (
          <div className="flex items-center justify-center py-24 text-main/30">
            <Spinner className="animate-spin" size={32} />
          </div>
        ) : rules.length === 0 ? (
          <button
            type="button"
            className="glass-panel w-full border-2 border-dashed p-16 text-center transition-colors hover:border-violet-500/35"
            onClick={openCreate}
          >
            <Robot
              size={42}
              weight="duotone"
              className="mx-auto mb-4 text-violet-400"
            />
            <div className="text-lg font-bold">创建第一条自动化规则</div>
            <div className="mt-2 text-sm text-main/45">
              配置触发器、过滤条件与顺序动作链
            </div>
          </button>
        ) : (
          <div className="space-y-6">
            {groupedRules.map(([group, items]) => (
              <section key={group} className="space-y-3">
                <div className="flex items-center gap-2 px-1">
                  <h2 className="text-sm font-bold">{group}</h2>
                  <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-bold text-violet-400">
                    {items.length}
                  </span>
                </div>
                <div className="dashboard-module-grid">
                  {items.map((rule) => (
                    <article
                      key={rule.id}
                      className={`dashboard-module-card glass-panel flex flex-col gap-3 p-4 ${rule.enabled === false ? "opacity-65" : ""}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate font-bold">{rule.name}</div>
                          <div className="mt-1 truncate text-[11px] text-main/40">
                            {rule.account_name}
                          </div>
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold ${rule.enabled === false ? "bg-main/5 text-main/35" : "bg-emerald-500/10 text-emerald-400"}`}
                        >
                          {rule.enabled === false ? "已停用" : "运行中"}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {rule.triggers.map((trigger, index) => (
                          <span
                            key={`${trigger.type}-${index}`}
                            className="rounded-lg border border-white/5 bg-main/[0.03] px-2 py-1 text-[10px] text-main/55"
                          >
                            {triggerLabels[trigger.type] || trigger.type}
                          </span>
                        ))}
                      </div>
                      <div className="rounded-xl bg-main/[0.025] px-3 py-2 text-[11px] text-main/45">
                        <div className="flex justify-between">
                          <span>匹配方式</span>
                          <b className="text-main/70">
                            {rule.filters?.text_rule || "all"}
                          </b>
                        </div>
                        <div className="mt-1 flex justify-between">
                          <span>动作数量</span>
                          <b className="text-main/70">{rule.handlers.length}</b>
                        </div>
                      </div>
                      <div className="truncate text-[10px] text-main/35">
                        {rule.handlers
                          .map(
                            (handler) =>
                              handlerLabels[handler.handler] || handler.handler,
                          )
                          .join(" → ")}
                      </div>
                      <div className="mt-auto flex items-center gap-1.5 border-t border-white/5 pt-3">
                        <button
                          className="btn-secondary flex-1 !h-8 !py-0 !text-[11px]"
                          onClick={() => runRule(rule)}
                          disabled={!!runningId || !!togglingId || !!deletingId}
                        >
                          {runningId === rule.id ? (
                            <Spinner className="animate-spin" />
                          ) : (
                            <Play weight="bold" />
                          )}
                          立即运行
                        </button>
                        <button
                          className="action-btn !h-8 !w-8"
                          onClick={() => toggleRule(rule)}
                          disabled={!!runningId || !!togglingId || !!deletingId}
                          title={rule.enabled === false ? "启用" : "停用"}
                        >
                          {togglingId === rule.id ? (
                            <Spinner className="animate-spin" />
                          ) : rule.enabled === false ? (
                            <Play weight="bold" />
                          ) : (
                            <Pause weight="bold" />
                          )}
                        </button>
                        <button
                          className="action-btn !h-8 !w-8 !text-cyan-400"
                          onClick={() => openDetails(rule)}
                          title="状态与日志"
                        >
                          <ListChecks weight="bold" />
                        </button>
                        <button
                          className="action-btn !h-8 !w-8"
                          onClick={() => openEdit(rule)}
                          title="编辑"
                        >
                          <PencilSimple weight="bold" />
                        </button>
                        <button
                          className="action-btn !h-8 !w-8 !text-rose-400"
                          onClick={() => removeRule(rule)}
                          disabled={!!runningId || !!togglingId || !!deletingId}
                          title="删除"
                        >
                          {deletingId === rule.id ? (
                            <Spinner className="animate-spin" />
                          ) : (
                            <Trash weight="bold" />
                          )}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>

      {editorOpen && (
        <div className="modal-overlay active">
          <div className="modal-content !max-w-[1080px] !p-0 overflow-hidden">
            <div className="modal-header !mb-0 border-b border-white/5 px-6 py-4">
              <div>
                <div className="modal-title">
                  {form.id ? "编辑自动化规则" : "新建自动化规则"}
                </div>
                <div className="mt-1 text-xs text-main/40">
                  触发器命中后，将按照从上到下的顺序执行动作
                </div>
              </div>
              <button
                className="action-btn"
                onClick={() => setEditorOpen(false)}
              >
                <X weight="bold" />
              </button>
            </div>
            <div className="custom-scrollbar max-h-[calc(100vh-170px)] overflow-y-auto p-6">
              <div className="grid gap-4 md:grid-cols-3">
                <label className="text-xs">
                  规则名称
                  <input
                    value={form.name}
                    onChange={(event) =>
                      setForm({ ...form, name: event.target.value })
                    }
                  />
                </label>
                <label className="text-xs">
                  账号
                  <select
                    value={form.account_name}
                    onChange={(event) =>
                      setForm({ ...form, account_name: event.target.value })
                    }
                  >
                    <option value="">选择账号</option>
                    {accounts.map((account) => (
                      <option key={account.name} value={account.name}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs">
                  分组
                  <input
                    value={form.group || ""}
                    onChange={(event) =>
                      setForm({ ...form, group: event.target.value })
                    }
                  />
                </label>
              </div>
              <div className="mt-1 flex flex-wrap gap-5 rounded-xl border border-white/5 bg-main/[0.02] px-4 py-3 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.enabled !== false}
                    onChange={(event) =>
                      setForm({ ...form, enabled: event.target.checked })
                    }
                  />
                  启用规则
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.drop_if_running !== false}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        drop_if_running: event.target.checked,
                      })
                    }
                  />
                  运行中忽略重复触发
                </label>
              </div>

              <EditorSection
                title="触发器"
                description="支持收到消息、定时和服务启动触发"
              >
                {form.triggers.map((trigger, index) => (
                  <div
                    key={index}
                    className="rounded-xl border border-white/8 bg-main/[0.02] p-4"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <select
                        className="!m-0 max-w-[220px]"
                        value={trigger.type}
                        onChange={(event) =>
                          updateTrigger(
                            index,
                            defaultTrigger(
                              event.target.value as AutomationTrigger["type"],
                            ),
                          )
                        }
                      >
                        <option value="message">收到消息</option>
                        <option value="timer">定时触发</option>
                        <option value="startup">服务启动</option>
                      </select>
                      <button
                        className="action-btn !text-rose-400"
                        onClick={() =>
                          setForm({
                            ...form,
                            triggers: form.triggers.filter(
                              (_, itemIndex) => itemIndex !== index,
                            ),
                          })
                        }
                        disabled={form.triggers.length <= 1}
                      >
                        <Trash />
                      </button>
                    </div>
                    {trigger.type === "message" && (
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        <label className="text-xs">
                          会话 ID / @用户名（每行一个，留空为全部）
                          <textarea
                            className="min-h-[72px] !mb-0"
                            value={joinReferences(trigger.params.chat_ids)}
                            onChange={(event) =>
                              updateTrigger(index, {
                                ...trigger,
                                params: {
                                  ...trigger.params,
                                  chat_ids: event.target.value as any,
                                },
                              })
                            }
                          />
                        </label>
                        <label className="text-xs">
                          发送者 ID / @用户名（每行一个）
                          <textarea
                            className="min-h-[72px] !mb-0"
                            value={joinReferences(trigger.params.from_user_ids)}
                            onChange={(event) =>
                              updateTrigger(index, {
                                ...trigger,
                                params: {
                                  ...trigger.params,
                                  from_user_ids: event.target.value as any,
                                },
                              })
                            }
                          />
                        </label>
                        <label className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={!!trigger.params.include_outgoing}
                            onChange={(event) =>
                              updateTrigger(index, {
                                ...trigger,
                                params: {
                                  ...trigger.params,
                                  include_outgoing: event.target.checked,
                                },
                              })
                            }
                          />
                          包含自己发送的消息
                        </label>
                        <label className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={!!trigger.params.reply_to_me}
                            onChange={(event) =>
                              updateTrigger(index, {
                                ...trigger,
                                params: {
                                  ...trigger.params,
                                  reply_to_me: event.target.checked,
                                },
                              })
                            }
                          />
                          仅匹配回复我的消息
                        </label>
                      </div>
                    )}
                    {trigger.type === "timer" && (
                      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                        <label className="text-xs">
                          Cron（与间隔二选一）
                          <input
                            value={trigger.params.cron || ""}
                            placeholder="0 8 * * *"
                            onChange={(event) =>
                              updateTrigger(index, {
                                ...trigger,
                                params: {
                                  ...trigger.params,
                                  cron: event.target.value,
                                  interval_seconds: undefined,
                                },
                              })
                            }
                          />
                        </label>
                        <label className="text-xs">
                          间隔秒数
                          <input
                            type="number"
                            min="10"
                            value={trigger.params.interval_seconds || ""}
                            onChange={(event) =>
                              updateTrigger(index, {
                                ...trigger,
                                params: {
                                  ...trigger.params,
                                  interval_seconds: event.target.value
                                    ? Number(event.target.value)
                                    : undefined,
                                  cron: "",
                                },
                              })
                            }
                          />
                        </label>
                        <label className="text-xs">
                          随机延迟秒数
                          <input
                            type="number"
                            min="0"
                            max="3600"
                            value={trigger.params.random_seconds || 0}
                            onChange={(event) =>
                              updateTrigger(index, {
                                ...trigger,
                                params: {
                                  ...trigger.params,
                                  random_seconds: Number(event.target.value),
                                },
                              })
                            }
                          />
                        </label>
                        <label className="text-xs">
                          默认目标会话（可选）
                          <input
                            value={trigger.params.chat_id || ""}
                            placeholder="-100... 或 @username"
                            onChange={(event) =>
                              updateTrigger(index, {
                                ...trigger,
                                params: {
                                  ...trigger.params,
                                  chat_id: event.target.value,
                                },
                              })
                            }
                          />
                        </label>
                      </div>
                    )}
                    {trigger.type === "startup" && (
                      <div className="mt-3">
                        <label className="text-xs">
                          默认目标会话（可选）
                          <input
                            value={trigger.params.chat_id || ""}
                            placeholder="-100... 或 @username"
                            onChange={(event) =>
                              updateTrigger(index, {
                                ...trigger,
                                params: {
                                  ...trigger.params,
                                  chat_id: event.target.value,
                                },
                              })
                            }
                          />
                        </label>
                        <div className="text-xs text-main/45">
                          后端服务启动完成后执行一次。
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                <button
                  className="btn-secondary !text-xs"
                  onClick={() =>
                    setForm({
                      ...form,
                      triggers: [...form.triggers, defaultTrigger()],
                    })
                  }
                >
                  <Plus weight="bold" />
                  添加触发器
                </button>
              </EditorSection>

              <EditorSection
                title="过滤条件"
                description="消息触发器命中后再进行过滤；定时和启动触发不应用这些条件"
              >
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="text-xs">
                    限定会话（每行一个，可选）
                    <textarea
                      className="min-h-[72px] !mb-0"
                      value={joinReferences(form.filters?.chat_ids)}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          filters: {
                            ...(form.filters || {}),
                            chat_ids: event.target.value as any,
                          },
                        })
                      }
                    />
                  </label>
                  <label className="text-xs">
                    限定发送者（每行一个，可选）
                    <textarea
                      className="min-h-[72px] !mb-0"
                      value={joinReferences(form.filters?.from_user_ids)}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          filters: {
                            ...(form.filters || {}),
                            from_user_ids: event.target.value as any,
                          },
                        })
                      }
                    />
                  </label>
                  <label className="text-xs">
                    文本匹配方式
                    <select
                      value={form.filters?.text_rule || "all"}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          filters: {
                            ...(form.filters || {}),
                            text_rule: event.target
                              .value as AutomationFilter["text_rule"],
                          },
                        })
                      }
                    >
                      <option value="all">所有消息</option>
                      <option value="exact">精确匹配</option>
                      <option value="contains">包含</option>
                      <option value="regex">正则表达式</option>
                    </select>
                  </label>
                  <label className="text-xs">
                    匹配内容
                    <input
                      disabled={(form.filters?.text_rule || "all") === "all"}
                      value={form.filters?.text_value || ""}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          filters: {
                            ...(form.filters || {}),
                            text_value: event.target.value,
                          },
                        })
                      }
                    />
                  </label>
                </div>
                <label className="mt-2 flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={form.filters?.ignore_case !== false}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        filters: {
                          ...(form.filters || {}),
                          ignore_case: event.target.checked,
                        },
                      })
                    }
                  />
                  忽略大小写
                </label>
              </EditorSection>

              <EditorSection
                title="动作链"
                description="可使用 {text}、{chat_id}、{message_id}、{sender_id} 和前序动作写入的变量"
              >
                {form.handlers.map((handler, index) => (
                  <div
                    key={index}
                    className="rounded-xl border border-white/8 bg-main/[0.02] p-4"
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/10 text-xs font-bold text-violet-400">
                        {index + 1}
                      </span>
                      <select
                        className="!m-0 max-w-[260px]"
                        value={handler.handler}
                        onChange={(event) =>
                          updateHandler(
                            index,
                            defaultHandler(event.target.value),
                          )
                        }
                      >
                        {handlerOptions.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <div className="ml-auto flex gap-1">
                        <button
                          className="action-btn !h-8 !w-8"
                          onClick={() => moveHandler(index, -1)}
                          disabled={index === 0}
                        >
                          <CaretUp />
                        </button>
                        <button
                          className="action-btn !h-8 !w-8"
                          onClick={() => moveHandler(index, 1)}
                          disabled={index === form.handlers.length - 1}
                        >
                          <CaretDown />
                        </button>
                        <button
                          className="action-btn !h-8 !w-8 !text-rose-400"
                          onClick={() =>
                            setForm({
                              ...form,
                              handlers: form.handlers.filter(
                                (_, itemIndex) => itemIndex !== index,
                              ),
                            })
                          }
                          disabled={form.handlers.length <= 1}
                        >
                          <Trash />
                        </button>
                      </div>
                    </div>
                    <HandlerFields
                      handler={handler}
                      onChange={(next) => updateHandler(index, next)}
                    />
                  </div>
                ))}
                <button
                  className="btn-secondary !text-xs"
                  onClick={() =>
                    setForm({
                      ...form,
                      handlers: [...form.handlers, defaultHandler()],
                    })
                  }
                >
                  <Plus weight="bold" />
                  添加动作
                </button>
              </EditorSection>

              <EditorSection
                title="初始变量"
                description="JSON 对象，可在动作模板中通过 {变量名} 使用；持久状态会覆盖同名初始变量"
              >
                <textarea
                  className="min-h-[120px] font-mono text-xs"
                  value={varsText}
                  onChange={(event) => setVarsText(event.target.value)}
                  spellCheck={false}
                />
              </EditorSection>
            </div>
            <div className="flex justify-end gap-2 border-t border-white/5 px-6 py-4">
              <button
                className="btn-secondary"
                onClick={() => setEditorOpen(false)}
              >
                取消
              </button>
              <button className="btn-gradient" onClick={save} disabled={saving}>
                {saving ? (
                  <Spinner className="animate-spin" />
                ) : (
                  <FloppyDisk weight="bold" />
                )}
                {form.id ? "保存修改" : "创建规则"}
              </button>
            </div>
          </div>
        </div>
      )}

      {detailRule && (
        <div className="modal-overlay active">
          <div className="modal-content !max-w-[900px] !p-0 overflow-hidden">
            <div className="modal-header !mb-0 border-b border-white/5 px-6 py-4">
              <div>
                <div className="modal-title">{detailRule.name}</div>
                <div className="mt-1 text-xs text-main/40">
                  运行状态、持久变量与最近日志
                </div>
              </div>
              <button
                className="action-btn"
                onClick={() => setDetailRule(null)}
              >
                <X weight="bold" />
              </button>
            </div>
            <div className="custom-scrollbar max-h-[70vh] overflow-y-auto p-6">
              {detailLoading ? (
                <div className="flex justify-center py-16">
                  <Spinner className="animate-spin" size={28} />
                </div>
              ) : (
                <div className="space-y-5">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <StatusTile
                      label="规则状态"
                      value={detailStatus?.enabled ? "已启用" : "已停用"}
                    />
                    <StatusTile
                      label="消息监听"
                      value={
                        detailStatus?.listener_active ? "运行中" : "未启用"
                      }
                    />
                    <StatusTile
                      label="当前执行"
                      value={detailStatus?.running ? "执行中" : "空闲"}
                    />
                  </div>
                  <div className="rounded-xl border border-white/5 bg-main/[0.02] p-4">
                    <div className="mb-2 text-sm font-bold">持久状态</div>
                    <pre className="custom-scrollbar overflow-x-auto whitespace-pre-wrap text-xs text-main/60">
                      {JSON.stringify(detailState, null, 2)}
                    </pre>
                  </div>
                  <div className="rounded-xl border border-white/5 bg-main/[0.02] overflow-hidden">
                    <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
                      <div className="text-sm font-bold">运行日志</div>
                      <button
                        className="action-btn !h-8 !w-8"
                        onClick={() => openDetails(detailRule)}
                      >
                        <ArrowClockwise />
                      </button>
                    </div>
                    <div className="custom-scrollbar max-h-[340px] overflow-y-auto">
                      {detailLogs.length ? (
                        detailLogs.map((log, index) => (
                          <div
                            key={`${log.time}-${index}`}
                            className="grid grid-cols-[150px_70px_minmax(0,1fr)] gap-3 border-b border-white/5 px-4 py-2.5 text-xs"
                          >
                            <span className="font-mono text-main/35">
                              {formatConfiguredDateTime(log.time, timezone)}
                            </span>
                            <span
                              className={
                                log.level === "error"
                                  ? "text-rose-400"
                                  : log.level === "success"
                                    ? "text-emerald-400"
                                    : "text-cyan-400"
                              }
                            >
                              {log.level}
                            </span>
                            <span className="break-words text-main/65">
                              {log.message}
                            </span>
                          </div>
                        ))
                      ) : (
                        <div className="py-12 text-center text-sm text-main/35">
                          暂无运行日志
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </div>
  );
}

function EditorSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6 space-y-3">
      <div>
        <h3 className="font-bold">{title}</h3>
        <p className="mt-1 text-xs text-main/40">{description}</p>
      </div>
      {children}
    </section>
  );
}

function StatusTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/5 bg-main/[0.02] p-4">
      <div className="text-[11px] text-main/40">{label}</div>
      <div className="mt-1 font-bold">{value}</div>
    </div>
  );
}

function HandlerFields({
  handler,
  onChange,
}: {
  handler: AutomationHandler;
  onChange: (next: AutomationHandler) => void;
}) {
  const params = handler.params;
  const set = (patch: Record<string, any>) =>
    onChange({ ...handler, params: { ...params, ...patch } });
  const wrap = (children: React.ReactNode) => (
    <div className="mt-3 grid gap-3 md:grid-cols-2">{children}</div>
  );
  switch (handler.handler) {
    case "send_text":
    case "reply_text":
      return wrap(
        <>
          <label className="text-xs">
            目标会话（回复消息可留空）
            <input
              value={params.chat_id || ""}
              placeholder="{chat_id} 或 @username"
              onChange={(event) => set({ chat_id: event.target.value })}
            />
          </label>
          <label className="text-xs">
            发送后删除秒数（可选）
            <input
              type="number"
              min="0"
              value={params.delete_after ?? ""}
              onChange={(event) =>
                set({
                  delete_after:
                    event.target.value === ""
                      ? undefined
                      : Number(event.target.value),
                })
              }
            />
          </label>
          <label className="text-xs md:col-span-2">
            文本内容
            <textarea
              className="min-h-[80px] !mb-0"
              value={params.text || ""}
              onChange={(event) => set({ text: event.target.value })}
            />
          </label>
        </>,
      );
    case "extract_regex":
      return wrap(
        <>
          <label className="text-xs">
            正则表达式
            <input
              value={params.pattern || ""}
              onChange={(event) => set({ pattern: event.target.value })}
            />
          </label>
          <label className="text-xs">
            写入变量
            <input
              value={params.var || "extracted"}
              onChange={(event) => set({ var: event.target.value })}
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={params.required !== false}
              onChange={(event) => set({ required: event.target.checked })}
            />
            未匹配时终止动作链
          </label>
        </>,
      );
    case "ai_reply":
      return wrap(
        <>
          <label className="text-xs md:col-span-2">
            系统提示词
            <textarea
              className="min-h-[80px] !mb-0"
              value={params.prompt || ""}
              onChange={(event) => set({ prompt: event.target.value })}
            />
          </label>
          <label className="text-xs">
            用户输入模板
            <input
              value={params.query || "{text}"}
              onChange={(event) => set({ query: event.target.value })}
            />
          </label>
          <label className="text-xs">
            目标会话（可留空）
            <input
              value={params.chat_id || ""}
              onChange={(event) => set({ chat_id: event.target.value })}
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={params.send !== false}
              onChange={(event) => set({ send: event.target.checked })}
            />
            生成后发送
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={params.reply !== false}
              onChange={(event) => set({ reply: event.target.checked })}
            />
            回复触发消息
          </label>
        </>,
      );
    case "blacklist_filter":
      return wrap(
        <label className="text-xs md:col-span-2">
          黑名单关键词（每行一个）
          <textarea
            className="min-h-[80px] !mb-0"
            value={joinReferences(params.values)}
            onChange={(event) => set({ values: event.target.value })}
          />
        </label>,
      );
    case "delay":
      return wrap(
        <label className="text-xs">
          延迟秒数（最多 300 秒）
          <input
            type="number"
            min="0"
            max="300"
            step="0.1"
            value={params.seconds ?? 1}
            onChange={(event) => set({ seconds: Number(event.target.value) })}
          />
        </label>,
      );
    case "forward":
      return wrap(
        <label className="text-xs">
          转发到会话
          <input
            value={params.to_chat_id || ""}
            placeholder="-100... 或 @username"
            onChange={(event) => set({ to_chat_id: event.target.value })}
          />
        </label>,
      );
    case "http_callback":
      return wrap(
        <>
          <label className="text-xs">
            公网 HTTPS 地址
            <input
              value={params.url || ""}
              onChange={(event) => set({ url: event.target.value })}
            />
          </label>
          <label className="text-xs">
            方法
            <select
              value={params.method || "post"}
              onChange={(event) => set({ method: event.target.value })}
            >
              <option value="post">POST</option>
              <option value="put">PUT</option>
              <option value="patch">PATCH</option>
            </select>
          </label>
          <label className="text-xs md:col-span-2">
            JSON 请求体模板
            <textarea
              className="min-h-[90px] font-mono text-xs"
              value={
                typeof params.payload === "string"
                  ? params.payload
                  : JSON.stringify(params.payload || {}, null, 2)
              }
              onChange={(event) => set({ payload: event.target.value })}
            />
          </label>
        </>,
      );
    case "external_forward": {
      const target = params.targets?.[0] || {
        type: "http",
        url: "",
        method: "post",
      };
      const setTarget = (patch: Record<string, any>) =>
        set({ targets: [{ ...target, ...patch }] });
      return wrap(
        <>
          <label className="text-xs">
            公网 HTTPS 地址
            <input
              value={target.url || ""}
              onChange={(event) => setTarget({ url: event.target.value })}
            />
          </label>
          <label className="text-xs">
            方法
            <select
              value={target.method || "post"}
              onChange={(event) => setTarget({ method: event.target.value })}
            >
              <option value="post">POST</option>
              <option value="put">PUT</option>
              <option value="patch">PATCH</option>
            </select>
          </label>
        </>,
      );
    }
    case "server_chan":
      return wrap(
        <>
          <label className="text-xs">
            SendKey
            <input
              type="password"
              value={params.send_key || ""}
              onChange={(event) => set({ send_key: event.target.value })}
            />
          </label>
          <label className="text-xs">
            标题
            <input
              value={params.title || "Automation"}
              onChange={(event) => set({ title: event.target.value })}
            />
          </label>
          <label className="text-xs md:col-span-2">
            正文
            <textarea
              className="min-h-[70px] !mb-0"
              value={params.body || "{text}"}
              onChange={(event) => set({ body: event.target.value })}
            />
          </label>
        </>,
      );
    case "schedule_next":
      return wrap(
        <>
          <label className="text-xs">
            基础延迟秒数
            <input
              type="number"
              min="1"
              value={params.delay_seconds ?? 300}
              onChange={(event) =>
                set({ delay_seconds: Number(event.target.value) })
              }
            />
          </label>
          <label className="text-xs">
            从变量读取（可选）
            <input
              value={params.from_var || ""}
              onChange={(event) => set({ from_var: event.target.value })}
            />
          </label>
          <label className="text-xs">
            变量单位
            <select
              value={params.from_var_unit || "seconds"}
              onChange={(event) => set({ from_var_unit: event.target.value })}
            >
              <option value="seconds">秒</option>
              <option value="minutes">分钟</option>
            </select>
          </label>
          <label className="text-xs">
            额外偏移秒数
            <input
              type="number"
              min="0"
              value={params.offset_seconds ?? 0}
              onChange={(event) =>
                set({ offset_seconds: Number(event.target.value) })
              }
            />
          </label>
          <label className="text-xs md:col-span-2">
            目标触发器 ID（留空为当前或首个定时触发器）
            <input
              value={params.target_trigger_id || ""}
              onChange={(event) =>
                set({ target_trigger_id: event.target.value })
              }
            />
          </label>
        </>,
      );
    case "store_state":
      return wrap(
        <>
          <label className="text-xs">
            状态键
            <input
              value={params.key || ""}
              onChange={(event) => set({ key: event.target.value })}
            />
          </label>
          <label className="text-xs">
            来源变量
            <input
              value={params.from_var || ""}
              onChange={(event) => set({ from_var: event.target.value })}
            />
          </label>
        </>,
      );
    case "load_state":
      return wrap(
        <>
          <label className="text-xs">
            状态键
            <input
              value={params.key || ""}
              onChange={(event) => set({ key: event.target.value })}
            />
          </label>
          <label className="text-xs">
            写入变量
            <input
              value={params.var || ""}
              onChange={(event) => set({ var: event.target.value })}
            />
          </label>
          <label className="text-xs">
            默认值
            <input
              value={params.default || ""}
              onChange={(event) => set({ default: event.target.value })}
            />
          </label>
        </>,
      );
    case "random_pick":
      return wrap(
        <>
          <label className="text-xs">
            候选项（每行一个）
            <textarea
              className="min-h-[80px] !mb-0"
              value={joinReferences(params.items)}
              onChange={(event) => set({ items: event.target.value })}
            />
          </label>
          <label className="text-xs">
            写入变量
            <input
              value={params.var || "picked"}
              onChange={(event) => set({ var: event.target.value })}
            />
          </label>
        </>,
      );
    default:
      return (
        <div className="mt-3 text-xs text-main/40">该动作暂无可视化配置。</div>
      );
  }
}
