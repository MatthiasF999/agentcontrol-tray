import { createContext, useContext, useMemo, type ReactNode } from "react";
import { BridgeClient } from "./bridgeClient";

const BridgeCtx = createContext<BridgeClient | null>(null);

export function BridgeClientProvider({ children }: { children: ReactNode }) {
  const client = useMemo(() => new BridgeClient(), []);
  return <BridgeCtx.Provider value={client}>{children}</BridgeCtx.Provider>;
}

export function useBridge(): BridgeClient {
  const c = useContext(BridgeCtx);
  if (c === null) {
    throw new Error("useBridge must be used within BridgeClientProvider");
  }
  return c;
}
