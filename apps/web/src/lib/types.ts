export const TABS = [
  "compose",
  "scheduled",
  "sent",
  "failed",
  "cancelled",
  "lists",
  "groups",
  "gmail",
] as const;

export type Tab = (typeof TABS)[number];

export const STATUS_TABS = [
  "scheduled",
  "sent",
  "failed",
  "cancelled",
] as const;

export type StatusTab = (typeof STATUS_TABS)[number];

export function isStatusTab(tab: Tab): tab is StatusTab {
  return (STATUS_TABS as readonly string[]).includes(tab);
}

export type Email = {
  id: string;
  recipient: string;
  subject: string;
  status: string;
  scheduledAt: string;
  sentAt: string | null;
  errorMessage: string | null;
};

export type Sender = {
  id: string;
  email: string;
  name: string | null;
  connectionStatus?: "CONNECTED" | "NEEDS_SETUP" | "ERROR";
};

export type Stats = Record<StatusTab, number> & {
  processing: number;
};

export type MailingListRecipient = {
  email: string;
  fields: Record<string, string>;
};

export type MailingList = {
  id: string;
  name: string;
  recipients: string[];
  recipientDetails?: MailingListRecipient[];
  createdAt: string;
  updatedAt: string;
};
