"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { Icon } from "./Icon";
import {
  createList,
  fetchLists,
  fetchSenders,
  scheduleBulk,
} from "../lib/api";
import {
  inputClass,
  ghostButton,
  primaryButton,
} from "../lib/ui";
import {
  EMAIL_RE,
  MAX_FILE_BYTES,
  formatDuration,
  prettyDate,
} from "../lib/utils";
import type { MailingList, Sender } from "../lib/types";

const MAX_RECIPIENTS = 500;

type RecipientRow = {
  email: string;
  fields: Record<string, string>;
};

type ParsedRecipients = {
  rows: RecipientRow[];
  rejected: number;
  headers: string[];
  emailColumn: string;
};

const EMAIL_HEADERS = [
  "email",
  "emailaddress",
  "recipient",
  "recipientemail",
  "gmail",
  "gmailaddress",
  "emailid",
  "emailaddr",
  "recipientaddress",
  "mail",
  "mailid",
  "mailaddress",
  "contactemail",
];

function normalizeHeader(value: string): string {
  return value
    .trim()
    .replace(/^\uFEFF/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Parse CSV/TXT files with comma, semicolon, or tab delimiters.
 * Supports quoted commas, escaped quotes, multiline quoted cells,
 * CRLF line endings, and a UTF-8 BOM.
 */
function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");

  const firstLine = source.split(/\r\n|\n|\r/, 1)[0] ?? "";

  function countDelimiters(
    line: string,
    delimiter: string,
  ): number {
    let quoted = false;
    let count = 0;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        if (quoted && line[i + 1] === '"') {
          i++;
        } else {
          quoted = !quoted;
        }
      } else if (!quoted && char === delimiter) {
        count++;
      }
    }

    return count;
  }

  const delimiters = [",", ";", "\t"];

  const delimiter = delimiters.reduce((best, candidate) =>
    countDelimiters(firstLine, candidate) >
      countDelimiters(firstLine, best)
      ? candidate
      : best,
  );

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (char === '"') {
      if (quoted && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (!quoted && char === delimiter) {
      row.push(cell.trim());
      cell = "";
      continue;
    }

    if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && source[i + 1] === "\n") {
        i++;
      }

      row.push(cell.trim());

      if (row.some((value) => value !== "")) {
        rows.push(row);
      }

      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell.trim());

  if (row.some((value) => value !== "")) {
    rows.push(row);
  }

  return rows;
}

