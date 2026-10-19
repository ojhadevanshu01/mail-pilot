import { Icon, type IconName } from "./Icon";
import { BRAND } from "../lib/utils";
import { TABS, isStatusTab, type Stats, type Tab } from "../lib/types";

const NAV_META: Record<Tab, { label: string; icon: IconName }> = {
  compose: { label: "Compose email", icon: "pen" },
  scheduled: { label: "Scheduled emails", icon: "clock" },
  sent: { label: "Sent emails", icon: "check" },
  failed: { label: "Failed emails", icon: "alert" },
  cancelled: { label: "Cancelled emails", icon: "x" },
  lists: { label: "Mailing lists", icon: "list" },
  groups: { label: "Groups", icon: "clock" },
  gmail: { label: "Gmail Accounts", icon: "mail" },
};

export function Sidebar({
  tab,
  stats,
  onChange,
}: {
  tab: Tab;
  stats: Stats;
  onChange: (tab: Tab) => void;
}) {
  return (
    <aside className="sticky top-0 hidden h-screen w-[260px] shrink-0 flex-col bg-[var(--sidebar)] px-4 py-6 text-white md:flex">
      <div className="mb-8 flex items-center gap-3 px-2">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-400 to-violet-600 shadow-lg shadow-indigo-950/30">
          <Icon name="send" className="size-5 text-white" />
        </div>

        <div className="min-w-0">
          <h1 className="truncate text-lg font-bold tracking-tight text-white">
            {BRAND}
          </h1>
          <p className="mt-0.5 text-xs text-[var(--sidebar-muted)]">
            Email workspace
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={() => onChange("compose")}
        className="mb-8 flex min-h-12 items-center justify-center gap-2 rounded-xl bg-indigo-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-950/20 transition hover:bg-indigo-400 focus-visible:ring-indigo-300"
      >
        <Icon name="plus" />
        Compose new email
      </button>

      <div className="mb-3 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--sidebar-muted)]">
        Workspace
      </div>

      <nav className="space-y-1" aria-label="Workspace navigation">
        {TABS.map((item) => {
          const active = tab === item;
          const meta = NAV_META[item];

          return (
            <button
              key={item}
              type="button"
              onClick={() => onChange(item)}
              aria-current={active ? "page" : undefined}
              className={`group flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-medium transition ${
                active
                  ? "bg-[var(--sidebar-active)] text-white shadow-sm"
                  : "text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] hover:text-white"
              }`}
            >
              <span
                className={`flex size-8 shrink-0 items-center justify-center rounded-lg transition ${
                  active
                    ? "bg-indigo-500/20 text-indigo-300"
                    : "text-[var(--sidebar-muted)] group-hover:text-white"
                }`}
              >
                <Icon name={meta.icon} />
              </span>

              <span className="min-w-0 flex-1 truncate">{meta.label}</span>

              {isStatusTab(item) && (
                <span
                  className={`min-w-7 rounded-md px-1.5 py-0.5 text-center text-xs tabular-nums ${
                    active
                      ? "bg-indigo-400/20 text-indigo-200"
                      : "bg-white/5 text-[var(--sidebar-muted)]"
                  }`}
                >
                  {stats[item].toLocaleString()}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto rounded-xl border border-white/10 bg-white/[0.03] p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="size-2 rounded-full bg-emerald-400" />
          <span className="text-xs font-semibold text-slate-200">
            Workspace ready
          </span>
        </div>
        <p className="text-xs leading-5 text-[var(--sidebar-muted)]">
          Manage your email schedules, recipient lists, and sending history.
        </p>
      </div>

      <div className="px-2 pt-5 text-[10px] text-[var(--sidebar-muted)]">
        {BRAND} Â· Email scheduler
      </div>
    </aside>
  );
}

export function MobileTabs({
  tab,
  onChange,
}: {
  tab: Tab;
  onChange: (tab: Tab) => void;
}) {
  return (
    <nav
      className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 shadow-sm md:hidden"
      aria-label="Mobile workspace navigation"
    >
      {TABS.map((item) => {
        const active = tab === item;
        const meta = NAV_META[item];

        return (
          <button
            key={item}
            type="button"
            onClick={() => onChange(item)}
            aria-current={active ? "page" : undefined}
            aria-label={meta.label}
            title={meta.label}
            className={`flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${
              active
                ? "bg-indigo-600 text-white shadow-sm"
                : "text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
            }`}
          >
            <Icon name={meta.icon} />
            <span className="hidden sm:inline">{meta.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
