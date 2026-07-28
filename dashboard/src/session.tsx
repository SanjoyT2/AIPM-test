import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Permission, SessionUser } from "./types";

/**
 * Who is signed in, and what they may do. The permission map comes from the server
 * rather than being recomputed here — the client hiding a button is a convenience,
 * the server's `deny()` is the actual boundary.
 */
interface SessionState {
  user: SessionUser | null;
  permissions: Partial<Record<Permission, boolean>>;
  loading: boolean;
  can: (perm: Permission) => boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [permissions, setPermissions] = useState<Partial<Record<Permission, boolean>>>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/auth/me", { credentials: "same-origin" });
      if (!r.ok) { setUser(null); setPermissions({}); return; }
      const d = await r.json();
      setUser(d.user); setPermissions(d.permissions ?? {});
    } catch {
      setUser(null); setPermissions({});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const signIn = useCallback(async (email: string, password: string) => {
    const r = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => null);
      throw new Error((d as any)?.error ?? "Sign in failed.");
    }
    await refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
    setUser(null); setPermissions({});
  }, []);

  const value = useMemo<SessionState>(() => ({
    user, permissions, loading, refresh, signIn, signOut,
    can: (perm) => permissions[perm] === true,
  }), [user, permissions, loading, refresh, signIn, signOut]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession must be used inside <SessionProvider>");
  return v;
}
