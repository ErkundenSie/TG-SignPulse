"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import {
  ChatCircleText,
  CaretDown,
  Cpu,
  DownloadSimple,
  Gear,
  GithubLogo,
  House,
  ListChecks,
  PaperPlaneTilt,
  Robot as BotIcon,
  ShieldCheck,
  SignOut,
  SignIn,
  Terminal,
  UsersThree,
  UserList,
  X,
  List,
  Lightning,
  UserCircle,
} from "@phosphor-icons/react";
import { ThemeLanguageToggle } from "../../components/ThemeLanguageToggle";
import { useLanguage } from "../../context/LanguageContext";
import { getToken, logout } from "../../lib/auth";
import { getMe } from "../../lib/api";
import type { CurrentUser } from "../../lib/types";

const navGroups = [
  {
    label: { zh: "工作台", en: "Workspace" },
    items: [
      {
        href: "/dashboard",
        label: { zh: "账号概览", en: "Accounts" },
        icon: House,
        exact: true,
      },
      {
        href: "/dashboard/sign-tasks",
        label: { zh: "签到任务", en: "Sign Tasks" },
        icon: ListChecks,
      },
    ],
  },
  {
    label: { zh: "消息自动化", en: "Message Automation" },
    items: [
      {
        href: "/dashboard/automation-rules",
        label: { zh: "自动化规则", en: "Automation Rules" },
        icon: BotIcon,
      },
      {
        href: "/dashboard/monitors",
        label: { zh: "关键词监控", en: "Keyword Monitor" },
        icon: ChatCircleText,
      },
    ],
  },
  {
    label: { zh: "群组/频道工具", en: "Group / Channel Tools" },
    items: [
      {
        href: "/dashboard/broadcast",
        label: { zh: "消息群发", en: "Broadcast" },
        icon: PaperPlaneTilt,
      },
      {
        href: "/dashboard/bulk-groups",
        label: { zh: "批量加入/退出", en: "Bulk Join / Leave" },
        icon: SignIn,
      },
    ],
  },
  {
    label: { zh: "成员采集", en: "Member Collection" },
    items: [
      {
        href: "/dashboard/member-export",
        label: { zh: "成员导出", en: "Member Export" },
        icon: UsersThree,
      },
      {
        href: "/dashboard/speaker-collection",
        label: { zh: "群发言者筛选", en: "Speaker Filter" },
        icon: UserList,
      },
    ],
  },
  {
    label: { zh: "系统", en: "System" },
    items: [
      {
        href: "/dashboard/settings",
        label: { zh: "系统设置", en: "Settings" },
        icon: Gear,
        children: [
          {
            href: "/dashboard/settings?section=account",
            section: "account",
            label: { zh: "账户安全", en: "Account Security" },
            icon: ShieldCheck,
          },
          {
            href: "/dashboard/settings?section=global",
            section: "global",
            label: { zh: "全局设置", en: "Global Settings" },
            icon: Gear,
          },
          {
            href: "/dashboard/settings?section=notify",
            section: "notify",
            label: { zh: "Bot 通知", en: "Bot Notify" },
            icon: BotIcon,
          },
          {
            href: "/dashboard/settings?section=ai",
            section: "ai",
            label: { zh: "AI 配置", en: "AI Config" },
            icon: BotIcon,
          },
          {
            href: "/dashboard/settings?section=telegram",
            section: "telegram",
            label: { zh: "Telegram API", en: "Telegram API" },
            icon: Cpu,
          },
          {
            href: "/dashboard/settings?section=logs",
            section: "logs",
            label: { zh: "系统日志", en: "System Logs" },
            icon: Terminal,
          },
          {
            href: "/dashboard/settings?section=backup",
            section: "backup",
            label: { zh: "备份迁移", en: "Backup" },
            icon: DownloadSimple,
          },
        ],
      },
    ],
  },
];

function navItemClass(active: boolean, nested = false) {
  const base = nested
    ? "sidebar-nav-item sidebar-nav-item-nested"
    : "sidebar-nav-item";
  return `${base}${active ? " is-active" : ""}`;
}

