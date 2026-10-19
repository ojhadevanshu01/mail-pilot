import type { Email, MailingList, MailingListRecipient, Sender, Stats } from "./types";

export const API =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  return fetch(input, { ...init, credentials: "include" });
}

async function readJson(response: Response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export async function fetchSenders(): Promise<Sender[]> {
  const response = await apiFetch(`${API}/api/senders`);
  if (!response.ok) throw new Error("Could not load senders.");

  const json = await readJson(response);
  return json.data ?? [];
}

export async function createSender(email: string, appPassword: string): Promise<Sender> {
  const response = await apiFetch(`${API}/api/senders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, appPassword, name: email.split("@")[0] }),
  });

  const json = await readJson(response);

  if (!response.ok) {
    throw new Error(json.error || "Could not add sender.");
  }

  return json.data;
}

export async function deleteSender(id: string): Promise<void> {
  const response = await apiFetch(`${API}/api/senders/${encodeURIComponent(id)}`, { method: "DELETE" });
  const json = await readJson(response);
  if (!response.ok) throw new Error(json.error || "Could not delete Gmail account.");
}

export async function fetchStats(): Promise<Stats | null> {
  try {
    const response = await apiFetch(`${API}/api/emails/stats`);
    if (!response.ok) return null;

    const json = await readJson(response);
    const d = json.data;

    if (!d) return null;

    return {
      scheduled: d.scheduled ?? 0,
      processing: d.processing ?? 0,
      sent: d.sent ?? 0,
      failed: d.failed ?? 0,
      cancelled: d.cancelled ?? 0,
    };
  } catch {
    return null;
  }
}

export async function fetchEmails(
  status: string,
  query: string,
  signal?: AbortSignal,
): Promise<Email[]> {
  const q = query.trim();

  const url = q
    ? `${API}/api/emails/search?q=${encodeURIComponent(q)}`
    : `${API}/api/emails/${status}`;

  const response = await apiFetch(url, { signal });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }

  const json = await readJson(response);
  let rows: Email[] = json.data ?? [];

  if (q) {
    rows = rows.filter(
      (email) => email.status.toLowerCase() === status.toLowerCase(),
    );
  }

  return rows;
}

/**
 * Custom fields associated with one CSV recipient.
 *
 * Example:
 * {
 *   email: "student@example.com",
 *   fields: { studentName: "Aman", rollNo: "101" }
 * }
 */
export type BulkRecipient = {
  email: string;
  fields?: Record<string, string | number | boolean>;
};

/**
 * Supports email-only recipients and personalized CSV rows.
 */
export type BulkPayload = {
  senderId: string;
  recipients: Array<string | BulkRecipient>;

  /**
   * Optional CSV column containing recipient email addresses.
   */
  emailColumn?: string;

  subject: string;
  body: string;
  startAt?: string;
  delaySeconds: number;
};

export async function scheduleBulk(
  payload: BulkPayload,
): Promise<number> {
  const response = await apiFetch(`${API}/api/emails/schedule-bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const json = await readJson(response);

  if (!response.ok) {
    throw new Error(json.error || "Scheduling failed.");
  }

  return json.data.count;
}

export async function cancelEmail(id: string): Promise<void> {
  const response = await apiFetch(
    `${API}/api/emails/${encodeURIComponent(id)}/cancel`,
    { method: "POST" },
  );

  const json = await readJson(response);

  if (!response.ok) {
    throw new Error(json.error || "Could not cancel the email.");
  }
}

export async function fetchLists(): Promise<MailingList[]> {
  const response = await apiFetch(`${API}/api/lists`);

  if (!response.ok) {
    throw new Error("Could not load mailing lists.");
  }

  const json = await readJson(response);
  return json.data ?? [];
}

export async function createList(
  name: string,
  recipients: string[] | MailingListRecipient[],
): Promise<MailingList> {
  const recipientDetails = recipients.length > 0 && typeof recipients[0] !== "string"
    ? recipients as MailingListRecipient[]
    : undefined;
  const emailRecipients = recipientDetails
    ? recipientDetails.map((recipient) => recipient.email)
    : recipients as string[];

  const response = await apiFetch(`${API}/api/lists`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, recipients: emailRecipients, recipientDetails }),
  });

  const json = await readJson(response);

  if (!response.ok) {
    throw new Error(json.error || "Could not save the list.");
  }

  return json.data;
}

export async function renameList(
  id: string,
  name: string,
): Promise<void> {
  const response = await apiFetch(
    `${API}/api/lists/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );

  const json = await readJson(response);

  if (!response.ok) {
    throw new Error(json.error || "Could not rename the list.");
  }
}

export async function deleteList(id: string): Promise<void> {
  const response = await apiFetch(
    `${API}/api/lists/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );

  const json = await readJson(response);

  if (!response.ok) {
    throw new Error(json.error || "Could not delete the list.");
  }
}

