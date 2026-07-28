import { useEffect, useState } from "react";
import { api, fmtTime } from "../api";
import { Empty, Panel } from "../components";
import { useSession } from "../session";
import { ROLE_BLURB, ROLES, type AccountRow, type Role } from "../types";

/** Accounts — admin only. Create, disable and reset the people who can sign in. */
export default function Users() {
  const { user: me } = useSession();
  const [rows, setRows] = useState<AccountRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showNew, setShowNew] = useState(false);
  // Inline password reset — window.prompt() is blocked in embedded browsers.
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPw, setResetPw] = useState("");

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("coach");
  const [learnerId, setLearnerId] = useState("");
  const [password, setPassword] = useState("");

  const reload = () =>
    api.users().then((r) => { setRows(r); setErr(null); })
      .catch((e) => { setRows([]); setErr(e instanceof Error ? e.message : String(e)); });

  useEffect(() => { reload(); }, []);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setErr(null); setNote(null);
    try { await fn(); if (ok) setNote(ok); await reload(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const create = () =>
    run(async () => {
      await api.createUser({
        email: email.trim(), password, role, name: name.trim() || undefined,
        learner_id: role === "learner" ? learnerId.trim() : undefined,
      });
      setEmail(""); setName(""); setPassword(""); setLearnerId(""); setShowNew(false);
    }, "Account created. Share the password over a channel you trust — they'll be asked to change it.");

  return (
    <>
      <h1>Accounts</h1>
      <div className="sub">Who can sign in, and what each of them can reach.</div>

      {err && <div className="banner danger" onClick={() => setErr(null)}>⚠︎ {err} <span className="sub">(click to dismiss)</span></div>}
      {note && <div className="banner ok" onClick={() => setNote(null)}>✓ {note} <span className="sub">(click to dismiss)</span></div>}

      {!showNew ? (
        <div className="filters"><button className="chip on" onClick={() => setShowNew(true)}>+ New account</button></div>
      ) : (
        <Panel title="New account">
          <div className="form">
            <label><span>Email</span>
              <input className="chip" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="coach@degree2destiny.com" />
            </label>
            <label><span>Name</span>
              <input className="chip" value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" />
            </label>
            <label><span>Role</span>
              <select className="chip" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label><span>Temporary password</span>
              <input className="chip" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 10 characters" />
            </label>
            {role === "learner" && (
              <label><span>Learner id</span>
                <input className="chip mono" value={learnerId} onChange={(e) => setLearnerId(e.target.value)} placeholder="lrn-919876543210" />
              </label>
            )}
          </div>
          <div className="sub" style={{ marginTop: 10 }}>{ROLE_BLURB[role]}</div>
          <div className="filters">
            <button className="chip on" disabled={busy || !email.trim() || !password || (role === "learner" && !learnerId.trim())} onClick={create}>
              Create account
            </button>
            <button className="chip" onClick={() => setShowNew(false)}>Cancel</button>
          </div>
        </Panel>
      )}

      {rows === null ? <div className="sub">Loading…</div>
        : rows.length === 0 ? <Empty>No accounts yet.</Empty>
        : (
          <table>
            <thead>
              <tr><th>Email</th><th>Name</th><th>Role</th><th>Scope</th><th>Last sign-in</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const isMe = u.user_id === me?.user_id;
                return (
                  <tr key={u.user_id} style={u.disabled ? { opacity: 0.5 } : undefined}>
                    <td>
                      {u.email}
                      {isMe && <span className="pill accent" style={{ marginLeft: 6 }}>you</span>}
                      {u.disabled && <span className="pill danger" style={{ marginLeft: 6 }}>disabled</span>}
                      {u.must_change_password && !u.disabled && <span className="pill warn" style={{ marginLeft: 6 }}>must change password</span>}
                    </td>
                    <td>{u.name ?? <span className="sub">—</span>}</td>
                    <td><span className="pill">{u.role}</span></td>
                    <td className="mono sub">{u.learner_id ?? "—"}</td>
                    <td className="sub">{u.last_login_at ? fmtTime(u.last_login_at) : "never"}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {resetFor === u.user_id ? (
                        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                          <input
                            className="chip" type="password" autoFocus value={resetPw}
                            placeholder="New password"
                            onChange={(e) => setResetPw(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Escape") { setResetFor(null); setResetPw(""); } }}
                          />
                          <button
                            className="chip on"
                            disabled={busy || resetPw.length < 10}
                            onClick={() => run(
                              async () => { await api.resetUserPassword(u.user_id, resetPw); setResetFor(null); setResetPw(""); },
                              `Password reset for ${u.email}.`,
                            )}
                          >
                            Save
                          </button>
                          <button className="chip" onClick={() => { setResetFor(null); setResetPw(""); }}>Cancel</button>
                        </span>
                      ) : (
                        <button className="chip" disabled={busy} onClick={() => { setResetFor(u.user_id); setResetPw(""); }}>
                          Reset password
                        </button>
                      )}
                      <button
                        className="chip danger-hover"
                        style={{ marginLeft: 6 }}
                        disabled={busy || isMe}
                        title={isMe ? "You cannot disable your own account" : ""}
                        onClick={() => run(() => api.setUserDisabled(u.user_id, !u.disabled), u.disabled ? `${u.email} re-enabled.` : `${u.email} disabled.`)}
                      >
                        {u.disabled ? "Enable" : "Disable"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
    </>
  );
}
