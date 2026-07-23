import { useEffect, useState } from "react";
import { api } from "../api";
import { Empty, Panel } from "../components";
import type { KbDocument, KnowledgeBase } from "../types";

/** Standalone knowledge bases — created here, attached to agents in the Studio. */
export default function Knowledge() {
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [openId, setOpenId] = useState("");
  const [docs, setDocs] = useState<KbDocument[]>([]);
  const [newName, setNewName] = useState("");
  const [docTitle, setDocTitle] = useState("");
  const [docBody, setDocBody] = useState("");

  const loadKbs = () => api.kbs().then(setKbs).catch(() => setKbs([]));
  useEffect(() => { loadKbs(); }, []);
  useEffect(() => { if (openId) api.kb(openId).then((k) => setDocs(k.documents)).catch(() => setDocs([])); }, [openId]);

  const createKb = async () => { if (!newName.trim()) return; await api.createKB(newName.trim()); setNewName(""); loadKbs(); };
  const addDoc = async () => {
    if (!openId || !docTitle.trim() || !docBody.trim()) return;
    await api.addDoc(openId, docTitle.trim(), docBody.trim());
    setDocTitle(""); setDocBody("");
    api.kb(openId).then((k) => setDocs(k.documents));
  };
  const delKb = async (id: string) => { await api.deleteKB(id); if (openId === id) setOpenId(""); loadKbs(); };
  const delDoc = async (id: string) => { await api.deleteDoc(id); if (openId) api.kb(openId).then((k) => setDocs(k.documents)); };

  return (
    <>
      <h1>Knowledge</h1>
      <div className="sub">Knowledge bases are standalone — the same one can be attached to many agents from the Studio.</div>

      <div className="filters">
        <input className="chip" style={{ width: 240 }} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="new knowledge base name" onKeyDown={(e) => e.key === "Enter" && createKb()} />
        <button className="chip" onClick={createKb} disabled={!newName.trim()}>Create</button>
      </div>

      {kbs.length === 0 ? <Empty>No knowledge bases yet.</Empty> : (
        <table>
          <thead><tr><th>Knowledge base</th><th className="num">Docs</th><th>Attached to</th><th></th></tr></thead>
          <tbody>
            {kbs.map((kb) => (
              <tr key={kb.kb_id} className="row" onClick={() => setOpenId(openId === kb.kb_id ? "" : kb.kb_id)}>
                <td>{kb.name}{kb.description && <span className="sub"> · {kb.description}</span>}</td>
                <td className="num">{kb.doc_count ?? 0}</td>
                <td>{(kb.attached_agents ?? []).length ? (kb.attached_agents ?? []).map((x) => <span key={x} className="pill accent" style={{ marginRight: 4 }}>{x}</span>) : <span className="sub">none</span>}</td>
                <td><button className="chip" onClick={(e) => { e.stopPropagation(); delKb(kb.kb_id); }}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {openId && (
        <Panel title={`Documents — ${kbs.find((k) => k.kb_id === openId)?.name ?? ""}`}>
          <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <input className="chip" style={{ width: 200 }} value={docTitle} onChange={(e) => setDocTitle(e.target.value)} placeholder="doc title" />
            <input className="chip" style={{ flex: 1, minWidth: 260 }} value={docBody} onChange={(e) => setDocBody(e.target.value)} placeholder="content…" onKeyDown={(e) => e.key === "Enter" && addDoc()} />
            <button className="chip" onClick={addDoc} disabled={!docTitle.trim() || !docBody.trim()}>Add doc</button>
          </div>
          {docs.length === 0 ? <div className="sub">No documents yet.</div> : docs.map((d) => (
            <div key={d.document_id} style={{ padding: "6px 0", borderTop: "1px solid var(--line2)" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <b>{d.title}</b>
                <button className="chip" onClick={() => delDoc(d.document_id)}>Delete</button>
              </div>
              <div className="sub">{d.content}</div>
            </div>
          ))}
        </Panel>
      )}
    </>
  );
}
