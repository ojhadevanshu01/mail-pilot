import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import prisma from "./prisma";

export const SESSION_COOKIE = "mailpilot_session";
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export function cookieValue(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      try { return decodeURIComponent(value); } catch { return undefined; }
    }
  }
  return undefined;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function setSessionCookie(res: Response, token: string) {
  const production = process.env.NODE_ENV === "production";
  const secure = production ? "; Secure" : "";
  const sameSite = process.env.AUTH_COOKIE_SAMESITE || (production ? "None" : "Lax");
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`);
}

export function clearSessionCookie(res: Response) {
  const production = process.env.NODE_ENV === "production";
  const secure = production ? "; Secure" : "";
  const sameSite = process.env.AUTH_COOKIE_SAMESITE || (production ? "None" : "Lax");
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=0${secure}`);
}

declare global {
  namespace Express {
    interface Request { userId?: string; userEmail?: string; userName?: string | null; }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const token = cookieValue(req, SESSION_COOKIE);
    if (!token || token.length > 300) {
      return res.status(401).json({ error: "Please sign in to continue.", code: "UNAUTHENTICATED" });
    }
    const session = await prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: { select: { id: true, email: true, name: true, emailVerifiedAt: true } } },
    });
    if (!session || session.expiresAt <= new Date() || !session.user.emailVerifiedAt) {
      if (session) await prisma.session.deleteMany({ where: { id: session.id } });
      clearSessionCookie(res);
      return res.status(401).json({ error: "Your session has expired. Please sign in again.", code: "UNAUTHENTICATED" });
    }
    req.userId = session.user.id;
    req.userEmail = session.user.email;
    req.userName = session.user.name;
    return next();
  } catch (error) {
    console.error("Authentication middleware failed:", error);
    return res.status(500).json({ error: "Could not verify your session." });
  }
}

// Protect ID-based email operations before their handlers run.
export async function emailOwnershipGuard(req: Request, res: Response, next: NextFunction) {
  const first = req.path.split("/").filter(Boolean)[0];
  if (!first || ["schedule", "schedule-bulk", "scheduled", "sent", "failed", "cancelled", "search", "stats"].includes(first)) return next();
  try {
    const row = await prisma.email.findFirst({ where: { id: first, sender: { userId: req.userId! } }, select: { id: true } });
    if (!row) return res.status(404).json({ error: "Email not found." });
    return next();
  } catch (error) {
    console.error("Email ownership check failed:", error);
    return res.status(500).json({ error: "Could not verify email ownership." });
  }
}

// Protect every group-ID endpoint, including nested recipient and edit routes.
export async function groupOwnershipGuard(req: Request, res: Response, next: NextFunction) {
  const first = req.path.split("/").filter(Boolean)[0];
  if (!first || req.method === "POST" && first === "") return next();
  try {
    const row = await prisma.schedulingGroup.findFirst({ where: { id: first, sender: { userId: req.userId! } }, select: { id: true } });
    if (!row) return res.status(404).json({ error: "Scheduling group not found." });
    return next();
  } catch (error) {
    console.error("Group ownership check failed:", error);
    return res.status(500).json({ error: "Could not verify group ownership." });
  }
}
