import { createHash } from "node:crypto";
import { Router } from "express";
import prisma from "../lib/prisma";
import { emailQueue, enqueueEmail } from "../queue/email.queue";

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 500;

type AddedRecipient = { email: string; fields: Record<string, string | number | boolean> };

function normalizeFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeAddedRecipients(input: unknown): { valid: AddedRecipient[]; invalid: number; duplicatesInUpload: number } {
  if (!Array.isArray(input)) return { valid: [], invalid: 0, duplicatesInUpload: 0 };

  const unique = new Map<string, AddedRecipient>();
  let invalid = 0;
  let duplicatesInUpload = 0;

  for (const item of input) {
    let rawEmail: unknown;
    let source: Record<string, unknown> = {};

    if (typeof item === "string") {
      rawEmail = item;
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const row = item as Record<string, unknown>;
      const nested = row.fields && typeof row.fields === "object" && !Array.isArray(row.fields)
        ? row.fields as Record<string, unknown>
        : row;
      source = nested;
      rawEmail = typeof row.email === "string" ? row.email
        : typeof row.recipient === "string" ? row.recipient
          : Object.entries(nested).find(([key]) => ["email", "emailaddress", "recipient", "recipientemail", "mail", "mailid", "mailaddress", "gmail", "gmailaddress", "emailid", "emailaddr", "recipientaddress", "contactemail"].includes(normalizeFieldName(key)))?.[1];
    }

    const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email)) {
      invalid++;
      continue;
    }

    if (unique.has(email)) {
      duplicatesInUpload++;
      continue;
    }

    const fields: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(source)) {
      const normalized = normalizeFieldName(key);
      if (!normalized || ["email", "emailaddress", "recipient", "recipientemail", "mail", "mailid", "mailaddress", "gmail", "gmailaddress", "emailid", "emailaddr", "recipientaddress", "contactemail", "fields"].includes(normalized)) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        fields[key.trim()] = value;
      }
    }

    unique.set(email, { email, fields });
  }

  return { valid: [...unique.values()], invalid, duplicatesInUpload };
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


async function removeWaitingJob(emailId: string): Promise<void> {
  // Keep this ID consistent with enqueueEmail() in email.queue.ts.
  const job = await emailQueue.getJob(`email-${emailId}`);

  if (!job) return;

  const state = await job.getState();

  // Never remove a job that has started processing.
  if (state === "active") {
    console.warn(`Email job ${job.id} is active; it was not removed.`);
    return;
  }

  if (
    ["waiting", "delayed", "paused", "prioritized", "waiting-children"]
      .includes(state)
  ) {
    await job.remove();
  }
}

// GET /api/groups?page=1&pageSize=20&q=search
router.get("/", async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20));
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

  try {
    const where = {
      sender: { userId: req.userId! },
      ...(q
        ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            {
              emails: {
                some: {
                  OR: [
                    {
                      subject: {
                        contains: q,
                        mode: "insensitive" as const,
                      },
                    },
                    {
                      recipient: {
                        contains: q,
                        mode: "insensitive" as const,
                      },
                    },
                  ],
                },
              },
            },
          ],
        }
        : {}),
    };

    const [groups, total] = await Promise.all([
      prisma.schedulingGroup.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          sender: { select: { email: true, name: true } },
        },
      }),
      prisma.schedulingGroup.count({ where }),
    ]);

    const ids = groups.map((group) => group.id);

    const groupedCounts = ids.length
      ? await prisma.email.groupBy({
        by: ["groupId", "status"],
        where: { groupId: { in: ids } },
        _count: { _all: true },
      })
      : [];

    const data = groups.map((group) => {
      const counts = {
        total: 0,
        scheduled: 0,
        processing: 0,
        sent: 0,
        failed: 0,
        cancelled: 0,
      };

      for (const item of groupedCounts) {
        if (item.groupId !== group.id) continue;

        const count = item._count._all;
        counts.total += count;

        switch (item.status) {
          case "SCHEDULED":
            counts.scheduled += count;
            break;
          case "PROCESSING":
            counts.processing += count;
            break;
          case "SENT":
            counts.sent += count;
            break;
          case "FAILED":
            counts.failed += count;
            break;
          case "CANCELLED":
            counts.cancelled += count;
            break;
        }
      }

      return { ...group, counts };
    });

    return res.json({
      data,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (error) {
    console.error("Failed to load scheduling groups:", error);
    return res.status(500).json({
      error: "Unable to load scheduling groups.",
    });
  }
});

