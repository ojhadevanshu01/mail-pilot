import "dotenv/config";

import {
  DelayedError,
  UnrecoverableError,
  Worker,
} from "bullmq";
import nodemailer from "nodemailer";
import type { SentMessageInfo } from "nodemailer";
import { decryptSenderPassword } from "./lib/sender-credentials";

import prisma from "./lib/prisma";
import { redis } from "./lib/redis";
import { emailQueue, EMAIL_QUEUE, enqueueEmail } from "./queue/email.queue";

const CONCURRENCY = Math.max(
  1,
  Number(process.env.WORKER_CONCURRENCY) || 5,
);

const MIN_DELAY_MS = Math.max(
  0,
  Number(process.env.MIN_EMAIL_DELAY_MS) || 2000,
);

const MAX_PER_HOUR = Math.max(
  1,
  Number(process.env.MAX_EMAILS_PER_HOUR_PER_SENDER) || 200,
);

const TEMPLATE_ERROR_PREFIX = "TEMPLATE_VALIDATION_ERROR:";
const SMTP_REJECTED_PREFIX = "SMTP_REJECTED:";

/** True only for errors that explicitly show SMTP did not accept the message. */
function isDefiniteSmtpRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const details = error as { code?: unknown; responseCode?: unknown; command?: unknown };
  const code = typeof details.code === "string" ? details.code.toUpperCase() : "";
  const command = typeof details.command === "string" ? details.command.toUpperCase() : "";
  const responseCode = Number(details.responseCode);

  // Authentication, envelope validation and local message validation fail
  // before the provider can accept the message for delivery.
  if (["EAUTH", "EENVELOPE", "EINVALIDHELO", "EINVALIDMAIL", "EINVALIDRCPT", "EMESSAGE"].includes(code)) {
    return true;
  }

  // A provider's explicit 5xx rejection at these SMTP stages means it refused
  // the message; socket timeouts/resets remain uncertain and are never retried.
  return responseCode >= 500 && responseCode <= 599 &&
    ["AUTH", "MAIL FROM", "RCPT TO", "DATA"].some((stage) => command.includes(stage));
}

function transporterForSender(sender: { email: string; smtpPasswordEncrypted: string | null }) {
  if (!sender.smtpPasswordEncrypted) {
    throw new Error("This sender Gmail account is not connected. Open Gmail Accounts and reconnect it.");
  }
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: { user: sender.email, pass: decryptSenderPassword(sender.smtpPasswordEncrypted) },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
}


const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function logPrismaError(
  context: string,
  id: string,
  error: unknown,
) {
  console.error(context);
  console.error("Email ID:", id);

  if (error instanceof Error) {
    console.error("Error name:", error.name);
    console.error("Error message:", error.message);
    console.error("Stack:", error.stack);
  }

  if (error && typeof error === "object") {
    const details = error as {
      code?: unknown;
      meta?: unknown;
      clientVersion?: unknown;
    };

    console.error("Prisma code:", details.code);
    console.error("Prisma metadata:", details.meta);
    console.error("Prisma client version:", details.clientVersion);
  }
}

/**
 * Normalize template keys so studentName, student_name and
 * "student name" can match the same CSV column.
 */
function normalizeTemplateKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

type RecipientFields = Record<string, string>;

/**
 * Extract scalar personalization values from the recipient's
 * Prisma JSON data. Arrays and non-object values are ignored.
 */

/**
 * Safely extract scalar personalization values from recipient JSON.
 * Supports string, number and boolean CSV values.
 */
function getRecipientFields(value: unknown): RecipientFields {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return {};
  }

  const fields: RecipientFields = {};

  for (const [key, fieldValue] of Object.entries(value)) {
    if (
      typeof fieldValue === "string" ||
      typeof fieldValue === "number" ||
      typeof fieldValue === "boolean"
    ) {
      fields[key] = String(fieldValue);
    }
  }

  return fields;
}

