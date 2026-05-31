interface Props {
  markdown: string;
  onClose: () => void;
}

// Read-only digest viewer. Renders the standup-summarizer markdown verbatim
// in a <pre> — tray webview has no markdown renderer wired, and the digest
// is plain text + bullets so monospace preserves the layout faithfully.
export function DigestModal({ markdown, onClose }: Props) {
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Standup digest"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-sheet"
        style={{ maxHeight: "80vh", overflow: "auto" }}
      >
        <div className="modal-head">
          <h2>Standup digest</h2>
          <button type="button" className="link" onClick={onClose}>
            Close
          </button>
        </div>
        <pre className="digest-pre">{markdown}</pre>
      </div>
    </div>
  );
}
