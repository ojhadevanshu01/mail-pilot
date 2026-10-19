import { Icon, type IconName } from "./Icon";
import type { Stats, Tab } from "../lib/types";

export function StatsCards({
  stats,
  onSelect,
}: {
  stats: Stats;
  onSelect: (tab: Tab) => void;
}) {
  const total =
    stats.scheduled + stats.sent + stats.failed + stats.cancelled;

  const cards: {
    label: string;
    value: number;
    icon: IconName;
    iconColor: string;
    iconBackground: string;
    target?: Tab;
    description: string;
  }[] = [
    {
      label: "Total emails",
      value: total,
      icon: "mail",
      iconColor: "text-slate-600",
      iconBackground: "bg-slate-100",
      description: "Across all statuses",
    },
    {
      label: "Scheduled",
      value: stats.scheduled,
      icon: "clock",
      iconColor: "text-indigo-600",
      iconBackground: "bg-indigo-50",
      target: "scheduled",
      description: "Waiting to be sent",
    },
    {
      label: "Sent",
      value: stats.sent,
      icon: "check",
      iconColor: "text-emerald-600",
      iconBackground: "bg-emerald-50",
      target: "sent",
      description: "Accepted by transport",
    },
    {
      label: "Failed",
      value: stats.failed,
      icon: "alert",
      iconColor: "text-rose-600",
      iconBackground: "bg-rose-50",
      target: "failed",
      description: "Need review",
    },
    {
      label: "Cancelled",
      value: stats.cancelled,
      icon: "x",
      iconColor: "text-amber-600",
      iconBackground: "bg-amber-50",
      target: "cancelled",
      description: "Stopped before sending",
    },
  ];

  const cardClass =
    "flex min-h-[150px] w-full flex-col justify-between rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-left shadow-sm transition hover:shadow-md";

  return (
    <section className="mb-8" aria-label="Email statistics">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--foreground)]">
            Email overview
          </h3>
          <p className="mt-1 text-xs text-[var(--muted)]">
            A quick look at your email activity
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {cards.map((card) => {
          const content = (
            <>
              <div className="flex items-start justify-between gap-3">
                <span className="text-sm font-medium text-[var(--muted)]">
                  {card.label}
                </span>

                <span
                  className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${card.iconBackground} ${card.iconColor}`}
                >
                  <Icon name={card.icon} />
                </span>
              </div>

              <div className="mt-5">
                <div className="text-3xl font-bold tracking-tight tabular-nums text-[var(--foreground)]">
                  {card.value.toLocaleString()}
                </div>
                <p className="mt-1.5 text-xs text-[var(--muted)]">
                  {card.description}
                </p>
              </div>
            </>
          );

          return card.target ? (
            <button
              key={card.label}
              type="button"
              onClick={() => onSelect(card.target!)}
              aria-label={`View ${card.label.toLowerCase()} emails`}
              className={`${cardClass} hover:-translate-y-0.5 hover:border-indigo-200 focus-visible:ring-[var(--accent)]`}
            >
              {content}
            </button>
          ) : (
            <div key={card.label} className={cardClass}>
              {content}
            </div>
          );
        })}
      </div>
    </section>
  );
}
