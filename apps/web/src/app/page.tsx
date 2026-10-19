"use client";

import { useCallback, useEffect, useState } from "react";
import { AuthGate } from "../components/AuthGate";
import { ErrorAlert, SuccessAlert } from "../components/Alerts";
import { EmailList } from "../components/EmailList";
import { Header } from "../components/Header";
import { ListsManager } from "../components/ListsManager";
import { MobileTabs, Sidebar } from "../components/Sidebar";
import { StatsCards } from "../components/StatsCards";
import { ComposeForm } from "../components/ComposeForm";
import { GroupsManager } from "../components/GroupsManager";
import { GmailAccountsManager } from "../components/GmailAccountsManager";
import { useEmails } from "../hooks/useEmails";
import { useStats } from "../hooks/useStats";
import { useTheme } from "../hooks/useTheme";
import { cancelEmail, fetchSenders } from "../lib/api";
import { BRAND } from "../lib/utils";
import type { Tab } from "../lib/types";


function Dashboard() {
  const [tab, setTab] = useState<Tab>("compose");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [senderCheckComplete, setSenderCheckComplete] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const { theme, ready, toggle } = useTheme();
  const { stats, loadStats } = useStats();
  const list = useEmails(tab);

  useEffect(() => {
    let alive = true;
    fetchSenders().then((senders) => {
      if (!alive) return;
      if (!senders.some((sender) => sender.connectionStatus === "CONNECTED")) setTab("gmail");
      setSenderCheckComplete(true);
    }).catch(() => setSenderCheckComplete(true));
    return () => { alive = false; };
  }, []);

  function changeTab(next: Tab) {
    if (next === tab) return;

    list.reset();
    setError("");
    setMessage("");
    setTab(next);
  }

  const notifyMessage = useCallback((text: string) => {
    setMessage(text);
    setError("");
  }, []);

  const notifyError = useCallback((text: string) => {
    setError(text);
    setMessage("");
  }, []);

  function refresh() {
    void loadStats();
    void list.loadEmails(false);
    setRefreshKey((current) => current + 1);
  }

  function onScheduled(count: number) {
    changeTab("scheduled");
    setMessage(`Successfully scheduled ${count} emails.`);
    void loadStats();
  }

  async function cancel(id: string) {
    if (
      !window.confirm(
        "Cancel this scheduled email? It will not be sent.",
      )
    ) {
      return;
    }

    setCancellingId(id);

    try {
      await cancelEmail(id);
      notifyMessage("Email cancelled.");
      refresh();
    } catch (e) {
      notifyError(
        e instanceof Error
          ? e.message
          : "Could not cancel the email.",
      );
    } finally {
      setCancellingId(null);
    }
  }

  const isListTab =
    tab !== "compose" &&
    tab !== "lists" &&
    tab !== "groups" &&
    tab !== "gmail";

  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--foreground)] antialiased transition-colors duration-200">
      <div className="mx-auto flex min-h-screen w-full max-w-[1600px]">
        <Sidebar tab={tab} stats={stats} onChange={changeTab} />

        <section className="min-w-0 flex-1 px-4 py-5 sm:px-7 sm:py-7 lg:px-10 lg:py-9">
          <div className="mx-auto w-full max-w-[1440px]">
            <Header
              tab={tab}
              theme={theme}
              themeReady={ready}
              onRefresh={refresh}
              onToggleTheme={toggle}
            />

            <MobileTabs tab={tab} onChange={changeTab} />

            {senderCheckComplete && tab !== "gmail" && <StatsCards stats={stats} onSelect={changeTab} />}

            <SuccessAlert
              message={message}
              onDismiss={() => setMessage("")}
            />

            <ErrorAlert
              message={error}
              onDismiss={() => setError("")}
            />

            {/* Keep the compose form mounted so drafts survive tab switches. */}
            <div className={tab === "compose" ? "" : "hidden"}>
              <ComposeForm
                active={tab === "compose"}
                onScheduled={onScheduled}
                onError={notifyError}
                onMessage={notifyMessage}
              />
            </div>

            {tab === "lists" && (
              <ListsManager
                key={`lists-${refreshKey}`}
                onError={notifyError}
                onMessage={notifyMessage}
              />
            )}

            {tab === "groups" && (
              <GroupsManager
                key={`groups-${refreshKey}`}
                onError={notifyError}
                onMessage={notifyMessage}
              />
            )}

            {tab === "gmail" && (
              <GmailAccountsManager onError={notifyError} onMessage={notifyMessage} />
            )}

            {isListTab && (
              <EmailList
                tab={tab}
                emails={list.emails}
                query={list.query}
                onQueryChange={list.setQuery}
                searching={list.searching}
                refreshing={list.refreshing}
                initialLoading={list.initialLoading}
                listError={list.listError}
                onRetry={() => void list.loadEmails(false)}
                onCompose={() => changeTab("compose")}
                onCancel={cancel}
                cancellingId={cancellingId}
              />
            )}

            <footer className="mt-10 flex flex-wrap justify-between gap-3 border-t border-[var(--border)] pt-5 text-xs text-[var(--muted)]">
              <span>{BRAND} · Email scheduler</span>
              <span>
                © {new Date().getFullYear()} {BRAND}
              </span>
            </footer>
          </div>
        </section>
      </div>
    </main>
  );
}


export default function Home() {
  return <AuthGate><Dashboard /></AuthGate>;
}
