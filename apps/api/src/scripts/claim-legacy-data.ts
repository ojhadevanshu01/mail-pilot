import "dotenv/config";
import prisma from "../lib/prisma";

/** One-time migration helper for the original unauthenticated local project.
 * Run only after the intended account has verified its email.
 * LEGACY_CLAIM_EMAIL must be the exact verified account receiving old records.
 */
async function main() {
  const targetEmail = process.env.LEGACY_CLAIM_EMAIL?.trim().toLowerCase();
  if (!targetEmail) throw new Error("Set LEGACY_CLAIM_EMAIL to the verified MailPilot account that should own existing data.");
  const target = await prisma.user.findUnique({ where: { email: targetEmail } });
  if (!target || !target.emailVerifiedAt || !target.passwordHash) throw new Error("Target account must exist, use a password, and have a verified email.");
  const legacy = await prisma.user.findUnique({ where: { email: "dev@local.test" } });
  if (!legacy || legacy.id === target.id) { console.log("No separate legacy owner needs transferring."); return; }
  const [senders, lists] = await prisma.$transaction([
    prisma.sender.updateMany({ where: { userId: legacy.id }, data: { userId: target.id } }),
    prisma.mailingList.updateMany({ where: { userId: legacy.id }, data: { userId: target.id } }),
  ]);
  const remainingSenders = await prisma.sender.count({ where: { userId: legacy.id } });
  if (remainingSenders === 0) {
    await prisma.session.deleteMany({ where: { userId: legacy.id } });
    await prisma.user.delete({ where: { id: legacy.id } });
  }
  console.log(`Legacy transfer complete: ${senders.count} sender(s), ${lists.count} mailing list(s). Email history and scheduling groups stay connected through those senders.`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await prisma.$disconnect(); });