export type SchedulingGroup = {
  id: string;
  name: string | null;
  senderId: string;
  startAt: string;
  delaySeconds: number;
  createdAt: string;
  sender: {
    email: string;
    name: string | null;
  };
  counts: {
    total: number;
    scheduled: number;
    processing: number;
    sent: number;
    failed: number;
    cancelled: number;
  };
};

export type GroupRecipient = {
  id: string;
  recipient: string;
  subject: string;
  body: string;
  status: string;
  scheduledAt: string;
  sentAt: string | null;
  attempts: number;
  errorMessage: string | null;
  createdAt: string;
};

export async function fetchGroups(page = 1, q = "") {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: "10",
  });

  if (q.trim()) {
    params.set("q", q.trim());
  }

  const response = await apiFetch(`${API}/api/groups?${params}`);
  const json = await readJson(response);

  if (!response.ok) {
    throw new Error(json.error || "Could not load scheduling groups.");
  }

  return {
    data: (json.data ?? []) as SchedulingGroup[],
    pagination: json.pagination as {
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
    },
  };
}

export async function fetchGroupRecipients(
  groupId: string,
  page = 1,
) {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: "20",
  });

  const response = await apiFetch(
    `${API}/api/groups/${encodeURIComponent(groupId)}/recipients?${params}`,
  );

  const json = await readJson(response);

  if (!response.ok) {
    throw new Error(json.error || "Could not load recipients.");
  }

  return {
    data: (json.data ?? []) as GroupRecipient[],
    pagination: json.pagination as {
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
    },
  };
}

export type GroupRecipientInput = {
  email: string;
  fields?: Record<string, string>;
};

export async function addGroupRecipients(
  groupId: string,
  recipients: Array<string | GroupRecipientInput>,
) {
  const response = await apiFetch(
    `${API}/api/groups/${encodeURIComponent(groupId)}/recipients`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipients }),
    },
  );

  const json = await readJson(response);

  if (!response.ok) {
    throw new Error(json.error || "Could not add recipients.");
  }

  return json.data as {
    groupId: string;
    added: number;
    skippedExisting: number;
    invalid?: number;
    duplicatesInUpload?: number;
    missingFields?: number;
    queueErrors?: number;
    requiredFields?: string[];
  };
}

export async function removeGroupRecipient(
  groupId: string,
  emailId: string,
): Promise<void> {
  const response = await apiFetch(
    `${API}/api/groups/${encodeURIComponent(groupId)}/recipients/${encodeURIComponent(emailId)}`,
    { method: "DELETE" },
  );

  const json = await readJson(response);

  if (!response.ok) {
    throw new Error(json.error || "Could not remove this recipient.");
  }
}

export async function rescheduleGroup(
  groupId: string,
  startAt: string,
  delaySeconds: number,
): Promise<{ rescheduled: number; queueErrors: number }> {
  const response = await apiFetch(
    `${API}/api/groups/${encodeURIComponent(groupId)}/reschedule`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startAt, delaySeconds }),
    },
  );

  const json = await readJson(response);

  if (!response.ok) {
    throw new Error(json.error || "Could not reschedule group.");
  }

  return json.data as {
    rescheduled: number;
    queueErrors: number;
  };
}

export async function cancelGroupScheduledEmails(
  groupId: string,
): Promise<number> {
  const response = await apiFetch(
    `${API}/api/groups/${encodeURIComponent(groupId)}/cancel-scheduled`,
    { method: "POST" },
  );

  const json = await readJson(response);

  if (!response.ok) {
    throw new Error(
      json.error || "Could not cancel scheduled group emails.",
    );
  }

  return Number(json.data?.cancelled ?? 0);
}

/**
 * Update the subject and body of all scheduled emails in a group.
 * Requires the matching PATCH endpoint in the API.
 */
export async function updateGroupEmailContent(
  groupId: string,
  changes: {
    subject: string;
    body: string;
  },
): Promise<{ updated: number }> {
  const response = await apiFetch(
    `${API}/api/groups/${encodeURIComponent(groupId)}/email-content`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    },
  );

  const json = await readJson(response);

  if (!response.ok) {
    throw new Error(
      json.error || "Could not update the group's email content.",
    );
  }

  return {
    updated: Number(json.updated ?? json.data?.updated ?? 0),
  };
}

export async function updateScheduledEmail(
  id: string,
  changes: {
    subject?: string;
    body?: string;
    scheduledAt?: string;
  },
): Promise<Email> {
  const response = await apiFetch(
    `${API}/api/emails/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    },
  );

  const json = await readJson(response);

  if (!response.ok) {
    throw new Error(json.error || "Could not update scheduled email.");
  }

  return json.data as Email;
}
