interface ImagePreviewProps {
  src: string;
  onRemove: () => void;
}

export default function ImagePreview({ src, onRemove }: ImagePreviewProps) {
  return (
    <div style={styles.container}>
      <img src={src} alt="Preview" style={styles.image} />
      <button onClick={onRemove} style={styles.removeBtn} title="Remove image">
        &times;
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'relative',
    display: 'inline-block',
  },
  image: {
    width: 64,
    height: 64,
    objectFit: 'cover',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid rgba(255, 255, 255, 0.12)',
  },
  removeBtn: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: '50%',
    background: 'var(--danger)',
    color: '#fff',
    fontSize: 14,
    lineHeight: '18px',
    textAlign: 'center',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 1px 6px rgba(0,0,0,0.3)',
  },
};
