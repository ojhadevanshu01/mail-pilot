import "dotenv/config";
import prisma from "./src/lib/prisma";

async function main() {
  const emailId = "cmv99hqdu0006zwvbrpw1ww26";

  console.log("Testing the worker's exact database lookup...");
  console.log("Email ID:", emailId);

  try {
    const email = await prisma.email.findUnique({
      where: { id: emailId },
      include: { sender: true }
    });

    if (!email) {
      console.log("RESULT: Email record not found.");
      return;
    }

    console.log("RESULT: Lookup succeeded.");
    console.log("Email status:", email.status);
    console.log("Sender relation loaded:", Boolean(email.sender));
    console.log("Scheduled date:", email.scheduledAt);
  } catch (error: unknown) {
    console.error("RESULT: Lookup failed.");

    if (error instanceof Error) {
      console.error("Error name:", error.name);
      console.error("Error message:", error.message);
      console.error("Stack:", error.stack);
    }

    if (error && typeof error === "object") {
      const details = error as {
        code?: unknown;
        meta?: unknown;
        clientVersion?: unknown;
      };

      console.error("Prisma code:", details.code);
      console.error("Prisma metadata:", details.meta);
      console.error("Prisma client version:", details.clientVersion);
    }

    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
