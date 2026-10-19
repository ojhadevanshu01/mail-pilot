-- Preserve per-recipient CSV personalization fields in saved mailing lists.
-- Existing email-only lists remain valid and receive an empty JSON array.
ALTER TABLE "MailingList"
ADD COLUMN "recipientDetails" JSONB NOT NULL DEFAULT '[]'::jsonb;
