'use client';

// Inline numeric input + Inherit/Clear toggle for overriding the supplemental
// set count. `value === undefined` means "inherit" (template default).
// `templateDefault` is shown in the placeholder so the user knows the fallback.

interface SupplementalSetsControlProps {
  value: number | undefined;
  templateDefault: number;
  onChange: (next: number | undefined) => void | Promise<void>;
  ariaLabel: string;
}

export function SupplementalSetsControl({
  value,
  templateDefault,
  onChange,
  ariaLabel,
}: SupplementalSetsControlProps) {
  const isOverridden = value !== undefined;
  const display = value ?? templateDefault;
  return (
    <div className="flex items-center gap-1">
      <span className="text-xs uppercase tracking-wide text-muted">Sets</span>
      <input
        type="number"
        min={1}
        max={20}
        step={1}
        inputMode="numeric"
        value={display === 0 ? '' : display}
        placeholder={templateDefault > 0 ? String(templateDefault) : '—'}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === '') {
            void onChange(undefined);
            return;
          }
          const n = Math.round(Number(raw));
          if (!Number.isFinite(n)) return;
          const clamped = Math.max(1, Math.min(20, n));
          void onChange(clamped === templateDefault ? undefined : clamped);
        }}
        className={`w-14 rounded border bg-bg px-1.5 py-0.5 text-xs ${
          isOverridden ? 'border-accent text-accent' : 'border-border'
        }`}
        aria-label={ariaLabel}
        title={
          isOverridden
            ? `Custom: ${value} sets (template default is ${templateDefault}). Clear to revert.`
            : `Template default: ${templateDefault} sets. Type a different number to override.`
        }
      />
      {isOverridden && (
        <button
          type="button"
          onClick={() => void onChange(undefined)}
          className="rounded border border-border bg-bg px-1.5 py-0.5 text-[10px] text-muted hover:text-fg"
          title={`Reset to template default (${templateDefault})`}
        >
          ↺
        </button>
      )}
    </div>
  );
}
