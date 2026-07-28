import { useState } from "react";
import { useSession } from "../session";

/** Sign-in screen. Shown instead of the console whenever there is no session. */
export default function Login() {
  const { signIn } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    try { await signIn(email.trim(), password); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <div className="mark">D2D</div>
          <div>
            <div className="name">Degree2Destiny</div>
            <div className="sub">operator console</div>
          </div>
        </div>

        <h1>Sign in</h1>
        <p className="sub" style={{ marginBottom: 18 }}>
          Coaches, assessors and learners all sign in here. Your view depends on your role.
        </p>

        {err && <div className="banner danger" style={{ cursor: "default" }}>⚠︎ {err}</div>}

        <label className="auth-field">
          <span>Email</span>
          <input
            className="chip" type="email" autoComplete="username" autoFocus required
            value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@degree2destiny.com"
          />
        </label>
        <label className="auth-field">
          <span>Password</span>
          <input
            className="chip" type="password" autoComplete="current-password" required
            value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••"
          />
        </label>

        <button className="chip on auth-submit" type="submit" disabled={busy || !email.trim() || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <div className="sub auth-foot">
          No account? An admin creates it for you. <a className="link" href="/">Back to the site</a>
        </div>
      </form>
    </div>
  );
}
