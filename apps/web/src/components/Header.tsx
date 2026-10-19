import { Icon } from "./Icon";
import type { Tab } from "../lib/types";
import type { Theme } from "../hooks/useTheme";

const PAGE_META: Record<Tab, { title: string; description: string }> = {
  compose: {
    title: "Compose email",
    description: "Create a message, choose recipients, and schedule delivery.",
  },
  scheduled: {
    title: "Scheduled emails",
    description: "Review upcoming messages and manage pending deliveries.",
  },
  sent: {
    title: "Sent emails",
    description: "Review messages accepted by your configured sending transport.",
  },
  failed: {
    title: "Failed emails",
    description: "Inspect failed messages and review their reported errors.",
  },
  cancelled: {
    title: "Cancelled emails",
    description: "Review messages cancelled before they were sent.",
  },
  lists: {
    title: "Mailing lists",
    description: "Manage reusable recipient lists and imported contacts.",
  },
  groups: {
    title: "Groups",
    description: "Manage recipient groups and their email scheduling history.",
  },
  gmail: {
    title: "Gmail Accounts",
    description: "Connect, test, and manage the Gmail accounts MailPilot sends from.",
  },
};

export function Header({
  tab,
  theme,
  themeReady,
  onRefresh,
  onToggleTheme,
}: {
  tab: Tab;
  theme: Theme;
  themeReady: boolean;
  onRefresh: () => void;
  onToggleTheme: () => void;
}) {
  const page = PAGE_META[tab];

  return (
    <header className="mb-7 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[var(--muted)]">
          <span>WORKSPACE</span>
          <span className="text-[var(--border)]">/</span>
          <span className="text-[var(--accent)]">{page.title}</span>
        </div>

        <h2 className="text-2xl font-bold tracking-tight text-[var(--foreground)] sm:text-3xl">
          {page.title}
        </h2>

        <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--muted)]">
          {page.description}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-medium text-[var(--foreground)] shadow-sm hover:border-[var(--accent)] hover:bg-[var(--surface-muted)] focus-visible:ring-[var(--accent)]"
        >
          <Icon name="refresh" />
          <span>Refresh</span>
        </button>

        <button
          type="button"
          onClick={onToggleTheme}
          disabled={!themeReady}
          className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] shadow-sm hover:bg-[var(--surface-muted)] focus-visible:ring-[var(--accent)]"
          aria-label={
            theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
          }
          title={
            theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
          }
        >
          <Icon name={themeReady && theme === "dark" ? "sun" : "moon"} />
        </button>
      </div>
    </header>
  );
}
