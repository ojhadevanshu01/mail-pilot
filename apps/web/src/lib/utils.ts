export const BRAND = "MailPilot";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function prettyDate(value: string | null) {
  if (!value) return "â€”";

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? "â€”"
    : date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.round(totalSeconds));

  if (seconds < 60) return `${seconds}s`;

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;

  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/**
 * Parses CSV content while supporting quoted cells, commas inside quotes,
 * escaped quotes ("") and Windows/Unix line endings.
 */
function parseCsvRows(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    if (char === '"') {
      if (quoted && content[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }

      continue;
    }

    if (!quoted && (char === "," || char === "\n" || char === "\r")) {
      row.push(field.trim());
      field = "";

      if (char === "\r" && content[i + 1] === "\n") {
        i++;
      }

      if (char !== ",") {
        if (row.some((cell) => cell.length > 0)) {
          rows.push(row);
        }

        row = [];
      }

      continue;
    }

    field += char;
  }

  row.push(field.trim());

  if (row.some((cell) => cell.length > 0)) {
    rows.push(row);
  }

  return rows;
}

function normalizeColumnName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const EMAIL_COLUMN_ALIASES = new Set([
  "email",
  "emails",
  "emailaddress",
  "emailaddresses",
  "emailid",
  "emailids",
  "mail",
  "mailaddress",
  "recipient",
  "recipientemail",
  "recipientaddress",
  "contactemail",
  "primaryemail",
  "workemail",
  "businessemail",
  "gmail",
  "gmailaddress",
  "emailaddr",
  "eaddress",
  "e_mail",
]);

/**
 * A parsed CSV row keeps all its original columns.
 * For example:
 * {
 *   id: "101",
 *   name: "Raj",
 *   gmailaddress: "raj@example.com",
 *   company: "Example Ltd"
 * }
 */
export type CsvRecipientRow = Record<string, string>;

export type ParsedRecipient = {
  email: string;
  fields: CsvRecipientRow;
  rowNumber: number;
};

export type ParsedCsvData = {
  headers: string[];
  rows: CsvRecipientRow[];
  suggestedEmailColumn: string | null;
};

/**
 * Parse a CSV file without discarding any columns.
 *
 * The first non-empty row is treated as the header row.
 * Arbitrary headers are supported; only email-column detection uses aliases.
 */
export function parseCsvData(content: string): ParsedCsvData {
  const normalized = content.replace(/^\uFEFF/, "").trim();

  if (!normalized) {
    return {
      headers: [],
      rows: [],
      suggestedEmailColumn: null,
    };
  }

  const table = parseCsvRows(normalized);

  if (table.length < 2) {
    return {
      headers: table[0] ?? [],
      rows: [],
      suggestedEmailColumn: null,
    };
  }

  const rawHeaders = table[0];

  const usedHeaders = new Set<string>();

  const headers = rawHeaders.map((rawHeader, index) => {
    const trimmed = rawHeader.trim();
    const base = trimmed || `column_${index + 1}`;

    let header = base;
    let suffix = 2;

    while (usedHeaders.has(header.toLowerCase())) {
      header = `${base}_${suffix}`;
      suffix++;
    }

    usedHeaders.add(header.toLowerCase());

    return header;
  });

  const rows = table.slice(1).map((cells) => {
    const record: CsvRecipientRow = {};

    headers.forEach((header, index) => {
      record[header] = cells[index] ?? "";
    });

    return record;
  });

  const suggestedEmailColumn =
    headers.find((header) =>
      EMAIL_COLUMN_ALIASES.has(normalizeColumnName(header)),
    ) ?? null;

  return {
    headers,
    rows,
    suggestedEmailColumn,
  };
}

/**
 * Turn parsed CSV rows into recipient records using the selected email column.
 *
 * The other fields remain attached to each recipient for personalization.
 * Invalid addresses are rejected, and duplicate email addresses are skipped.
 */
export function buildPersonalizedRecipients(
  data: ParsedCsvData,
  emailColumn: string,
): {
  recipients: ParsedRecipient[];
  rejected: number;
  duplicates: number;
} {
  const recipients: ParsedRecipient[] = [];
  const seenEmails = new Set<string>();

  let rejected = 0;
  let duplicates = 0;

  if (!data.headers.includes(emailColumn)) {
    return { recipients, rejected: data.rows.length, duplicates };
  }

  data.rows.forEach((fields, index) => {
    const email = (fields[emailColumn] ?? "").trim().toLowerCase();

    if (!email || !EMAIL_RE.test(email)) {
      rejected++;
      return;
    }

    if (seenEmails.has(email)) {
      duplicates++;
      return;
    }

    seenEmails.add(email);

    recipients.push({
      email,
      fields,
      // Header is CSV row 1, so the first recipient is on row 2.
      rowNumber: index + 2,
    });
  });

  return { recipients, rejected, duplicates };
}

/**
 * Backward-compatible parser for existing features that only need email strings.
 * Existing recipient lists and the current ComposeForm can keep using this.
 */
export function parseRecipients(content: string) {
  const normalized = content.replace(/^\uFEFF/, "").trim();

  if (!normalized) {
    return {
      unique: [] as string[],
      rejected: 0,
    };
  }

  const looksLikeCsv =
    normalized.includes(",") ||
    normalized.includes("\n") ||
    normalized.includes("\r");

  // Preserve the old behavior for plain email lists.
  const values = looksLikeCsv
    ? parseCsvRows(normalized).flat()
    : normalized.split(/[\s,;]+/);

  const valid: string[] = [];
  let rejected = 0;

  for (const rawValue of values) {
    const value = rawValue.trim().replace(/^["']|["']$/g, "");

    if (!value) continue;

    const header = normalizeColumnName(value);

    if (
      [
        ...EMAIL_COLUMN_ALIASES,
        "name",
        "fullname",
        "firstname",
        "first",
        "lastname",
        "last",
        "company",
        "id",
      ].includes(header)
    ) {
      continue;
    }

    const matches = value.match(
      /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi,
    );

    if (matches?.length) {
      for (const match of matches) {
        const email = match.toLowerCase();

        if (EMAIL_RE.test(email)) {
          valid.push(email);
        } else {
          rejected++;
        }
      }

      continue;
    }

    if (value.includes("@")) {
      rejected++;
    }
  }

  return {
    unique: [...new Set(valid)],
    rejected,
  };
}