function DashboardSidebar({
  mobileOpen,
  setMobileOpen,
}: {
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { language } = useLanguage();
  const text = (label: { zh: string; en: string }) => label[language];
  const settingsSection = searchParams.get("section") || "account";
  const onSettings = pathname.startsWith("/dashboard/settings");
  const [settingsOpen, setSettingsOpen] = useState(onSettings);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [identityLoadFailed, setIdentityLoadFailed] = useState(false);

  useEffect(() => {
    if (onSettings) setSettingsOpen(true);
  }, [onSettings]);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    getMe(token)
      .then((user) => {
        setCurrentUser(user);
        setIdentityLoadFailed(false);
      })
      .catch(() => setIdentityLoadFailed(true));
  }, []);

  const groups = [
    ...navGroups,
    ...(currentUser?.is_admin
      ? [
          {
            label: { zh: "管理", en: "Administration" },
            items: [
              {
                href: "/dashboard/admin/users",
                label: { zh: "用户管理", en: "User Management" },
                description: { zh: "单管理员模式", en: "Single administrator" },
                icon: UserList,
              },
            ],
          },
        ]
      : []),
  ];

  return (
    <aside className={`sidebar-shell${mobileOpen ? " is-open" : ""}`}>
      <div className="sidebar-brand">
        <Link
          href="/dashboard"
          className="sidebar-brand-home"
          aria-label={
            language === "zh" ? "返回账户概览" : "Go to account overview"
          }
          onClick={() => setMobileOpen(false)}
        >
          <div className="sidebar-brand-mark" aria-hidden>
            <Lightning weight="fill" size={18} />
          </div>
          <div className="sidebar-brand-text">
            <div className="sidebar-brand-title">TG-FlowPulse</div>
            <div className="sidebar-brand-subtitle">Control Center</div>
          </div>
        </Link>
        <button
          type="button"
          className="sidebar-icon-btn lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-label={language === "zh" ? "关闭" : "Close"}
        >
          <X weight="bold" size={16} />
        </button>
      </div>

      <nav className="sidebar-nav">
        {groups.map((group) => (
          <div className="sidebar-group" key={group.label.zh}>
            <div className="sidebar-group-label">{text(group.label)}</div>
            <div className="sidebar-group-items">
              {group.items.map((item) => {
                const active = item.exact
                  ? pathname === item.href
                  : pathname.startsWith(item.href);
                const Icon = item.icon;
                const children = "children" in item ? item.children : undefined;

                if (children?.length) {
                  const expanded = settingsOpen || onSettings;
                  return (
                    <div
                      key={item.href}
                      className={`sidebar-tree${expanded ? " is-expanded" : ""}`}
                    >
                      <button
                        type="button"
                        className={navItemClass(active)}
                        onClick={() => setSettingsOpen((open) => !open)}
                        aria-expanded={expanded}
                      >
                        <Icon
                          weight={active ? "fill" : "duotone"}
                          size={18}
                          className="sidebar-nav-icon"
                        />
                        <span className="sidebar-nav-text">
                          {text(item.label)}
                        </span>
                        <CaretDown
                          weight="bold"
                          size={12}
                          className={`sidebar-caret${expanded ? " is-open" : ""}`}
                        />
                      </button>
                      {expanded && (
                        <div className="sidebar-subnav">
                          {children.map((child) => {
                            const childActive =
                              onSettings && settingsSection === child.section;
                            const ChildIcon = child.icon;
                            return (
                              <Link
                                href={child.href}
                                key={child.href}
                                className={navItemClass(childActive, true)}
                                onClick={() => setMobileOpen(false)}
                              >
                                <ChildIcon
                                  weight={childActive ? "fill" : "duotone"}
                                  size={16}
                                  className="sidebar-nav-icon"
                                />
                                <span className="sidebar-nav-text">
                                  {text(child.label)}
                                </span>
                              </Link>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }

                return (
                  <Link
                    href={item.href}
                    key={item.href}
                    className={`${navItemClass(active)}${"description" in item ? " has-description" : ""}`}
                    onClick={() => setMobileOpen(false)}
                  >
                    <Icon
                      weight={active ? "fill" : "duotone"}
                      size={18}
                      className="sidebar-nav-icon"
                    />
                    <span className="sidebar-nav-text">
                      <span>{text(item.label)}</span>
                      {"description" in item && (
                        <span className="sidebar-nav-description">
                          {text(item.description)}
                        </span>
                      )}
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-footer-tools">
          <ThemeLanguageToggle />
          <a
            href="https://github.com/ErkundenSie/TG-FlowPulse"
            target="_blank"
            rel="noopener noreferrer"
            className="sidebar-project-link"
            title={language === "zh" ? "GitHub 项目地址" : "GitHub repository"}
            aria-label={
              language === "zh"
                ? "打开 GitHub 项目地址"
                : "Open GitHub repository"
            }
          >
            <GithubLogo weight="bold" size={18} />
          </a>
        </div>
        <div className="sidebar-user">
          <div className="sidebar-user-avatar" aria-hidden>
            <UserCircle weight="fill" size={22} />
          </div>
          <div className="sidebar-user-meta">
            <div className="sidebar-user-name">
              {currentUser?.username ||
                (identityLoadFailed
                  ? language === "zh"
                    ? "身份加载失败"
                    : "Identity unavailable"
                  : language === "zh"
                    ? "加载中"
                    : "Loading")}
            </div>
            <div className="sidebar-user-role">
              {!currentUser
                ? identityLoadFailed
                  ? language === "zh"
                    ? "请重新登录"
                    : "Please sign in again"
                  : language === "zh"
                    ? "正在验证"
                    : "Verifying"
                : currentUser.is_admin
                  ? language === "zh"
                    ? "管理员"
                    : "Administrator"
                  : language === "zh"
                    ? "普通用户"
                    : "User"}
            </div>
          </div>
          <button
            type="button"
            className="sidebar-logout-btn"
            onClick={logout}
            title={language === "zh" ? "退出登录" : "Sign out"}
            aria-label={language === "zh" ? "退出登录" : "Sign out"}
          >
            <SignOut weight="bold" size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { language } = useLanguage();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  return (
    <div className="app-shell">
      <button
        type="button"
        className="sidebar-mobile-trigger"
        onClick={() => setMobileOpen(true)}
        aria-label={language === "zh" ? "打开导航" : "Open navigation"}
      >
        <List weight="bold" size={20} />
      </button>

      {mobileOpen && (
        <button
          type="button"
          className="sidebar-backdrop"
          onClick={() => setMobileOpen(false)}
          aria-label={language === "zh" ? "关闭导航" : "Close navigation"}
        />
      )}

      <Suspense fallback={null}>
        <DashboardSidebar
          mobileOpen={mobileOpen}
          setMobileOpen={setMobileOpen}
        />
      </Suspense>

      <main className="app-main">
        <div className="app-main-glow" aria-hidden />
        <div className="app-main-content">{children}</div>
      </main>
    </div>
  );
}
