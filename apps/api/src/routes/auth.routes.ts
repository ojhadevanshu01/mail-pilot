import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import nodemailer from "nodemailer";
import prisma from "../lib/prisma";
import { clearSessionCookie, hashToken, requireAuth, SESSION_MAX_AGE_SECONDS, setSessionCookie, cookieValue, SESSION_COOKIE } from "../lib/auth";

const router = Router();
const scrypt = promisify(scryptCallback);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WEB_URL = (process.env.WEB_URL || "http://localhost:3001").replace(/\/$/, "");
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "Too many authentication attempts. Try again in 15 minutes.",
  },
  skip: () => process.env.NODE_ENV !== "production",
});
router.use(authLimiter);

function token() { return randomBytes(32).toString("base64url"); }
function htmlEscape(s: string) { return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)); }
async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt}$${key.toString("hex")}`;
}
async function verifyPassword(password: string, encoded: string) {
  const [scheme, salt, hash] = encoded.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = await scrypt(password, salt, expected.length) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function mailer() {
  // Intentionally do not fall back to the scheduler's SMTP variables: auth mail
  // must come from the dedicated MailPilot account, not a user's sender setup.
  const host = process.env.AUTH_SMTP_HOST;
  const user = process.env.AUTH_SMTP_USER;
  const pass = process.env.AUTH_SMTP_PASS;
  const port = Number(process.env.AUTH_SMTP_PORT || 587);
  if (!host || !user || !pass) throw new Error("Authentication email is not configured. Set AUTH_SMTP_HOST, AUTH_SMTP_USER and AUTH_SMTP_PASS.");
  return { transport: nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } }), from: process.env.AUTH_MAIL_FROM || `MailPilot <${user}>` };
}
async function sendLink(to: string, subject: string, intro: string, link: string, button: string) {
  const { transport, from } = mailer();
  await transport.sendMail({ from, to, subject, text: `${intro}\n\n${link}\n\nIf you did not request this, you can ignore this email.`, html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#172033"><h2>MailPilot</h2><p>${htmlEscape(intro)}</p><p><a href="${htmlEscape(link)}" style="display:inline-block;background:#5b5ce2;color:white;padding:12px 18px;border-radius:8px;text-decoration:none">${htmlEscape(button)}</a></p><p>If the button does not work, copy this link:</p><p>${htmlEscape(link)}</p><p>If you did not request this, you can ignore this email.</p></div>` });
}
function publicUser(user: { id: string; name: string | null; email: string; emailVerifiedAt: Date | null }) { return { id: user.id, name: user.name, email: user.email, emailVerified: Boolean(user.emailVerifiedAt) }; }
async function createSession(userId: string, res: import("express").Response) {
  const raw = token();
  await prisma.session.create({ data: { userId, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000) } });
  setSessionCookie(res, raw);
}

router.post("/register", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = req.body?.password;
  if (!name || name.length > 100) return res.status(400).json({ error: "Name is required (maximum 100 characters)." });
  if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: "Enter a valid email address." });
  if (typeof password !== "string" || password.length < 10 || password.length > 200) return res.status(400).json({ error: "Password must be between 10 and 200 characters." });
  const raw = token();
  try {
    const user = await prisma.user.create({ data: { name, email, passwordHash: await passwordHash(password), verificationTokenHash: hashToken(raw), verificationExpiresAt: new Date(Date.now() + 30 * 60 * 1000) } });
    const link = `${WEB_URL}/?verify=${encodeURIComponent(raw)}&email=${encodeURIComponent(email)}`;
    try {
      await sendLink(email, "Verify your MailPilot email", "Verify your email address to activate your MailPilot account. This link expires in 30 minutes.", link, "Verify email");
    } catch (mailError) {
      console.error("Verification email send failed:", mailError);
      return res.status(503).json({ error: "Your account was created, but the verification email could not be sent. Check the MailPilot SMTP settings, then use Resend verification." });
    }
    return res.status(201).json({ message: "Account created. Check your email for the verification link." });
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && (error as {code:string}).code === "P2002") return res.status(409).json({ error: "An account with this email already exists." });
    console.error("Registration failed:", error);
    return res.status(500).json({ error: "Could not create your account." });
  }
});

router.post("/verify-email", async (req, res) => {
  const raw = typeof req.body?.token === "string" ? req.body.token : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!raw || !EMAIL_RE.test(email)) return res.status(400).json({ error: "Verification link is invalid." });
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.verificationTokenHash || user.verificationTokenHash !== hashToken(raw) || !user.verificationExpiresAt || user.verificationExpiresAt <= new Date()) return res.status(400).json({ error: "This verification link is invalid or expired. Request a new one." });
    const verified = await prisma.user.updateMany({
      where: { id: user.id, verificationTokenHash: hashToken(raw), verificationExpiresAt: { gt: new Date() }, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date(), verificationTokenHash: null, verificationExpiresAt: null },
    });
    if (!verified.count) return res.status(400).json({ error: "This verification link is invalid or expired. Request a new one." });
    return res.json({ message: "Email verified. You can now sign in." });
  } catch (error) { console.error("Email verification failed:", error); return res.status(500).json({ error: "Could not verify your email." }); }
});

