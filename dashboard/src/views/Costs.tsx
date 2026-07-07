import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, fmtUsd } from "../api";
import { Empty } from "../components";
import type { CostRollupRow } from "../types";

const DIMS = ["agent", "subject", "plan", "status"] as const;

/** The cost train: spend by dimension; every row clicks through to the transactions behind it. */
export default function Costs() {
  const [params, setParams] = useSearchParams();
  const by = (params.get("by") ?? "agent") as (typeof DIMS)[number];
  const [rows, setRows] = useState<CostRollupRow[]>([]);
  const nav = useNavigate();

  useEffect(() => {
    api.costRollup(by).then(setRows).catch(() => setRows([]));
  }, [by]);

  const total = rows.reduce((a, r) => a + r.total_usd, 0);
  const max = Math.max(...rows.map((r) => r.total_usd), 1e-9);

  const drill = (dim: string) => {
    if (by === "agent") nav(`/transactions?agent=${encodeURIComponent(dim)}`);
    else if (by === "subject") nav(`/transactions?subject=${encodeURIComponent(dim)}`);
    else if (by === "plan") nav(`/transactions?plan=${encodeURIComponent(dim)}`);
    else nav(`/transactions?status=${encodeURIComponent(dim)}`);
  };

  return (
    <>
      <h1>Cost train</h1>
      <div className="sub">Total on ledger: <span className="mono">{fmtUsd(total)}</span>. Click any row to open the transactions behind the number.</div>

      <div className="filters">
        {DIMS.map((d) => (
          <button key={d} className={`chip ${by === d ? "on" : ""}`} onClick={() => setParams({ by: d }, { replace: true })}>
            by {d}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <Empty>No cost data yet — the ledger is empty.</Empty>
      ) : (
        <table>
          <thead><tr><th>{by}</th><th className="num">Transactions</th><th className="num">USD</th><th style={{ width: "38%" }}>Share</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.dimension} className="row" onClick={() => drill(r.dimension)}>
                <td className="mono">{r.dimension}</td>
                <td className="num">{r.transactions}</td>
                <td className="num">{fmtUsd(r.total_usd)}</td>
                <td>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${(r.total_usd / max) * 100}%` }} /></div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
