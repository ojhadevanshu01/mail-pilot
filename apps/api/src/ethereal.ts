import nodemailer from "nodemailer";

async function main() {
  const account = await nodemailer.createTestAccount();

  console.log("Ethereal test account created successfully.");
  console.log(`ETHEREAL_HOST=${account.smtp.host}`);
  console.log(`ETHEREAL_PORT=${account.smtp.port}`);
  console.log(`ETHEREAL_USER=${account.user}`);
  console.log("Copy credentials to your local .env only.");
}

main().catch((error: unknown) => {
  console.error("Failed to create Ethereal test account:", error);
  process.exitCode = 1;
});