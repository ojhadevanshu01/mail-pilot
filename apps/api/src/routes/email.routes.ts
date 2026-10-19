import { Router } from "express";
import prisma from "../lib/prisma";
import { emailQueue, enqueueEmail } from "../queue/email.queue";

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 500;
const MAX_DELAY_SECONDS = 86400;

const ALLOWED_STATUSES = [
  "SCHEDULED",
  "SENT",
  "FAILED",
  "CANCELLED",
] as const;

type SearchStatus = (typeof ALLOWED_STATUSES)[number];
type RecipientField = string | number | boolean;
type RecipientFields = Record<string, RecipientField>;

type BulkRecipient = {
  email: string;
  fields: RecipientFields;
};

const EMAIL_FIELD_NAMES = [
  "email",
  "emailaddress",
  "recipient",
  "recipientemail",
  "gmailaddress",
  "mail",
  "mailaddress",
  "emailid",
  "recipientaddress",
  "emailaddr",
] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as { code: unknown }).code);
  }

  return undefined;
}

function isValidDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !Number.isNaN(new Date(value).getTime())
  );
}

function normalizeFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getTemplatePlaceholders(subject: string, body: string): string[] {
  const found = new Map<string, string>();
  for (const match of `${subject}\n${body}`.matchAll(/{{\s*([^{}]+?)\s*}}/g)) {
    const name = match[1].trim();
    const normalized = normalizeFieldName(name);
    if (normalized && !found.has(normalized)) found.set(normalized, name);
  }
  return [...found.values()];
}

function getMissingTemplateFields(
  value: unknown,
  recipient: string,
  subject: string,
  body: string,
): string[] {
  const source =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  // {{email}} is built-in and comes from Email.recipient, not recipientData.
  const fields = new Map<string, string>();
  for (const [key, fieldValue] of Object.entries(source)) {
    fields.set(normalizeFieldName(key), String(fieldValue ?? "").trim());
  }
  fields.set("email", recipient.trim());

  return getTemplatePlaceholders(subject, body).filter(
    (field) => !fields.get(normalizeFieldName(field)),
  );
}

/**
 * Extract only scalar personalization values.
 *
 * Supports both:
 *   { email: "person@example.com", name: "Alex" }
 * and:
 *   { email: "person@example.com", fields: { name: "Alex" } }
 *
 * Email addresses are stored separately from personalization fields.
 */
function extractRecipientFields(
  value: Record<string, unknown>,
  emailColumn?: string,
): RecipientFields {
  const result: RecipientFields = {};

  const nestedFields =
    typeof value.fields === "object" &&
    value.fields !== null &&
    !Array.isArray(value.fields)
      ? (value.fields as Record<string, unknown>)
      : null;

  const source = nestedFields ?? value;

  const normalizedEmailColumn = emailColumn
    ? normalizeFieldName(emailColumn)
    : undefined;

  for (const [key, fieldValue] of Object.entries(source)) {
    const normalizedKey = normalizeFieldName(key);

    if (
      !normalizedKey ||
      normalizedKey === "fields" ||
      normalizedKey === "emailcolumn" ||
      EMAIL_FIELD_NAMES.includes(
        normalizedKey as (typeof EMAIL_FIELD_NAMES)[number],
      )
    ) {
      continue;
    }

    if (
      normalizedEmailColumn &&
      normalizedKey === normalizedEmailColumn
    ) {
      continue;
    }

    if (
      typeof fieldValue === "string" ||
      typeof fieldValue === "number" ||
      typeof fieldValue === "boolean"
    ) {
      result[key.trim()] = fieldValue;
    }
  }

  return result;
}

/**
 * Convert all supported recipient formats into one consistent shape.
 */
function normalizeRecipients(
  input: unknown,
  emailColumn?: string,
): BulkRecipient[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const recipients = new Map<string, BulkRecipient>();

  const normalizedEmailColumn = emailColumn
    ? normalizeFieldName(emailColumn)
    : undefined;

  for (const item of input) {
    let rawEmail: unknown;
    let fields: RecipientFields = {};

    if (typeof item === "string") {
      rawEmail = item;
    } else if (
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item)
    ) {
      const row = item as Record<string, unknown>;

      if (typeof row.email === "string") {
        rawEmail = row.email;
      } else if (typeof row.recipient === "string") {
        rawEmail = row.recipient;
      } else if (normalizedEmailColumn) {
        const matchingKey = Object.keys(row).find(
          (key) =>
            normalizeFieldName(key) === normalizedEmailColumn,
        );

        rawEmail = matchingKey ? row[matchingKey] : undefined;
      } else {
        const matchingKey = Object.keys(row).find((key) =>
          EMAIL_FIELD_NAMES.includes(
            normalizeFieldName(key) as (typeof EMAIL_FIELD_NAMES)[number],
          ),
        );

        rawEmail = matchingKey ? row[matchingKey] : undefined;
      }

      fields = extractRecipientFields(row, emailColumn);
    } else {
      continue;
    }

    if (typeof rawEmail !== "string") {
      continue;
    }

    const email = rawEmail.trim().toLowerCase();

    if (!EMAIL_RE.test(email)) {
      continue;
    }

    // Keep the first occurrence of each address.
    if (!recipients.has(email)) {
      recipients.set(email, { email, fields });
    }
  }

  return Array.from(recipients.values());
}

