export const ICONS = {
  pen: ["M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"],
  clock: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 7v5l3 2"],
  check: ["M20 6 9 17l-5-5"],
  alert: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 8v5", "M12 16.5h.01"],
  mail: [
    "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
    "m3 7 9 6 9-6",
  ],
  upload: ["M12 16V4", "m7 9 5-5 5 5", "M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"],
  sun: [
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
    "M12 2v2",
    "M12 20v2",
    "m4.93 4.93 1.41 1.41",
    "m17.66 17.66 1.41 1.41",
    "M2 12h2",
    "M20 12h2",
    "m4.93 19.07 1.41-1.41",
    "m17.66 6.34 1.41-1.41",
  ],
  moon: ["M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"],
  refresh: [
    "M21 12a9 9 0 0 1-15.5 6.2L3 16",
    "M3 21v-5h5",
    "M3 12a9 9 0 0 1 15.5-6.2L21 8",
    "M21 3v5h-5",
  ],
  search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z", "m21 21-4.3-4.3"],
  send: ["m22 2-11 11", "m22 2-7 20-4-9-9-4Z"],
  plus: ["M12 5v14", "M5 12h14"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  list: ["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"],
  trash: ["M3 6h18", "M8 6V4h8v2", "M19 6l-1 14H6L5 6", "M10 11v6", "M14 11v6"],
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  className = "h-4 w-4",
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {ICONS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