// GET /api/groups/:id/recipients?page=1&pageSize=20
router.get("/:id/recipients", async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

  try {
    const group = await prisma.schedulingGroup.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });

    if (!group) {
      return res.status(404).json({
        error: "Scheduling group not found.",
      });
    }

    const where = { groupId: group.id };

    const [emails, total] = await Promise.all([
      prisma.email.findMany({
        where,
        orderBy: { createdAt: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          recipient: true,
          subject: true,
          body: true,
          status: true,
          scheduledAt: true,
          sentAt: true,
          attempts: true,
          errorMessage: true,
          createdAt: true,
        },
      }),
      prisma.email.count({ where }),
    ]);

    return res.json({
      data: emails,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (error) {
    console.error("Failed to load group recipients:", error);
    return res.status(500).json({
      error: "Unable to load group recipients.",
    });
  }
});


// PATCH /api/groups/:id/email-content
// Update the subject and body of all scheduled emails in a group.
router.patch("/:id/email-content", async (req, res) => {
  const subject =
    typeof req.body?.subject === "string"
      ? req.body.subject.trim()
      : "";

  const body =
    typeof req.body?.body === "string"
      ? req.body.body
      : "";

  if (!subject || !body.trim()) {
    return res.status(400).json({
      error: "Subject and message body are required.",
    });
  }

  try {
    const group = await prisma.schedulingGroup.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });

    if (!group) {
      return res.status(404).json({
        error: "Scheduling group not found.",
      });
    }

    const scheduledEmails = await prisma.email.findMany({
      where: { groupId: group.id, status: "SCHEDULED" },
      select: { id: true, recipientData: true },
    });

    const requiredFields = getTemplatePlaceholders(subject, body);
    const missingByRecipient = scheduledEmails.filter((email) => {
      const data = email.recipientData;
      const values = data && typeof data === "object" && !Array.isArray(data)
        ? new Map(Object.entries(data).map(([key, value]) => [normalizeFieldName(key), String(value ?? "").trim()]))
        : new Map<string, string>();
      return requiredFields.some((field) => !values.get(normalizeFieldName(field)));
    });

    if (missingByRecipient.length > 0) {
      const allMissing = new Set<string>();
      for (const email of missingByRecipient) {
        const data = email.recipientData;
        const values = data && typeof data === "object" && !Array.isArray(data)
          ? new Map(Object.entries(data).map(([key, value]) => [normalizeFieldName(key), String(value ?? "").trim()]))
          : new Map<string, string>();
        for (const field of requiredFields) {
          if (!values.get(normalizeFieldName(field))) allMissing.add(field);
        }
      }
      return res.status(400).json({
        error: `Cannot apply these placeholders because data is missing for ${missingByRecipient.length} scheduled recipient(s): ${[...allMissing].join(", ")}. Remove the placeholders or provide the missing fields in a new schedule.`,
        missingRecipients: missingByRecipient.length,
        missingFields: [...allMissing],
      });
    }

    const result = await prisma.email.updateMany({
      where: { groupId: group.id, status: "SCHEDULED" },
      data: { subject, body },
    });

    return res.json({
      message: "Scheduled group emails updated.",
      updated: result.count,
    });
  } catch (error) {
    console.error("Group email content update failed:", error);

    return res.status(500).json({
      error: "Unable to update the group's scheduled emails.",
    });
  }
});

