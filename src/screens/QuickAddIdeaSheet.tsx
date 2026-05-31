import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useProjectsList } from '../backlog/useProjectsList';

interface Props {
  orgId: string;
  onClose: () => void;
  onSubmitted: (title: string) => void;
}

type SubmitState = 'idle' | 'submitting' | 'error';

export function QuickAddIdeaSheet({ orgId, onClose, onSubmitted }: Props) {
  const { client } = useAuth();
  const { projects } = useProjectsList(orgId);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState<string>('');
  const [state, setState] = useState<SubmitState>('idle');
  const [errMsg, setErrMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (client === null) {
      setErrMsg('Not signed in.');
      setState('error');
      return;
    }
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      setErrMsg('Title is required.');
      setState('error');
      return;
    }
    setState('submitting');
    setErrMsg(null);
    const { error } = await client.rpc('submit_idea', {
      p_org_id: orgId,
      p_project_id: projectId === '' ? null : projectId,
      p_title: trimmed,
      p_description: description.trim() === '' ? null : description.trim(),
    });
    if (error !== null) {
      setErrMsg(error.message);
      setState('error');
      return;
    }
    onSubmitted(trimmed);
    onClose();
  }

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Submit idea"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form className="modal-sheet form" onSubmit={(e) => void submit(e)}>
        <div className="modal-head">
          <h2>Submit idea</h2>
          <button type="button" className="link" onClick={onClose}>
            Cancel
          </button>
        </div>
        <label>
          Title
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            autoFocus
            required
            placeholder="One-line idea"
          />
        </label>
        <label>
          Description <span className="muted">(optional)</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Context, links, repro — anything helpful"
          />
        </label>
        <label>
          Project <span className="muted">(optional — org-wide if blank)</span>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">— Org-wide —</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {errMsg !== null && <div className="error">{errMsg}</div>}
        <button type="submit" disabled={state === 'submitting'}>
          {state === 'submitting' ? 'Submitting…' : 'Submit idea'}
        </button>
      </form>
    </div>
  );
}
