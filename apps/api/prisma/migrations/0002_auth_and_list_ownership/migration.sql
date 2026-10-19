-- Additive MailPilot authentication migration. Existing email/sender/group rows are retained.
ALTER TABLE "User"
  ADD COLUMN "passwordHash" TEXT,
  ADD COLUMN "emailVerifiedAt" TIMESTAMPTZ(3),
  ADD COLUMN "verificationTokenHash" TEXT,
  ADD COLUMN "verificationExpiresAt" TIMESTAMPTZ(3),
  ADD COLUMN "resetTokenHash" TEXT,
  ADD COLUMN "resetExpiresAt" TIMESTAMPTZ(3);

CREATE UNIQUE INDEX "User_verificationTokenHash_key" ON "User"("verificationTokenHash");
CREATE UNIQUE INDEX "User_resetTokenHash_key" ON "User"("resetTokenHash");

CREATE TABLE "Session" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every existing sender already belongs to a User. Ensure a legacy owner exists for existing lists.
INSERT INTO "User" ("id", "email", "name", "createdAt", "updatedAt")
SELECT 'mailpilot_legacy_owner', 'dev@local.test', 'Legacy MailPilot Data', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "User" WHERE "email" = 'dev@local.test');

ALTER TABLE "MailingList" ADD COLUMN "userId" TEXT;
UPDATE "MailingList" SET "userId" = (SELECT "id" FROM "User" WHERE "email" = 'dev@local.test' LIMIT 1)
WHERE "userId" IS NULL;
ALTER TABLE "MailingList" ALTER COLUMN "userId" SET NOT NULL;
DROP INDEX IF EXISTS "MailingList_name_key";
CREATE UNIQUE INDEX "MailingList_userId_name_key" ON "MailingList"("userId", "name");
CREATE INDEX "MailingList_userId_idx" ON "MailingList"("userId");
ALTER TABLE "MailingList" ADD CONSTRAINT "MailingList_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