function parseRecipientFile(
  text: string,
  preferredEmailColumn?: string,
): ParsedRecipients {
  const parsed = parseCsv(text);

  if (parsed.length === 0) {
    return {
      rows: [],
      rejected: 0,
      headers: [],
      emailColumn: "",
    };
  }

  const firstRow = parsed[0].map((value) =>
    value.trim().replace(/^\uFEFF/, ""),
  );

  const firstRowHasEmail = firstRow.some((cell) =>
    EMAIL_RE.test(cell.trim()),
  );

  const firstRowHasKnownEmailHeader = firstRow.some((cell) =>
    EMAIL_HEADERS.includes(normalizeHeader(cell)),
  );

  const laterRowsHaveEmail = parsed.slice(1).some((row) =>
    row.some((cell) => EMAIL_RE.test(cell.trim())),
  );

  const hasHeader =
    firstRowHasKnownEmailHeader ||
    (!firstRowHasEmail && laterRowsHaveEmail);

  const headers = hasHeader
    ? firstRow
    : firstRow.map((_, index) =>
      index === 0 ? "email" : `column${index + 1}`,
    );

  const dataRows = hasHeader ? parsed.slice(1) : parsed;

  let emailIndex = -1;

  if (preferredEmailColumn) {
    emailIndex = headers.findIndex(
      (header) =>
        normalizeHeader(header) ===
        normalizeHeader(preferredEmailColumn),
    );
  }

  if (emailIndex < 0) {
    emailIndex = headers.findIndex((header) =>
      EMAIL_HEADERS.includes(normalizeHeader(header)),
    );
  }

  // Support files where the email column has an unusual heading.
  if (emailIndex < 0) {
    let bestScore = 0;

    headers.forEach((_, column) => {
      const score = dataRows.reduce(
        (total, row) =>
          total +
          (EMAIL_RE.test((row[column] ?? "").trim()) ? 1 : 0),
        0,
      );

      if (score > bestScore) {
        bestScore = score;
        emailIndex = column;
      }
    });
  }

  if (emailIndex < 0 || !headers[emailIndex]) {
    return {
      rows: [],
      rejected: dataRows.length || 1,
      headers,
      emailColumn: "",
    };
  }

  const emailColumn = headers[emailIndex];
  const unique = new Map<string, RecipientRow>();
  let rejected = 0;

  for (const cells of dataRows) {
    const email = (cells[emailIndex] ?? "")
      .trim()
      .toLowerCase();

    if (!EMAIL_RE.test(email)) {
      rejected++;
      continue;
    }

    const fields: Record<string, string> = {};

    headers.forEach((header, index) => {
      const key = header.trim().replace(/^\uFEFF/, "");

      if (!key || index === emailIndex) {
        return;
      }

      fields[key] = (cells[index] ?? "").trim();
    });

    if (unique.has(email)) {
      rejected++;
      continue;
    }

    unique.set(email, { email, fields });
  }

  const rows = Array.from(unique.values());

  return {
    rows,
    rejected,
    headers,
    emailColumn,
  };
}

/** Replace {{fieldName}} placeholders with a recipient's CSV data. */
function renderPreview(
  template: string,
  fields: Record<string, string>,
): string {
  return template.replace(
    /\{\{\s*([^{}]+?)\s*\}\}/g,
    (placeholder, key: string) => {
      const normalizedKey = normalizeHeader(key);

      const actualKey = Object.keys(fields).find(
        (field) => normalizeHeader(field) === normalizedKey,
      );

      return actualKey ? fields[actualKey] : placeholder;
    },
  );
}

function Step({
  n,
  title,
  hint,
  children,
}: {
  n: number;
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-5 py-7 first:pt-0 last:pb-0 lg:grid-cols-[190px_minmax(0,1fr)] lg:gap-10">
      <div>
        <div className="flex items-center gap-2.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-600 text-xs font-semibold text-white">
            {n}
          </span>
          <h4 className="text-sm font-semibold">{title}</h4>
        </div>

        <p className="mt-2 text-sm leading-6 text-slate-500 [.dark_&]:text-slate-400">
          {hint}
        </p>
      </div>

      <div className="min-w-0">{children}</div>
    </section>
  );
}