/**
 * Render placeholders using this email's own CSV row.
 * Unknown placeholders are rejected before SMTP delivery.
 */

function renderTemplate(
  template: string,
  fields: RecipientFields,
): string {
  const normalizedFields = new Map<string, string>();

  for (const [key, value] of Object.entries(fields)) {
    const normalizedKey = normalizeTemplateKey(key);

    if (normalizedKey) {
      normalizedFields.set(normalizedKey, value);
    }
  }

  const missing = new Set<string>();

  const rendered = template.replace(
    /{{\s*([^{}]+?)\s*}}/g,
    (_match, rawKey: string) => {
      const key = rawKey.trim();
      const normalizedKey = normalizeTemplateKey(key);

      if (!normalizedKey || !normalizedFields.has(normalizedKey)) {
        missing.add(key || "(empty variable)");
        return _match;
      }

      return normalizedFields.get(normalizedKey)!;
    },
  );

  if (missing.size > 0) {
    throw new Error(
      `${TEMPLATE_ERROR_PREFIX} Missing CSV field(s): ${[
        ...missing,
      ].join(", ")}`,
    );
  }

  return rendered;
}


async function lookupEmail(id: string) {
  try {
    return await prisma.email.findUnique({
      where: { id },
      include: { sender: true },
    });
  } catch (error: unknown) {
    logPrismaError("Worker email database lookup failed.", id, error);
    throw error;
  }
}

// Retry the database status update only; never resend the email here.
async function persistSentStatus(emailId: string): Promise<boolean> {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const updated = await prisma.email.updateMany({
        where: {
          id: emailId,
          status: "PROCESSING",
        },
        data: {
          status: "SENT",
          sentAt: new Date(),
          errorMessage: null,
        },
      });

      if (updated.count === 1) return true;

      console.error(
        `Email ${emailId}: cannot mark SENT because its status is no longer PROCESSING.`,
      );
      return false;
    } catch (error: unknown) {
      console.error(
        `Email ${emailId}: database status update attempt ${attempt}/${maxAttempts} failed.`,
        error,
      );

      if (attempt < maxAttempts) {
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
  }

  return false;
}