function isReplaceableQueueState(state: string): boolean {
  return [
    "waiting",
    "delayed",
    "paused",
    "prioritized",
    "waiting-children",
  ].includes(state);
}

/**
 * Schedule one email.
 */
router.post("/schedule", async (req, res) => {
  const {
    senderId,
    recipient,
    subject,
    body,
    scheduledAt,
    idempotencyKey,
    recipientData,
  } = req.body ?? {};

  if (
    !isNonEmptyString(senderId) ||
    !isNonEmptyString(recipient) ||
    !isNonEmptyString(subject) ||
    !isNonEmptyString(body) ||
    !isValidDate(scheduledAt)
  ) {
    return res.status(400).json({
      error:
        "senderId, recipient, subject, body, and a valid scheduledAt are required.",
    });
  }

  const normalizedRecipient = recipient.trim().toLowerCase();

  if (!EMAIL_RE.test(normalizedRecipient)) {
    return res.status(400).json({
      error: "recipient must be a valid email address.",
    });
  }

  if (
    idempotencyKey !== undefined &&
    (!isNonEmptyString(idempotencyKey) ||
      idempotencyKey.trim().length > 255)
  ) {
    return res.status(400).json({
      error:
        "idempotencyKey must be a non-empty string of at most 255 characters.",
    });
  }

  if (
    recipientData !== undefined &&
    (typeof recipientData !== "object" ||
      recipientData === null ||
      Array.isArray(recipientData))
  ) {
    return res.status(400).json({
      error: "recipientData must be an object when provided.",
    });
  }

  const normalizedRecipientData =
    recipientData !== undefined
      ? extractRecipientFields({ fields: recipientData })
      : undefined;

  const date = new Date(scheduledAt);

  try {
    const ownedSender = await prisma.sender.findFirst({ where: { id: senderId.trim(), userId: req.userId! }, select: { id: true, connectionStatus: true } });
    if (!ownedSender) return res.status(404).json({ error: "Sender not found." });
    if (ownedSender.connectionStatus !== "CONNECTED") return res.status(400).json({ error: "Connect and verify this Gmail account from Gmail Accounts before scheduling emails." });
    const email = await prisma.email.create({
      data: {
        senderId: senderId.trim(),
        recipient: normalizedRecipient,
        subject: subject.trim(),
        body,
        scheduledAt: date,
        ...(normalizedRecipientData !== undefined
          ? { recipientData: normalizedRecipientData }
          : {}),
        ...(idempotencyKey !== undefined
          ? { idempotencyKey: idempotencyKey.trim() }
          : {}),
      },
    });

    try {
      const jobId = await enqueueEmail(email.id, date);

      const saved = await prisma.email.update({
        where: { id: email.id },
        data: { bullmqJobId: jobId },
      });

      return res.status(201).json({
        data: saved,
        queueStatus: "QUEUED",
      });
    } catch (queueError) {
      console.error(
        `Queue enqueue failed for email ${email.id}:`,
        queueError,
      );

      return res.status(201).json({
        data: email,
        queueStatus: "PENDING_RECONCILIATION",
        warning:
          "The email was saved, but its queue job could not be confirmed. The worker reconciliation process should restore it.",
      });
    }
  } catch (error) {
    if (getErrorCode(error) === "P2002") {
      return res.status(409).json({
        error: "An email with this unique identifier already exists.",
      });
    }

    if (getErrorCode(error) === "P2003") {
      return res.status(400).json({
        error: "The specified sender does not exist.",
      });
    }

    console.error("Failed to create email record:", error);

    return res.status(500).json({
      error: "Unable to create email record.",
    });
  }
});

/**
 * List scheduled emails.
 */
