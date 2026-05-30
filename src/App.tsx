import { useState } from "react";
import "./App.css";

type Status = "unpaired" | "stopped" | "running";

function statusColor(s: Status): string {
  if (s === "running") return "#22c55e";
  if (s === "stopped") return "#eab308";
  return "#ef4444";
}

function statusLabel(s: Status): string {
  if (s === "running") return "Bridge connected";
  if (s === "stopped") return "Bridge paired but not running";
  return "Bridge not paired";
}

function App() {
  const [status] = useState<Status>("unpaired");

  return (
    <main className="container">
      <header className="brand">
        <h1>AgentControl</h1>
        <div className="status-row">
          <span
            className="status-dot"
            style={{ backgroundColor: statusColor(status) }}
            aria-label={statusLabel(status)}
          />
          <span className="status-text">{statusLabel(status)}</span>
        </div>
      </header>

      <section className="placeholder">
        <p>Phase 27.0 spike — tray + window shell only.</p>
        <p className="muted">
          Login, pairing, and settings UIs land in 27.1–27.4.
        </p>
      </section>
    </main>
  );
}

export default App;
