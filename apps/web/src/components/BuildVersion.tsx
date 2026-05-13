// Subtle build-version badge. Surfaces the git short SHA captured at
// `next build` time (see next.config.mjs). Helpful for confirming a fresh
// deployment is actually live in the browser (vs. cached SW shell).

const SHA = process.env.NEXT_PUBLIC_BUILD_SHA ?? 'dev';
const TIME = process.env.NEXT_PUBLIC_BUILD_TIME ?? '';

function formatBuildDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())} UTC`;
}

export function BuildVersion() {
  return (
    <span
      aria-label="Build version"
      title={formatBuildDate(TIME) || undefined}
      className="select-text font-mono text-[10px] text-muted/60"
    >
      {SHA}
    </span>
  );
}
