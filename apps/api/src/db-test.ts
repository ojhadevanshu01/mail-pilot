import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

async function main() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is missing from apps/api/.env");
  }

  const adapter = new PrismaPg({
    connectionString,
  });

  const prisma = new PrismaClient({ adapter });

  try {
    const result = await prisma.$queryRaw<
      Array<{ result: number }>
    >`SELECT 1 AS result`;

    console.log("Neon database connection successful!");
    console.log("Test query result:", result);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  console.error(
    "Database connection test failed. Check DATABASE_URL, network access, and the underlying error locally."
  );
  process.exitCode = 1;
});
