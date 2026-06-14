import { forwardRef, useEffect, useRef, useState, useImperativeHandle } from 'react';
import { computeRawScore, PauseTracker } from '../scoring';

interface Props {
  isPaused: boolean;
  onScore: (score: number, streak: number) => void;
  onBack: () => void;
}

const CANVAS_WIDTH = 300;
const CANVAS_HEIGHT = 320;
const GAME_DURATION = 30;

const WORD_LIST = [
  'function', 'const', 'let', 'var', 'return', 'if', 'else', 'for', 'while',
  'class', 'import', 'export', 'async', 'await', 'try', 'catch', 'throw',
  'map', 'filter', 'reduce', 'push', 'pop', 'shift', 'slice', 'splice',
  'react', 'vue', 'angular', 'svelte', 'node', 'deno', 'bun', 'vite',
  'git', 'commit', 'push', 'pull', 'merge', 'branch', 'clone', 'fetch',
  'api', 'rest', 'graphql', 'json', 'xml', 'yaml', 'toml', 'csv',
  'sql', 'select', 'insert', 'update', 'delete', 'join', 'where', 'index',
  'html', 'css', 'sass', 'less', 'flex', 'grid', 'dom', 'svg',
  'test', 'jest', 'mocha', 'cypress', 'vitest', 'playwright', 'e2e', 'unit',
  'docker', 'kube', 'aws', 'azure', 'gcp', 'ci', 'cd', 'deploy',
];

interface WordTarget {
  word: string;
  x: number;
  y: number;
  speed: number;
  typed: number;
}

