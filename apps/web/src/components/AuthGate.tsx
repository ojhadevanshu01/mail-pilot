"use client";

import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { API } from "../lib/api";

type Mode = "login" | "register" | "forgot" | "resend" | "reset";
type User = { id: string; name: string | null; email: string; emailVerified: boolean };

async function post(path: string, data: Record<string, string>) {
  const response = await fetch(`${API}/api/auth/${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  let json: any = {};
  try { json = await response.json(); } catch { /* API returned no JSON */ }
  if (!response.ok) {
    const error = new Error(json.error || "Request failed.") as Error & { code?: string };
    error.code = json.code;
    throw error;
  }
  return json;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [mode, setMode] = useState<Mode>("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [token, setToken] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const verify = params.get("verify");
    const reset = params.get("reset");
    const queryEmail = params.get("email") || "";
    if (queryEmail) setEmail(queryEmail);
    if (reset) { setToken(reset); setMode("reset"); }
    if (verify) {
      setMode("login");
      setBusy(true);
      post("verify-email", { token: verify, email: queryEmail })
        .then((result) => setMessage(result.message || "Email verified. You can now sign in."))
        .catch((e: Error) => setError(e.message))
        .finally(() => {
          setBusy(false);
          window.history.replaceState({}, "", window.location.pathname);
        });
    }
    fetch(`${API}/api/auth/me`, { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) return null;
        const json = await response.json();
        return json.data as User;
      })
      .then((current) => setUser(current))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setMessage("");
    try {
      if (mode === "register") {
        const result = await post("register", { name, email, password });
        setMessage(result.message || "Account created. Check your email to verify it.");
        setMode("resend"); setPassword("");
      } else if (mode === "login") {
        const result = await post("login", { email, password });
        setUser(result.data); setPassword("");
      } else if (mode === "forgot" || mode === "resend") {
        const result = await post(mode === "forgot" ? "forgot-password" : "resend-verification", { email });
        setMessage(result.message || "If your account needs an email, it will be sent shortly.");
      } else {
        if (password !== confirmPassword) throw new Error("Passwords do not match.");
        const result = await post("reset-password", { email, token, password });
        setMessage(result.message || "Password reset. Please sign in.");
        setMode("login"); setPassword(""); setConfirmPassword(""); setToken("");
        window.history.replaceState({}, "", window.location.pathname);
      }
    } catch (e) {
      const err = e as Error & { code?: string };
      setError(err.message);
      if (err.code === "EMAIL_NOT_VERIFIED") setMode("resend");
    } finally { setBusy(false); }
  }

  async function logout() {
    try { await post("logout", {}); } catch { /* The local UI still returns to sign-in. */ } finally { setUser(null); setMode("login"); }
  }

  if (loading) return <div className="flex min-h-screen items-center justify-center bg-[var(--background)] text-sm text-[var(--muted)]">Loading MailPilot…</div>;
  if (user) return <div className="min-h-screen bg-[var(--background)]"><div className="flex items-center justify-end gap-3 border-b border-[var(--border)] px-5 py-3 text-sm"><span className="text-[var(--muted)]">{user.name || user.email}</span><button onClick={logout} className="rounded-lg border border-[var(--border)] px-3 py-2 font-medium hover:bg-[var(--surface-muted)]">Sign out</button></div>{children}</div>;

  const title = mode === "register" ? "Create your account" : mode === "forgot" ? "Reset your password" : mode === "resend" ? "Verify your email" : mode === "reset" ? "Choose a new password" : "Welcome back";
  const description = mode === "register" ? "Create a MailPilot account. You must verify your email before signing in." : mode === "forgot" ? "We’ll email a single-use reset link if this account exists." : mode === "resend" ? "Enter your account email and we’ll send a verification link if needed." : mode === "reset" ? "Your reset link expires after 30 minutes and works once." : "Sign in to manage your scheduled emails.";
  const fieldClass = "w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100";
  return <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10 text-slate-900">
    <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-7 shadow-xl shadow-slate-200/50 sm:p-9">
      <div className="mb-7"><div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-indigo-600 text-xl font-bold text-white">M</div><h1 className="text-2xl font-bold tracking-tight">MailPilot</h1><h2 className="mt-4 text-xl font-semibold">{title}</h2><p className="mt-2 text-sm leading-6 text-slate-600">{description}</p></div>
      {error && <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700">{error}</div>}
      {message && <div role="status" className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-800">{message}</div>}
      <form onSubmit={submit} className="space-y-4">
        {mode === "register" && <label className="block text-sm font-medium">Full name<input required maxLength={100} autoComplete="name" className={`${fieldClass} mt-1.5`} value={name} onChange={e => setName(e.target.value)} /></label>}
        {mode !== "reset" && <label className="block text-sm font-medium">Email address<input required type="email" autoComplete="email" className={`${fieldClass} mt-1.5`} value={email} onChange={e => setEmail(e.target.value)} /></label>}
        {(mode === "login" || mode === "register" || mode === "reset") && <label className="block text-sm font-medium">{mode === "reset" ? "New password" : "Password"}<input required minLength={10} maxLength={200} type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} className={`${fieldClass} mt-1.5`} value={password} onChange={e => setPassword(e.target.value)} /><span className="mt-1 block text-xs font-normal text-slate-500">Use at least 10 characters.</span></label>}
        {mode === "reset" && <label className="block text-sm font-medium">Confirm new password<input required minLength={10} maxLength={200} type="password" autoComplete="new-password" className={`${fieldClass} mt-1.5`} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} /></label>}
        <button disabled={busy} className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60">{busy ? "Please wait…" : mode === "register" ? "Create account" : mode === "forgot" ? "Send reset link" : mode === "resend" ? "Send verification link" : mode === "reset" ? "Reset password" : "Sign in"}</button>
      </form>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm text-indigo-700">
        {mode === "login" && <><button onClick={() => {setMode("register");setError("");setMessage("");}}>Create account</button><button onClick={() => {setMode("forgot");setError("");setMessage("");}}>Forgot password?</button><button onClick={() => {setMode("resend");setError("");setMessage("");}}>Resend verification</button></>}
        {mode !== "login" && <button onClick={() => {setMode("login");setError("");setMessage("");}}>Back to sign in</button>}
      </div>
      <p className="mt-7 text-center text-xs leading-5 text-slate-500">Your account is private. Sign-in is enabled only after email verification.</p>
    </section>
  </main>;
}