router.get("/scheduled", async (req, res) => {
  try {
    const emails = await prisma.email.findMany({
      where: { status: "SCHEDULED", sender: { userId: req.userId! } },
      orderBy: { scheduledAt: "asc" },
      take: 100,
    });

    return res.json({ data: emails });
  } catch (error) {
    console.error("Failed to list scheduled emails:", error);

    return res.status(500).json({
      error: "Unable to list scheduled emails.",
    });
  }
});

/**
 * Bulk schedule emails with optional per-recipient personalization.
 */
router.post("/schedule-bulk", async (req, res) => {
  const {
    senderId,
    recipients,
    emailColumn,
    subject,
    body,
    startAt,
    delaySeconds,
    groupName,
  } = req.body ?? {};

  if (
    !isNonEmptyString(senderId) ||
    !isNonEmptyString(subject) ||
    !isNonEmptyString(body) ||
    !Array.isArray(recipients)
  ) {
    return res.status(400).json({
      error: "senderId, recipients, subject, and body are required.",
    });
  }

  if (recipients.length === 0) {
    return res.status(400).json({
      error: "At least one recipient is required.",
    });
  }

  if (recipients.length > MAX_RECIPIENTS) {
    return res.status(400).json({
      error: `Maximum ${MAX_RECIPIENTS} recipient rows per request.`,
    });
  }

  if (
    emailColumn !== undefined &&
    !isNonEmptyString(emailColumn)
  ) {
    return res.status(400).json({
      error: "emailColumn must be a non-empty string when provided.",
    });
  }

  if (
    groupName !== undefined &&
    (typeof groupName !== "string" ||
      groupName.trim().length === 0)
  ) {
    return res.status(400).json({
      error: "groupName must be a non-empty string when provided.",
    });
  }

  const valid = normalizeRecipients(
    recipients,
    isNonEmptyString(emailColumn) ? emailColumn.trim() : undefined,
  );

  if (valid.length === 0) {
    return res.status(400).json({
      error:
        "No valid recipient email addresses were found. Check your email column and CSV data.",
    });
  }

  if (startAt !== undefined && !isValidDate(startAt)) {
    return res.status(400).json({
      error: "startAt must be a valid date/time.",
    });
  }

  const start = startAt === undefined ? new Date() : new Date(startAt);
  const delay = Number(delaySeconds ?? 0);

  if (
    !Number.isFinite(delay) ||
    delay < 0 ||
    delay > MAX_DELAY_SECONDS
  ) {
    return res.status(400).json({
      error: `delaySeconds must be between 0 and ${MAX_DELAY_SECONDS}.`,
    });
  }

  const delayInSeconds = Math.floor(delay);

  try {
    const ownedSender = await prisma.sender.findFirst({ where: { id: senderId.trim(), userId: req.userId! }, select: { id: true, connectionStatus: true } });
    if (!ownedSender) return res.status(404).json({ error: "Sender not found." });
    if (ownedSender.connectionStatus !== "CONNECTED") return res.status(400).json({ error: "Connect and verify this Gmail account from Gmail Accounts before scheduling emails." });
    const result = await prisma.$transaction(
      async (tx) => {
        const group = await tx.schedulingGroup.create({
          data: {
            name: isNonEmptyString(groupName)
              ? groupName.trim().slice(0, 120)
              : subject.trim().slice(0, 120),
            senderId: senderId.trim(),
            startAt: start,
            delaySeconds: delayInSeconds,
          },
        });

        const emails = [];

        for (let i = 0; i < valid.length; i++) {
          const recipient = valid[i];

          const scheduledAt = new Date(
            start.getTime() + i * delayInSeconds * 1000,
          );

          const email = await tx.email.create({
            data: {
              groupId: group.id,
              senderId: senderId.trim(),
              recipient: recipient.email,
              recipientData: recipient.fields,
              subject: subject.trim(),
              body,
              scheduledAt,
            },
          });

          emails.push(email);
        }

        return { group, emails };
      },
      {
        maxWait: 10000,
        timeout: 30000,
      },
    );

    let queued = 0;
    let queueErrors = 0;

    for (const email of result.emails) {
      try {
        const jobId = await enqueueEmail(
          email.id,
          email.scheduledAt,
        );

        await prisma.email.update({
          where: { id: email.id },
          data: { bullmqJobId: jobId },
        });

        queued++;
      } catch (error) {
        queueErrors++;

        console.error(
          `Queue enqueue failed for email ${email.id}:`,
          error,
        );
      }
    }

    return res.status(201).json({
      data: {
        count: result.emails.length,
        groupId: result.group.id,
        queued,
        queueErrors,
        queueStatus:
          queueErrors === 0 ? "QUEUED" : "PARTIALLY_QUEUED",
      },
    });
  } catch (error) {
    if (getErrorCode(error) === "P2003") {
      return res.status(400).json({
        error: "The specified sender does not exist.",
      });
    }

    console.error("Bulk scheduling failed:", error);

    return res.status(500).json({
      error: "Unable to schedule emails.",
    });
  }
});

