"use client";

import { useEffect, useState } from "react";
import { createSender, deleteSender, fetchSenders } from "../lib/api";
import type { Sender } from "../lib/types";
import { Icon } from "./Icon";

export function GmailAccountsManager({ onMessage, onError }: { onMessage: (message: string) => void; onError: (message: string) => void }) {
  const [senders, setSenders] = useState<Sender[]>([]);
  const [email, setEmail] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  async function load() { setLoading(true); try { setSenders(await fetchSenders()); } catch (e) { onError(e instanceof Error ? e.message : "Could not load Gmail accounts."); } finally { setLoading(false); } }
  useEffect(() => { void load(); }, []);

  async function connect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true);
    try { const sender = await createSender(email, appPassword); setSenders((old) => [sender, ...old.filter((s) => s.id !== sender.id)]); setEmail(""); setAppPassword(""); onMessage("Gmail connected successfully."); }
    catch (e) { onError(e instanceof Error ? e.message : "Could not connect Gmail."); }
    finally { setBusy(false); }
  }

  async function remove(sender: Sender) {
    if (!window.confirm(`Delete ${sender.email} from MailPilot? Scheduled emails using this account must be cancelled or completed first.`)) return;
    try { await deleteSender(sender.id); setSenders((old) => old.filter((s) => s.id !== sender.id)); onMessage("Gmail account deleted."); }
    catch (e) { onError(e instanceof Error ? e.message : "Could not delete Gmail account."); }
  }

  return <section className="space-y-6">
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-7">
      <div className="mb-5 flex items-start gap-3"><div className="rounded-xl bg-[var(--surface-muted)] p-3"><Icon name="mail" className="size-6" /></div><div><h3 className="text-lg font-semibold">Connect a Gmail account</h3><p className="mt-1 text-sm text-[var(--muted)]">Add the account MailPilot should send emails from. You can connect more than one.</p></div></div>
      <div className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 text-sm">
        <h4 className="mb-3 font-semibold">Quick setup guide</h4>
        <ol className="list-inside list-decimal space-y-2 text-[var(--muted)]"><li>Enable <b>2-Step Verification</b> in your Google Account.</li><li>Create a Google <b>App Password</b> for MailPilot.</li><li>Enter your Gmail address and that App Password below. MailPilot tests the connection before saving.</li></ol>
        <div className="mt-3 flex flex-wrap gap-3"><a className="font-medium text-[var(--accent)] underline" href="https://myaccount.google.com/security" target="_blank" rel="noreferrer">Google Security ↗</a><a className="font-medium text-[var(--accent)] underline" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">Create App Password ↗</a></div>
        <p className="mt-3 text-xs text-[var(--muted)]">Use the generated App Password, not your normal Google password. Some Google accounts may not support App Passwords.</p>
      </div>
      <form onSubmit={connect} className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium">Gmail address<input required type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@gmail.com" className="mt-2 min-h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 font-normal" /></label>
        <label className="block text-sm font-medium">Google App Password<input required type="password" autoComplete="new-password" value={appPassword} onChange={(e) => setAppPassword(e.target.value)} placeholder="Paste your App Password" className="mt-2 min-h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 font-normal" /></label>
        <div className="sm:col-span-2"><button disabled={busy} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-indigo-600 px-5 font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">{busy ? "Testing connection…" : "Test and connect Gmail"}</button></div>
      </form>
    </div>
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-7"><div className="mb-4 flex items-center justify-between"><div><h3 className="text-lg font-semibold">Your Gmail accounts</h3><p className="text-sm text-[var(--muted)]">{senders.length} account(s) connected or awaiting setup</p></div><button onClick={() => void load()} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm">Refresh</button></div>
      {loading ? <p className="py-5 text-sm text-[var(--muted)]">Loading accounts…</p> : senders.length === 0 ? <p className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--muted)]">No Gmail accounts yet. Follow the guide above to connect your first account.</p> : <div className="divide-y divide-[var(--border)]">{senders.map((sender) => <div key={sender.id} className="flex flex-wrap items-center gap-3 py-4"><div className="rounded-full bg-[var(--surface-muted)] p-2"><Icon name="mail" /></div><div className="min-w-0 flex-1"><p className="truncate font-medium">{sender.email}</p><p className="mt-1 text-xs text-[var(--muted)]">{sender.connectionStatus === "CONNECTED" ? "Connected · Ready to send" : "Needs setup · Reconnect this account"}</p></div><button onClick={() => void remove(sender)} className="inline-flex items-center gap-2 rounded-lg border border-red-300 px-3 py-2 text-sm text-red-600 hover:bg-red-50"><Icon name="trash" />Delete</button></div>)}</div>}
    </div>
  </section>;
}
