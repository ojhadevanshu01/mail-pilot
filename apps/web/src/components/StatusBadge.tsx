const STYLES: Record<string, string> = {
  SENT: "bg-emerald-50 text-emerald-700 [.dark_&]:bg-emerald-400/10 [.dark_&]:text-emerald-300",
  SCHEDULED: "bg-indigo-50 text-indigo-700 [.dark_&]:bg-indigo-400/10 [.dark_&]:text-indigo-300",
  FAILED: "bg-rose-50 text-rose-700 [.dark_&]:bg-rose-400/10 [.dark_&]:text-rose-300",
  CANCELLED: "bg-slate-100 text-slate-600 [.dark_&]:bg-slate-700/40 [.dark_&]:text-slate-300",
};

export function StatusBadge({ status }: { status: string }) {
  const normalized = status.toUpperCase();
  const label = normalized.charAt(0) + normalized.slice(1).toLowerCase();

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
        STYLES[normalized] ??
        "bg-slate-100 text-slate-600 [.dark_&]:bg-slate-800 [.dark_&]:text-slate-300"
      }`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
