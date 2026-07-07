import { useEffect, useState } from "react";
import { api } from "../api";
import { Panel } from "../components";
import type { Health } from "../types";

const NAMES = ["competency-framework", "composite-formula", "progression-rules", "diagnostic", "guardrails", "critics", "cost-model"];

/** Framework versions + live view of any editable config the service booted with. */
export default function Frameworks() {
  const [health, setHealth] = useState<Health | null>(null);
  const [open, setOpen] = useState<string>("");
  const [doc, setDoc] = useState<unknown>(null);

  useEffect(() => { api.health().then(setHealth).catch(() => setHealth(null)); }, []);
  useEffect(() => {
    if (open) api.framework(open).then(setDoc).catch(() => setDoc({ error: "failed to load" }));
    else setDoc(null);
  }, [open]);

  return (
    <>
      <h1>Frameworks</h1>
      <div className="sub">The editable config the service is running with. Versions are stamped on every score (ADR-006).</div>

      {health && (
        <Panel title={`System · gateway ${health.gateway} · storage ${health.storage} · env ${health.env}`}>
          <div className="kv">
            {Object.entries(health.framework_versions).map(([k, v]) => (
              <><div key={k} className="k">{k.replaceAll("_", " ")}</div><div className="mono">{v}</div></>
            ))}
          </div>
        </Panel>
      )}

      <div className="filters">
        {NAMES.map((n) => (
          <button key={n} className={`chip ${open === n ? "on" : ""}`} onClick={() => setOpen(open === n ? "" : n)}>{n}</button>
        ))}
      </div>

      {doc != null && (
        <Panel title={open}>
          <pre className="code">{JSON.stringify(doc, null, 2)}</pre>
        </Panel>
      )}
    </>
  );
}
