// Page-aware suggested-prompt resolver for the chat empty state.
//
// Given the user's current pathname, return 3–4 conversation-starter
// prompts tailored to that screen — so opening the chat from
// /program/block surfaces "Why these accessories?" instead of the
// generic global set. Pure: takes a pathname string in, returns an
// ordered prompt list. The first matching pattern wins (specific
// before general). Always returns at least the global fallback set
// so the chat is never empty.

export interface ChatPromptHint {
  /** Short button label (≤ 35 chars). */
  title: string;
  /** Full prompt body that gets sent as the user message on tap. */
  body: string;
  /** Emoji icon shown left of the title. */
  icon: string;
}

const GLOBAL_PROMPTS: ChatPromptHint[] = [
  {
    title: 'Half-marathon readiness',
    body: 'Analyze my running history. Can I run my upcoming half-marathon under 2 hours, or do I need to increase my volume — and what kind of running given my overall load?',
    icon: '🏃',
  },
  {
    title: 'Race target check',
    body: 'Given my upcoming A-race, am I on track for the target time? What should I change in the next 4 weeks?',
    icon: '🎯',
  },
  {
    title: 'Where am I stalling?',
    body: 'Where are my strength gains stalling on the four main lifts? What should I change?',
    icon: '🪨',
  },
  {
    title: 'Plan next block',
    body: 'Plan my next training block given my current TMs, recent fatigue, race calendar, and Training Profile.',
    icon: '🧭',
  },
];

interface PageRule {
  test: (path: string) => boolean;
  prompts: ChatPromptHint[];
}

const PAGE_RULES: PageRule[] = [
  // /program/block — block detail. User is looking at the active
  // training block + per-day assistance + main lifts.
  {
    test: (p) => p.startsWith('/program/block'),
    prompts: [
      {
        title: 'Why these accessories?',
        body: "Walk me through the accessory choices for each day of this block — what's each one targeting and how does it fit my Training Profile?",
        icon: '🤔',
      },
      {
        title: "What's coming next?",
        body: "What's my next scheduled session and what should I prioritize? Anything I should adjust based on recent fatigue or upcoming races?",
        icon: '⏭️',
      },
      {
        title: 'Swap suggestions',
        body: 'Review my current block. Are there movements I should swap given my recent training, equipment, or any limitations? Propose specific edits.',
        icon: '🔁',
      },
      {
        title: 'Volume sanity check',
        body: "Is the assistance volume on this block right for me right now? Consider phase, recent fatigue, and race calendar. Propose a preset change if needed.",
        icon: '📊',
      },
    ],
  },
  // /calendar — weekly / monthly grid + timeline.
  {
    test: (p) => p.startsWith('/calendar'),
    prompts: [
      {
        title: "Plan around races",
        body: 'Look at my calendar + upcoming races. Should I shift any sessions to peak right? Propose specific reschedules or skips.',
        icon: '🏁',
      },
      {
        title: "This week's focus",
        body: "What's the focus of this calendar week? Which session is most important to hit, and which one could I afford to skip if life gets in the way?",
        icon: '🗓️',
      },
      {
        title: 'Cardio rebalance',
        body: 'Review my cardio plan against my strength schedule and races. Anything to add, remove, or rescope?',
        icon: '🚴',
      },
    ],
  },
  // /cardio — log + plan editor.
  {
    test: (p) => p.startsWith('/cardio'),
    prompts: [
      {
        title: 'How am I trending?',
        body: 'Analyze my recent cardio: distance, pace, time-in-zones, polarized distribution. Any patterns or red flags? What should I change?',
        icon: '📈',
      },
      {
        title: 'Plan around training',
        body: 'Suggest adjustments to my cardio plan so it complements my current strength block + upcoming races. Propose specific slot changes.',
        icon: '🔧',
      },
      {
        title: 'Friday session ideas',
        body: 'Suggest 2-3 specific cardio sessions I could do this week given my recent load. Pick types (Z2 / threshold / intervals) based on my polarized distribution.',
        icon: '💡',
      },
    ],
  },
  // /recovery + injuries.
  {
    test: (p) => p.startsWith('/recovery'),
    prompts: [
      {
        title: 'Active limitations',
        body: "Review my active injuries and limitations. Are my current swaps appropriate? Anything else I should be doing for recovery or rehab?",
        icon: '🩹',
      },
      {
        title: 'Recovery patterns',
        body: 'Look at my recovery entries over the last 4 weeks. Any patterns I should be aware of? Sleep, soreness, fatigue trends?',
        icon: '😴',
      },
      {
        title: 'When to deload?',
        body: 'Based on recent recovery + training load, am I due for a deload? Propose a deload block if so.',
        icon: '🪶',
      },
    ],
  },
  // /races
  {
    test: (p) => p.startsWith('/races'),
    prompts: [
      {
        title: 'Taper plan',
        body: 'Walk me through the taper plan for my next A-race. What changes when, and what should I do this week specifically?',
        icon: '🏃‍♂️',
      },
      {
        title: 'Race target realism',
        body: 'Given my recent training, is my target time realistic for this race? What would have to change to hit it?',
        icon: '🎯',
      },
      {
        title: 'Race-week edits',
        body: 'Propose specific edits to my training and cardio plans for race week — what stays, what gets cut, what gets added.',
        icon: '✂️',
      },
    ],
  },
  // /stats / /load — analytics views.
  {
    test: (p) => p.startsWith('/stats') || p.startsWith('/load'),
    prompts: [
      {
        title: 'Trend summary',
        body: 'Summarize my training trends over the last 4-8 weeks: tonnage, AMRAP performance, fatigue, cardio distribution. What stands out?',
        icon: '📊',
      },
      {
        title: 'Hidden risks',
        body: 'Look at my analytics for anything that could lead to overtraining, an injury, or a stall. Surface the top 2-3 risks with proposed mitigations.',
        icon: '⚠️',
      },
    ],
  },
  // /goals / /profile
  {
    test: (p) => p.startsWith('/goals') || p.startsWith('/profile'),
    prompts: [
      {
        title: 'Goal alignment check',
        body: "Are my current training profile, block structure, and accessories aligned with my stated goals? Where's the biggest mismatch?",
        icon: '🎯',
      },
      {
        title: 'PR plan',
        body: "Pick my next realistic PR target on each main lift and propose a path to get there (block structure, weekly tonnage, peaking strategy).",
        icon: '🏆',
      },
    ],
  },
  // Home / dashboard.
  {
    test: (p) => p === '/' || p === '/home',
    prompts: [
      {
        title: 'How am I doing?',
        body: 'Give me a brief assessment of my current training: am I on track, what should I prioritize this week, anything I should adjust?',
        icon: '✅',
      },
      {
        title: "Today's plan",
        body: "What should I do today? Consider my schedule, recent training, recovery, and any active limitations.",
        icon: '☀️',
      },
      ...GLOBAL_PROMPTS.slice(0, 2),
    ],
  },
];

/**
 * Return the prompts to show on the chat empty state for the given
 * pathname. Always returns at least 3 prompts; falls back to the
 * global set when no rule matches.
 */
export function suggestedPromptsForPath(path: string | undefined): ChatPromptHint[] {
  const p = path ?? '/';
  for (const rule of PAGE_RULES) {
    if (rule.test(p)) return rule.prompts.slice(0, 4);
  }
  return GLOBAL_PROMPTS;
}