router.post("/resend-verification", async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) return res.status(200).json({ message: "If the account needs verification, an email will be sent." });
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && !user.emailVerifiedAt && user.passwordHash) {
      const raw = token();
      await prisma.user.update({ where: { id: user.id }, data: { verificationTokenHash: hashToken(raw), verificationExpiresAt: new Date(Date.now() + 30 * 60 * 1000) } });
      await sendLink(email, "Verify your MailPilot email", "Verify your email address to activate your MailPilot account. This link expires in 30 minutes.", `${WEB_URL}/?verify=${encodeURIComponent(raw)}&email=${encodeURIComponent(email)}`, "Verify email");
    }
    return res.json({ message: "If the account needs verification, an email will be sent." });
  } catch (error) { console.error("Resend verification failed:", error); return res.status(503).json({ error: "Could not send the verification email. Check MailPilot SMTP settings." }); }
});

router.post("/login", async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = req.body?.password;
  if (!EMAIL_RE.test(email) || typeof password !== "string") return res.status(400).json({ error: "Enter your email and password." });
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) return res.status(401).json({ error: "Email or password is incorrect." });
    if (!user.emailVerifiedAt) return res.status(403).json({ error: "Verify your email before signing in.", code: "EMAIL_NOT_VERIFIED" });
    await createSession(user.id, res);
    return res.json({ data: publicUser(user) });
  } catch (error) { console.error("Login failed:", error); return res.status(500).json({ error: "Could not sign in." }); }
});

router.get("/me", requireAuth, async (req, res) => {
  return res.json({ data: { id: req.userId, name: req.userName, email: req.userEmail, emailVerified: true } });
});

router.post("/logout", async (req, res) => {
  try {
    const raw = cookieValue(req, SESSION_COOKIE);
    if (raw) await prisma.session.deleteMany({ where: { tokenHash: hashToken(raw) } });
    clearSessionCookie(res);
    return res.json({ message: "Signed out." });
  } catch (error) { console.error("Logout failed:", error); clearSessionCookie(res); return res.status(500).json({ error: "Could not sign out cleanly." }); }
});

router.post("/forgot-password", async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const generic = { message: "If an account exists for that email, a password reset link will be sent." };
  if (!EMAIL_RE.test(email)) return res.json(generic);
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user?.passwordHash && user.emailVerifiedAt) {
      const raw = token();
      await prisma.user.update({ where: { id: user.id }, data: { resetTokenHash: hashToken(raw), resetExpiresAt: new Date(Date.now() + 30 * 60 * 1000) } });
      await sendLink(email, "Reset your MailPilot password", "Use this link to reset your MailPilot password. It expires in 30 minutes and can only be used once.", `${WEB_URL}/?reset=${encodeURIComponent(raw)}&email=${encodeURIComponent(email)}`, "Reset password");
    }
    return res.json(generic);
  } catch (error) { console.error("Password reset email failed:", error); return res.status(503).json({ error: "Could not send reset email. Check MailPilot SMTP settings." }); }
});

router.post("/reset-password", async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const raw = typeof req.body?.token === "string" ? req.body.token : "";
  const password = req.body?.password;
  if (!EMAIL_RE.test(email) || !raw || typeof password !== "string" || password.length < 10 || password.length > 200) return res.status(400).json({ error: "Use a valid reset link and a password of 10–200 characters." });
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.resetTokenHash || user.resetTokenHash !== hashToken(raw) || !user.resetExpiresAt || user.resetExpiresAt <= new Date()) return res.status(400).json({ error: "This reset link is invalid or expired. Request a new one." });
    const nextHash = await passwordHash(password);
    const changed = await prisma.$transaction(async (tx) => {
      const result = await tx.user.updateMany({
        where: { id: user.id, resetTokenHash: hashToken(raw), resetExpiresAt: { gt: new Date() } },
        data: { passwordHash: nextHash, resetTokenHash: null, resetExpiresAt: null },
      });
      if (result.count) await tx.session.deleteMany({ where: { userId: user.id } });
      return result.count;
    });
    if (!changed) return res.status(400).json({ error: "This reset link is invalid or expired. Request a new one." });
    clearSessionCookie(res);
    return res.json({ message: "Password reset successfully. Sign in with your new password." });
  } catch (error) { console.error("Password reset failed:", error); return res.status(500).json({ error: "Could not reset your password." }); }
});

export default router;
