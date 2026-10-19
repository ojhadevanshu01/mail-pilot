
import prisma from "./lib/prisma";

async function main() {
  const unique = `${Date.now()}`;

  const user = await prisma.user.create({
    data: {
      name: "MailPilot Test User",
      email: `mailpilot-test-${unique}@example.com`,
    },
  });

  const sender = await prisma.sender.create({
    data: {
      userId: user.id,
      email: `sender-${unique}@example.com`,
      name: "Test Sender",
    },
  });

  console.log("Test records created successfully.");
  console.log(
    JSON.stringify(
      {
        userId: user.id,
        senderId: sender.id,
        senderEmail: sender.email,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error: unknown) => {
    console.error("Test data creation failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
