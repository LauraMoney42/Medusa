// Onboarding slide content.
// Icon values are SVG path data: see OnboardingView.tsx for how they're rendered.

export interface OnboardingSlide {
  id: string;
  iconType: 'sparkles' | 'coffee' | 'bot' | 'document' | 'hub' | 'skills' | 'yolo' | 'image' | 'checkmark' | 'projects' | 'flowchart' | 'kanban' | 'devlog';
  iconColor: string;
  title: string;
  subtitle: string;
  description: string;
}

// Rewritten 2026-09-17 for the single-orchestrator model. The old deck taught a
// roster of bots coordinating through a Hub feed; both were removed, so the
// slides that described them would have walked a new user into features that no
// longer exist. `iconType` values are kept as-is: they name SVG shapes in
// OnboardingView.tsx, not products.
export const ONBOARDING_SLIDES: OnboardingSlide[] = [
  {
    id: 'welcome',
    iconType: 'sparkles',
    iconColor: '#4aba6a',
    title: 'Welcome to Medusa',
    subtitle: 'One coding agent, any engine.',
    description: 'Medusa is a harness for a coding agent. You pick the brain behind it (Claude, Kimi, Code Puppy, or an OpenRouter model) and every tool and setting works the same way whichever one you choose.',
  },
  {
    id: 'chats',
    iconType: 'bot',
    iconColor: '#4aba6a',
    title: 'One Chat, One Project',
    subtitle: 'A chat is a folder plus a brain.',
    description: 'Click New Chat in the left rail and pick a project folder, a provider, a model and an engine. The chat is scoped to that folder for its whole life, and its title defaults to the folder name.',
  },
  {
    id: 'subagents',
    iconType: 'flowchart',
    iconColor: '#4aba6a',
    title: 'Subagents',
    subtitle: 'Fan work out without losing the thread.',
    description: 'Ask for something big and Medusa can spawn subagents to work in parallel, each with its own fresh context. Every subagent renders as a collapsible card in the transcript, with its own model and tool calls.',
  },
  {
    id: 'panels',
    iconType: 'hub',
    iconColor: '#4aba6a',
    title: 'Browser & Simulator',
    subtitle: 'Watch the work happen.',
    description: 'The icons at the top right of a chat open a live Chrome session and an iOS Simulator beside it. You can take over either one with your own mouse and keyboard. Press Cmd+B to show or hide the panel.',
  },
  {
    id: 'activity',
    iconType: 'devlog',
    iconColor: '#4aba6a',
    title: 'Activity Log',
    subtitle: 'Nothing happens off the record.',
    description: 'Cmd+L opens the Activity Log on the far right: the raw stream for the current chat, with every tool call, its arguments, its full output, timestamps and token counts. Each message also carries its own tool-call disclosure.',
  },
  {
    id: 'projects',
    iconType: 'projects',
    iconColor: '#4aba6a',
    title: 'Projects',
    subtitle: 'A plan you can watch move.',
    description: 'Medusa can write a structured plan for the current chat, with priorities and per-task owners, and the Projects pane updates live as work lands. Useful when a fan-out of subagents would otherwise scroll away.',
  },
  {
    id: 'tools',
    iconType: 'skills',
    iconColor: '#4aba6a',
    title: 'Tools, Skills & Rules',
    subtitle: 'Shape what the agent can reach.',
    description: 'The Tools view lists this chat\'s engine and provider, the Medusa tool set, your installed skills, and rule files you can switch on per chat. Chat settings adds per-chat instructions on top.',
  },
  {
    id: 'yolo',
    iconType: 'yolo',
    iconColor: '#8B2E2E',
    title: 'YOLO Mode',
    subtitle: 'Autonomous, but never unsupervised.',
    description: 'YOLO mode skips per-tool confirmation prompts for a chat so long runs do not stall waiting on you. Turn it on only in folders you are happy to have changed without a prompt, and read the diff afterwards.',
  },
  {
    id: 'caffeine',
    iconType: 'coffee',
    iconColor: '#B5873A',
    title: 'Caffeine Mode',
    subtitle: 'Keep the work going.',
    description: 'For long-running tasks, turn on Caffeine using the toggle in the top-right corner. It keeps your Mac awake so a run finishes uninterrupted, even overnight. Toggle it off when you are done to restore normal sleep behavior.',
  },
  {
    id: 'images',
    iconType: 'image',
    iconColor: '#4aba6a',
    title: 'Images & Screenshots',
    subtitle: 'Show Medusa what you see.',
    description: 'Drag any image from your desktop onto Medusa, paste from the clipboard, or use the camera icon in the input bar to capture a screenshot. Medusa can analyze, describe, and act on what is in the picture.',
  },
  {
    id: 'usage',
    iconType: 'document',
    iconColor: '#4aba6a',
    title: 'What It Costs',
    subtitle: 'Priced per turn, visible per chat.',
    description: 'The ring under the input shows the running cost of the current chat. Settings has a Usage tab that breaks spend down by chat, source and model, and a Stop All tab that aborts every chat at once.',
  },
  {
    id: 'ready',
    iconType: 'checkmark',
    iconColor: '#4aba6a',
    title: "You're Ready",
    subtitle: 'Pick a folder and start.',
    description: 'Create your first chat from the left rail. Always review important outputs before acting on them, and use the Bug / Feature link when something is wrong: it goes straight to the project\'s issue tracker.',
  },
];
