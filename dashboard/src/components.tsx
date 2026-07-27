import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { OP_KEY_EVENT, opKey, setOpKey } from "./api";
import type { CriticVerdict, TransactionStatus } from "./types";

/**
 * Operator key control. Every curriculum/learner write is gated server-side; this is
 * where the coach supplies the key. Lives in the sidebar so it's reachable from any
 * view, and reflects changes made elsewhere (e.g. cleared after a 401) via OP_KEY_EVENT.
 */
export function OperatorKey() {
  const [saved, setSaved] = useState(opKey());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const sync = () => { setSaved(opKey()); setEditing(false); setDraft(""); };
    window.addEventListener(OP_KEY_EVENT, sync);
    return () => window.removeEventListener(OP_KEY_EVENT, sync);
  }, []);

  const commit = () => { setOpKey(draft); setDraft(""); setEditing(false); setSaved(opKey()); };

  if (!editing) {
    return (
      <div className="opkey">
        <div className="opkey-state">
          <span className={`pill ${saved ? "ok" : "warn"}`}>{saved ? "operator key set" : "no operator key"}</span>
        </div>
        <button className="chip" onClick={() => setEditing(true)}>{saved ? "Change" : "Set key"}</button>
      </div>
    );
  }

  return (
    <div className="opkey">
      <input
        className="chip"
        type="password"
        autoFocus
        value={draft}
        placeholder="Paste operator key"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setEditing(false); setDraft(""); } }}
      />
      <div className="opkey-actions">
        <button className="chip on" onClick={commit}>Save</button>
        {saved && <button className="chip" onClick={() => { setOpKey(""); setSaved(""); setEditing(false); }}>Clear</button>}
        <button className="chip" onClick={() => { setEditing(false); setDraft(""); }}>Cancel</button>
      </div>
    </div>
  );
}

export function StatusPill({ status }: { status: TransactionStatus }) {
  const tone =
    status === "completed" ? "ok" :
    status === "escalated" ? "warn" :
    status === "blocked" || status === "failed" ? "danger" : "info";
  return <span className={`pill ${tone}`}>{status}</span>;
}

export function VerdictPill({ verdict }: { verdict: CriticVerdict | "skipped_by_policy" }) {
  const tone =
    verdict === "accept" ? "ok" :
    verdict === "escalate" ? "warn" :
    verdict === "reject" ? "danger" :
    verdict === "revise" ? "info" : "";
  return <span className={`pill ${tone}`}>{verdict === "skipped_by_policy" ? "critic: sampled out" : `critic: ${verdict}`}</span>;
}

/** Action card — the dashboard's core primitive: a number that is a click. */
export function ActionCard(props: { label: string; value: ReactNode; hint: string; to: string; tone?: "alert" | "bad" | "good" }) {
  return (
    <Link className={`card ${props.tone ?? ""}`} to={props.to}>
      <div className="label">{props.label}</div>
      <div className="value">{props.value}</div>
      <div className="hint">{props.hint} →</div>
    </Link>
  );
}

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="panel">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
