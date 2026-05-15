import Link from 'next/link';

const ITEMS = [
  { href: '/chat', label: 'Chat', desc: 'AI coach grounded in your training data', icon: '💬' },
  { href: '/goals', label: 'Goals', desc: 'PR targets, race times, habits', icon: '🎯' },
  { href: '/profile', label: 'Training Profile', desc: 'Movement focus, phase, filters, AI notes, bodyweight', icon: '🧭' },
  { href: '/recovery/injuries', label: 'Injuries', desc: 'Active limitations + history; Coach-proposed adjustments', icon: '🩹' },
  { href: '/races', label: 'Races', desc: 'Race calendar, taper priority, results', icon: '🏁' },
  { href: '/movements', label: 'Movements', desc: 'Library, custom lifts, cues', icon: '🏋️' },
  { href: '/notifications', label: 'Notifications', desc: 'Auto-event history, AI rationales', icon: '🔔' },
  { href: '/settings', label: 'Settings', desc: 'Equipment, timer, display, Strava, backup', icon: '⚙️' },
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