/**
 * List sent emails.
 */
router.get("/sent", async (req, res) => {
  try {
    const emails = await prisma.email.findMany({
      where: { status: "SENT", sender: { userId: req.userId! } },
      orderBy: { sentAt: "desc" },
      take: 100,
    });

    return res.json({ data: emails });
  } catch (error) {
    console.error("Failed to list sent emails:", error);

    return res.status(500).json({
      error: "Unable to list sent emails.",
    });
  }
});

/**
 * List failed emails.
 */
router.get("/failed", async (req, res) => {
  try {
    const emails = await prisma.email.findMany({
      where: { status: "FAILED", sender: { userId: req.userId! } },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });

    return res.json({ data: emails });
  } catch (error) {
    console.error("Failed to list failed emails:", error);

    return res.status(500).json({
      error: "Unable to list failed emails.",
    });
  }
});

/**
 * List cancelled emails.
 */
router.get("/cancelled", async (req, res) => {
  try {
    const emails = await prisma.email.findMany({
      where: { status: "CANCELLED", sender: { userId: req.userId! } },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });

    return res.json({ data: emails });
  } catch (error) {
    console.error("Failed to list cancelled emails:", error);

    return res.status(500).json({
      error: "Unable to list cancelled emails.",
    });
  }
});

/**
 * Search emails by recipient, subject, or body.
 */
