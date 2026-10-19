import { Router } from "express";
import nodemailer from "nodemailer";
import prisma from "../lib/prisma";
import { encryptSenderPassword } from "../lib/sender-credentials";

const router = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const publicSender = (sender: any) => ({
  id: sender.id, email: sender.email, name: sender.name,
  connectionStatus: sender.connectionStatus, createdAt: sender.createdAt, updatedAt: sender.updatedAt,
});

router.get("/", async (req, res) => {
  try {
    const senders = await prisma.sender.findMany({ where: { userId: req.userId!, connectionStatus: { not: "REMOVED" } }, orderBy: { createdAt: "desc" } });
    return res.json({ data: senders.map(publicSender) });
  } catch (error) {
    console.error("List senders failed:", error);
    return res.status(500).json({ error: "Unable to list Gmail accounts." });
  }
});

router.post("/", async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.appPassword === "string" ? req.body.appPassword.replace(/\s+/g, "") : "";
  const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 100) : email.split("@")[0];
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Enter a valid Gmail address." });
  if (!email.endsWith("@gmail.com")) return res.status(400).json({ error: "For this setup, enter a Gmail address ending in @gmail.com." });
  if (password.length < 12 || password.length > 32) return res.status(400).json({ error: "Enter the Google App Password, not your normal Google password." });
  try {
    const transport = nodemailer.createTransport({ host: "smtp.gmail.com", port: 587, secure: false, auth: { user: email, pass: password }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 });
    try { await transport.verify(); } finally { transport.close(); }
    const encrypted = encryptSenderPassword(password);
    const sender = await prisma.sender.upsert({
      where: { userId_email: { userId: req.userId!, email } },
      update: { name, smtpPasswordEncrypted: encrypted, connectionStatus: "CONNECTED" },
      create: { userId: req.userId!, email, name, smtpPasswordEncrypted: encrypted, connectionStatus: "CONNECTED" },
    });
    return res.status(201).json({ data: publicSender(sender), message: "Gmail connected successfully." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connection failed.";
    if (/SENDER_CREDENTIALS_KEY/.test(message)) return res.status(500).json({ error: "Server credential encryption is not configured. Set SENDER_CREDENTIALS_KEY and restart the API." });
    console.warn("Gmail connection test failed for sender account.");
    return res.status(400).json({ error: "Could not connect to Gmail. Check the address and App Password, confirm 2-Step Verification is enabled, and try again." });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const sender = await prisma.sender.findFirst({ where: { id: req.params.id, userId: req.userId! }, select: { id: true } });
    if (!sender) return res.status(404).json({ error: "Gmail account not found." });
    const pending = await prisma.email.count({ where: { senderId: sender.id, status: { in: ["SCHEDULED", "PROCESSING"] } } });
    if (pending > 0) return res.status(409).json({ error: `This Gmail account has ${pending} scheduled or processing email(s). Cancel or finish them before deleting the account.` });
    const [emailHistory, groupHistory] = await Promise.all([
      prisma.email.count({ where: { senderId: sender.id } }),
      prisma.schedulingGroup.count({ where: { senderId: sender.id } }),
    ]);
    if (emailHistory > 0 || groupHistory > 0) {
      // Preserve sender foreign keys required by historical email/group records.
      await prisma.sender.update({
        where: { id: sender.id },
        data: { smtpPasswordEncrypted: null, connectionStatus: "REMOVED" },
      });
    } else {
      await prisma.sender.delete({ where: { id: sender.id } });
    }
    return res.json({ message: "Gmail account deleted." });
  } catch (error) {
    console.error("Delete sender failed:", error);
    return res.status(500).json({ error: "Unable to delete this Gmail account." });
  }
});

export default router;
