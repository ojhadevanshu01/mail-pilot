import { Icon } from "./Icon";
import { StatusBadge } from "./StatusBadge";
import { inputClass } from "../lib/ui";
import { prettyDate } from "../lib/utils";
import type { Email, Tab } from "../lib/types";

export function EmailList({
  tab,
  emails,
  query,
  onQueryChange,
  searching,
  refreshing,
  initialLoading,
  listError,
  onRetry,
  onCompose,
  onCancel,
  cancellingId,
}: {
  tab: Tab;
  emails: Email[];
  query: string;
  onQueryChange: (q: string) => void;
  searching: boolean;
  refreshing: boolean;
  initialLoading: boolean;
  listError: string;
  onRetry: () => void;
  onCompose: () => void;
  onCancel?: (id: string) => void;
  cancellingId?: string | null;
}) {
  const showActions = tab === "scheduled" && !!onCancel;
  const columns = showActions ? 5 : 4;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm [.dark_&]:border-slate-800 [.dark_&]:bg-slate-900">
      <div className="flex flex-col gap-4 border-b border-slate-200/80 p-5 [.dark_&]:border-slate-800 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <p className="flex items-center gap-2 text-sm text-slate-500 [.dark_&]:text-slate-400">
          <span className="tabular-nums">{emails.length} records</span>
          {searching && (
            <span className="inline-flex items-center gap-1.5 text-indigo-600 [.dark_&]:text-indigo-400">
              <span className="h-3 w-3 rounded-full border-2 border-indigo-200 border-t-indigo-600 motion-safe:animate-spin [.dark_&]:border-indigo-900 [.dark_&]:border-t-indigo-400" />
              Updating
            </span>
          )}
        </p>
        <div className="relative sm:w-80">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 [.dark_&]:text-slate-500">
            <Icon name="search" />
          </span>
          <input
            className={`${inputClass} !pl-10`}
            placeholder="Search by recipient or subject"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            aria-label="Search emails"
          />
        </div>
      </div>

      {listError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b border-rose-200 bg-rose-50 px-5 py-3 text-sm text-rose-800 [.dark_&]:border-rose-500/25 [.dark_&]:bg-rose-500/10 [.dark_&]:text-rose-300"
        >
          <span>{listError}</span>
          <button onClick={onRetry} className="font-semibold underline">
            Retry
          </button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50/80 text-xs uppercase tracking-wider text-slate-500 [.dark_&]:border-slate-800 [.dark_&]:bg-slate-950/50 [.dark_&]:text-slate-400">
            <tr>
              <th className="px-5 py-3 font-medium">Recipient</th>
              <th className="px-5 py-3 font-medium">Subject</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">Time</th>
              {showActions && <th className="px-5 py-3 text-right font-medium">Action</th>}
            </tr>
          </thead>
          <tbody
            className={`divide-y divide-slate-100 transition-opacity duration-200 [.dark_&]:divide-slate-800 ${
              refreshing ? "opacity-70" : "opacity-100"
            }`}
          >
            {initialLoading && !emails.length ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="motion-safe:animate-pulse">
                  {Array.from({ length: columns }).map((__, j) => (
                    <td key={j} className="px-5 py-4">
                      <div className="h-4 rounded bg-slate-100 [.dark_&]:bg-slate-800" />
                    </td>
                  ))}
                </tr>
              ))
            ) : emails.length ? (
              emails.map((email) => (
                <tr
                  key={email.id}
                  className="transition-colors duration-150 hover:bg-indigo-50/40 [.dark_&]:hover:bg-indigo-400/5"
                >
                  <td className="px-5 py-3.5 font-medium">
                    {email.recipient}
                    {email.errorMessage && (
                      <p
                        className="mt-1 max-w-xs truncate text-xs font-normal text-rose-600 [.dark_&]:text-rose-400"
                        title={email.errorMessage}
                      >
                        {email.errorMessage}
                      </p>
                    )}
                  </td>
                  <td className="max-w-xs truncate px-5 py-3.5 text-slate-600 [.dark_&]:text-slate-300">
                    {email.subject}
                  </td>
                  <td className="px-5 py-3.5">
                    <StatusBadge status={email.status} />
                  </td>
                  <td className="whitespace-nowrap px-5 py-3.5 tabular-nums text-slate-500 [.dark_&]:text-slate-400">
                    {prettyDate(email.sentAt ?? email.scheduledAt)}
                  </td>
                  {showActions && (
                    <td className="px-5 py-3.5 text-right">
                      <button
                        type="button"
                        onClick={() => onCancel!(email.id)}
                        disabled={cancellingId === email.id}
                        className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 disabled:opacity-60 [.dark_&]:border-rose-500/30 [.dark_&]:text-rose-300 [.dark_&]:hover:bg-rose-500/10"
                      >
                        {cancellingId === email.id ? "Cancelling..." : "Cancel"}
                      </button>
                    </td>
                  )}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={columns} className="px-5 py-16 text-center">
                  <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 ring-1 ring-indigo-100 [.dark_&]:bg-indigo-400/10 [.dark_&]:text-indigo-400 [.dark_&]:ring-indigo-400/20">
                    <Icon name="mail" className="h-5 w-5" />
                  </div>
                  <p className="font-medium">No emails found</p>
                  <p className="mt-1 text-sm text-slate-500 [.dark_&]:text-slate-400">
                    {query ? "Try a different search term." : `You have no ${tab} emails yet.`}
                  </p>
                  <button
                    onClick={query ? () => onQueryChange("") : onCompose}
                    className="mt-4 text-sm font-semibold text-indigo-600 hover:text-indigo-700 [.dark_&]:text-indigo-400 [.dark_&]:hover:text-indigo-300"
                  >
                    {query ? "Clear search" : "Compose an email"}
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