const worker = new Worker(
  EMAIL_QUEUE,
  async (job, token) => {
    const emailId = String(job.data?.emailId ?? "");

    if (!emailId) {
      throw new Error("Queue job is missing emailId.");
    }

    console.log("Looking up email ID:", emailId);

    const email = await lookupEmail(emailId);

    // Ignore deleted, cancelled, sent, or otherwise ineligible records.
    if (!email || email.status !== "SCHEDULED") {
      console.log(
        `Skipping email ${emailId}: record missing or status is not SCHEDULED.`,
      );
      return;
    }

    // Honor schedule changes made after the queue job was created.
    if (email.scheduledAt.getTime() > Date.now()) {
      await job.moveToDelayed(email.scheduledAt.getTime(), token);
      throw new DelayedError();
    }

    const senderId = email.senderId;
    const gapKey = `email-gap:${senderId}`;

    const hourWindow = Math.floor(Date.now() / 3_600_000);
    const hourKey = `email-rate:${senderId}:${hourWindow}`;

    // Enforce minimum delay between emails from the same sender.
    if (MIN_DELAY_MS > 0) {
      const gotGap = await redis.set(
        gapKey,
        "1",
        "PX",
        MIN_DELAY_MS,
        "NX",
      );

      if (!gotGap) {
        const wait = Math.max(await redis.pttl(gapKey), 100);

        await job.moveToDelayed(Date.now() + wait, token);
        throw new DelayedError();
      }
    }

    // Enforce hourly sending limit.
    const count = await redis.incr(hourKey);

    if (count === 1) {
      await redis.expire(hourKey, 3700);
    }

    if (count > MAX_PER_HOUR) {
      await redis.decr(hourKey);

      if (MIN_DELAY_MS > 0) {
        await redis.del(gapKey);
      }

      await job.moveToDelayed(
        (hourWindow + 1) * 3_600_000,
        token,
      );

      throw new DelayedError();
    }

    // Claim the email atomically so another worker cannot claim it.
    const claim = await prisma.email.updateMany({
      where: {
        id: emailId,
        status: "SCHEDULED",
      },
      data: {
        status: "PROCESSING",
        attempts: { increment: 1 },
        errorMessage: null,
      },
    });

    if (claim.count === 0) {
      await redis.decr(hourKey).catch(() => undefined);

      if (MIN_DELAY_MS > 0) {
        await redis.del(gapKey).catch(() => undefined);
      }

      return;
    }

    const claimedEmail = await lookupEmail(emailId);

    if (
      !claimedEmail ||
      claimedEmail.status !== "PROCESSING"
    ) {
      await redis.decr(hourKey).catch(() => undefined);

      if (MIN_DELAY_MS > 0) {
        await redis.del(gapKey).catch(() => undefined);
      }

      return;
    }

    let personalizedSubject: string;
    let personalizedBody: string;

    try {
      const fields = getRecipientFields(claimedEmail.recipientData);

      // Always use the actual destination address for {{email}}.
      fields.email = String(claimedEmail.recipient ?? "").trim();

      personalizedSubject = renderTemplate(
        claimedEmail.subject,
        fields,
      );

      personalizedBody = renderTemplate(
        claimedEmail.body,
        fields,
      );
    } catch (error: unknown) {
      // Template errors happen before SMTP is called.
      // Mark them as permanent failures, not uncertain deliveries.
      await redis.decr(hourKey).catch(() => undefined);

      if (MIN_DELAY_MS > 0) {
        await redis.del(gapKey).catch(() => undefined);
      }

      const message =
        error instanceof Error ? error.message : String(error);

      throw new UnrecoverableError(
        message.startsWith(TEMPLATE_ERROR_PREFIX)
          ? message
          : `${TEMPLATE_ERROR_PREFIX} ${message}`,
      );
    }

    let info: SentMessageInfo;

    const transporter = transporterForSender(claimedEmail.sender);

    try {
      info = await transporter.sendMail({
        from:
          `"${claimedEmail.sender.name ?? "MailPilot"}" ` +
          `<${claimedEmail.sender.email}>`,
        to: claimedEmail.recipient,
        subject: personalizedSubject,
        text: personalizedBody,
        html: personalizedBody
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;")
          .replace(/\r\n|\r|\n/g, "<br>\n"),
      });
    } catch (error: unknown) {
      await redis.decr(hourKey).catch((redisError) => {
        console.error("Could not restore hourly quota:", redisError);
      });

      const originalMessage =
        error instanceof Error ? error.message : String(error);

      if (isDefiniteSmtpRejection(error)) {
        const rejectedMessage = `${SMTP_REJECTED_PREFIX} The SMTP provider explicitly rejected this message. Details: ${originalMessage}`;
        try {
          await prisma.email.updateMany({
            where: { id: emailId, status: "PROCESSING" },
            data: { errorMessage: rejectedMessage.slice(0, 1000) },
          });
        } catch (statusError: unknown) {
          console.error(`Could not save SMTP rejection details for ${emailId}:`, statusError);
        }
        throw new UnrecoverableError(rejectedMessage);
      }

      const uncertaintyMessage =
        `DELIVERY_UNCERTAIN: SMTP sendMail failed. ` +
        `Delivery may need manual verification. Details: ${originalMessage}`;

      // Unknown transport errors can happen after provider acceptance. Avoid
      // automatic retry because that could send duplicate messages.
      try {
        await prisma.email.updateMany({
          where: { id: emailId, status: "PROCESSING" },
          data: { errorMessage: uncertaintyMessage.slice(0, 1000) },
        });
      } catch (statusError: unknown) {
        console.error(`Could not save delivery-uncertainty details for ${emailId}:`, statusError);
      }

      throw new UnrecoverableError(uncertaintyMessage);
    } finally {
      transporter.close();
    }

    // SMTP accepted the email. Only retry the status update, not delivery.
    const saved = await persistSentStatus(emailId);

    if (saved) {
      console.log(`SENT ${emailId} -> ${claimedEmail.recipient}`);
    } else {
      const uncertainStatus =
        "DELIVERY_STATUS_UNKNOWN: SMTP accepted the message, but MailPilot could not confirm the SENT status. Verify delivery with the provider before taking any resend action.";
      console.error(
        `DELIVERY_STATUS_UNKNOWN ${emailId} -> ${claimedEmail.recipient}. ` +
        "SMTP accepted the message, but SENT status could not be confirmed. " +
        "Reconcile manually; do not resend automatically.",
      );
      // Best effort to leave a durable explanation for the dashboard/operator.
      // Never change the record back to SCHEDULED: SMTP has already accepted it.
      try {
        await prisma.email.updateMany({
          where: { id: emailId, status: "PROCESSING" },
          data: { errorMessage: uncertainStatus },
        });
      } catch (markerError) {
        console.error(
          `Could not persist DELIVERY_STATUS_UNKNOWN marker for ${emailId}:`,
          markerError,
        );
      }
    }

    const preview = nodemailer.getTestMessageUrl(info);

    if (preview) {
      console.log(`Preview: ${preview}`);
    }
  },
  {
    connection: redis,
    concurrency: CONCURRENCY,
    autorun: false,
  },
);