export function ComposeForm({
  active,
  onScheduled,
  onError,
  onMessage,
}: {
  active: boolean;
  onScheduled: (count: number) => void;
  onError: (message: string) => void;
  onMessage: (message: string) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [senders, setSenders] = useState<Sender[]>([]);
  const [senderId, setSenderId] = useState("");
  const [newSender, setNewSender] = useState("");

  const [recipientRows, setRecipientRows] = useState<RecipientRow[]>([]);
  const [manualRecipientText, setManualRecipientText] = useState("");
  const [rejected, setRejected] = useState(0);
  const [csvName, setCsvName] = useState("");
  const [csvText, setCsvText] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [emailColumn, setEmailColumn] = useState("");

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [startAt, setStartAt] = useState("");
  const [delay, setDelay] = useState(2);
  const [submitting, setSubmitting] = useState(false);

  const [lists, setLists] = useState<MailingList[]>([]);
  const [listName, setListName] = useState("");
  const [savingList, setSavingList] = useState(false);

  const recipients = recipientRows.map((row) => row.email);

  const loadSenders = useCallback(async () => {
    const rows = (await fetchSenders()).filter((sender) => sender.connectionStatus === "CONNECTED");

    setSenders(rows);
    setSenderId((previous) => rows.some((sender) => sender.id === previous) ? previous : rows[0]?.id || "");
  }, []);

  useEffect(() => {
    loadSenders().catch(() => {
      onError("We couldn't connect to the server. Please try again shortly.");
    });
  }, [loadSenders, onError]);

  useEffect(() => {
    if (!active) return;

    fetchLists()
      .then(setLists)
      .catch(() => {
        onError("Could not load mailing lists. Please try again.");
      });
  }, [active, onError]);

  async function addSender() {
    const email = newSender.trim();

    if (!EMAIL_RE.test(email)) {
      onError("Enter a valid sender email address.");
      return;
    }

    try {
      onError("Connect sender Gmail accounts from the Gmail Accounts section first, using a Google App Password.");
      return;
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Could not add sender.",
      );
    }
  }

  function clearRecipients() {
    setRecipientRows([]);
    setManualRecipientText("");
    setRejected(0);
    setCsvName("");
    setCsvText("");
    setHeaders([]);
    setEmailColumn("");

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  async function onFile(file?: File) {
    if (!file) return;

    if (file.size > MAX_FILE_BYTES) {
      onError("File must be smaller than 5 MB.");
      return;
    }

    try {
      const text = await file.text();
      const result = parseRecipientFile(text);

      if (result.rows.length === 0) {
        onError(
          "No valid recipients found. Check that the file contains valid email addresses and a usable email column.",
        );
        return;
      }

      const limitedRows = result.rows.slice(0, MAX_RECIPIENTS);

      setCsvText(text);
      setManualRecipientText("");
      setRecipientRows(limitedRows);
      setRejected(
        result.rejected +
        Math.max(0, result.rows.length - MAX_RECIPIENTS),
      );
      setCsvName(file.name);
      setHeaders(result.headers);
      setEmailColumn(result.emailColumn);

      if (result.rows.length > MAX_RECIPIENTS) {
        onMessage(
          `Loaded the first ${MAX_RECIPIENTS} recipients. Extra recipients were skipped.`,
        );
      } else {
        onMessage(`Loaded ${result.rows.length} unique recipients.`);
      }
    } catch (error) {
      console.error("CSV/TXT upload failed:", error);
      onError("Could not read the selected file. Please try another file.");
    }
  }

  function applyList(id: string) {
    if (!id) return;

    const list = lists.find((item) => item.id === id);

    if (!list) return;

    setManualRecipientText("");
    const savedDetails = list.recipientDetails ?? [];
    const detailsByEmail = new Map(
      savedDetails.map((recipient) => [recipient.email.toLowerCase(), recipient]),
    );
    setRecipientRows(
      list.recipients.slice(0, MAX_RECIPIENTS).map((email) => {
        const saved = detailsByEmail.get(email.toLowerCase());
        return {
          email,
          fields: saved?.fields ?? {},
        };
      }),
    );

    setRejected(Math.max(0, list.recipients.length - MAX_RECIPIENTS));
    setCsvName(`List: ${list.name}`);
    setCsvText("");
    setHeaders([]);
    setEmailColumn("");

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }

    onMessage(
      `Loaded "${list.name}" (${Math.min(
        list.recipients.length,
        MAX_RECIPIENTS,
      )} recipients).`,
    );
  }

  function loadPastedRecipients() {
    const text = manualRecipientText.trim();
    if (!text) {
      onError("Paste recipient addresses or CSV rows first.");
      return;
    }

    const result = parseRecipientFile(text, emailColumn || undefined);
    if (result.rows.length === 0) {
      onError("No valid recipients found. Use one email address per line, or include a CSV header such as name,email,place.");
      return;
    }

    const limitedRows = result.rows.slice(0, MAX_RECIPIENTS);
    setRecipientRows(limitedRows);
    setRejected(result.rejected + Math.max(0, result.rows.length - MAX_RECIPIENTS));
    setCsvText(text);
    setCsvName("Pasted recipients");
    setHeaders(result.headers);
    setEmailColumn(result.emailColumn);
    onMessage(`Loaded ${limitedRows.length} pasted recipient(s). ${result.rejected} invalid or duplicate row(s) skipped.`);
  }

  function changeEmailColumn(nextColumn: string) {
    if (!csvText) {
      setEmailColumn(nextColumn);
      return;
    }

    const result = parseRecipientFile(csvText, nextColumn);

    if (result.rows.length === 0) {
      onError("The selected column contains no valid email addresses.");
      return;
    }

    setEmailColumn(result.emailColumn);
    setRecipientRows(result.rows.slice(0, MAX_RECIPIENTS));
    setRejected(
      result.rejected +
      Math.max(0, result.rows.length - MAX_RECIPIENTS),
    );

    onMessage(
      `Loaded ${Math.min(
        result.rows.length,
        MAX_RECIPIENTS,
      )} recipients using "${result.emailColumn}".`,
    );
  }

  async function saveCurrentList() {
    const name = listName.trim();

    if (!name) {
      onError("Give the list a name.");
      return;
    }

    if (recipients.length === 0) {
      onError("Add recipients before saving a list.");
      return;
    }

    setSavingList(true);

    try {
      await createList(
        name,
        recipientRows.map((recipient) => ({
          email: recipient.email,
          fields: recipient.fields,
        })),
      );
      setListName("");
      setLists(await fetchLists());

      onMessage(`Saved list "${name}".`);
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Could not save the list.",
      );
    } finally {
      setSavingList(false);
    }
  }

  async function submit() {
    if (!senderId) {
      onError("Please select or add a sender.");
      return;
    }

    if (recipientRows.length === 0) {
      onError("Add recipients from a CSV/TXT file or a saved list.");
      return;
    }

    if (recipientRows.length > MAX_RECIPIENTS) {
      onError(`Maximum ${MAX_RECIPIENTS} recipients per scheduling request.`);
      return;
    }

    if (!subject.trim() || !body.trim()) {
      onError("Subject and email body are required.");
      return;
    }

    if (!Number.isFinite(delay) || delay < 0) {
      onError("Delay must be zero or more seconds.");
      return;
    }

    if (startAt) {
      const startDate = new Date(startAt);

      if (Number.isNaN(startDate.getTime())) {
        onError("Please select a valid start date and time.");
        return;
      }

      if (startDate.getTime() < Date.now()) {
        onError("The scheduled start time must be in the future.");
        return;
      }
    }

    // Validate placeholders against the actual recipient data before
    // sending the scheduling request.
    const placeholders = [
      ...subject.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g),
      ...body.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g),
    ].map((match) => match[1].trim());

    const uniquePlaceholders = Array.from(new Set(placeholders));

    if (uniquePlaceholders.length > 0) {

      const missing = uniquePlaceholders.filter((placeholder) =>
        recipientRows.some((recipient) => {
          const normalizedPlaceholder = normalizeHeader(placeholder);

          // The destination email comes from recipient.email,
          // not necessarily from recipient.fields.
          if (normalizedPlaceholder === "email") {
            return !recipient.email?.trim();
          }

          const matchingKey = Object.keys(recipient.fields).find(
            (key) =>
              normalizeHeader(key) === normalizedPlaceholder,
          );

          if (!matchingKey) {
            return true;
          }

          const value = recipient.fields[matchingKey];

          return (
            value === undefined ||
            value === null ||
            String(value).trim() === ""
          );
        }),
      );


      if (missing.length > 0) {
        onError(
          `Personalization field(s) missing or empty for at least one recipient: ${missing.join(
            ", ",
          )}. Upload a CSV containing those columns or remove those placeholders.`,
        );
        return;
      }
    }

    setSubmitting(true);

    try {
      const count = await scheduleBulk({
        senderId,
        recipients: recipientRows.map((recipient) => ({
          email: recipient.email,
          fields: recipient.fields,
        })),
        emailColumn: emailColumn || undefined,
        subject: subject.trim(),
        body,
        startAt: startAt ? new Date(startAt).toISOString() : undefined,
        delaySeconds: delay,
      });

      clearRecipients();
      setSubject("");
      setBody("");
      setStartAt("");

      onScheduled(count);
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Could not schedule emails.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const selectedSender = senders.find(
    (sender) => sender.id === senderId,
  )?.email;

  const startDate = startAt ? new Date(startAt) : null;
  const startValid = !!startDate && !Number.isNaN(startDate.getTime());

  const totalSeconds =
    Math.max(0, recipientRows.length - 1) * (Number(delay) || 0);

  const finishDate = new Date(
    (startValid ? startDate!.getTime() : Date.now()) +
    totalSeconds * 1000,
  );

  const checklist = [
    { label: "Sender selected", done: !!senderId },
    { label: "Recipients added", done: recipientRows.length > 0 },
    {
      label: "Subject and message written",
      done: !!subject.trim() && !!body.trim(),
    },
  ];

  // The destination address is a built-in personalization field, even though
  // it is intentionally excluded from CSV custom fields.
  const availableFields = Array.from(
    new Set([
      "email",
      ...headers.filter(
        (header) =>
          header && normalizeHeader(header) !== normalizeHeader(emailColumn),
      ),
    ]),
  );

  const previewRecipient = recipientRows[0];
  const previewFields = previewRecipient
    ? { ...previewRecipient.fields, email: previewRecipient.email }
    : {};

  const previewSubject = previewRecipient
    ? renderPreview(subject, previewFields)
    : subject;

  const previewBody = previewRecipient
    ? renderPreview(body, previewFields)
    : body;

  return (
    <div className="grid items-start gap-7 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="divide-y divide-slate-200/80 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm [.dark_&]:divide-slate-800 [.dark_&]:border-slate-800 [.dark_&]:bg-slate-900 sm:p-7">
        <Step
          n={1}
          title="Sender"
          hint="The address your emails are sent from."
        >
          <select
            className={inputClass}
            value={senderId}
            onChange={(event) => setSenderId(event.target.value)}
            aria-label="Sender"
          >
            <option value="">Select a sender</option>
            {senders.map((sender) => (
              <option key={sender.id} value={sender.id}>
                {sender.email}
              </option>
            ))}
          </select>

          <div className="mt-2 flex gap-2">
            <input
              className={inputClass}
              placeholder="Add a new sender email"
              value={newSender}
              onChange={(event) => setNewSender(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void addSender();
                }
              }}
              aria-label="New sender email"
            />

            <button
              type="button"
              onClick={() => void addSender()}
              className={`${ghostButton} shrink-0`}
            >
              <Icon name="plus" />
              Add
            </button>
          </div>
        </Step>

        <Step
          n={2}
          title="Recipients"
          hint="Paste recipient data, upload a CSV/TXT file, or load a saved mailing list. Invalid addresses and duplicates are removed."
        >
          <div className="mb-4 rounded-xl border border-slate-200 p-4 [.dark_&]:border-slate-800">
            <label htmlFor="manual-recipients" className="mb-2 block text-sm font-medium">
              Paste recipient data
            </label>
            <textarea
              id="manual-recipients"
              className={`${inputClass} min-h-28 font-mono text-sm`}
              value={manualRecipientText}
              onChange={(event) => setManualRecipientText(event.target.value)}
              placeholder={"Basic schedule — one email per line:\namit@example.com\npriya@example.com\n\nAdvanced schedule — include a header row:\nname,email,place\nAmit Sharma,amit@example.com,Delhi"}
            />
            <p className="mt-2 text-xs text-slate-500 [.dark_&]:text-slate-400">
              Basic: paste one email address per line. Advanced: include the column header row (for example, name,email,place) followed by recipient values. You can also upload a CSV/TXT file below.
            </p>
            <button type="button" className={`${ghostButton} mt-3`} onClick={loadPastedRecipients}>
              Use pasted recipients
            </button>
          </div>

          <select
            className={inputClass}
            value=""
            onChange={(event) => applyList(event.target.value)}
            aria-label="Load a saved mailing list"
            disabled={lists.length === 0}
          >
            <option value="">
              {lists.length
                ? "Load a saved mailing list..."
                : "No saved lists yet"}
            </option>

            {lists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name} ({list.recipients.length})
              </option>
            ))}
          </select>

          <div className="mt-3 rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-5 [.dark_&]:border-slate-700 [.dark_&]:bg-slate-950/40">
            <input
              ref={fileInputRef}
              id="recipient-file"
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              className="sr-only"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                void onFile(file);
                event.currentTarget.value = "";
              }}
            />

            <div className="flex flex-wrap items-center gap-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-white text-indigo-600 ring-1 ring-slate-200 [.dark_&]:bg-slate-900 [.dark_&]:text-indigo-400 [.dark_&]:ring-slate-700">
                <Icon name="upload" className="h-5 w-5" />
              </span>

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {csvName || "Choose a recipient file"}
                </p>
                <p className="mt-1 text-xs text-slate-500 [.dark_&]:text-slate-400">
                  CSV or TXT, maximum 5 MB
                </p>
              </div>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className={ghostButton}
              >
                {csvName ? "Replace file" : "Browse files"}
              </button>
            </div>
          </div>

          {headers.length > 0 && csvText && (
            <div className="mt-4">
              <label
                htmlFor="email-column"
                className="mb-1.5 block text-sm font-medium"
              >
                Which column contains email addresses?
              </label>

              <select
                id="email-column"
                className={inputClass}
                value={emailColumn}
                onChange={(event) =>
                  changeEmailColumn(event.target.value)
                }
              >
                {headers.map((header, index) => (
                  <option key={`${header}-${index}`} value={header}>
                    {header || `Column ${index + 1}`}
                  </option>
                ))}
              </select>

              <p className="mt-2 text-xs text-slate-500 [.dark_&]:text-slate-400">
                Other columns remain available for personalization.
              </p>
            </div>
          )}

          {(recipientRows.length > 0 || rejected > 0) && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <span className="rounded-md bg-emerald-50 px-2.5 py-1 font-medium text-emerald-700 [.dark_&]:bg-emerald-400/10 [.dark_&]:text-emerald-300">
                {recipientRows.length} valid
              </span>

              <span className="rounded-md bg-rose-50 px-2.5 py-1 font-medium text-rose-700 [.dark_&]:bg-rose-400/10 [.dark_&]:text-rose-300">
                {rejected} skipped
              </span>

              {recipientRows.length > 0 && (
                <button
                  type="button"
                  onClick={clearRecipients}
                  className="px-2 text-slate-500 underline-offset-2 hover:text-rose-600 hover:underline [.dark_&]:text-slate-400"
                >
                  Clear list
                </button>
              )}
            </div>
          )}

          {recipientRows.length > 0 && (
            <>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {recipientRows.slice(0, 8).map((recipient) => (
                  <span
                    key={recipient.email}
                    className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700 [.dark_&]:bg-slate-800 [.dark_&]:text-slate-300"
                  >
                    {recipient.email}
                  </span>
                ))}

                {recipientRows.length > 8 && (
                  <span className="px-1 py-1 text-xs text-slate-500 [.dark_&]:text-slate-400">
                    +{recipientRows.length - 8} more
                  </span>
                )}
              </div>

              {availableFields.length > 0 && (
                <div className="mt-4 rounded-xl border border-indigo-100 bg-indigo-50/60 p-4 [.dark_&]:border-indigo-400/20 [.dark_&]:bg-indigo-400/5">
                  <p className="text-sm font-medium text-indigo-950 [.dark_&]:text-indigo-200">
                    Personalization fields available
                  </p>

                  <p className="mt-1 text-xs leading-5 text-slate-600 [.dark_&]:text-slate-300">
                    Use double curly braces in the subject or body, such
                    as <code>{"{{name}}"}</code>.
                  </p>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {availableFields.map((field) => (
                      <button
                        key={field}
                        type="button"
                        title={`Insert {{${field}}} into the message body`}
                        onClick={() =>
                          setBody((previous) => `${previous}{{${field}}}`)
                        }
                        className="rounded-md border border-indigo-200 bg-white px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100 [.dark_&]:border-indigo-400/30 [.dark_&]:bg-slate-900 [.dark_&]:text-indigo-300"
                      >
                        {`{{${field}}}`}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-4 flex gap-2">
                <input
                  className={inputClass}
                  placeholder="Save these recipients as a list..."
                  value={listName}
                  onChange={(event) => setListName(event.target.value)}
                  aria-label="Mailing list name"
                />

                <button
                  type="button"
                  onClick={() => void saveCurrentList()}
                  disabled={savingList}
                  className={`${ghostButton} shrink-0`}
                >
                  {savingList ? "Saving..." : "Save list"}
                </button>
              </div>
            </>
          )}
        </Step>

        <Step
          n={3}
          title="Message"
          hint="Write one message and personalize it for every recipient."
        >
          <div className="space-y-4">
            <div>
              <label
                htmlFor="subject"
                className="mb-1.5 block text-sm font-medium"
              >
                Subject line
              </label>

              <input
                id="subject"
                className={inputClass}
                placeholder="e.g. An update for {{name}}"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label htmlFor="body" className="text-sm font-medium">
                  Email body
                </label>

                <span className="text-xs tabular-nums text-slate-400">
                  {body.length} characters
                </span>
              </div>

              <textarea
                id="body"
                className={`${inputClass} resize-y leading-6`}
                rows={8}
                placeholder={"Hello {{name}},\n\nYour update is ready."}
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />

              <p className="mt-2 text-xs text-slate-500 [.dark_&]:text-slate-400">
                Example: Hello {"{{name}}"}.
              </p>
            </div>
          </div>

          {recipientRows.length > 0 &&
            (subject.includes("{{") || body.includes("{{")) && (
              <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4 [.dark_&]:border-slate-800 [.dark_&]:bg-slate-950/50">
                <div className="flex items-center justify-between gap-3">
                  <h5 className="text-sm font-semibold">
                    Personalization preview
                  </h5>

                  <span className="text-xs text-slate-500 [.dark_&]:text-slate-400">
                    First recipient
                  </span>
                </div>

                <div className="mt-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500 [.dark_&]:text-slate-400">
                    Subject
                  </p>

                  <p className="mt-1 break-words text-sm font-medium">
                    {previewSubject || "No subject yet"}
                  </p>
                </div>

                <div className="mt-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500 [.dark_&]:text-slate-400">
                    Message
                  </p>

                  <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700 [.dark_&]:text-slate-300">
                    {previewBody || "No message yet"}
                  </p>
                </div>
              </div>
            )}
        </Step>

        <Step
          n={4}
          title="Schedule"
          hint="Choose when sending starts and how far apart messages are."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="start"
                className="mb-1.5 block text-sm font-medium"
              >
                Start time
              </label>

              <input
                id="start"
                type="datetime-local"
                className={`${inputClass} [.dark_&]:[color-scheme:dark]`}
                value={startAt}
                onChange={(event) => setStartAt(event.target.value)}
              />

              <p className="mt-1.5 text-xs text-slate-500 [.dark_&]:text-slate-400">
                Leave empty to start now.
              </p>
            </div>

            <div>
              <label
                htmlFor="delay"
                className="mb-1.5 block text-sm font-medium"
              >
                Delay between emails
              </label>

              <div className="flex items-center gap-2">
                <input
                  id="delay"
                  type="number"
                  min={0}
                  step={1}
                  className={inputClass}
                  value={delay}
                  onChange={(event) => setDelay(Number(event.target.value))}
                />

                <span className="text-sm text-slate-500 [.dark_&]:text-slate-400">
                  seconds
                </span>
              </div>

              <p className="mt-1.5 text-xs text-slate-500 [.dark_&]:text-slate-400">
                Spacing between each message.
              </p>
            </div>
          </div>
        </Step>
      </div>

      <aside className="space-y-4 xl:sticky xl:top-8">
        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm [.dark_&]:border-slate-800 [.dark_&]:bg-slate-900 sm:p-6">
          <h3 className="text-sm font-semibold">Summary</h3>

          <p className="mt-4 text-4xl font-semibold tabular-nums tracking-tight">
            {recipientRows.length.toLocaleString()}
          </p>

          <p className="text-sm text-slate-500 [.dark_&]:text-slate-400">
            recipients ready
          </p>

          <dl className="mt-5 space-y-3 border-t border-slate-200 pt-4 text-sm [.dark_&]:border-slate-800">
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500 [.dark_&]:text-slate-400">
                Sender
              </dt>

              <dd
                className="max-w-[170px] truncate font-medium"
                title={selectedSender}
              >
                {selectedSender ?? "None"}
              </dd>
            </div>

            <div className="flex justify-between gap-4">
              <dt className="text-slate-500 [.dark_&]:text-slate-400">
                Starts
              </dt>

              <dd className="text-right font-medium">
                {startValid
                  ? prettyDate(startDate!.toISOString())
                  : "Right away"}
              </dd>
            </div>

            <div className="flex justify-between gap-4">
              <dt className="text-slate-500 [.dark_&]:text-slate-400">
                Spacing
              </dt>

              <dd className="font-medium tabular-nums">{delay}s</dd>
            </div>

            <div className="flex justify-between gap-4">
              <dt className="text-slate-500 [.dark_&]:text-slate-400">
                Estimated finish
              </dt>

              <dd className="text-right font-medium">
                {recipientRows.length > 0 ? (
                  <>
                    {prettyDate(finishDate.toISOString())}

                    <span className="block text-xs font-normal text-slate-400 [.dark_&]:text-slate-500">
                      over {formatDuration(totalSeconds)}
                    </span>
                  </>
                ) : (
                  "â€”"
                )}
              </dd>
            </div>
          </dl>

          <ul className="mt-5 space-y-2.5 border-t border-slate-200 pt-4 text-sm [.dark_&]:border-slate-800">
            {checklist.map((item) => (
              <li key={item.label} className="flex items-center gap-2.5">
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${item.done
                      ? "bg-indigo-600 text-white [.dark_&]:bg-indigo-400 [.dark_&]:text-slate-950"
                      : "border border-slate-300 text-transparent [.dark_&]:border-slate-700"
                    }`}
                >
                  <Icon name="check" className="h-3 w-3" />
                </span>

                <span
                  className={
                    item.done
                      ? "text-slate-900 [.dark_&]:text-slate-100"
                      : "text-slate-500 [.dark_&]:text-slate-400"
                  }
                >
                  {item.label}
                </span>
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
            className={`${primaryButton} mt-6 w-full`}
          >
            <Icon name="send" />
            {submitting ? "Scheduling..." : "Schedule emails"}
          </button>

          <p className="mt-3 text-center text-xs text-slate-500 [.dark_&]:text-slate-400">
            Maximum {MAX_RECIPIENTS} recipients per request.
          </p>
        </div>
      </aside>
    </div>
  );
}
