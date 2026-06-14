import { useState, useMemo } from 'react';
import ArcadeWidget from './ArcadeWidget';
import './arcade.css';

type ArcadeTab = 'games' | 'leaderboard' | 'stats';

interface LeaderboardEntry {
  rank: number;
  name: string;
  game: string;
  score: number;
  multiplier: number;
  badge: string | null;
}

const MOCK_LEADERBOARD: LeaderboardEntry[] = [
  { rank: 1, name: 'Dev2', game: 'Snake', score: 2450, multiplier: 3, badge: 'on-fire' },
  { rank: 2, name: 'Dev4', game: 'Reaction', score: 1980, multiplier: 2, badge: 'hot' },
  { rank: 3, name: 'Dev1', game: 'Word Match', score: 1750, multiplier: 2, badge: 'hot' },
  { rank: 4, name: 'Dev3', game: 'Snake', score: 1320, multiplier: 1, badge: null },
  { rank: 5, name: 'Dev2', game: 'Word Match', score: 1100, multiplier: 1, badge: null },
];

const MOCK_STATS = {
  totalGames: 42,
  totalScore: 12480,
  winRate: 68,
  longestStreak: 7,
  timePlayed: '2h 14m',
};

export default function ArcadePane() {
  const [activeTab, setActiveTab] = useState<ArcadeTab>('games');
  const [scores, setScores] = useState<LeaderboardEntry[]>(MOCK_LEADERBOARD);

  const handleScoreSubmit = (data: { game: string; finalScore: number; multiplier: number; badge: string | null }) => {
    const newEntry: LeaderboardEntry = {
      rank: 0,
      name: 'You',
      game: data.game,
      score: data.finalScore,
      multiplier: data.multiplier,
      badge: data.badge,
    };
    const updated = [...scores, newEntry]
      .sort((a, b) => b.score - a.score)
      .map((e, i) => ({ ...e, rank: i + 1 }));
    setScores(updated.slice(0, 10));
  };

  const topGame = useMemo(() => {
    const counts: Record<string, number> = {};
    scores.forEach((s) => {
      counts[s.game] = (counts[s.game] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';
  }, [scores]);

  return (
    <div className="arcade-pane">
      <div className="arcade-pane-header">
        <span className="arcade-pane-title">🎮 Dev Idle Arcade</span>
      </div>

      <div className="arcade-pane-tabs">
        <button
          className={`arcade-pane-tab ${activeTab === 'games' ? 'active' : ''}`}
          onClick={() => setActiveTab('games')}
        >
          Games
        </button>
        <button
          className={`arcade-pane-tab ${activeTab === 'leaderboard' ? 'active' : ''}`}
          onClick={() => setActiveTab('leaderboard')}
        >
          Leaderboard
        </button>
        <button
          className={`arcade-pane-tab ${activeTab === 'stats' ? 'active' : ''}`}
          onClick={() => setActiveTab('stats')}
        >
          Stats
        </button>
      </div>

      <div className="arcade-pane-content">
        {activeTab === 'games' && (
          <ArcadeWidget onScoreSubmit={handleScoreSubmit} autoExpand />
        )}

        {activeTab === 'leaderboard' && (
          <div className="arcade-leaderboard">
            {scores.map((entry) => (
              <div key={`${entry.rank}-${entry.name}`} className="arcade-leaderboard-row">
                <div
                  className={`arcade-leaderboard-rank ${entry.rank <= 3 ? 'top3' : ''}`}
                >
                  {entry.rank}
                </div>
                <div className="arcade-leaderboard-name">
                  {entry.name}
                  <span style={{ color: 'var(--text-secondary)', fontSize: 12, marginLeft: 8 }}>
                    {entry.game}
                  </span>
                  {entry.badge && (
                    <span style={{ fontSize: 11, marginLeft: 6, color: '#f59e0b', fontWeight: 700 }}>
                      {entry.badge === 'on-fire' ? '🔥' : entry.badge === 'hot' ? '♨️' : '🔅'}
                    </span>
                  )}
                </div>
                <div className="arcade-leaderboard-score">
                  {entry.score}
                  {entry.multiplier > 1 && (
                    <span style={{ fontSize: 10, color: '#f59e0b', marginLeft: 4 }}>×{entry.multiplier}</span>
                  )}
                </div>
              </div>
            ))}
            {scores.length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: 40 }}>
                No scores yet. Play a game to get on the board!
              </div>
            )}
          </div>
        )}

        {activeTab === 'stats' && (
          <>
            <div className="arcade-stats-grid">
              <div className="arcade-stat-card">
                <div className="arcade-stat-value">{MOCK_STATS.totalGames}</div>
                <div className="arcade-stat-label">Games Played</div>
              </div>
              <div className="arcade-stat-card">
                <div className="arcade-stat-value">{MOCK_STATS.totalScore.toLocaleString()}</div>
                <div className="arcade-stat-label">Total Score</div>
              </div>
              <div className="arcade-stat-card">
                <div className="arcade-stat-value">{MOCK_STATS.winRate}%</div>
                <div className="arcade-stat-label">Win Rate</div>
              </div>
              <div className="arcade-stat-card">
                <div className="arcade-stat-value">{MOCK_STATS.longestStreak}</div>
                <div className="arcade-stat-label">Best Streak</div>
              </div>
            </div>
            <div
              style={{
                background: 'rgba(255,255,255,0.04)',
                borderRadius: 12,
                padding: 16,
                marginTop: 8,
              }}
            >
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
                Time Played
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#4aba6a' }}>
                {MOCK_STATS.timePlayed}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 12, marginBottom: 8 }}>
                Favorite Game
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#4aba6a' }}>
                {topGame}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
