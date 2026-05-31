import { useState } from "react";
import { QuickAddIdeaSheet } from "./QuickAddIdeaSheet";

interface Props {
  orgId: string;
}

// Floating quick-add FAB per architect §10.2 — globally available wherever
// HomeScreen renders. Owns the open/close + transient success toast so any
// host screen can drop this in without lifecycle plumbing.
export function BacklogQuickAddButton({ orgId }: Props) {
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  function handleSubmitted(title: string): void {
    setToast(`Submitted: ${title}`);
    setTimeout(() => setToast(null), 1500);
  }

  return (
    <>
      <button
        type="button"
        className="fab"
        aria-label="Submit idea to backlog"
        onClick={() => setOpen(true)}
      >
        + Idea
      </button>
      {open && (
        <QuickAddIdeaSheet
          orgId={orgId}
          onClose={() => setOpen(false)}
          onSubmitted={handleSubmitted}
        />
      )}
      {toast !== null && <div className="toast">{toast}</div>}
    </>
  );
}
