import { useEffect, useState } from "react";
import {
  checkDocker,
  composeRun,
  type DockerAvailability,
  type DockerRunResult,
} from "../lib/docker";
import { useAppSettings } from "../lib/appSettings";

type Action = "up" | "down" | "restart";

function describe(action: Action, profile: string): string[] {
  if (action === "up") return ["--profile", profile, "up", "-d"];
  if (action === "down") return ["--profile", profile, "down"];
  return ["--profile", profile, "restart"];
}

export function ContainerControlCard() {
  const { values } = useAppSettings();
  const [docker, setDocker] = useState<DockerAvailability | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [last, setLast] = useState<{ action: Action; result: DockerRunResult } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setDocker(await checkDocker());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  async function run(action: Action): Promise<void> {
    if (values.composeDir === null) return;
    setBusy(action);
    setError(null);
    try {
      const args = describe(action, values.composeProfile);
      const result = await composeRun(values.composeDir, args);
      setLast({ action, result });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (docker === null) return <section className="card">Checking Docker…</section>;
  if (!docker.installed) {
    return (
      <section className="card">
        <h2>Container control</h2>
        <p className="muted">
          Docker CLI not found. Install Docker Engine or Docker Desktop to
          enable Start / Stop / Restart from this app.
        </p>
        {docker.error !== null && <code className="endpoint">{docker.error}</code>}
      </section>
    );
  }
  if (values.composeDir === null) {
    return (
      <section className="card">
        <h2>Container control</h2>
        <p className="muted">
          Set <code>composeDir</code> in Settings to enable container control.
          Should be the directory containing your supabase{" "}
          <code>docker-compose.yml</code>.
        </p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Container control</h2>
      <p className="muted">
        {docker.version} · profile <code>{values.composeProfile}</code> in{" "}
        <code className="endpoint">{values.composeDir}</code>
      </p>
      <div className="form" style={{ flexDirection: "row", gap: 8 }}>
        <button
          type="button"
          onClick={() => void run("up")}
          disabled={busy !== null}
        >
          {busy === "up" ? "Starting…" : "Start"}
        </button>
        <button
          type="button"
          onClick={() => void run("restart")}
          disabled={busy !== null}
        >
          {busy === "restart" ? "Restarting…" : "Restart"}
        </button>
        <button
          type="button"
          onClick={() => void run("down")}
          disabled={busy !== null}
        >
          {busy === "down" ? "Stopping…" : "Stop"}
        </button>
      </div>
      {error !== null && <div className="error">{error}</div>}
      {last !== null && (
        <details>
          <summary className="muted">
            Last action: <code>{last.action}</code> exit{" "}
            {last.result.exit_code ?? "?"}
          </summary>
          {last.result.stdout.trim().length > 0 && (
            <pre style={{ fontSize: 12, overflow: "auto" }}>
              {last.result.stdout}
            </pre>
          )}
          {last.result.stderr.trim().length > 0 && (
            <pre style={{ fontSize: 12, overflow: "auto", color: "#b91c1c" }}>
              {last.result.stderr}
            </pre>
          )}
        </details>
      )}
    </section>
  );
}
