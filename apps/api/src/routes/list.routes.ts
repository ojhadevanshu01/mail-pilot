import { Router } from "express";
import prisma from "../lib/prisma";
import type { Prisma } from "../generated/prisma/client";

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 500;

type RecipientDetail = { email: string; fields: Record<string, string> };

function clean(input: unknown): string[] {
  if (!Array.isArray(input)) return [];

  return [
    ...new Set(
      input
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim().toLowerCase())
        .filter((value) => EMAIL_RE.test(value))
    )
  ];
}

function cleanDetails(input: unknown): RecipientDetail[] {
  if (!Array.isArray(input)) return [];

  const seen = new Set<string>();
  const details: RecipientDetail[] = [];

  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;

    const row = item as { email?: unknown; fields?: unknown };
    const email = typeof row.email === "string" ? row.email.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email) || seen.has(email)) continue;
    seen.add(email);

    const fields: Record<string, string> = {};
    if (row.fields && typeof row.fields === "object" && !Array.isArray(row.fields)) {
      for (const [key, value] of Object.entries(row.fields as Record<string, unknown>)) {
        const fieldName = key.trim();
        if (!fieldName || fieldName.length > 100) continue;
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          fields[fieldName] = String(value).trim();
        }
      }
    }

    // Email is stored separately as the destination address, not as a custom field.
    for (const key of Object.keys(fields)) {
      if (key.toLowerCase().replace(/[^a-z0-9]/g, "") === "email") delete fields[key];
    }

    details.push({ email, fields });
  }

  return details;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

router.get("/", async (req, res) => {
  try {
    const lists = await prisma.mailingList.findMany({
      where: { userId: req.userId! },
      orderBy: { updatedAt: "desc" }
    });

    return res.json({ data: lists });
  } catch (error) {
    console.error("List mailing lists failed:", error);

    return res.status(500).json({
      error: "Unable to load mailing lists."
    });
  }
});

router.post("/", async (req, res) => {
  const name =
    typeof req.body?.name === "string"
      ? req.body.name.trim()
      : "";

  const suppliedDetails = cleanDetails(req.body?.recipientDetails);
  const recipients = suppliedDetails.length
    ? suppliedDetails.map((recipient) => recipient.email)
    : clean(req.body?.recipients);
  const recipientDetails = suppliedDetails.length
    ? suppliedDetails
    : recipients.map((email) => ({ email, fields: {} }));

  if (!name || name.length > 80) {
    return res.status(400).json({
      error: "List name is required (max 80 characters)."
    });
  }

  if (recipients.length === 0) {
    return res.status(400).json({
      error: "Add at least one valid email address."
    });
  }

  if (recipients.length > MAX_RECIPIENTS) {
    return res.status(400).json({
      error: `A list can hold at most ${MAX_RECIPIENTS} recipients.`
    });
  }

  try {
    const list = await prisma.mailingList.create({
      data: {
        userId: req.userId!,
        name,
        recipients,
        recipientDetails: recipientDetails as Prisma.InputJsonValue,
      }
    });

    return res.status(201).json({ data: list });
  } catch (error) {
    if (errorCode(error) === "P2002") {
      return res.status(409).json({
        error: "A list with this name already exists."
      });
    }

    console.error("Create list failed:", error);

    return res.status(500).json({
      error: "Unable to save the list."
    });
  }
});

router.patch("/:id", async (req, res) => {
  const data: {
    name?: string;
    recipients?: string[];
    recipientDetails?: Prisma.InputJsonValue;
  } = {};

  if (req.body?.name !== undefined) {
    const name =
      typeof req.body.name === "string"
        ? req.body.name.trim()
        : "";

    if (!name || name.length > 80) {
      return res.status(400).json({
        error: "List name is required (max 80 characters)."
      });
    }

    data.name = name;
  }

  if (req.body?.recipients !== undefined || req.body?.recipientDetails !== undefined) {
    const suppliedDetails = cleanDetails(req.body?.recipientDetails);
    const recipients = suppliedDetails.length
      ? suppliedDetails.map((recipient) => recipient.email)
      : clean(req.body?.recipients);

    if (recipients.length === 0 || recipients.length > MAX_RECIPIENTS) {
      return res.status(400).json({
        error: `Provide 1-${MAX_RECIPIENTS} valid recipients.`
      });
    }

    data.recipients = recipients;
    data.recipientDetails = (suppliedDetails.length
      ? suppliedDetails
      : recipients.map((email) => ({ email, fields: {} }))) as Prisma.InputJsonValue;
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({
      error: "Provide a list name or recipient list to update."
    });
  }

  try {
    const changed = await prisma.mailingList.updateMany({
      where: { id: req.params.id, userId: req.userId! },
      data
    });
    if (!changed.count) return res.status(404).json({ error: "List not found." });
    const list = await prisma.mailingList.findFirst({ where: { id: req.params.id, userId: req.userId! } });
    return res.json({ data: list });
  } catch (error) {
    if (errorCode(error) === "P2025") {
      return res.status(404).json({
        error: "List not found."
      });
    }

    if (errorCode(error) === "P2002") {
      return res.status(409).json({
        error: "A list with this name already exists."
      });
    }

    console.error("Update list failed:", error);

    return res.status(500).json({
      error: "Unable to update the list."
    });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const deleted = await prisma.mailingList.deleteMany({ where: { id: req.params.id, userId: req.userId! } });
    if (!deleted.count) return res.status(404).json({ error: "List not found." });

    return res.json({
      data: { id: req.params.id }
    });
  } catch (error) {
    if (errorCode(error) === "P2025") {
      return res.status(404).json({
        error: "List not found."
      });
    }

    console.error("Delete list failed:", error);

    return res.status(500).json({
      error: "Unable to delete the list."
    });
  }
});

export default router;
