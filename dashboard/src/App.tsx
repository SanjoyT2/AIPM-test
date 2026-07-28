import { useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api";
import { OperatorKey } from "./components";
import { useSession } from "./session";
import type { Permission } from "./types";
import AgentDetail from "./views/AgentDetail";
import Cohort from "./views/Cohort";
import Costs from "./views/Costs";
import Courses from "./views/Courses";
import Frameworks from "./views/Frameworks";
import GuardrailSets from "./views/GuardrailSets";
import Knowledge from "./views/Knowledge";
import LearnerDetail from "./views/LearnerDetail";
import Learners from "./views/Learners";
import Login from "./views/Login";
import MyJourney from "./views/MyJourney";
import Overview from "./views/Overview";
import Signups from "./views/Signups";
import Studio from "./views/Studio";
import TransactionDetail from "./views/TransactionDetail";
import Transactions from "./views/Transactions";
import Users from "./views/Users";

/** Nav entries and the permission each one needs. Hidden when the role lacks it. */
const NAV: { to: string; label: string; need?: Permission }[] = [
  { to: "/", label: "Overview", need: "viewOperator" },
  { to: "/cohort", label: "Cohort", need: "viewOperator" },
  { to: "/courses", label: "Courses", need: "authorCurriculum" },
  { to: "/signups", label: "Signups", need: "viewSignups" },
  { to: "/learners", label: "Learners", need: "viewOperator" },
  { to: "/studio", label: "Agent Studio", need: "configureAgents" },
  { to: "/knowledge", label: "Knowledge", need: "configureAgents" },
  { to: "/guardrails", label: "Guardrails", need: "configureAgents" },
  { to: "/transactions", label: "Transactions", need: "viewOperator" },
  { to: "/costs", label: "Cost train", need: "viewOperator" },
  { to: "/frameworks", label: "Frameworks" },
  { to: "/users", label: "Accounts", need: "manageUsers" },
];

export default function App() {
  const { user, loading, can, signOut } = useSession();

  // Don't flash the login screen while /api/auth/me is still in flight.
  if (loading) return <div className="auth-shell"><div className="sub">Loading…</div></div>;
  if (!user) return <Login />;

  // Learners get their own single-purpose shell, not a stripped-down console.
  if (user.role === "learner") {
    return (
      <div className="layout">
        <aside className="side">
          <div className="brand">
            <div className="mark">D2D</div>
            <div>
              <div className="name">Degree2Destiny</div>
              <div className="sub">college to career</div>
            </div>
          </div>
          <nav className="nav"><NavLink to="/" end>My journey</NavLink></nav>
          <WhoAmI onSignOut={signOut} />
        </aside>
        <main className="main">
          <Routes>
            <Route path="/" element={<MyJourney />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    );
  }

  const visible = NAV.filter((n) => !n.need || can(n.need));

  return (
    <div className="layout">
      <aside className="side">
        <div className="brand">
          <div className="mark">D2D</div>
          <div>
            <div className="name">Degree2Destiny</div>
            <div className="sub">operator console</div>
          </div>
        </div>
        <nav className="nav">
          {visible.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === "/"}>{n.label}</NavLink>
          ))}
        </nav>
        <OperatorKey />
        <WhoAmI onSignOut={signOut} />
      </aside>
      <main className="main">
        {user.must_change_password && (
          <div className="banner warn" style={{ cursor: "default" }}>
            You're still on the password an admin set for you. Change it from the sidebar.
          </div>
        )}
        <Routes>
          <Route path="/" element={<Guard need="viewOperator"><Overview /></Guard>} />
          <Route path="/cohort" element={<Guard need="viewOperator"><Cohort /></Guard>} />
          <Route path="/courses" element={<Guard need="authorCurriculum"><Courses /></Guard>} />
          <Route path="/signups" element={<Guard need="viewSignups"><Signups /></Guard>} />
          <Route path="/learners" element={<Guard need="viewOperator"><Learners /></Guard>} />
          <Route path="/learners/:id" element={<Guard need="viewOperator"><LearnerDetail /></Guard>} />
          <Route path="/studio" element={<Guard need="configureAgents"><Studio /></Guard>} />
          <Route path="/studio/:name" element={<Guard need="configureAgents"><AgentDetail /></Guard>} />
          <Route path="/knowledge" element={<Guard need="configureAgents"><Knowledge /></Guard>} />
          <Route path="/guardrails" element={<Guard need="configureAgents"><GuardrailSets /></Guard>} />
          <Route path="/transactions" element={<Guard need="viewOperator"><Transactions /></Guard>} />
          <Route path="/transactions/:id" element={<Guard need="viewOperator"><TransactionDetail /></Guard>} />
          <Route path="/costs" element={<Guard need="viewOperator"><Costs /></Guard>} />
          <Route path="/frameworks" element={<Frameworks />} />
          <Route path="/users" element={<Guard need="manageUsers"><Users /></Guard>} />
          <Route path="*" element={<Navigate to={visible[0]?.to ?? "/frameworks"} replace />} />
        </Routes>
      </main>
    </div>
  );
}

/** Route-level permission check, so a typed URL can't reach a view the role lacks. */
function Guard({ need, children }: { need: Permission; children: React.ReactNode }) {
  const { can, user } = useSession();
  if (can(need)) return <>{children}</>;
  return (
    <div className="empty">
      Your role ({user?.role}) doesn't have access to this page.
    </div>
  );
}

function WhoAmI({ onSignOut }: { onSignOut: () => void }) {
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const change = async () => {
    setBusy(true); setMsg(null);
    try {
      await api.changeMyPassword(current, next);
      setMsg("Password changed."); setCurrent(""); setNext(""); setOpen(false);
      // Re-read the session so the must-change banner clears.
      window.location.reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <div className="whoami">
      <div className="whoami-id">
        <div className="whoami-name">{user?.name ?? user?.email}</div>
        <div className="sub">{user?.role}</div>
      </div>
      {msg && <div className="sub" style={{ color: "var(--accent)" }}>{msg}</div>}
      {open ? (
        <>
          <input className="chip" type="password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          <input className="chip" type="password" placeholder="New password" value={next} onChange={(e) => setNext(e.target.value)} />
          <div className="opkey-actions">
            <button className="chip on" disabled={busy || !current || next.length < 10} onClick={change}>Save</button>
            <button className="chip" onClick={() => { setOpen(false); setMsg(null); }}>Cancel</button>
          </div>
        </>
      ) : (
        <div className="opkey-actions">
          <button className="chip" onClick={() => setOpen(true)}>Password</button>
          <button className="chip" onClick={onSignOut}>Sign out</button>
        </div>
      )}
    </div>
  );
}