router.get("/search", async (req, res) => {
  const q =
    typeof req.query.q === "string" ? req.query.q.trim() : "";

  const rawStatus =
    typeof req.query.status === "string"
      ? req.query.status.trim().toUpperCase()
      : "";

  if (!q) {
    return res.status(400).json({
      error: "Provide a non-empty search query using ?q=...",
    });
  }

  if (q.length > 200) {
    return res.status(400).json({
      error: "Search query must be 200 characters or fewer.",
    });
  }

  if (
    rawStatus &&
    !ALLOWED_STATUSES.includes(rawStatus as SearchStatus)
  ) {
    return res.status(400).json({
      error: "Invalid email status filter.",
    });
  }

  const status = rawStatus
    ? (rawStatus as SearchStatus)
    : undefined;

  try {
    const emails = await prisma.email.findMany({
      where: {
        sender: { userId: req.userId! },
        ...(status ? { status } : {}),
        OR: [
          {
            recipient: {
              contains: q,
              mode: "insensitive",
            },
          },
          {
            subject: {
              contains: q,
              mode: "insensitive",
            },
          },
          {
            body: {
              contains: q,
              mode: "insensitive",
            },
          },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    return res.json({ data: emails });
  } catch (error) {
    console.error("Email search failed:", error);

    return res.status(500).json({
      error: "Unable to search emails.",
    });
  }
});

/**
 * Dashboard counts.
 */
router.get("/stats", async (req, res) => {
  try {
    const [scheduled, processing, sent, failed, cancelled] =
      await Promise.all([
        prisma.email.count({ where: { status: "SCHEDULED", sender: { userId: req.userId! } } }),
        prisma.email.count({ where: { status: "PROCESSING", sender: { userId: req.userId! } } }),
        prisma.email.count({ where: { status: "SENT", sender: { userId: req.userId! } } }),
        prisma.email.count({ where: { status: "FAILED", sender: { userId: req.userId! } } }),
        prisma.email.count({ where: { status: "CANCELLED", sender: { userId: req.userId! } } }),
      ]);

    return res.json({
      data: {
        scheduled,
        processing,
        sent,
        failed,
        cancelled,
        total: scheduled + processing + sent + failed + cancelled,
      },
    });
  } catch (error) {
    console.error("Failed to load stats:", error);

    return res.status(500).json({
      error: "Unable to load stats.",
    });
  }
});

/**
 * Cancel a scheduled email.
 */
router.post("/:id/cancel", async (req, res) => {
  const id = req.params.id;

  try {
    const result = await prisma.email.updateMany({
      where: {
        id,
        status: "SCHEDULED",
      },
      data: {
        status: "CANCELLED",
        bullmqJobId: null,
      },
    });

    if (result.count === 0) {
      const current = await prisma.email.findUnique({
        where: { id },
        select: { status: true },
      });

      if (!current) {
        return res.status(404).json({
          error: "Email not found.",
        });
      }

      return res.status(409).json({
        error: `Only scheduled emails can be cancelled. Current status: ${current.status}.`,
      });
    }

    const jobIds = [`email-${id}`, id];
    const warnings: string[] = [];

    for (const jobId of jobIds) {
      try {
        const job = await emailQueue.getJob(jobId);

        if (!job) continue;

        const state = await job.getState();

        if (
          [
            "waiting",
            "delayed",
            "paused",
            "prioritized",
            "waiting-children",
            "failed",
          ].includes(state)
        ) {
          await job.remove();
        } else if (state === "active") {
          warnings.push(
            `Job ${jobId} is active and may require delivery verification.`,
          );
        }
      } catch (queueError) {
        console.error(
          `Could not remove queue job ${jobId}:`,
          queueError,
        );

        warnings.push(
          `Queue job ${jobId} could not be removed; it should be skipped by the worker because the email is CANCELLED.`,
        );
      }
    }

    return res.json({
      data: {
        id,
        status: "CANCELLED",
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  } catch (error) {
    console.error("Email cancellation failed:", error);

    return res.status(500).json({
      error: "Unable to cancel email.",
    });
  }
});

/**
 * Edit a scheduled email.
 */
router.patch("/:id", async (req, res) => {
  const id = req.params.id;
  const { subject, body, scheduledAt } = req.body ?? {};

  if (
    subject === undefined &&
    body === undefined &&
    scheduledAt === undefined
  ) {
    return res.status(400).json({
      error: "Provide subject, body, or scheduledAt to update.",
    });
  }

  if (
    subject !== undefined &&
    (typeof subject !== "string" || !subject.trim())
  ) {
    return res.status(400).json({
      error: "subject must be a non-empty string.",
    });
  }

  if (
    body !== undefined &&
    (typeof body !== "string" || !body.trim())
  ) {
    return res.status(400).json({
      error: "body must be a non-empty string.",
    });
  }

  let date: Date | undefined;

  if (scheduledAt !== undefined) {
    if (!isValidDate(scheduledAt)) {
      return res.status(400).json({
        error: "scheduledAt must be a valid date/time.",
      });
    }

    date = new Date(scheduledAt);

    if (date.getTime() <= Date.now()) {
      return res.status(400).json({
        error: "scheduledAt must be in the future.",
      });
    }
  }

  try {
    const existing = await prisma.email.findUnique({
      where: { id },
    });

    if (!existing) {
      return res.status(404).json({ error: "Email not found." });
    }

    if (existing.status !== "SCHEDULED") {
      return res.status(409).json({
        error: "Only scheduled emails can be edited.",
      });
    }

    const nextSubject = subject !== undefined ? subject.trim() : existing.subject;
    const nextBody = body !== undefined ? body : existing.body;
    const missingFields = getMissingTemplateFields(existing.recipientData, existing.recipient, nextSubject, nextBody);
    if (missingFields.length > 0) {
      return res.status(400).json({
        error: `This recipient is missing personalization field(s): ${missingFields.join(", ")}. The scheduled email was not changed.`,
        missingFields,
      });
    }

    const update = await prisma.email.updateMany({
      where: { id, status: "SCHEDULED" },
      data: {
        ...(subject !== undefined ? { subject: subject.trim() } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(date ? { scheduledAt: date } : {}),
      },
    });

    if (update.count === 0) {
      return res.status(409).json({
        error:
          "Email status changed. Only scheduled emails can be edited.",
      });
    }

    let updated = await prisma.email.findUniqueOrThrow({
      where: { id },
    });

    if (date && date.getTime() !== existing.scheduledAt.getTime()) {
      try {
        const jobId = await enqueueEmail(updated.id, updated.scheduledAt);

        updated = await prisma.email.update({
          where: { id },
          data: { bullmqJobId: jobId },
        });
      } catch (queueError) {
        console.error(
          `Reschedule queue operation failed for email ${id}:`,
          queueError,
        );

        return res.status(503).json({
          data: updated,
          error:
            "The email changes were saved, but its queue job could not be confirmed. The worker reconciliation process should restore it.",
        });
      }
    }

    return res.json({ data: updated });
  } catch (error) {
    console.error("Email update failed:", error);

    return res.status(500).json({
      error: "Unable to update the email.",
    });
  }
});

/**
 * Get an email by ID.
 * Keep this route after the named routes above.
 */
router.get("/:id", async (req, res) => {
  try {
    const email = await prisma.email.findUnique({
      where: { id: req.params.id },
    });

    if (!email) {
      return res.status(404).json({ error: "Email not found." });
    }

    return res.json({ data: email });
  } catch (error) {
    console.error("Failed to retrieve email:", error);

    return res.status(500).json({
      error: "Unable to retrieve email.",
    });
  }
});

export default router;
