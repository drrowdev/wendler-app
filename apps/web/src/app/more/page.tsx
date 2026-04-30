import Link from 'next/link';

const ITEMS = [
  { href: '/goals', label: 'Goals', desc: 'PR targets, race times, habits', icon: '🎯' },
  { href: '/cardio', label: 'Cardio', desc: 'Runs, bike, rowing, walks', icon: '🏃' },
  { href: '/recovery', label: 'Recovery', desc: 'Sleep, HRV, fatigue, soreness', icon: '🛌' },
  { href: '/load', label: 'Load & Deload', desc: 'Weekly stress score and deload coach', icon: '📊' },
  { href: '/movements', label: 'Movements', desc: 'Library, custom lifts, cues', icon: '🏋️' },
  { href: '/settings', label: 'Settings', desc: 'Bar, plates, sync, theme', icon: '⚙️' },
];

export default function MorePage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">More</h1>
      <div className="grid gap-2 sm:grid-cols-2">
        {ITEMS.map((it) => (
          <Link
            key={it.href}
            href={it.href}
            className="flex items-start gap-3 rounded-lg border border-border bg-card p-4 hover:border-accent"
          >
            <span className="text-2xl">{it.icon}</span>
            <div>
              <div className="font-medium">{it.label}</div>
              <div className="text-xs text-muted">{it.desc}</div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
