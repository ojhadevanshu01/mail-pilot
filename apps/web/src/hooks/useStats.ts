"use client";

import { useCallback, useEffect, useState } from "react";

import { fetchStats } from "../lib/api";
import { STATUS_TABS, type Stats } from "../lib/types";

const STATS_POLL_MS = 10_000;

export function useStats() {
  const [stats, setStats] = useState<Stats>({
    scheduled: 0,
    processing: 0,
    sent: 0,
    failed: 0,
    cancelled: 0,
  });

  const loadStats = useCallback(async () => {
    const next = await fetchStats();

    if (!next) return;

    setStats((previous) => {
      const statusCountsUnchanged = STATUS_TABS.every(
        (key) => previous[key] === next[key]
      );

      if (
        statusCountsUnchanged &&
        previous.processing === next.processing
      ) {
        return previous;
      }

      return next;
    });
  }, []);

  useEffect(() => {
    void loadStats();

    const timer = window.setInterval(() => {
      if (!document.hidden) {
        void loadStats();
      }
    }, STATS_POLL_MS);

    return () => window.clearInterval(timer);
  }, [loadStats]);

  return { stats, loadStats };
}
