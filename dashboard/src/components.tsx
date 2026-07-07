import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { CriticVerdict, TransactionStatus } from "./types";

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
