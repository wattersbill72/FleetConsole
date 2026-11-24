export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

export const when = (iso: string) => new Date(iso).toLocaleString();

/** "42 s ago", "5 min ago". Under ten seconds is "just now". */
export function ago(seconds: number | null): string {
  if (seconds === null) return 'never';
  if (seconds < 10) return 'just now';
  return `${formatDuration(seconds)} ago`;
}

export const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v)}%`);
