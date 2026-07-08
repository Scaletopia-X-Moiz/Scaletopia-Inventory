"use client";

import { createContext, useContext } from "react";

export interface SessionInfo {
  email: string;
  role: "admin" | "member";
}

const SessionContext = createContext<SessionInfo | null>(null);

export function SessionProvider({
  value,
  children,
}: {
  value: SessionInfo | null;
  children: React.ReactNode;
}) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** Current signed-in user (email + role), or null. Available anywhere inside AppShell. */
export function useSession(): SessionInfo | null {
  return useContext(SessionContext);
}
