"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { fetchEmails } from "../lib/api";
import type { Email, Tab } from "../lib/types";

const LIST_POLL_MS = 8000;
const SEARCH_DEBOUNCE_MS = 350;

export function useEmails(tab: Tab) {
  const [emails, setEmails] = useState<Email[]>([]);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [listError, setListError] = useState("");
  const [initialLoading, setInitialLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const hasLoadedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const isNonEmailTab =
    tab === "compose" ||
    tab === "lists" ||
    tab === "groups" ||
    tab === "gmail" ||
    (tab as string) === "campaigns";

  const loadEmails = useCallback(
    async (silent = false) => {
      if (isNonEmailTab) {
        return;
      }

      abortRef.current?.abort();

      const controller = new AbortController();
      abortRef.current = controller;

      if (!silent) {
        if (hasLoadedRef.current) {
          setRefreshing(true);
        } else {
          setInitialLoading(true);
        }
      }

      try {
        const rows = await fetchEmails(
          tab,
          debouncedQuery,
          controller.signal
        );

        setEmails((previous) =>
          JSON.stringify(previous) === JSON.stringify(rows)
            ? previous
            : rows
        );

        hasLoadedRef.current = true;
        setListError("");
      } catch (error) {
        if ((error as Error).name === "AbortError") return;

        if (!silent) {
          setListError(
            "We couldn't load your emails. Please try again."
          );
        }
      } finally {
        if (abortRef.current === controller) {
          setInitialLoading(false);
          setRefreshing(false);
        }
      }
    },
    [tab, debouncedQuery, isNonEmailTab]
  );

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedQuery(query),
      SEARCH_DEBOUNCE_MS
    );

    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (isNonEmailTab) {
      abortRef.current?.abort();
      setInitialLoading(false);
      setRefreshing(false);
      return;
    }

    void loadEmails(false);

    const searching = debouncedQuery.trim() !== "";

    const timer = searching
      ? null
      : window.setInterval(() => {
          if (!document.hidden) {
            void loadEmails(true);
          }
        }, LIST_POLL_MS);

    return () => {
      if (timer) window.clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [tab, debouncedQuery, loadEmails, isNonEmailTab]);

  const reset = useCallback(() => {
    hasLoadedRef.current = false;
    setEmails([]);
    setQuery("");
    setDebouncedQuery("");
    setListError("");
  }, []);

  const searching =
    query.trim() !== debouncedQuery.trim() || refreshing;

  return {
    emails,
    query,
    setQuery,
    listError,
    initialLoading,
    refreshing,
    searching,
    loadEmails,
    reset,
  };
}