// POST /api/groups/:id/recipients
// Adds only new recipients to a group that still has scheduled emails.
// Input rows may be email strings or { email, fields } objects.
router.post("/:id/recipients", async (req, res) => {
  const parsed = normalizeAddedRecipients(req.body?.recipients);

  if (parsed.valid.length === 0) {
    return res.status(400).json({
      error: "No valid recipient addresses were found. Use an email address for basic groups or recipient rows with fields for personalized groups.",
      invalid: parsed.invalid,
      duplicatesInUpload: parsed.duplicatesInUpload,
    });
  }

  if (parsed.valid.length > MAX_RECIPIENTS) {
    return res.status(400).json({ error: `Maximum ${MAX_RECIPIENTS} recipients per request.` });
  }

  try {
    const group = await prisma.schedulingGroup.findUnique({ where: { id: req.params.id } });
    if (!group) return res.status(404).json({ error: "Scheduling group not found." });

    const pending = await prisma.email.findMany({
      where: { groupId: group.id, status: "SCHEDULED" },
      orderBy: { scheduledAt: "desc" },
      take: 1,
      select: { id: true, subject: true, body: true, scheduledAt: true },
    });

    if (pending.length === 0) {
      return res.status(409).json({
        error: "This group has no pending scheduled emails. Add recipients before the group finishes sending, or create a new schedule.",
      });
    }

    const template = pending[0];
    const requiredFields = getTemplatePlaceholders(template.subject, template.body);
    const validWithFields = parsed.valid.filter((recipient) => {
      const values = new Map(
        Object.entries(recipient.fields).map(([key, value]) => [
          normalizeFieldName(key),
          String(value ?? "").trim(),
        ]),
      );

      // The destination email is also a valid personalization field.
      values.set("email", recipient.email);

      return requiredFields.every((field) =>
        Boolean(values.get(normalizeFieldName(field))),
      );
    });
    const missingFields = parsed.valid.length - validWithFields.length;

    if (validWithFields.length === 0) {
      return res.status(400).json({
        error: requiredFields.length
          ? `This group requires these personalization fields: ${requiredFields.join(", ")}. Include them for each recipient.`
          : "No valid recipient rows were provided.",
        requiredFields,
        invalid: parsed.invalid,
        duplicatesInUpload: parsed.duplicatesInUpload,
        missingFields,
      });
    }

    const existing = await prisma.email.findMany({
      where: { groupId: group.id },
      select: { recipient: true },
    });
    const existingSet = new Set(existing.map((item) => item.recipient.trim().toLowerCase()));
    const newRecipients = validWithFields.filter((recipient) => !existingSet.has(recipient.email));
    const skippedExisting = validWithFields.length - newRecipients.length;

    if (newRecipients.length === 0) {
      return res.status(409).json({
        error: "All valid recipients already exist in this group.",
        added: 0,
        skippedExisting,
        invalid: parsed.invalid,
        duplicatesInUpload: parsed.duplicatesInUpload,
        missingFields,
      });
    }

    const now = Date.now();
    const latestPendingAt = pending[0].scheduledAt.getTime();
    const baseTime = Math.max(now, latestPendingAt);
    const created: Array<{ id: string; scheduledAt: Date }> = [];

    // Recheck duplicates inside the transaction and persist the personalization data.
    await prisma.$transaction(async (tx) => {
      const existingNow = await tx.email.findMany({
        where: { groupId: group.id },
        select: { recipient: true },
      });
      const existingNowSet = new Set(existingNow.map((item) => item.recipient.trim().toLowerCase()));
      const actualNew = newRecipients.filter((recipient) => !existingNowSet.has(recipient.email));

      for (let index = 0; index < actualNew.length; index++) {
        const recipient = actualNew[index];
        const scheduledAt = new Date(baseTime + (index + 1) * group.delaySeconds * 1000);
        const email = await tx.email.create({
          data: {
            groupId: group.id,
            senderId: group.senderId,
            recipient: recipient.email,
            recipientData: {
              ...recipient.fields,
              email: recipient.email,
            },
            subject: template.subject,
            body: template.body,
            scheduledAt,
            idempotencyKey: `group-add-${createHash("sha256").update(`${group.id}:${recipient.email}`).digest("hex")}`,
          },
        });
        created.push(email);
      }
    }, { maxWait: 10000, timeout: 30000 });

    let queueErrors = 0;
    for (const email of created) {
      try {
        const jobId = await enqueueEmail(email.id, email.scheduledAt);
        await prisma.email.update({ where: { id: email.id }, data: { bullmqJobId: jobId } });
      } catch (error) {
        queueErrors++;
        // The persisted SCHEDULED record can be queued by startup reconciliation.
        console.error(`Queue enqueue failed for ${email.id}:`, error);
      }
    }

    return res.status(201).json({
      data: {
        groupId: group.id,
        added: created.length,
        skippedExisting: skippedExisting + (newRecipients.length - created.length),
        invalid: parsed.invalid,
        duplicatesInUpload: parsed.duplicatesInUpload,
        missingFields,
        queueErrors,
        requiredFields,
      },
    });
  } catch (error) {
    console.error("Failed to add group recipients:", error);
    return res.status(500).json({ error: "Unable to add group recipients." });
  }
});