// Persist failures without overwriting SENT or other non-processing states.
worker.on("failed", async (job, error) => {
  if (!job) return;

  const emailId = String(job.data?.emailId ?? "");
  if (!emailId) return;

  try {
    // Template validation is a permanent failure before SMTP delivery.
    if (error.message.startsWith(TEMPLATE_ERROR_PREFIX)) {
      await prisma.email.updateMany({
        where: {
          id: emailId,
          status: "PROCESSING",
        },
        data: {
          status: "FAILED",
          errorMessage: error.message.slice(0, 1000),
        },
      });

      console.error(`TEMPLATE_FAILED ${emailId}: ${error.message}`);
      return;
    }

    if (error.message.startsWith(SMTP_REJECTED_PREFIX)) {
      await prisma.email.updateMany({
        where: { id: emailId, status: "PROCESSING" },
        data: { status: "FAILED", errorMessage: error.message.slice(0, 1000) },
      });
      console.error(`SMTP_REJECTED ${emailId}: ${error.message}`);
      return;
    }

    const deliveryUncertain =
      error instanceof UnrecoverableError ||
      error.message.startsWith("DELIVERY_UNCERTAIN:");

    if (deliveryUncertain) {
      // Keep PROCESSING for manual delivery reconciliation.
      await prisma.email.updateMany({
        where: {
          id: emailId,
          status: "PROCESSING",
        },
        data: {
          errorMessage: error.message.slice(0, 1000),
        },
      });

      console.error(`DELIVERY_UNCERTAIN ${emailId}: ${error.message}`);
      return;
    }

    const finalFailure =
      job.attemptsMade >= (job.opts.attempts ?? 1);

    await prisma.email.updateMany({
      where: {
        id: emailId,
        status: "PROCESSING",
      },
      data: finalFailure
        ? {
          status: "FAILED",
          errorMessage: error.message.slice(0, 1000),
        }
        : {
          status: "SCHEDULED",
          errorMessage: error.message.slice(0, 1000),
        },
    });

    if (finalFailure) {
      console.error(`FAILED ${emailId}: ${error.message}`);
    }
  } catch (statusError: unknown) {
    console.error(
      `Could not persist failed-email status for ${emailId}:`,
      statusError,
    );
  }
});

worker.on("error", (error) => {
  console.error("Worker error name:", error.name);
  console.error("Worker error message:", error.message);
  console.error("Full worker error:", error);

  if ("code" in error) {
    console.error("Error code:", error.code);
  }

  if ("meta" in error) {
    console.error("Error metadata:", error.meta);
  }
});

