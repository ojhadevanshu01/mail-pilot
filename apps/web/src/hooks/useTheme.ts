"use client";

import {
  useCallback,
  useEffect,
  useState,
} from "react";

export type Theme = "light" | "dark";

const THEME_KEY = "mailpilot-theme";

export function useTheme() {
  const [theme, setTheme] = useState<Theme>("light");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let initial: Theme = "light";

    try {
      const stored = localStorage.getItem(THEME_KEY);

      if (stored === "light" || stored === "dark") {
        initial = stored;
      } else if (
        window.matchMedia("(prefers-color-scheme: dark)").matches
      ) {
        initial = "dark";
      }
    } catch {
      // Browser storage may be unavailable.
    }

    setTheme(initial);
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;

    document.documentElement.classList.toggle(
      "dark",
      theme === "dark"
    );

    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Ignore storage failures.
    }
  }, [theme, ready]);

  const toggle = useCallback(() => {
    setTheme((current) =>
      current === "dark" ? "light" : "dark"
    );
  }, []);

  return { theme, ready, toggle };
}