// PATCH /api/groups/:id/reschedule
// Recalculate scheduled recipients in order and replace their delayed jobs.
router.patch("/:id/reschedule", async (req, res) => {
  const { startAt, delaySeconds } = req.body ?? {};
  const start = new Date(startAt);
  const delay = Number(delaySeconds);

  if (
    typeof startAt !== "string" ||
    Number.isNaN(start.getTime()) ||
    start.getTime() <= Date.now()
  ) {
    return res.status(400).json({
      error: "startAt must be a valid future date/time.",
    });
  }

  if (!Number.isInteger(delay) || delay < 0 || delay > 86400) {
    return res.status(400).json({
      error: "delaySeconds must be an integer between 0 and 86400.",
    });
  }

  try {
    const group = await prisma.schedulingGroup.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });

    if (!group) {
      return res.status(404).json({
        error: "Scheduling group not found.",
      });
    }

    await prisma.schedulingGroup.update({
      where: { id: group.id },
      data: { startAt: start, delaySeconds: delay },
    });

    const pending = await prisma.email.findMany({
      where: { groupId: group.id, status: "SCHEDULED" },
      select: { id: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    let rescheduled = 0;
    let queueErrors = 0;

    for (let index = 0; index < pending.length; index++) {
      const emailId = pending[index].id;
      const scheduledAt = new Date(start.getTime() + index * delay * 1000);

      const updated = await prisma.email.updateMany({
        where: {
          id: emailId,
          groupId: group.id,
          status: "SCHEDULED",
        },
        data: { scheduledAt },
      });

      if (updated.count === 0) continue;

      try {
        const jobId = await enqueueEmail(emailId, scheduledAt);

        await prisma.email.updateMany({
          where: { id: emailId, status: "SCHEDULED" },
          data: { bullmqJobId: jobId },
        });

        rescheduled++;
      } catch (error) {
        queueErrors++;

        // DB schedule is authoritative; an existing job will re-read it,
        // and startup reconciliation restores missing jobs.
        console.error(
          `Group reschedule queue update failed for ${emailId}:`,
          error,
        );
      }
    }

    return res.json({
      data: {
        rescheduled,
        queueErrors,
        startAt: start.toISOString(),
        delaySeconds: delay,
      },
    });
  } catch (error) {
    console.error("Failed to reschedule group:", error);
    return res.status(500).json({
      error: "Unable to reschedule this group.",
    });
  }
});

// POST /api/groups/:id/cancel-scheduled
router.post("/:id/cancel-scheduled", async (req, res) => {
  try {
    const group = await prisma.schedulingGroup.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });

    if (!group) {
      return res.status(404).json({
        error: "Scheduling group not found.",
      });
    }

    const pending = await prisma.email.findMany({
      where: {
        groupId: group.id,
        status: "SCHEDULED",
      },
      select: { id: true },
    });

    const changed = await prisma.email.updateMany({
      where: {
        groupId: group.id,
        status: "SCHEDULED",
      },
      data: { status: "CANCELLED" },
    });

    for (const email of pending) {
      try {
        await removeWaitingJob(email.id);
      } catch (queueError) {
        console.warn(
          `Could not remove queue job email-${email.id}; worker must skip cancelled emails:`,
          queueError,
        );
      }
    }

    return res.json({
      data: { cancelled: changed.count },
    });
  } catch (error) {
    console.error("Failed to cancel group emails:", error);
    return res.status(500).json({
      error: "Unable to cancel scheduled group emails.",
    });
  }
});

// DELETE /api/groups/:id/recipients/:emailId
// Preserve email history; cancel only records that are still scheduled.
router.delete("/:id/recipients/:emailId", async (req, res) => {
  const { id: groupId, emailId } = req.params;

  try {
    const existing = await prisma.email.findFirst({
      where: {
        id: emailId,
        groupId,
      },
      select: {
        id: true,
        status: true,
      },
    });

    if (!existing) {
      return res.status(404).json({
        error: "Recipient record not found in this group.",
      });
    }

    if (existing.status !== "SCHEDULED") {
      return res.status(409).json({
        error:
          "Only scheduled recipients can be removed from active sending. Sent, failed, cancelled, or processing history is preserved.",
      });
    }

    const changed = await prisma.email.updateMany({
      where: {
        id: emailId,
        groupId,
        status: "SCHEDULED",
      },
      data: { status: "CANCELLED" },
    });

    if (changed.count === 0) {
      return res.status(409).json({
        error:
          "This email has already started processing. Refresh the group.",
      });
    }

    try {
      await removeWaitingJob(emailId);
    } catch (queueError) {
      console.warn(
        `Could not remove queue job email-${emailId}; worker must skip cancelled emails:`,
        queueError,
      );
    }

    return res.json({
      data: {
        id: emailId,
        status: "CANCELLED",
      },
    });
  } catch (error) {
    console.error("Failed to remove group recipient:", error);
    return res.status(500).json({
      error: "Unable to remove this recipient.",
    });
  }
});

export default router;