/**
 * Restore queue jobs for persisted SCHEDULED emails that have no job.
 * PROCESSING records are deliberately never requeued automatically because
 * SMTP may have accepted a message before a crash or database disconnect.
 */
async function reconcileScheduledEmails(): Promise<void> {
  const scheduled = await prisma.email.findMany({
    where: { status: "SCHEDULED" },
    select: { id: true, scheduledAt: true, bullmqJobId: true },
    orderBy: { scheduledAt: "asc" },
  });

  let restored = 0;
  let needsReview = 0;

  for (const email of scheduled) {
    const stableId = `email-${email.id}`;
    let job = await emailQueue.getJob(stableId);

    // Recognize older jobs created before stable prefixed IDs were adopted.
    if (!job) job = await emailQueue.getJob(email.id);

    if (job) {
      const state = await job.getState();

      if (state === "failed" || state === "completed") {
        // A terminal job plus a SCHEDULED DB record is ambiguous; never resend.
        needsReview++;
        console.error(
          `QUEUE_RECONCILIATION_REVIEW email=${email.id} job=${job.id} state=${state}; not requeued automatically.`,
        );
      } else if (email.bullmqJobId !== String(job.id)) {
        await prisma.email.updateMany({
          where: { id: email.id, status: "SCHEDULED" },
          data: { bullmqJobId: String(job.id) },
        });
      }

      continue;
    }

    const jobId = await enqueueEmail(email.id, email.scheduledAt);

    await prisma.email.updateMany({
      where: { id: email.id, status: "SCHEDULED" },
      data: { bullmqJobId: jobId },
    });

    restored++;
  }

  console.log(
    `Queue reconciliation complete: scanned=${scheduled.length}, restored=${restored}, review=${needsReview}.`,
  );
}


/**
 * Mark abandoned PROCESSING records for operator review without requeueing them.
 * A process may have crashed before or after SMTP accepted the message, so the
 * only safe automatic action is to record the ambiguity, never resend it.
 */
async function reconcileStaleProcessingEmails(): Promise<void> {
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
  const result = await prisma.email.updateMany({
    where: {
      status: "PROCESSING",
      updatedAt: { lt: staleBefore },
      errorMessage: null,
    },
    data: {
      errorMessage:
        "DELIVERY_STATUS_UNKNOWN: This email remained PROCESSING for more than five minutes. The worker may have stopped during delivery. Verify delivery with the provider before taking any resend action.",
    },
  });

  if (result.count > 0) {
    console.error(
      `STALE_PROCESSING_REVIEW: marked ${result.count} email(s) for manual delivery verification; none were requeued.`,
    );
  }
}

let closing = false;

async function startWorker(): Promise<void> {
  try {
    await reconcileScheduledEmails();
  } catch (error) {
    // Do not start sending if the initial reconciliation could not complete.
    console.error(
      "Worker startup reconciliation failed; worker was not started.",
      error,
    );

    process.exitCode = 1;
    return;
  }

  console.log(`MailPilot worker started (concurrency ${CONCURRENCY}).`);

  const staleProcessingTimer = setInterval(() => {
    void reconcileStaleProcessingEmails().catch((error: unknown) => {
      console.error("Stale PROCESSING reconciliation failed:", error);
    });
  }, 60_000);
  staleProcessingTimer.unref();
  void reconcileStaleProcessingEmails().catch((error: unknown) => {
    console.error("Initial stale PROCESSING reconciliation failed:", error);
  });

  void worker.run().catch((error: unknown) => {
    console.error("Worker run loop failed:", error);
    process.exitCode = 1;
  });
}

void startWorker();

async function shutdown(signal: string) {
  if (closing) return;
  closing = true;

  console.log(`${signal} received; closing worker...`);

  try {
    await worker.close();
    await redis.quit();
    await prisma.$disconnect();
  } catch (error: unknown) {
    console.error("Worker shutdown failed:", error);
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
