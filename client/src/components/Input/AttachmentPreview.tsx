import type { FileEntry } from '../../stores/fileDropStore';

interface AttachmentPreviewProps {
  entry: FileEntry;
  onRemove: () => void;
}

/** Truncate filename to fit the 64px box */
function truncateName(name: string, maxLen = 12): string {
  if (name.length <= maxLen) return name;
  const ext = name.lastIndexOf('.');
  if (ext > 0 && name.length - ext <= 5) {
    // Keep extension visible: "longfilen...txt"
    const base = name.slice(0, maxLen - name.length + ext - 1);
    return `${base}…${name.slice(ext)}`;
  }
  return name.slice(0, maxLen - 1) + '…';
}

export default function AttachmentPreview({ entry, onRemove }: AttachmentPreviewProps) {
  return (
    <div style={styles.container}>
      {entry.isImage ? (
        <img src={entry.preview} alt="Preview" style={styles.image} />
      ) : (
        <div style={styles.fileBox}>
          {/* Generic file icon */}
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span style={styles.fileName}>{truncateName(entry.file.name)}</span>
        </div>
      )}
      <button onClick={onRemove} style={styles.removeBtn} title="Remove attachment">
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
  fileBox: {
    width: 64,
    height: 64,
    borderRadius: 'var(--radius-sm)',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    background: 'rgba(255, 255, 255, 0.04)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    padding: 4,
  },
  fileName: {
    fontSize: 9,
    color: 'var(--text-secondary)',
    textAlign: 'center',
    lineHeight: 1.2,
    wordBreak: 'break-all',
    maxWidth: 56,
    overflow: 'hidden',
  } as React.CSSProperties,
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
