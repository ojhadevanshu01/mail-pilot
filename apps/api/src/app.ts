import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import emailRoutes from "./routes/email.routes.js";
import senderRoutes from "./routes/sender.routes.js";
import listRoutes from "./routes/list.routes.js";
import groupRoutes from "./routes/group.routes.js";
import authRoutes from "./routes/auth.routes.js";
import { requireAuth, emailOwnershipGuard, groupOwnershipGuard } from "./lib/auth";

const app = express();

const production = process.env.NODE_ENV === "production";

const allowedOrigins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.disable("x-powered-by");
app.use(helmet());

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || (!production && allowedOrigins.length === 0)) {
        callback(null, true);
        return;
      }

      callback(null, allowedOrigins.includes(origin));
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
    ],
    maxAge: 600,
    credentials: true,
  }),
);

app.use(express.json({ limit: "1mb" }));

// CORS alone does not stop a cross-site request from reaching the API.
// Reject browser requests whose Origin is not explicitly allowed before any
// cookie-authenticated mutation route can run.
app.use((req, res, next) => {
  const origin = req.get("Origin");
  const isMutation = !["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase());

  if (
    isMutation &&
    origin &&
    !( !production && allowedOrigins.length === 0 ) &&
    !allowedOrigins.includes(origin)
  ) {
    return res.status(403).json({ error: "Request origin is not allowed." });
  }

  return next();
});

app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.API_RATE_LIMIT) || 300,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      error: "Too many requests. Please try again later.",
    },
  }),
);

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "mailpilot-api",
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/emails", requireAuth, emailOwnershipGuard, emailRoutes);
app.use("/api/senders", requireAuth, senderRoutes);
app.use("/api/lists", requireAuth, listRoutes);
app.use("/api/groups", requireAuth, groupOwnershipGuard, groupRoutes);

app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("Unhandled API error:", error);

    res.status(500).json({
      error: "An unexpected server error occurred.",
    });
  },
);

export default app;
