import "dotenv/config";

import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Server } from "node:http";

import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";

import app from "./app.js";
import prisma from "./lib/prisma";
import { emailQueue, enqueueEmail } from "./queue/email.queue";
import { redis } from "./lib/redis";

const PORT = Number(process.env.PORT) || 3000;

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);

  return x.length === y.length && timingSafeEqual(x, y);
}

function boardAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const password = process.env.ADMIN_PASSWORD;

  if (!password) {
    if (process.env.NODE_ENV === "production") {
      return res
        .status(503)
        .send(
          "Queue dashboard disabled. Set ADMIN_PASSWORD to enable it."
        );
    }

    return next();
  }

  const [scheme, encoded] = (
    req.headers.authorization ?? ""
  ).split(" ");

  if (scheme === "Basic" && encoded) {
    const [user, ...rest] = Buffer.from(
      encoded,
      "base64"
    )
      .toString()
      .split(":");

    if (
      safeEqual(user, process.env.ADMIN_USER ?? "admin") &&
      safeEqual(rest.join(":"), password)
    ) {
      return next();
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="Queues"');

  return res.status(401).send("Authentication required");
}

const boardAdapter = new ExpressAdapter();

boardAdapter.setBasePath("/admin/queues");

createBullBoard({
  queues: [new BullMQAdapter(emailQueue)],
  serverAdapter: boardAdapter
});

app.use(
  "/admin/queues",
  boardAuth,
  boardAdapter.getRouter()
);

async function reconcile() {
  const pending = await prisma.email.findMany({
    where: {
      status: "SCHEDULED"
    }
  });

  let queued = 0;
  let errors = 0;

  for (const email of pending) {
    try {
      const jobId = await enqueueEmail(
        email.id,
        email.scheduledAt
      );

      if (email.bullmqJobId !== jobId) {
        await prisma.email.update({
          where: {
            id: email.id
          },
          data: {
            bullmqJobId: jobId
          }
        });
      }

      queued++;
    } catch (error) {
      errors++;

      console.error(
        `Could not reconcile scheduled email ${email.id}:`,
        error
      );
    }
  }

  console.log(
    `Queue reconciliation: ${queued} checked, ${errors} errors`
  );
}

const server: Server = app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);

  void reconcile().catch((error) => {
    console.error(
      "Initial queue reconciliation failed:",
      error
    );
  });
});

const reconcileTimer = setInterval(() => {
  void reconcile().catch((error) => {
    console.error("Queue reconciliation failed:", error);
  });
}, Math.max(
  15_000,
  Number(process.env.RECONCILE_INTERVAL_MS) || 60_000
));

reconcileTimer.unref();

let closing = false;

async function shutdown(signal: string) {
  if (closing) return;

  closing = true;

  console.log(`${signal} received; shutting down API...`);

  clearInterval(reconcileTimer);

  server.close(async (error) => {
    try {
      await emailQueue.close();
      await redis.quit();
      await prisma.$disconnect();

      if (error) throw error;
    } catch (shutdownError) {
      console.error(
        "API shutdown failed:",
        shutdownError
      );

      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
