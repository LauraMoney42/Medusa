import { forwardRef, useEffect, useRef, useState, useImperativeHandle } from 'react';
import { computeRawScore, PauseTracker } from '../scoring';

interface Props {
  isPaused: boolean;
  onScore: (score: number, streak: number) => void;
  onBack: () => void;
}

const GAME_DURATION = 30;
const CANVAS_WIDTH = 300;
const CANVAS_HEIGHT = 320;

interface Target {
  x: number;
  y: number;
  radius: number;
  createdAt: number;
  hit: boolean;
}

export default forwardRef(function ReactionTestGame(
  { isPaused, onScore, onBack }: Props,
  ref: React.Ref<{ pause: () => void; resume: () => void }>
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(GAME_DURATION);
  const [gameOver, setGameOver] = useState(false);
  const [, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);

  const targetsRef = useRef<Target[]>([]);
  const scoreRef = useRef(0);
  const streakRef = useRef(0);
  const bestStreakRef = useRef(0);
  const gameStateRef = useRef<'playing' | 'paused' | 'over'>('playing');
  const animFrameRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const spawnTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(Date.now());
  const pauseTrackerRef = useRef(new PauseTracker());
  const hitsRef = useRef(0);
  const missesRef = useRef(0);
  const reactionTimesRef = useRef<number[]>([]);

  useImperativeHandle(ref, () => ({
    pause: () => { gameStateRef.current = 'paused'; },
    resume: () => { if (gameStateRef.current === 'paused') gameStateRef.current = 'playing'; },
  }));

  // Timer countdown
  useEffect(() => {
    if (isPaused || gameOver) return;
    timerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
      const remaining = Math.max(0, GAME_DURATION - elapsed);
      setTimeLeft(remaining);
      if (remaining <= 0) {
        endGame();
      }
    }, 100);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isPaused, gameOver]);

  // Spawn targets
  useEffect(() => {
    if (isPaused || gameOver) return;
    const spawn = () => {
      if (gameStateRef.current !== 'playing') return;
      const margin = 30;
      const target: Target = {
        x: margin + Math.random() * (CANVAS_WIDTH - margin * 2),
        y: margin + Math.random() * (CANVAS_HEIGHT - margin * 2),
        radius: 18 + Math.random() * 12,
        createdAt: Date.now(),
        hit: false,
      };
      targetsRef.current.push(target);
      // Remove old targets
      const now = Date.now();
      targetsRef.current = targetsRef.current.filter(
        (t) => !t.hit && now - t.createdAt < 2000
      );
    };
    spawnTimerRef.current = setInterval(spawn, 800);
    return () => { if (spawnTimerRef.current) clearInterval(spawnTimerRef.current); };
  }, [isPaused, gameOver]);

  // Game loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const loop = () => {
      if (gameStateRef.current === 'over') return;

      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Background
      ctx.fillStyle = '#0f0f23';
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Grid pattern
      ctx.strokeStyle = 'rgba(102, 126, 234, 0.1)';
      ctx.lineWidth = 1;
      for (let x = 0; x < CANVAS_WIDTH; x += 20) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, CANVAS_HEIGHT);
        ctx.stroke();
      }
      for (let y = 0; y < CANVAS_HEIGHT; y += 20) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(CANVAS_WIDTH, y);
        ctx.stroke();
      }

      if (gameStateRef.current === 'paused') {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 24px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('PAUSED', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
        animFrameRef.current = requestAnimationFrame(loop);
        return;
      }

      const now = Date.now();

      // Draw targets
      targetsRef.current.forEach((target) => {
        if (target.hit) return;
        const age = now - target.createdAt;
        const shrink = Math.max(0.5, 1 - age / 2000);
        const r = target.radius * shrink;

        // Outer glow
        const gradient = ctx.createRadialGradient(
          target.x, target.y, 0,
          target.x, target.y, r * 2
        );
        gradient.addColorStop(0, 'rgba(102, 126, 234, 0.8)');
        gradient.addColorStop(0.5, 'rgba(118, 75, 162, 0.4)');
        gradient.addColorStop(1, 'rgba(102, 126, 234, 0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(target.x, target.y, r * 2, 0, Math.PI * 2);
        ctx.fill();

        // Inner circle
        ctx.fillStyle = '#667eea';
        ctx.beginPath();
        ctx.arc(target.x, target.y, r, 0, Math.PI * 2);
        ctx.fill();

        // Border
        ctx.strokeStyle = '#a78bfa';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(target.x, target.y, r, 0, Math.PI * 2);
        ctx.stroke();
      });

      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, []);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (gameStateRef.current !== 'playing') return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = CANVAS_WIDTH / rect.width;
    const scaleY = CANVAS_HEIGHT / rect.height;
    const clickX = (e.clientX - rect.left) * scaleX;
    const clickY = (e.clientY - rect.top) * scaleY;

    let hit = false;
    targetsRef.current.forEach((target) => {
      if (target.hit) return;
      const dx = clickX - target.x;
      const dy = clickY - target.y;
      if (Math.sqrt(dx * dx + dy * dy) < target.radius + 5) {
        target.hit = true;
        hit = true;
        const reactionMs = Date.now() - target.createdAt;
        reactionTimesRef.current.push(reactionMs);
        hitsRef.current += 1;
        streakRef.current += 1;
        if (streakRef.current > bestStreakRef.current) {
          bestStreakRef.current = streakRef.current;
        }
        setStreak(streakRef.current);
        setBestStreak(bestStreakRef.current);
      }
    });

    if (!hit) {
      missesRef.current += 1;
      streakRef.current = 0;
      setStreak(0);
    }

    // Compute score using Dev3's scoring engine
    const avgReaction = reactionTimesRef.current.length > 0
      ? reactionTimesRef.current.reduce((a, b) => a + b, 0) / reactionTimesRef.current.length
      : 1000;
    const totalClicks = hitsRef.current + missesRef.current;
    const accuracy = totalClicks > 0 ? hitsRef.current / totalClicks : 0;
    const rawScore = computeRawScore('reaction-test', {
      hits: hitsRef.current,
      misses: missesRef.current,
      accuracy,
      avgReactionMs: avgReaction,
    });
    scoreRef.current = rawScore;
    setScore(rawScore);
  };

  const endGame = () => {
    gameStateRef.current = 'over';
    setGameOver(true);
    if (timerRef.current) clearInterval(timerRef.current);
    if (spawnTimerRef.current) clearInterval(spawnTimerRef.current);
    cancelAnimationFrame(animFrameRef.current);
    onScore(scoreRef.current, bestStreakRef.current);
  };

  const restart = () => {
    scoreRef.current = 0;
    streakRef.current = 0;
    bestStreakRef.current = 0;
    hitsRef.current = 0;
    missesRef.current = 0;
    reactionTimesRef.current = [];
    pauseTrackerRef.current = new PauseTracker();
    targetsRef.current = [];
    setScore(0);
    setStreak(0);
    setBestStreak(0);
    setTimeLeft(GAME_DURATION);
    setGameOver(false);
    gameStateRef.current = 'playing';
    startTimeRef.current = Date.now();
  };

  // Pause/resume from prop
  useEffect(() => {
    if (isPaused) {
      gameStateRef.current = 'paused';
      pauseTrackerRef.current.pause();
    } else if (gameStateRef.current === 'paused') {
      gameStateRef.current = 'playing';
      pauseTrackerRef.current.resume();
    }
  }, [isPaused]);

  return (
    <div className="arcade-game-container">
      <canvas
        ref={canvasRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        className="arcade-game-canvas"
        onClick={handleClick}
        style={{ cursor: 'crosshair' }}
      />
      <div className="arcade-game-ui">
        <div className="arcade-score">{score} pts</div>
        <div className="arcade-timer">{timeLeft}s</div>
      </div>
      <button className="arcade-back-btn" onClick={onBack}>← Back</button>

      {gameOver && (
        <div className="arcade-gameover">
          <div className="arcade-gameover-title">Time's Up!</div>
          <div className="arcade-gameover-score">{score}</div>
          <div className="arcade-gameover-streak">
            {bestStreak > 1 ? `🔥 Best streak: ${bestStreak}x` : 'Keep practicing!'}
          </div>
          <div className="arcade-gameover-btns">
            <button className="arcade-gameover-btn primary" onClick={restart}>Play Again</button>
            <button className="arcade-gameover-btn secondary" onClick={onBack}>Menu</button>
          </div>
        </div>
      )}
    </div>
  );
});
