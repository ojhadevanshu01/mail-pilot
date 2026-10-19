import { Icon } from "./Icon";

export function SuccessAlert({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  if (!message) return null;
  return (
    <div
      role="status"
      className="mb-5 flex items-start justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 [.dark_&]:border-emerald-500/25 [.dark_&]:bg-emerald-500/10 [.dark_&]:text-emerald-300"
    >
      <span className="flex items-start gap-2">
        <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0" />
        {message}
      </span>
      <button onClick={onDismiss} aria-label="Dismiss message" className="opacity-70 hover:opacity-100">
        <Icon name="x" />
      </button>
    </div>
  );
}

export function ErrorAlert({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="mb-5 flex items-start justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 [.dark_&]:border-rose-500/25 [.dark_&]:bg-rose-500/10 [.dark_&]:text-rose-300"
    >
      <span className="flex items-start gap-2">
        <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
        {message}
      </span>
      <button onClick={onDismiss} aria-label="Dismiss error" className="opacity-70 hover:opacity-100">
        <Icon name="x" />
      </button>
    </div>
  );
}
