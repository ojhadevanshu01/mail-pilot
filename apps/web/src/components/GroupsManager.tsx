"use client";

import { useCallback, useEffect, useState } from "react";
import {
  addGroupRecipients,
  cancelEmail,
  cancelGroupScheduledEmails,
  fetchGroups,
  fetchGroupRecipients,
  removeGroupRecipient,
  rescheduleGroup,
  updateScheduledEmail,
  updateGroupEmailContent,
  type SchedulingGroup,
  type GroupRecipient,
} from "../lib/api";
import { inputClass, ghostButton, primaryButton } from "../lib/ui";
import { prettyDate } from "../lib/utils";
import { StatusBadge } from "./StatusBadge";


const EMAIL_HEADERS = new Set(["email", "emailaddress", "recipient", "recipientemail", "mail", "mailid", "mailaddress", "gmail", "gmailaddress", "emailid", "emailaddr", "recipientaddress", "contactemail"]);

function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function templateFields(subject: string, body: string): string[] {
  const result = new Map<string, string>();
  for (const match of `${subject}\n${body}`.matchAll(/{{\s*([^{}]+?)\s*}}/g)) {
    const field = match[1].trim();
    const key = normalizeHeader(field);
    if (key && !result.has(key)) result.set(key, field);
  }
  return [...result.values()];
}

function parseDelimitedRows(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  const firstLine = source.split(/\r\n|\n|\r/, 1)[0] ?? "";
  const delimiters = [",", ";", "\t"];
  const count = (line: string, delimiter: string) => {
    let quoted = false;
    let total = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') {
        if (quoted && line[i + 1] === '"') i++;
        else quoted = !quoted;
      } else if (!quoted && line[i] === delimiter) total++;
    }
    return total;
  };
  const delimiter = delimiters.reduce((best, item) => count(firstLine, item) > count(firstLine, best) ? item : best, ",");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && char === delimiter) {
      row.push(cell.trim()); cell = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && source[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some((value) => value !== "")) rows.push(row);
      row = []; cell = "";
    } else cell += char;
  }
  row.push(cell.trim());
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

function makeRecipientRows(text: string, fields: string[]): Array<string | { email: string; fields: Record<string, string> }> {
  const source = text.trim();
  if (!source) return [];

  // Basic groups accept addresses separated by commas, semicolons, spaces, or new lines.
  if (fields.length === 0) {
    const parsed = parseDelimitedRows(source);
    const first = parsed[0] ?? [];
    const hasHeader = first.some((value) => EMAIL_HEADERS.has(normalizeHeader(value)));
    if (hasHeader && parsed.length > 1) {
      const headers = first;
      const emailIndex = headers.findIndex((value) => EMAIL_HEADERS.has(normalizeHeader(value)));
      return parsed.slice(1).map((row) => ({ email: row[emailIndex] ?? "", fields: {} }));
    }
    return source.split(/[\s,;]+/).filter(Boolean);
  }

  const parsed = parseDelimitedRows(source);
  if (!parsed.length) return [];
  const first = parsed[0].map((value) => value.trim());
  const headerEmailIndex = first.findIndex((value) => EMAIL_HEADERS.has(normalizeHeader(value)));
  const hasHeader = headerEmailIndex >= 0;
  const headers = hasHeader ? first : fields;
  const dataRows = hasHeader ? parsed.slice(1) : parsed;
  const emailIndex = headers.findIndex((value) => EMAIL_HEADERS.has(normalizeHeader(value)));
  const effectiveEmailIndex = emailIndex >= 0 ? emailIndex : headers.findIndex((value) => normalizeHeader(value) === "email");

  return dataRows.map((cells) => {
    const email = cells[effectiveEmailIndex >= 0 ? effectiveEmailIndex : 0] ?? "";
    const rowFields: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (!header || EMAIL_HEADERS.has(normalizeHeader(header))) return;
      rowFields[header] = cells[index] ?? "";
    });
    return { email, fields: rowFields };
  });
}

