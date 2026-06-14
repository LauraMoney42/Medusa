import { useState, useCallback, useRef, useEffect } from 'react';
import { useHubStore } from '../../stores/hubStore';
import ReactionTestGame from './games/ReactionTestGame';
import SnakeGame from './games/SnakeGame';
import WordMatchGame from './games/WordMatchGame';
import { scoreSession, PauseTracker, MemoryStorage, type ScoreResult } from './scoring';
import './arcade.css';

type GameType = 'menu' | 'reaction' | 'snake' | 'wordmatch';

const GAME_SLUGS: Record<GameType, string> = {
  menu: '',
  reaction: 'reaction-test',
  snake: 'snake',
  wordmatch: 'word-match',
};

// TODO: Swap to Supabase storage when Dev2 backend is ready
const storage = new MemoryStorage();

interface ScoreData {
  game: string;
  rawScore: number;
  finalScore: number;
  streak: number;
  multiplier: number;
  badge: string | null;
}

interface Props {
  onScoreSubmit?: (data: ScoreData) => void;
  autoExpand?: boolean;
}

export default function ArcadeWidget({ onScoreSubmit, autoExpand = false }: Props) {
  const [activeGame, setActiveGame] = useState<GameType>('menu');
  const [lastScore, setLastScore] = useState<ScoreData | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [isExpanded, setIsExpanded] = useState(autoExpand);
  const gameRef = useRef<any>(null);

  const pauseTracker = useRef(new PauseTracker());
  const sessionStart = useRef<number>(0);

  const hubMessages = useHubStore((s) => s.messages);
  const lastMessageCount = useRef(hubMessages.length);

  // Auto-pause when new agent message arrives
  useEffect(() => {
    if (hubMessages.length > lastMessageCount.current) {
      const newMessages = hubMessages.slice(lastMessageCount.current);
      const hasAgentMessage = newMessages.some(
        (m: any) => m.sender && !m.sender.startsWith('User')
      );
      if (hasAgentMessage && activeGame !== 'menu') {
        setIsPaused(true);
        pauseTracker.current.pause();
      }
    }
    lastMessageCount.current = hubMessages.length;
  }, [hubMessages, activeGame]);

  // Track session start when entering a game
  useEffect(() => {
    if (activeGame !== 'menu') {
      sessionStart.current = Date.now();
      pauseTracker.current = new PauseTracker();
    }
  }, [activeGame]);

  // Resume handler
  const handleResume = useCallback(() => {
    setIsPaused(false);
    pauseTracker.current.resume();
  }, []);

  const handleScore = useCallback(
    async (game: GameType, rawScore: number, _streak: number) => {
      const slug = GAME_SLUGS[game];
      const session = {
        gameSlug: slug,
        playerId: 'local-player',
        startTime: sessionStart.current,
        endTime: Date.now(),
        pausedMs: pauseTracker.current.getPausedMs(),
        rawScore,
        streakAtStart: 0,
      };

      let result: ScoreResult;
      try {
        result = await scoreSession(session, storage);
      } catch {
        // Fallback if scoring fails
        result = {
          rawScore,
          streak: 1,
          streakMultiplier: 1,
          finalScore: rawScore,
          badge: null,
          isAboveAverage: true,
        };
      }

      const data: ScoreData = {
        game: slug,
        rawScore: result.rawScore,
        finalScore: result.finalScore,
        streak: result.streak,
        multiplier: result.streakMultiplier,
        badge: result.badge,
      };

      setLastScore(data);
      onScoreSubmit?.(data);
      setActiveGame('menu');
    },
    [onScoreSubmit]
  );

  const handleBack = useCallback(() => {
    setActiveGame('menu');
    setIsPaused(false);
    pauseTracker.current = new PauseTracker();
  }, []);

  if (!isExpanded) {
    return (
      <div className="arcade-collapsed" onClick={() => setIsExpanded(true)}>
        <div className="arcade-icon">🎮</div>
        <div className="arcade-teaser">
          {lastScore ? (
            <span>Last: {lastScore.finalScore} pts</span>
          ) : (
            <span>Play while you wait</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="arcade-widget">
      <div className="arcade-header">
        <span className="arcade-title">🎮 Dev Idle Arcade</span>
        <button className="arcade-close" onClick={() => setIsExpanded(false)}>
          ✕
        </button>
      </div>

      {isPaused && activeGame !== 'menu' && (
        <div className="arcade-pause-overlay">
          <div className="arcade-pause-content">
            <div className="arcade-pause-icon">⏸️</div>
            <div>Agent responded — paused</div>
            <button className="arcade-resume-btn" onClick={handleResume}>
              Resume
            </button>
          </div>
        </div>
      )}

      {activeGame === 'menu' && (
        <div className="arcade-menu">
          {lastScore && (
            <div className="arcade-last-score">
              Last game: {lastScore.finalScore} pts
              {lastScore.badge && (
                <span className="arcade-streak"> 🔥 {lastScore.badge}</span>
              )}
              <span style={{ color: 'var(--text-secondary)', fontSize: 11, marginLeft: 8 }}>
                (×{lastScore.multiplier})
              </span>
            </div>
          )}
          <div className="arcade-games-grid">
            <button
              className="arcade-game-btn"
              onClick={() => { setActiveGame('reaction'); setIsPaused(false); }}
            >
              <div className="arcade-game-icon">⚡</div>
              <div className="arcade-game-name">Reaction Test</div>
              <div className="arcade-game-desc">Click targets fast</div>
            </button>
            <button
              className="arcade-game-btn"
              onClick={() => { setActiveGame('snake'); setIsPaused(false); }}
            >
              <div className="arcade-game-icon">🐍</div>
              <div className="arcade-game-name">Snake</div>
              <div className="arcade-game-desc">Eat, grow, survive</div>
            </button>
            <button
              className="arcade-game-btn"
              onClick={() => { setActiveGame('wordmatch'); setIsPaused(false); }}
            >
              <div className="arcade-game-icon">🔤</div>
              <div className="arcade-game-name">Word Match</div>
              <div className="arcade-game-desc">Type words fast</div>
            </button>
          </div>
        </div>
      )}

      {activeGame === 'reaction' && (
        <ReactionTestGame
          isPaused={isPaused}
          onScore={(score, streak) => handleScore('reaction', score, streak)}
          onBack={handleBack}
          ref={gameRef}
        />
      )}

      {activeGame === 'snake' && (
        <SnakeGame
          isPaused={isPaused}
          onScore={(score, streak) => handleScore('snake', score, streak)}
          onBack={handleBack}
          ref={gameRef}
        />
      )}

      {activeGame === 'wordmatch' && (
        <WordMatchGame
          isPaused={isPaused}
          onScore={(score, streak) => handleScore('wordmatch', score, streak)}
          onBack={handleBack}
          ref={gameRef}
        />
      )}
    </div>
  );
}
