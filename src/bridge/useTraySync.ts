import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BridgePairingState } from "./bridgeClient";

type StatusKey = "running" | "stopped" | "claimed" | "unpaired" | "unreachable";

function deriveStatus(
  pairing: BridgePairingState | null,
  error: string | null,
): { state: StatusKey; tooltip: string } {
  if (error !== null && pairing === null) {
    return {
      state: "unreachable",
      tooltip: "AgentControl — Bridge unreachable",
    };
  }
  if (pairing === null) {
    return {
      state: "unpaired",
      tooltip: "AgentControl — Bridge not paired",
    };
  }
  if (pairing.state === "paired") {
    return {
      state: "running",
      tooltip: `AgentControl — Paired (${pairing.bridgeId.slice(0, 8)}…)`,
    };
  }
  if (pairing.state === "claimed") {
    return {
      state: "claimed",
      tooltip: "AgentControl — Pairing in progress",
    };
  }
  return {
    state: "unpaired",
    tooltip: "AgentControl — Bridge not paired",
  };
}

export function useTraySync(
  pairing: BridgePairingState | null,
  error: string | null,
): void {
  useEffect(() => {
    const { state, tooltip } = deriveStatus(pairing, error);
    void invoke("update_tray_status", { state, tooltip }).catch(() => {
      // Tray-sync is best-effort — swallow Rust-side errors so they don't
      // crash the React tree. Real failure modes (tray missing on Wayland)
      // are documented in PHASE-27-0-SPIKE.md Layer 2.
    });
  }, [pairing, error]);
}
