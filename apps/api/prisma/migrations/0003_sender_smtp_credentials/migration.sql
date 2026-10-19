ALTER TABLE "Sender" ADD COLUMN "smtpPasswordEncrypted" TEXT;
ALTER TABLE "Sender" ADD COLUMN "connectionStatus" TEXT NOT NULL DEFAULT 'NEEDS_SETUP';