export default forwardRef(function WordMatchGame(
  { isPaused, onScore, onBack }: Props,
  ref: React.Ref<{ pause: () => void; resume: () => void }>
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(GAME_DURATION);
  const [gameOver, setGameOver] = useState(false);

  const wordsRef = useRef<WordTarget[]>([]);
  const scoreRef = useRef(0);
  const streakRef = useRef(0);
  const bestStreakRef = useRef(0);
  const gameStateRef = useRef<'playing' | 'paused' | 'over'>('playing');
  const animFrameRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const spawnTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(Date.now());
  const currentInputRef = useRef('');
  const pauseTrackerRef = useRef(new PauseTracker());
  const wordsTypedRef = useRef(0);
  const charsTypedRef = useRef(0);
  const errorsRef = useRef(0);

  useImperativeHandle(ref, () => ({
    pause: () => { gameStateRef.current = 'paused'; },
    resume: () => { if (gameStateRef.current === 'paused') gameStateRef.current = 'playing'; },
  }));

  const spawnWord = () => {
    if (gameStateRef.current !== 'playing') return;
    const word = WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];
    wordsRef.current.push({
      word,
      x: 20 + Math.random() * (CANVAS_WIDTH - 140),
      y: -20,
      speed: 0.5 + Math.random() * 0.8 + (scoreRef.current / 200),
      typed: 0,
    });
  };

  // Spawn words
  useEffect(() => {
    if (isPaused || gameOver) return;
    spawnTimerRef.current = setInterval(spawnWord, 2000);
    return () => { if (spawnTimerRef.current) clearInterval(spawnTimerRef.current); };
  }, [isPaused, gameOver]);

  // Timer
  useEffect(() => {
    if (isPaused || gameOver) return;
    timerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
      const remaining = Math.max(0, GAME_DURATION - elapsed);
      setTimeLeft(remaining);
      if (remaining <= 0) endGame();
    }, 100);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isPaused, gameOver]);

  // Game loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const loop = () => {
      if (gameStateRef.current === 'over') return;

      ctx.fillStyle = '#0f0f23';
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Grid
      ctx.strokeStyle = 'rgba(102, 126, 234, 0.1)';
      ctx.lineWidth = 0.5;
      for (let x = 0; x <= CANVAS_WIDTH; x += 20) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, CANVAS_HEIGHT);
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

      // Update and draw words
      wordsRef.current.forEach((w) => {
        w.y += w.speed;
      });

      // Remove words that fell off screen
      wordsRef.current = wordsRef.current.filter((w) => w.y < CANVAS_HEIGHT + 20);

      wordsRef.current.forEach((w) => {
        const completed = w.word.slice(0, w.typed);
        const remaining = w.word.slice(w.typed);

        // Background for word
        const totalWidth = ctx.measureText(w.word).width + 12;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(w.x - 6, w.y - 16, totalWidth, 24);

        // Completed portion
        ctx.font = 'bold 16px monospace';
        ctx.fillStyle = '#4ade80';
        ctx.textAlign = 'left';
        ctx.fillText(completed, w.x, w.y);

        // Remaining portion
        const completedWidth = ctx.measureText(completed).width;
        ctx.fillStyle = '#e5e7eb';
        ctx.fillText(remaining, w.x + completedWidth, w.y);

        // Border
        ctx.strokeStyle = w.typed > 0 ? '#4ade80' : 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = 1;
        ctx.strokeRect(w.x - 6, w.y - 16, totalWidth, 24);
      });

      // Current input display
      ctx.fillStyle = 'rgba(102, 126, 234, 0.2)';
      ctx.fillRect(10, CANVAS_HEIGHT - 40, CANVAS_WIDTH - 20, 30);
      ctx.fillStyle = '#a78bfa';
      ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`> ${currentInputRef.current}`, 16, CANVAS_HEIGHT - 20);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.font = '12px monospace';
      ctx.fillText('Type the falling words!', 10, CANVAS_HEIGHT - 50);

      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, []);

  // Keyboard input
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (gameStateRef.current !== 'playing') return;

      if (e.key === 'Backspace') {
        currentInputRef.current = currentInputRef.current.slice(0, -1);
        return;
      }

      if (e.key === 'Escape') {
        currentInputRef.current = '';
        return;
      }

      if (e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
        currentInputRef.current += e.key.toLowerCase();
      }

      // Check for matches
      let matched = false;
      wordsRef.current.forEach((w) => {
        if (w.word.toLowerCase().startsWith(currentInputRef.current)) {
          w.typed = currentInputRef.current.length;
        } else {
          w.typed = 0;
        }

        if (w.word.toLowerCase() === currentInputRef.current) {
          matched = true;
          w.typed = w.word.length;
          wordsTypedRef.current += 1;
          charsTypedRef.current += w.word.length;
          streakRef.current += 1;
          if (streakRef.current > bestStreakRef.current) {
            bestStreakRef.current = streakRef.current;
          }
        }
      });

      if (matched) {
        currentInputRef.current = '';
        wordsRef.current = wordsRef.current.filter(
          (w) => w.word.toLowerCase() !== currentInputRef.current
        );

        // Compute score using Dev3's scoring engine (mapped to code-typer)
        const elapsed = (Date.now() - startTimeRef.current - pauseTrackerRef.current.getPausedMs()) / 1000;
        const cpm = elapsed > 0 ? (charsTypedRef.current / elapsed) * 60 : 0;
        const accuracy = charsTypedRef.current > 0
          ? (charsTypedRef.current / (charsTypedRef.current + errorsRef.current)) * 100
          : 100;
        const rawScore = computeRawScore('code-typer', {
          cpm,
          accuracy,
          snippetsCompleted: wordsTypedRef.current,
        });
        scoreRef.current = rawScore;
        setScore(rawScore);
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const endGame = () => {
    gameStateRef.current = 'over';
    setGameOver(true);
    if (timerRef.current) clearInterval(timerRef.current);
    if (spawnTimerRef.current) clearInterval(spawnTimerRef.current);
    cancelAnimationFrame(animFrameRef.current);
    onScore(scoreRef.current, bestStreakRef.current);
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

  const restart = () => {
    wordsRef.current = [];
    scoreRef.current = 0;
    streakRef.current = 0;
    bestStreakRef.current = 0;
    wordsTypedRef.current = 0;
    charsTypedRef.current = 0;
    errorsRef.current = 0;
    currentInputRef.current = '';
    pauseTrackerRef.current = new PauseTracker();
    setScore(0);
    setTimeLeft(GAME_DURATION);
    setGameOver(false);
    gameStateRef.current = 'playing';
    startTimeRef.current = Date.now();
  };

  return (
    <div className="arcade-game-container">
      <canvas
        ref={canvasRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        className="arcade-game-canvas"
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
            {bestStreakRef.current > 1 ? `🔥 Best streak: ${bestStreakRef.current}x` : 'Keep practicing!'}
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
