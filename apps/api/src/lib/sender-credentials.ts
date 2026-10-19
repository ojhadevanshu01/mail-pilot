import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function key(): Buffer {
  const raw = process.env.SENDER_CREDENTIALS_KEY;
  if (!raw || !/^[a-fA-F0-9]{64}$/.test(raw)) {
    throw new Error("SENDER_CREDENTIALS_KEY must be set to 64 hexadecimal characters (32 bytes). Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  }
  return Buffer.from(raw, "hex");
}

export function encryptSenderPassword(password: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptSenderPassword(value: string): string {
  const [ivText, tagText, dataText] = value.split(".");
  if (!ivText || !tagText || !dataText) throw new Error("Stored sender credentials are invalid.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivText, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataText, "base64")), decipher.final()]).toString("utf8");
}
