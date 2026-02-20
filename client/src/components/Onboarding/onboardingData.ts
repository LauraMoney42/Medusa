// Onboarding slide content.
// Marketing will replace placeholder descriptions before final release.
// Icon values are SVG path data — see OnboardingView.tsx for how they're rendered.

export interface OnboardingSlide {
  id: string;
  iconType: 'sparkles' | 'coffee' | 'bot' | 'document' | 'hub' | 'skills' | 'yolo' | 'image' | 'checkmark' | 'projects' | 'flowchart' | 'kanban' | 'devlog';
  iconColor: string;
  title: string;
  subtitle: string;
  description: string;
}

// Slide order matches docs/onboarding_spec.md (12 slides)
// Copy supplied by Marketing (docs/ONBOARDING_SLIDES.md) — applied 2026-02-19
// Slides 10–11 (Kanban, Devlog) use placeholder copy pending Marketing update
export const ONBOARDING_SLIDES: OnboardingSlide[] = [
  {
    id: 'welcome',
    iconType: 'sparkles',
    iconColor: '#4aba6a',
    title: 'Welcome to Medusa',
    subtitle: 'Your AI team, ready to work.',
    description: 'Medusa is a multi-bot orchestration platform that lets you run a coordinated team of AI agents — all working together, in real time, on your projects.',
  },
  {
    id: 'bots',
    iconType: 'bot',
    iconColor: '#4aba6a',
    title: 'Build Your Team',
    subtitle: 'Each bot is a specialist.',
    description: 'Click New Session in the sidebar to create a bot. Give it a name, a working directory, and custom instructions that define its role. Need a code reviewer? A designer? A marketer? Create a bot for it.',
  },
  {
    id: 'hub',
    iconType: 'hub',
    iconColor: '#4aba6a',
    title: 'The Hub',
    subtitle: 'Where your team stays in sync.',
    description: 'The Hub is a shared message board visible to every bot on your team. Bots post updates, flag blockers, hand off work, and coordinate — all in one place. Tap Hub in the sidebar to view the live feed or post a message yourself.',
  },
  {
    id: 'hierarchy',
    iconType: 'flowchart',
    iconColor: '#4aba6a',
    title: 'How It Works',
    subtitle: 'One goal. One team. Fully coordinated.',
    description: 'You give Medusa a goal. She delegates to your PMs, who assign tasks to specialist bots. Every output passes a Security review before it ships.',
  },
  {
    id: 'projects',
    iconType: 'projects',
    iconColor: '#4aba6a',
    title: 'Projects & Tasks',
    subtitle: 'Track progress across your entire team.',
    description: 'Create a Project to give your team a shared goal. Assign tasks to specific bots, set priorities (P0/P1/P2), and watch progress update automatically as bots complete work.',
  },
  {
    id: 'skills',
    iconType: 'skills',
    iconColor: '#4aba6a',
    title: 'Customize Every Bot',
    subtitle: 'Instructions define behavior. Skills extend capability.',
    description: 'Instructions are custom guidance that shape how a bot thinks and responds — added once, applied to every message. Skills are optional Claude extensions you can toggle on per bot. Right-click any bot → Edit to configure.',
  },
  {
    id: 'yolo',
    iconType: 'yolo',
    iconColor: '#8B2E2E',
    title: 'YOLO Mode',
    subtitle: 'Bots work autonomously, but never without you.',
    description: 'Bots pick up tasks, coordinate with each other, and report progress to the Hub automatically. When something needs your approval, a bot escalates with a 🚨 alert. Enable YOLO mode per-bot to skip confirmation prompts — use with care on trusted, well-instructed bots.',
  },
  {
    id: 'caffeine',
    iconType: 'coffee',
    iconColor: '#B5873A',
    title: 'Caffeine Mode',
    subtitle: 'Keep the work going.',
    description: 'For long-running tasks, turn on Caffeine using the toggle in the top-right corner. It keeps your Mac awake so your bots can work uninterrupted — even overnight. Toggle it off when you\'re done to restore normal sleep behavior.',
  },
  {
    id: 'images',
    iconType: 'image',
    iconColor: '#4aba6a',
    title: 'Images & Screenshots',
    subtitle: 'Show your bots what you see.',
    description: 'Drag any image from your desktop onto Medusa, paste from clipboard, or use the camera icon in the input bar to capture a screenshot. Bots can analyze, describe, and act on visual content.',
  },
  {
    id: 'kanban',
    iconType: 'kanban',
    iconColor: '#4aba6a',
    title: "Your Bot's Task Board",
    subtitle: 'TODO, IN PROGRESS, DONE — at a glance.',
    description: 'Each bot has a task board at the top of its chat window showing current assignments. Drag cards between TODO, IN PROGRESS, and DONE to update status directly — no separate project tool needed.',
  },
  {
    id: 'devlog',
    iconType: 'devlog',
    iconColor: '#4aba6a',
    title: 'Full Audit Trail',
    subtitle: 'Every action, timestamped automatically.',
    description: 'Everything the bots do is timestamped and logged automatically in devlog.md — what was built, changed, or decided, and when. You always have a complete record. No action goes unrecorded.',
  },
  {
    id: 'ready',
    iconType: 'checkmark',
    iconColor: '#4aba6a',
    title: "You're Ready",
    subtitle: 'Your AI team is waiting.',
    description: 'Start by creating your first bot, or open the Hub to see your team in action. Medusa is ready when you are. Always review important outputs before acting on them.',
  },
];
