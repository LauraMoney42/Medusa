interface JumpToStartButtonProps {
  onClick: () => void;
}

export default function JumpToStartButton({ onClick }: JumpToStartButtonProps) {
  return (
    <button onClick={onClick} style={styles.button}>
      &#8593; Jump to start
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  button: {
    position: 'absolute',
    bottom: 8,
    right: 16,
    padding: '6px 16px',
    background: '#2c2c2e',
    color: 'var(--text-primary)',
    borderRadius: 20,
    fontSize: 13,
    boxShadow: '0 4px 24px rgba(0, 0, 0, 0.35)',
    zIndex: 10,
    border: '1px solid rgba(255, 255, 255, 0.10)',
    cursor: 'pointer',
  } as React.CSSProperties,
};