export function GroupsManager({
  onError,
  onMessage,
}: {
  onError: (message: string) => void;
  onMessage: (message: string) => void;
}) {
  const [groups, setGroups] = useState<SchedulingGroup[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);

  const [selected, setSelected] = useState<SchedulingGroup | null>(null);
  const [recipients, setRecipients] = useState<GroupRecipient[]>([]);
  const [recipientPage, setRecipientPage] = useState(1);
  const [recipientPages, setRecipientPages] = useState(1);

  const [newRecipients, setNewRecipients] = useState("");
  const [recipientFileName, setRecipientFileName] = useState("");
  const [saving, setSaving] = useState(false);

  const [editing, setEditing] = useState<GroupRecipient | null>(null);
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editScheduledAt, setEditScheduledAt] = useState("");
  const [busyRecipientId, setBusyRecipientId] = useState<string | null>(null);

  const [groupStartAt, setGroupStartAt] = useState("");
  const [groupDelaySeconds, setGroupDelaySeconds] = useState("0");

  // Group-wide email content editor
  const [showGroupMailEditor, setShowGroupMailEditor] = useState(false);
  const [groupMailSubject, setGroupMailSubject] = useState("");
  const [groupMailBody, setGroupMailBody] = useState("");

  const loadGroups = useCallback(async () => {
    setLoading(true);

    try {
      const result = await fetchGroups(page, query);
      setGroups(result.data);
      setTotalPages(Math.max(1, result.pagination.totalPages));
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Could not load groups.",
      );
    } finally {
      setLoading(false);
    }
  }, [page, query, onError]);

  const loadRecipients = useCallback(
    async (groupId: string, nextPage: number) => {
      try {
        const result = await fetchGroupRecipients(groupId, nextPage);

        setRecipients(result.data);
        setRecipientPage(result.pagination.page);
        setRecipientPages(
          Math.max(1, result.pagination.totalPages),
        );
      } catch (error) {
        onError(
          error instanceof Error
            ? error.message
            : "Could not load recipients.",
        );
      }
    },
    [onError],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadGroups();
    }, 300);

    return () => window.clearTimeout(timer);
  }, [loadGroups]);

  async function openGroup(group: SchedulingGroup) {
    setSelected(group);
    setNewRecipients("");
    setEditing(null);
    setShowGroupMailEditor(false);

    const date = new Date(group.startAt);

    setGroupStartAt(
      new Date(
        date.getTime() - date.getTimezoneOffset() * 60000,
      )
        .toISOString()
        .slice(0, 16),
    );

    setGroupDelaySeconds(String(group.delaySeconds));

    await loadRecipients(group.id, 1);
  }

  async function saveGroupSchedule() {
    if (!selected) return;

    if (
      !groupStartAt ||
      new Date(groupStartAt).getTime() <= Date.now()
    ) {
      onError("Choose a future start date and time.");
      return;
    }

    const delay = Number(groupDelaySeconds);

    if (
      !Number.isInteger(delay) ||
      delay < 0 ||
      delay > 86400
    ) {
      onError("Delay must be between 0 and 86400 seconds.");
      return;
    }

    setSaving(true);

    try {
      const startAt = new Date(groupStartAt).toISOString();

      const result = await rescheduleGroup(
        selected.id,
        startAt,
        delay,
      );

      setSelected((current) =>
        current
          ? {
              ...current,
              startAt,
              delaySeconds: delay,
            }
          : current,
      );

      onMessage(
        `Updated group schedule for ${result.rescheduled} pending recipient(s).` +
          (result.queueErrors
            ? ` ${result.queueErrors} queue update(s) need reconciliation.`
            : ""),
      );

      await loadRecipients(selected.id, 1);
      await loadGroups();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Could not reschedule this group.",
      );
    } finally {
      setSaving(false);
    }
  }

  function beginEdit(recipient: GroupRecipient) {
    setEditing(recipient);
    setEditSubject(recipient.subject);
    setEditBody(recipient.body ?? "");

    const date = new Date(recipient.scheduledAt);

    setEditScheduledAt(
      new Date(
        date.getTime() - date.getTimezoneOffset() * 60000,
      )
        .toISOString()
        .slice(0, 16),
    );
  }

  async function saveEdit() {
    if (!selected || !editing) return;

    if (
      !editSubject.trim() ||
      !editBody.trim() ||
      !editScheduledAt
    ) {
      onError("Enter the subject, message, and scheduled time.");
      return;
    }

    const scheduledAt = new Date(editScheduledAt);

    if (Number.isNaN(scheduledAt.getTime())) {
      onError("Choose a valid scheduled date and time.");
      return;
    }

    if (scheduledAt.getTime() <= Date.now()) {
      onError("Choose a future scheduled date and time.");
      return;
    }

    setBusyRecipientId(editing.id);

    try {
      await updateScheduledEmail(editing.id, {
        subject: editSubject.trim(),
        body: editBody,
        scheduledAt: scheduledAt.toISOString(),
      });

      onMessage(
        `Updated scheduled email for ${editing.recipient}.`,
      );

      setEditing(null);

      await loadRecipients(selected.id, recipientPage);
      await loadGroups();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Could not update scheduled email.",
      );
    } finally {
      setBusyRecipientId(null);
    }
  }

  async function cancelRecipient(recipient: GroupRecipient) {
    if (
      !selected ||
      !window.confirm(
        `Cancel the scheduled email to ${recipient.recipient}? Its history will be kept.`,
      )
    ) {
      return;
    }

    setBusyRecipientId(recipient.id);

    try {
      await cancelEmail(recipient.id);

      setSelected((current) =>
        current
          ? {
              ...current,
              counts: {
                ...current.counts,
                scheduled: Math.max(
                  0,
                  current.counts.scheduled - 1,
                ),
                cancelled: current.counts.cancelled + 1,
              },
            }
          : current,
      );

      onMessage(
        `Cancelled the scheduled email to ${recipient.recipient}.`,
      );

      await loadRecipients(selected.id, recipientPage);
      await loadGroups();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Could not cancel this email.",
      );
    } finally {
      setBusyRecipientId(null);
    }
  }

  async function removeRecipient(recipient: GroupRecipient) {
    if (
      !selected ||
      !window.confirm(
        `Remove ${recipient.recipient} from active sending? The record will remain in history as cancelled.`,
      )
    ) {
      return;
    }

    setBusyRecipientId(recipient.id);

    try {
      await removeGroupRecipient(selected.id, recipient.id);

      setSelected((current) =>
        current
          ? {
              ...current,
              counts: {
                ...current.counts,
                scheduled: Math.max(
                  0,
                  current.counts.scheduled - 1,
                ),
                cancelled: current.counts.cancelled + 1,
              },
            }
          : current,
      );

      onMessage(
        `Removed ${recipient.recipient} from active sending; history was preserved.`,
      );

      await loadRecipients(selected.id, recipientPage);
      await loadGroups();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Could not remove this recipient.",
      );
    } finally {
      setBusyRecipientId(null);
    }
  }

  async function cancelGroup() {
    if (
      !selected ||
      !window.confirm(
        "Cancel every scheduled email in this group? Sent emails cannot be recalled.",
      )
    ) {
      return;
    }

    setSaving(true);

    try {
      const cancelled = await cancelGroupScheduledEmails(
        selected.id,
      );

      setSelected((current) =>
        current
          ? {
              ...current,
              counts: {
                ...current.counts,
                scheduled: Math.max(
                  0,
                  current.counts.scheduled - cancelled,
                ),
                cancelled: current.counts.cancelled + cancelled,
              },
            }
          : current,
      );

      setShowGroupMailEditor(false);

      onMessage(`Cancelled ${cancelled} scheduled email(s).`);

      await loadRecipients(selected.id, 1);
      await loadGroups();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Could not cancel this group.",
      );
    } finally {
      setSaving(false);
    }
  }

  // Update subject and message for all scheduled emails in this group.
  async function saveGroupMail() {
    if (!selected) return;

    if (
      !groupMailSubject.trim() ||
      !groupMailBody.trim()
    ) {
      onError("Enter both the subject and message.");
      return;
    }

    if (selected.counts.scheduled === 0) {
      onError(
        "This group has no scheduled emails to update.",
      );
      return;
    }

    const confirmed = window.confirm(
      `Update the subject and message for all ${selected.counts.scheduled} scheduled emails in this group?`,
    );

    if (!confirmed) return;

    setSaving(true);

    try {
      const result = await updateGroupEmailContent(
        selected.id,
        {
          subject: groupMailSubject.trim(),
          body: groupMailBody,
        },
      );

      setShowGroupMailEditor(false);

      onMessage(
        `Updated the email content for ${result.updated} scheduled email(s).`,
      );

      await loadRecipients(selected.id, recipientPage);
      await loadGroups();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Could not update group email content.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function addRecipients() {
    if (!selected) return;

    const template = recipients.find((recipient) => recipient.status === "SCHEDULED") ?? recipients[0];
    const requiredFields = template ? templateFields(template.subject, template.body) : [];
    const fieldOrder = [
      ...requiredFields.filter((field) => normalizeHeader(field) === "name"),
      "email",
      ...requiredFields.filter((field) => normalizeHeader(field) !== "name" && normalizeHeader(field) !== "place" && normalizeHeader(field) !== "email"),
      ...requiredFields.filter((field) => normalizeHeader(field) === "place"),
    ].filter((field, index, all) => all.findIndex((candidate) => normalizeHeader(candidate) === normalizeHeader(field)) === index);
    const expectedFields = fieldOrder;
    const parsedRecipients = makeRecipientRows(newRecipients, expectedFields);

    if (!parsedRecipients.length) {
      onError("Enter recipient data or choose a CSV/TXT file.");
      return;
    }

    setSaving(true);
    try {
      const result = await addGroupRecipients(selected.id, parsedRecipients);
      setNewRecipients("");
      setRecipientFileName("");
      const notices = [
        `Added ${result.added} recipient(s).`,
        `Skipped ${result.skippedExisting} existing recipient(s).`,
      ];
      if (result.invalid) notices.push(`${result.invalid} invalid row(s).`);
      if (result.duplicatesInUpload) notices.push(`${result.duplicatesInUpload} duplicate row(s) in the import.`);
      if (result.missingFields) notices.push(`${result.missingFields} row(s) missing required personalization fields.`);
      if (result.queueErrors) notices.push(`${result.queueErrors} job(s) will be retried by queue reconciliation.`);
      onMessage(notices.join(" "));
      await loadRecipients(selected.id, 1);
      await loadGroups();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not add recipients.");
    } finally {
      setSaving(false);
    }
  }

  async function loadRecipientFile(file?: File) {
    if (!file) return;
    if (!/\.(csv|txt)$/i.test(file.name)) {
      onError("Choose a .csv or .txt file.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      onError("Recipient files must be 5 MB or smaller.");
      return;
    }
    try {
      setNewRecipients(await file.text());
      setRecipientFileName(file.name);
      onMessage(`Loaded ${file.name}. Review the data format, then click Add recipients.`);
    } catch {
      onError("Could not read that file.");
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm [.dark_&]:border-slate-800 [.dark_&]:bg-slate-900 sm:p-6">
        <div className="mb-5">
          <h2 className="text-lg font-semibold">
            Scheduling history
          </h2>

          <p className="mt-1 text-sm text-slate-500 [.dark_&]:text-slate-400">
            Each row represents one bulk scheduling operation.
          </p>
        </div>

        <input
          className={inputClass}
          value={query}
          onChange={(event) => {
            setPage(1);
            setQuery(event.target.value);
          }}
          placeholder="Search groups, subjects, or recipients"
          aria-label="Search scheduling groups"
        />

        {loading ? (
          <p className="py-10 text-center text-sm text-slate-500">
            Loading groupsâ€¦
          </p>
        ) : groups.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-500">
            No scheduling groups found. New bulk schedules will
            appear here.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            {groups.map((group) => (
              <button
                key={group.id}
                type="button"
                onClick={() => void openGroup(group)}
                className="w-full rounded-xl border border-slate-200 p-4 text-left transition hover:border-indigo-300 hover:bg-indigo-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 [.dark_&]:border-slate-800 [.dark_&]:hover:border-indigo-700 [.dark_&]:hover:bg-indigo-500/5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">
                      {group.name || "Email schedule"}
                    </p>

                    <p className="mt-1 text-xs text-slate-500 [.dark_&]:text-slate-400">
                      Created {prettyDate(group.createdAt)} Â·{" "}
                      {group.sender.email}
                    </p>
                  </div>

                  <span className="text-sm font-semibold">
                    {group.counts.total} recipients
                  </span>
                </div>

                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  <span className="text-indigo-600 [.dark_&]:text-indigo-300">
                    Scheduled {group.counts.scheduled}
                  </span>

                  <span className="text-emerald-600 [.dark_&]:text-emerald-300">
                    Sent {group.counts.sent}
                  </span>

                  <span className="text-rose-600 [.dark_&]:text-rose-300">
                    Failed {group.counts.failed}
                  </span>

                  <span className="text-slate-500">
                    Cancelled {group.counts.cancelled}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}

        <div className="mt-5 flex items-center justify-between gap-3">
          <span className="text-sm text-slate-500">
            Page {page} of {totalPages}
          </span>

          <div className="flex gap-2">
            <button
              className={ghostButton}
              disabled={page <= 1}
              onClick={() =>
                setPage((value) => Math.max(1, value - 1))
              }
            >
              Previous
            </button>

            <button
              className={ghostButton}
              disabled={page >= totalPages}
              onClick={() =>
                setPage((value) =>
                  Math.min(totalPages, value + 1),
                )
              }
            >
              Next
            </button>
          </div>
        </div>
      </section>

      {selected && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm [.dark_&]:border-slate-800 [.dark_&]:bg-slate-900 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">
                {selected.name || "Email schedule"}
              </h2>

              <p className="mt-1 text-sm text-slate-500">
                Recipient-level outcomes
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={primaryButton}
                disabled={
                  saving || selected.counts.scheduled === 0
                }
                onClick={() => {
                  const template = recipients.find(
                    (recipient) =>
                      recipient.status === "SCHEDULED",
                  );

                  setGroupMailSubject(
                    template?.subject ?? "",
                  );
                  setGroupMailBody(template?.body ?? "");
                  setShowGroupMailEditor(true);
                }}
              >
                Update Email for Group
              </button>

              <button
                type="button"
                className={ghostButton}
                disabled={
                  saving || selected.counts.scheduled === 0
                }
                onClick={() => void cancelGroup()}
              >
                Cancel all scheduled (
                {selected.counts.scheduled})
              </button>

              <button
                type="button"
                className={ghostButton}
                onClick={() => {
                  setSelected(null);
                  setShowGroupMailEditor(false);
                  setEditing(null);
                }}
              >
                Close details
              </button>
            </div>
          </div>

          {/* Group-wide email subject and message editor */}
          {showGroupMailEditor && (
            <div className="my-5 rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 [.dark_&]:border-indigo-900 [.dark_&]:bg-indigo-950/20">
              <h3 className="font-semibold">
                Update Email for the Whole Group
              </h3>

              <p className="mt-1 text-sm text-slate-600 [.dark_&]:text-slate-400">
                Changes apply to scheduled emails only. Sent,
                failed, cancelled, and processing emails will
                not be changed.
              </p>

              <div className="mt-4 grid gap-4">
                <label className="block text-sm font-medium">
                  Subject

                  <input
                    className={`${inputClass} mt-1`}
                    value={groupMailSubject}
                    onChange={(event) =>
                      setGroupMailSubject(event.target.value)
                    }
                    placeholder="Enter email subject"
                  />
                </label>

                <label className="block text-sm font-medium">
                  Message

                  <textarea
                    className={`${inputClass} mt-1 min-h-40`}
                    value={groupMailBody}
                    onChange={(event) =>
                      setGroupMailBody(event.target.value)
                    }
                    placeholder="Enter email message"
                  />
                </label>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={primaryButton}
                    disabled={
                      saving ||
                      !groupMailSubject.trim() ||
                      !groupMailBody.trim() ||
                      selected.counts.scheduled === 0
                    }
                    onClick={() => void saveGroupMail()}
                  >
                    {saving
                      ? "Savingâ€¦"
                      : "Save for Whole Group"}
                  </button>

                  <button
                    type="button"
                    className={ghostButton}
                    disabled={saving}
                    onClick={() =>
                      setShowGroupMailEditor(false)
                    }
                  >
                    Discard
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Reschedule all pending emails in this group */}
          <div className="my-5 rounded-xl border border-slate-200 p-4 [.dark_&]:border-slate-700">
            <h3 className="font-medium">
              Reschedule group
            </h3>

            <p className="mt-1 text-sm text-slate-500">
              Only pending scheduled emails are changed. Sent,
              failed, cancelled, and processing records remain
              untouched.
            </p>

            <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_180px_auto] sm:items-end">
              <label className="block text-sm font-medium">
                New start time

                <input
                  className={`${inputClass} mt-1`}
                  type="datetime-local"
                  value={groupStartAt}
                  onChange={(event) =>
                    setGroupStartAt(event.target.value)
                  }
                />
              </label>

              <label className="block text-sm font-medium">
                Delay between emails (seconds)

                <input
                  className={`${inputClass} mt-1`}
                  type="number"
                  min="0"
                  max="86400"
                  step="1"
                  value={groupDelaySeconds}
                  onChange={(event) =>
                    setGroupDelaySeconds(event.target.value)
                  }
                />
              </label>

              <button
                type="button"
                className={primaryButton}
                disabled={
                  saving || selected.counts.scheduled === 0
                }
                onClick={() => void saveGroupSchedule()}
              >
                {saving ? "Savingâ€¦" : "Update schedule"}
              </button>
            </div>
          </div>

          {/* Add recipients by text or CSV/TXT upload */}
          <div className="my-5 rounded-xl border border-slate-200 p-4 [.dark_&]:border-slate-800">
            <label className="mb-2 block text-sm font-semibold">
              Add recipients to this group
            </label>
            {(() => {
              const template = recipients.find((recipient) => recipient.status === "SCHEDULED") ?? recipients[0];
              const fields = template ? templateFields(template.subject, template.body) : [];
              const orderedFields = [
                ...fields.filter((field) => normalizeHeader(field) === "name"),
                "email",
                ...fields.filter((field) => normalizeHeader(field) !== "name" && normalizeHeader(field) !== "place"),
                ...fields.filter((field) => normalizeHeader(field) === "place"),
              ].filter((field, index, all) => all.findIndex((candidate) => normalizeHeader(candidate) === normalizeHeader(field)) === index);
              const advanced = fields.length > 0;
              const format = advanced ? orderedFields.join(",") : "email";
              const example = advanced
                ? `${orderedFields.map((field) => normalizeHeader(field) === "name" ? "Amit Sharma" : normalizeHeader(field) === "email" ? "amit@example.com" : normalizeHeader(field) === "place" ? "Delhi" : field === "email" ? "amit@example.com" : `Sample ${field}`).join(",")}`
                : "amit@example.com";
              return (
                <>
                  <div className="mb-3 rounded-lg bg-slate-50 p-3 text-sm [.dark_&]:bg-slate-950">
                    <p className="font-medium">{advanced ? "Personalized group format" : "Basic group format"}</p>
                    <p className="mt-1 break-all font-mono text-xs">{format}</p>
                    <p className="mt-1 break-all font-mono text-xs text-slate-500">{example}</p>
                    {advanced && <p className="mt-2 text-xs text-slate-500">Required template fields: {fields.join(", ")}. Include every field for each new recipient. A matching header row is optional.</p>}
                    {!advanced && <p className="mt-2 text-xs text-slate-500">Enter one address per line, or separate addresses with commas or semicolons.</p>}
                  </div>
                  <label className="mb-2 block text-sm font-medium">Import CSV/TXT file (optional)</label>
                  <input
                    type="file"
                    accept=".csv,.txt,text/csv,text/plain"
                    className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-3 file:py-2 file:font-medium file:text-indigo-700 hover:file:bg-indigo-100 [.dark_&]:file:bg-indigo-950 [.dark_&]:file:text-indigo-200"
                    onChange={(event) => { void loadRecipientFile(event.target.files?.[0]); event.currentTarget.value = ""; }}
                  />
                  {recipientFileName && <p className="mt-1 text-xs text-slate-500">Loaded: {recipientFileName}</p>}
                  <label className="mb-2 mt-4 block text-sm font-medium">Or paste recipient data</label>
                  <textarea
                    className={`${inputClass} min-h-28 font-mono text-sm`}
                    value={newRecipients}
                    onChange={(event) => { setNewRecipients(event.target.value); setRecipientFileName(""); }}
                    placeholder={advanced ? `${format}\n${example}` : "amit@example.com\npriya@example.com"}
                  />
                  <p className="mt-1 text-xs text-slate-500">CSV/TXT files up to 5 MB. Existing recipients are skipped; invalid rows and missing personalization fields are reported. Only new rows are scheduled.</p>
                </>
              );
            })()}
            <button
              type="button"
              className={`${primaryButton} mt-3`}
              disabled={saving || selected.counts.scheduled === 0}
              onClick={() => void addRecipients()}
            >
              {saving ? "Adding…" : "Add recipients"}
            </button>
            {selected.counts.scheduled === 0 && <p className="mt-2 text-xs text-amber-600">This group has no pending scheduled emails, so new recipients cannot be appended.</p>}
          </div>

          {/* Edit one scheduled email */}
          {editing && (
            <div className="mb-5 rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 [.dark_&]:border-indigo-900 [.dark_&]:bg-indigo-950/20">
              <h3 className="font-semibold">
                Edit scheduled email to {editing.recipient}
              </h3>

              <p className="mt-1 text-xs text-slate-500">
                Editing is available only before processing
                begins.
              </p>

              <div className="mt-3 grid gap-3">
                <label className="text-sm font-medium">
                  Subject

                  <input
                    className={`${inputClass} mt-1`}
                    value={editSubject}
                    onChange={(event) =>
                      setEditSubject(event.target.value)
                    }
                  />
                </label>

                <label className="text-sm font-medium">
                  Message

                  <textarea
                    className={`${inputClass} mt-1 min-h-28`}
                    value={editBody}
                    onChange={(event) =>
                      setEditBody(event.target.value)
                    }
                  />
                </label>

                <label className="text-sm font-medium">
                  Scheduled time

                  <input
                    type="datetime-local"
                    className={`${inputClass} mt-1`}
                    value={editScheduledAt}
                    onChange={(event) =>
                      setEditScheduledAt(event.target.value)
                    }
                  />
                </label>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={primaryButton}
                    disabled={
                      busyRecipientId === editing.id ||
                      !editSubject.trim() ||
                      !editBody.trim() ||
                      !editScheduledAt
                    }
                    onClick={() => void saveEdit()}
                  >
                    {busyRecipientId === editing.id
                      ? "Savingâ€¦"
                      : "Save changes"}
                  </button>

                  <button
                    type="button"
                    className={ghostButton}
                    onClick={() => setEditing(null)}
                  >
                    Discard
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Recipient history */}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase text-slate-500 [.dark_&]:border-slate-800">
                  <th className="py-3 pr-3">Recipient</th>
                  <th className="py-3 pr-3">Status</th>
                  <th className="py-3 pr-3">
                    Scheduled / sent
                  </th>
                  <th className="py-3 pr-3">Actions</th>
                </tr>
              </thead>

              <tbody>
                {recipients.map((recipient) => (
                  <tr
                    key={recipient.id}
                    className="border-b border-slate-100 [.dark_&]:border-slate-800"
                  >
                    <td className="py-3 pr-3">
                      <div>{recipient.recipient}</div>

                      {recipient.errorMessage && (
                        <p className="mt-1 max-w-sm text-xs text-rose-600 [.dark_&]:text-rose-400">
                          {recipient.errorMessage}
                        </p>
                      )}
                    </td>

                    <td className="py-3 pr-3">
                      <StatusBadge status={recipient.status} />
                    </td>

                    <td className="whitespace-nowrap py-3 pr-3 text-slate-500">
                      {prettyDate(
                        recipient.sentAt ||
                          recipient.scheduledAt,
                      )}
                    </td>

                    <td className="py-3 pr-3">
                      {recipient.status === "SCHEDULED" ? (
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className={ghostButton}
                            onClick={() => beginEdit(recipient)}
                          >
                            Edit
                          </button>

                          <button
                            type="button"
                            className={ghostButton}
                            disabled={
                              busyRecipientId === recipient.id
                            }
                            onClick={() =>
                              void cancelRecipient(recipient)
                            }
                          >
                            Cancel
                          </button>

                          <button
                            type="button"
                            className={ghostButton}
                            disabled={
                              busyRecipientId === recipient.id
                            }
                            onClick={() =>
                              void removeRecipient(recipient)
                            }
                          >
                            Remove
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">
                          History retained
                        </span>
                      )}
                    </td>
                  </tr>
                ))}

                {recipients.length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className="py-8 text-center text-slate-500"
                    >
                      No recipients on this page.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Recipient pagination */}
          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-sm text-slate-500">
              Recipient page {recipientPage} of {recipientPages}
            </span>

            <div className="flex gap-2">
              <button
                type="button"
                className={ghostButton}
                disabled={recipientPage <= 1}
                onClick={() =>
                  void loadRecipients(
                    selected.id,
                    recipientPage - 1,
                  )
                }
              >
                Previous
              </button>

              <button
                type="button"
                className={ghostButton}
                disabled={recipientPage >= recipientPages}
                onClick={() =>
                  void loadRecipients(
                    selected.id,
                    recipientPage + 1,
                  )
                }
              >
                Next
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
