import { forwardRef, useEffect, useRef, useState, useImperativeHandle, useCallback } from 'react';
import { computeRawScore, PauseTracker } from '../scoring';

interface Props {
  isPaused: boolean;
  onScore: (score: number, streak: number) => void;
  onBack: () => void;
}

const GRID_SIZE = 15;
const CELL_SIZE = 20;
const CANVAS_WIDTH = GRID_SIZE * CELL_SIZE;
const CANVAS_HEIGHT = GRID_SIZE * CELL_SIZE;
const GAME_DURATION = 30;

type Direction = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';

interface Point {
  x: number;
  y: number;
}

export default forwardRef(function SnakeGame(
  { isPaused, onScore, onBack }: Props,
  ref: React.Ref<{ pause: () => void; resume: () => void }>
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(GAME_DURATION);
  const [gameOver, setGameOver] = useState(false);

  const snakeRef = useRef<Point[]>([{ x: 7, y: 7 }]);
  const directionRef = useRef<Direction>('RIGHT');
  const nextDirectionRef = useRef<Direction>('RIGHT');
  const foodRef = useRef<Point>({ x: 3, y: 3 });
  const scoreRef = useRef(0);
  const gameStateRef = useRef<'playing' | 'paused' | 'over'>('playing');
  const animFrameRef = useRef<number>(0);
  const lastMoveRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(Date.now());
  const moveIntervalRef = useRef(150);
  const streakRef = useRef(0);
  const bestStreakRef = useRef(0);
  const pauseTrackerRef = useRef(new PauseTracker());
  const foodEatenRef = useRef(0);

  useImperativeHandle(ref, () => ({
    pause: () => { gameStateRef.current = 'paused'; },
    resume: () => { if (gameStateRef.current === 'paused') gameStateRef.current = 'playing'; },
  }));

  const spawnFood = useCallback(() => {
    let pos: Point;
    do {
      pos = {
        x: Math.floor(Math.random() * GRID_SIZE),
        y: Math.floor(Math.random() * GRID_SIZE),
      };
    } while (snakeRef.current.some((s) => s.x === pos.x && s.y === pos.y));
    foodRef.current = pos;
  }, []);

  const endGame = useCallback(() => {
    gameStateRef.current = 'over';
    setGameOver(true);
    if (timerRef.current) clearInterval(timerRef.current);
    cancelAnimationFrame(animFrameRef.current);
    onScore(scoreRef.current, bestStreakRef.current);
  }, [onScore]);

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
  }, [isPaused, gameOver, endGame]);

  // Game loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const loop = (timestamp: number) => {
      if (gameStateRef.current === 'over') return;

      // Clear
      ctx.fillStyle = '#0f0f23';
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Grid
      ctx.strokeStyle = 'rgba(102, 126, 234, 0.1)';
      ctx.lineWidth = 0.5;
      for (let x = 0; x <= CANVAS_WIDTH; x += CELL_SIZE) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, CANVAS_HEIGHT);
        ctx.stroke();
      }
      for (let y = 0; y <= CANVAS_HEIGHT; y += CELL_SIZE) {
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

      // Move snake
      if (timestamp - lastMoveRef.current > moveIntervalRef.current) {
        lastMoveRef.current = timestamp;
        directionRef.current = nextDirectionRef.current;

        const head = { ...snakeRef.current[0] };
        switch (directionRef.current) {
          case 'UP': head.y -= 1; break;
          case 'DOWN': head.y += 1; break;
          case 'LEFT': head.x -= 1; break;
          case 'RIGHT': head.x += 1; break;
        }

        // Wall collision = wrap around
        if (head.x < 0) head.x = GRID_SIZE - 1;
        if (head.x >= GRID_SIZE) head.x = 0;
        if (head.y < 0) head.y = GRID_SIZE - 1;
        if (head.y >= GRID_SIZE) head.y = 0;

        // Self collision
        if (snakeRef.current.some((s) => s.x === head.x && s.y === head.y)) {
          streakRef.current = 0;
          endGame();
          return;
        }

        snakeRef.current.unshift(head);

        // Check food
        if (head.x === foodRef.current.x && head.y === foodRef.current.y) {
          foodEatenRef.current += 1;
          streakRef.current += 1;
          if (streakRef.current > bestStreakRef.current) {
            bestStreakRef.current = streakRef.current;
          }
          moveIntervalRef.current = Math.max(80, 150 - snakeRef.current.length * 3);
          spawnFood();

          // Compute score using Dev3's scoring engine
          const timeSurvived = Date.now() - startTimeRef.current - pauseTrackerRef.current.getPausedMs();
          const rawScore = computeRawScore('snake', {
            foodEaten: foodEatenRef.current,
            snakeLength: snakeRef.current.length,
            timeSurvivedMs: timeSurvived,
          });
          scoreRef.current = rawScore;
          setScore(rawScore);
        } else {
          snakeRef.current.pop();
        }
      }

      // Draw food
      const food = foodRef.current;
      ctx.fillStyle = '#f59e0b';
      ctx.shadowColor = '#f59e0b';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(
        food.x * CELL_SIZE + CELL_SIZE / 2,
        food.y * CELL_SIZE + CELL_SIZE / 2,
        CELL_SIZE / 2 - 2,
        0,
        Math.PI * 2
      );
      ctx.fill();
      ctx.shadowBlur = 0;

      // Draw snake
      snakeRef.current.forEach((segment, i) => {
        const isHead = i === 0;
        const x = segment.x * CELL_SIZE;
        const y = segment.y * CELL_SIZE;

        ctx.fillStyle = isHead ? '#667eea' : '#4c5fd7';
        ctx.fillRect(x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2);

        if (isHead) {
          ctx.strokeStyle = '#a78bfa';
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2);
        }
      });

      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [spawnFood, endGame]);

  // Keyboard controls
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (gameStateRef.current !== 'playing') return;
      switch (e.key) {
        case 'ArrowUp':
        case 'w':
        case 'W':
          if (directionRef.current !== 'DOWN') nextDirectionRef.current = 'UP';
          break;
        case 'ArrowDown':
        case 's':
        case 'S':
          if (directionRef.current !== 'UP') nextDirectionRef.current = 'DOWN';
          break;
        case 'ArrowLeft':
        case 'a':
        case 'A':
          if (directionRef.current !== 'RIGHT') nextDirectionRef.current = 'LEFT';
          break;
        case 'ArrowRight':
        case 'd':
        case 'D':
          if (directionRef.current !== 'LEFT') nextDirectionRef.current = 'RIGHT';
          break;
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  // Touch controls (swipe)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const handleTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStartRef.current || gameStateRef.current !== 'playing') return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;
    if (Math.abs(dx) > Math.abs(dy)) {
      if (dx > 0 && directionRef.current !== 'LEFT') nextDirectionRef.current = 'RIGHT';
      else if (dx < 0 && directionRef.current !== 'RIGHT') nextDirectionRef.current = 'LEFT';
    } else {
      if (dy > 0 && directionRef.current !== 'UP') nextDirectionRef.current = 'DOWN';
      else if (dy < 0 && directionRef.current !== 'DOWN') nextDirectionRef.current = 'UP';
    }
    touchStartRef.current = null;
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
    snakeRef.current = [{ x: 7, y: 7 }];
    directionRef.current = 'RIGHT';
    nextDirectionRef.current = 'RIGHT';
    scoreRef.current = 0;
    streakRef.current = 0;
    bestStreakRef.current = 0;
    moveIntervalRef.current = 150;
    pauseTrackerRef.current = new PauseTracker();
    foodEatenRef.current = 0;
    setScore(0);
    setTimeLeft(GAME_DURATION);
    setGameOver(false);
    gameStateRef.current = 'playing';
    startTimeRef.current = Date.now();
    spawnFood();
  };

  return (
    <div className="arcade-game-container">
      <canvas
        ref={canvasRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        className="arcade-game-canvas"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        style={{ touchAction: 'none' }}
      />
      <div className="arcade-game-ui">
        <div className="arcade-score">{score} pts</div>
        <div className="arcade-timer">{timeLeft}s</div>
      </div>
      <button className="arcade-back-btn" onClick={onBack}>← Back</button>

      {gameOver && (
        <div className="arcade-gameover">
          <div className="arcade-gameover-title">
            {timeLeft <= 0 ? "Time's Up!" : 'Crashed!'}
          </div>
          <div className="arcade-gameover-score">{score}</div>
          <div className="arcade-gameover-streak">
            {bestStreakRef.current > 0 ? `🔥 Best streak: ${bestStreakRef.current}x` : 'Keep practicing!'}
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
