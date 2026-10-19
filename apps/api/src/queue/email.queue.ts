import { Queue } from "bullmq";
import { redis } from "../lib/redis";

export const EMAIL_QUEUE = "emails";

export const emailQueue = new Queue(EMAIL_QUEUE, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
    removeOnComplete: true,
  },
});

const REPLACEABLE_STATES = [
  "waiting",
  "delayed",
  "paused",
  "prioritized",
  "failed",
] as const;

export async function enqueueEmail(
  emailId: string,
  scheduledAt: Date,
): Promise<string> {
  if (!emailId || typeof emailId !== "string") {
    throw new Error("A valid email ID is required.");
  }

  const scheduledTime = scheduledAt.getTime();

  if (Number.isNaN(scheduledTime)) {
    throw new Error("A valid scheduled date is required.");
  }

  const stableJobId = `email-${emailId}`;
  const existing = await emailQueue.getJob(stableJobId);

  if (existing) {
    const state = await existing.getState();

    if (state === "active") {
      throw new Error(
        `Email job ${stableJobId} is currently active and cannot be replaced.`,
      );
    }

    if (state === "completed") {
      throw new Error(
        `Email job ${stableJobId} has completed. Verify delivery before scheduling it again.`,
      );
    }

    if (
      REPLACEABLE_STATES.includes(
        state as (typeof REPLACEABLE_STATES)[number],
      )
    ) {
      await existing.remove();
    } else {
      throw new Error(
        `Cannot safely replace email job ${stableJobId} in state "${state}".`,
      );
    }
  }

  const delay = Math.max(0, scheduledTime - Date.now());

  const job = await emailQueue.add(
    "send",
    { emailId },
    {
      jobId: stableJobId,
      delay,
    },
  );

  if (!job.id) {
    throw new Error(`Failed to create a queue job for email ${emailId}.`);
  }

  return String(job.id);
}
