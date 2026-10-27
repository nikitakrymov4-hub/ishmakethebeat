export default function Icon({
  name,
  size = 18,
}: {
  name: string;
  size?: number;
}) {
  const paths: Record<string, React.ReactNode> = {
    play: <path d="m7 4 13 8-13 8Z" />,
    pause: (
      <>
        <path d="M7 4h3v16H7zM14 4h3v16h-3z" />
      </>
    ),
    stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
    loop: (
      <>
        <path d="M19 8H7a4 4 0 0 0-4 4v1m2 3h12a4 4 0 0 0 4-4v-1M16 5l3 3-3 3M8 13l-3 3 3 3" />
      </>
    ),
    spark: (
      <>
        <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4m-2-2h4" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" />
      </>
    ),
    unlock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 7-2m-3 9v3" />
      </>
    ),
    save: (
      <>
        <path d="M4 3h13l4 4v14H3V3Zm3 0v7h10V3M7 21v-7h10v7" />
      </>
    ),
    export: (
      <>
        <path d="M12 16V3m-5 5 5-5 5 5M4 14v7h16v-7" />
      </>
    ),
    folder: <path d="M3 6h7l2 3h9v11H3V6Z" />,
    undo: (
      <>
        <path d="m8 5-5 5 5 5M3 10h11a6 6 0 0 1 6 6v3" />
      </>
    ),
    redo: (
      <>
        <path d="m16 5 5 5-5 5m5-5H10a6 6 0 0 0-6 6v3" />
      </>
    ),
    sliders: (
      <>
        <path d="M4 5h16M4 12h16M4 19h16" />
        <circle cx="9" cy="5" r="2" />
        <circle cx="16" cy="12" r="2" />
        <circle cx="8" cy="19" r="2" />
      </>
    ),
    notes: (
      <>
        <path d="M8 17V6l12-3v12M8 10l12-3" />
        <ellipse cx="5" cy="18" rx="3" ry="2" />
        <ellipse cx="17" cy="16" rx="3" ry="2" />
      </>
    ),
    drums: (
      <>
        <rect x="3" y="4" width="6" height="6" rx="1" />
        <rect x="15" y="4" width="6" height="6" rx="1" />
        <rect x="3" y="15" width="6" height="6" rx="1" />
        <rect x="15" y="15" width="6" height="6" rx="1" />
      </>
    ),
    timeline: (
      <>
        <path d="M3 5h18M3 12h18M3 19h18" />
        <path d="M4 3v4m7 3v4m5 3v4" />
      </>
    ),
    headphones: (
      <>
        <path d="M4 13V11a8 8 0 0 1 16 0v2" />
        <rect x="3" y="12" width="4" height="8" rx="2" />
        <rect x="17" y="12" width="4" height="8" rx="2" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6m0-10v1" />
      </>
    ),
    volume: (
      <>
        <path d="M4 9h4l5-4v14l-5-4H4Zm12-1a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />
      </>
    ),
    wave: <path d="M2 10v4m4-8v12m4-15v18m4-13v8m4-11v14m4-9v4" />,
    check: <path d="m5 12 4 4L19 6" />,
    trash: (
      <>
        <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={["play", "pause", "stop"].includes(name) ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.wave}
    </svg>
  );
}
