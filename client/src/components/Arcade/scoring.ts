/**
 * Dev Idle Arcade — Scoring & Streak Mechanics
 *
 * Framework-agnostic scoring engine. Computes per-game scores,
 * tracks consecutive above-average performance streaks, applies
 * multipliers, and handles pause/resume around agent responses.
 */

export type GameSlug = 'reaction-test' | 'code-typer' | 'bug-squash' | string;

export interface ScoreResult {
  rawScore: number;
  streak: number;
  streakMultiplier: number;
  finalScore: number;
  badge: string | null;
  isAboveAverage: boolean;
}

export interface GameSession {
  gameSlug: GameSlug;
  playerId: string;
  startTime: number;
  endTime: number | null;
  pausedMs: number;
  rawScore: number;
  streakAtStart: number;
}

export interface ScoreRecord {
  gameSlug: GameSlug;
  playerId: string;
  rawScore: number;
  finalScore: number;
  streak: number;
  timestamp: number;
}

export interface StreakStorage {
  getRecentScores(playerId: string, gameSlug: GameSlug, limit: number): Promise<ScoreRecord[]>;
  saveScore(record: ScoreRecord): Promise<void>;
}

const STREAK_MULTIPLIERS: Record<number, number> = {
  0: 1,
  1: 1,
  2: 1,
  3: 2,
  4: 2,
  5: 3,
};

function getStreakMultiplier(streak: number): number {
  if (streak >= 10) return 3;
  return STREAK_MULTIPLIERS[streak] ?? 1;
}

function getBadge(streak: number): string | null {
  if (streak >= 10) return 'on-fire';
  if (streak >= 5) return 'hot';
  if (streak >= 3) return 'warming-up';
  return null;
}

/**
 * Calculate rolling average from the last N scores.
 */
export function calculateRollingAverage(scores: ScoreRecord[], windowSize = 10): number {
  if (scores.length === 0) return 0;
  const recent = scores.slice(-windowSize);
  const sum = recent.reduce((acc, s) => acc + s.rawScore, 0);
  return sum / recent.length;
}

/**
 * Compute the current streak from ordered score history.
 * Streak = consecutive games with above-average score,
 * counting backwards from the most recent.
 */
export function computeStreak(
  history: ScoreRecord[],
  currentRawScore: number,
  windowSize = 10
): number {
  if (history.length === 0) {
    // First game: any positive score starts a streak of 1
    return currentRawScore > 0 ? 1 : 0;
  }

  const average = calculateRollingAverage(history, windowSize);
  if (currentRawScore < average) return 0;

  let streak = 1;
  // We need scores ordered oldest → newest; history should already be.
  const recent = history.slice(-windowSize);
  for (let i = recent.length - 1; i >= 0; i--) {
    const scoreAverage = calculateRollingAverage(recent.slice(0, i + 1), windowSize);
    if (recent[i].rawScore >= scoreAverage) {
      streak++;
    } else {
      break;
    }
  }

  return streak;
}

/**
 * Score a completed game session.
 */
export async function scoreSession(
  session: GameSession,
  storage: StreakStorage
): Promise<ScoreResult> {
  const history = await storage.getRecentScores(
    session.playerId,
    session.gameSlug,
    50
  );

  const streak = computeStreak(history, session.rawScore);
  const multiplier = getStreakMultiplier(streak);
  const finalScore = Math.round(session.rawScore * multiplier);

  const result: ScoreResult = {
    rawScore: session.rawScore,
    streak,
    streakMultiplier: multiplier,
    finalScore,
    badge: getBadge(streak),
    isAboveAverage: streak > 0 || history.length === 0,
  };

  const record: ScoreRecord = {
    gameSlug: session.gameSlug,
    playerId: session.playerId,
    rawScore: session.rawScore,
    finalScore,
    streak,
    timestamp: Date.now(),
  };

  await storage.saveScore(record);
  return result;
}

/**
 * Pause/resume helper for agent-response interruptions.
 * Tracks total paused time so sessions can deduct it from duration.
 */
export class PauseTracker {
  private pausedAt: number | null = null;
  private totalPausedMs = 0;

  pause() {
    if (this.pausedAt === null) {
      this.pausedAt = Date.now();
    }
  }

  resume() {
    if (this.pausedAt !== null) {
      this.totalPausedMs += Date.now() - this.pausedAt;
      this.pausedAt = null;
    }
  }

  getPausedMs(): number {
    let extra = 0;
    if (this.pausedAt !== null) {
      extra = Date.now() - this.pausedAt;
    }
    return this.totalPausedMs + extra;
  }

  isPaused(): boolean {
    return this.pausedAt !== null;
  }
}

/**
 * Per-game scoring algorithms.
 */
export const ScoringAlgorithms: Record<string, (metrics: Record<string, number>) => number> = {
  'reaction-test': (metrics) => {
    // hits * accuracy bonus - misses * penalty
    const hits = metrics.hits || 0;
    const misses = metrics.misses || 0;
    const accuracy = metrics.accuracy || 0;
    const avgReactionMs = metrics.avgReactionMs || 1000;
    const speedBonus = Math.max(0, 1000 - avgReactionMs) / 10;
    return Math.round(hits * (10 + speedBonus) * (0.5 + accuracy / 2) - misses * 5);
  },

  'code-typer': (metrics) => {
    // chars per minute adjusted for accuracy
    const cpm = metrics.cpm || 0;
    const accuracy = metrics.accuracy || 0;
    const snippets = metrics.snippetsCompleted || 0;
    return Math.round(cpm * (accuracy / 100) + snippets * 50);
  },

  'bug-squash': (metrics) => {
    // bugs squashed - feature misclicks penalty
    const bugs = metrics.bugsSquashed || 0;
    const featuresHit = metrics.featuresHit || 0;
    const timeBonus = (metrics.timeRemainingMs || 0) / 100;
    return Math.round(bugs * 20 - featuresHit * 50 + timeBonus);
  },

  'snake': (metrics) => {
    // food eaten + survival time + length bonus
    const food = metrics.foodEaten || 0;
    const length = metrics.snakeLength || 1;
    const timeBonus = (metrics.timeSurvivedMs || 0) / 1000;
    return Math.round(food * 10 + length * 5 + timeBonus * 2);
  },
};

export function computeRawScore(gameSlug: GameSlug, metrics: Record<string, number>): number {
  const algo = ScoringAlgorithms[gameSlug] || ScoringAlgorithms['reaction-test'];
  return Math.max(0, algo(metrics));
}

/**
 * In-memory storage adapter for testing and offline play.
 */
export class MemoryStorage implements StreakStorage {
  private scores: ScoreRecord[] = [];

  async getRecentScores(playerId: string, gameSlug: GameSlug, limit: number): Promise<ScoreRecord[]> {
    return this.scores
      .filter((s) => s.playerId === playerId && s.gameSlug === gameSlug)
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-limit);
  }

  async saveScore(record: ScoreRecord): Promise<void> {
    this.scores.push(record);
  }

  clear() {
    this.scores = [];
  }
}
