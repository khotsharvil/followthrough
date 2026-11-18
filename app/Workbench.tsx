"use client";
import { useEffect, useMemo, useState } from "react";
import type { RunResult } from "@/lib/agent";
import type { Action } from "@/lib/verifier";
import AudioPanel from "./AudioPanel";

type Sample = { id: string; clientId: string; header: string; raw: string };
type Person = { id: string; name: string; age: number; city: string; clinician: string; service: string; presenting: string; constraints: { channel: string; doNotMention: string[]; doNotContact: string[]; quietHours: string | null }; noteCount: number };
type Decision = "pending" | "approved" | "rejected";

const TYPE_LABEL: Record<Action["type"], string> = {
  risk_flag: "Risk review",
  homework: "Homework",
  client_message: "Message to client (draft)",
  booking: "Booking",
  check_in: "Check-in",
  care_team_note: "Care-team note",
};

export default function Workbench({ samples, clients }: { samples: Sample[]; clients: Person[] }) {
  const [mode, setMode] = useState<"sample" | "paste" | "audio">("sample");
  const [audioClient, setAudioClient] = useState("c02");
  const [sampleId, setSampleId] = useState("t09");
  const [pasteClient, setPasteClient] = useState(clients[0].id);
  const [pasteText, setPasteText] = useState("");
  const [result, setResult] = useState<(RunResult & { savedAt?: string }) | null>(null);
  const [source, setSource] = useState<"saved" | "live" | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hl, setHl] = useState<string[]>([]);
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [editing, setEditing] = useState<number | null>(null);

  const sample = samples.find((s) => s.id === sampleId)!;
  const clientId = mode === "sample" ? sample.clientId : mode === "audio" ? audioClient : pasteClient;
  const person = clients.find((c) => c.id === clientId)!;

  const reset = () => { setDecisions({}); setEdits({}); setEditing(null); setError(null); setHl([]); };

  // Saved run for samples: instant, costs nothing.
  useEffect(() => {
    if (mode !== "sample") return;
    reset();
    setResult(null);
    fetch(`/results/${sampleId}.json`).then((r) => (r.ok ? r.json() : null)).then((r) => { if (r) { setResult(r); setSource("saved"); } }).catch(() => {});
  }, [sampleId, mode]);

  async function runLive(transcriptOverride?: string) {
    reset();
    setLoading(true);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, transcript: transcriptOverride ?? (mode === "sample" ? sample.raw : pasteText) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Run failed");
      setResult(data);
      setSource("live");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const riskLines = useMemo(() => new Set(result ? [...result.risk.lexicon.map((h) => h.lineId), ...("lineIds" in result.risk.classifier ? result.risk.classifier.lineIds : [])] : []), [result]);
  const cost = result ? result.usage.reduce((s, u) => s + u.usd, 0) : 0;

  const Chip = ({ id }: { id: string }) => (
    <button type="button" className="src" onMouseEnter={() => setHl([id])} onMouseLeave={() => setHl([])} onFocus={() => setHl([id])} onBlur={() => setHl([])} aria-label={`Source ${id}`}>
      {id}
      <span className="tip">{result?.sources[id] ?? "unknown source"}</span>
    </button>
  );

  const outbox = result ? result.actions.map((a, i) => ({ a, i })).filter(({ i }) => decisions[i] === "approved") : [];

  return (
    <main className="layout">
      {/* Left: input */}
      <section className="stack">
        <div className="panel picker">
          <h2>Session</h2>
          <div className="pad">
            <div className="tabs" role="tablist">
              <button className={mode === "sample" ? "on" : ""} onClick={() => setMode("sample")}>Sample sessions</button>
              <button className={mode === "audio" ? "on" : ""} onClick={() => { setMode("audio"); setResult(null); setSource(null); reset(); }}>Session audio</button>
              <button className={mode === "paste" ? "on" : ""} onClick={() => { setMode("paste"); setResult(null); setSource(null); reset(); }}>Paste text</button>
            </div>
            {mode === "sample" ? (
              <>
                <select value={sampleId} onChange={(e) => setSampleId(e.target.value)} aria-label="Sample session">
                  {samples.map((s) => (
                    <option key={s.id} value={s.id}>{s.id} · {s.header.replace(/SYNTHETIC SESSION[^.]*\.\s*/, "").replace(/\. Not a real person\./, "")}</option>
                  ))}
                </select>
                <p className="meta">Saved results load instantly. "Run live" calls the model again (about 15–20s).</p>
              </>
            ) : mode === "audio" ? (
              <AudioPanel clients={clients} clientId={audioClient} setClientId={setAudioClient} onRun={(t) => runLive(t)} running={loading} />
            ) : (
              <>
                <select value={pasteClient} onChange={(e) => setPasteClient(e.target.value)} aria-label="Client">
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.id} · {c.name}</option>)}
                </select>
                <textarea style={{ marginTop: 8 }} value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder={"One line per turn:\nT: How has the week been?\nC: Better, I slept more.\n\nUse synthetic text only."} />
              </>
            )}
            {mode !== "audio" && <div className="row" style={{ marginTop: 10 }}>
              <button className="btn" onClick={() => runLive()} disabled={loading || (mode === "paste" && !pasteText.trim())}>{loading ? "Running…" : "Run live"}</button>
              {source && <span className="badge">{source === "saved" ? "showing saved run" : "live run"}</span>}
            </div>}
            <div className="profile">
              <b>{person.name}</b>, {person.age}, {person.city} · {person.service}<br />
              Presenting: {person.presenting}<br />
              Channel: {person.constraints.channel}
              {person.constraints.doNotContact.length > 0 && <> · Do not contact: {person.constraints.doNotContact.join(", ")}</>}
              {person.constraints.doNotMention.length > 0 && <> · Never mention: {person.constraints.doNotMention.join(", ")}</>}
              {person.constraints.quietHours && <> · Quiet hours: {person.constraints.quietHours}</>}
              <br />{person.noteCount} past notes available to the agent
            </div>
          </div>
        </div>

        {(mode === "sample" || (result && mode !== "paste")) && (
          <div className="panel">
            <h2>Transcript</h2>
            <div className="transcript" style={{ marginTop: 10 }}>
              {(result?.lines ?? []).map((l) => (
                <div key={l.id} className={`tline ${l.speaker} ${hl.includes(l.id) ? "hl" : ""} ${riskLines.has(l.id) ? "risk" : ""}`}>
                  <span className="id">{l.id.replace("T:", "")}</span>
                  <span><b>{l.speaker === "T" ? "Clinician" : "Client"}:</b> {l.text}</span>
                </div>
              ))}
              {!result && <pre className="pad mono" style={{ whiteSpace: "pre-wrap" }}>{sample.raw}</pre>}
            </div>
          </div>
        )}
      </section>

      {/* Right: output */}
      <section className="stack">
        {error && <div className="error">{error}</div>}
        {!result && !loading && !error && <div className="panel empty">{mode === "paste" ? "Paste a synthetic transcript and press Run live." : mode === "audio" ? "Transcribe a session recording, review the transcript, then draft the note and follow-ups." : "Loading saved run…"}</div>}
        {loading && <div className="panel empty">Screening for risk, searching past notes, drafting the note and follow-ups, then verifying every citation…</div>}

        {result && !loading && (
          <>
            {/* 1. Risk first */}
            <div className={`panel ${result.risk.flagged ? "risk" : "risk clear"}`}>
              <h2>{result.risk.flagged ? "Needs your review: safety concern" : "Risk screen: nothing flagged"}</h2>
              <div className="pad">
                {result.risk.flagged ? (
                  <ul>
                    {result.risk.lexicon.map((h, i) => (
                      <li key={i}><span className="badge risk">{h.signal}</span>“{h.quote}” <Chip id={h.lineId} /></li>
                    ))}
                    {"reason" in result.risk.classifier && result.risk.classifier.flagged && (
                      <li><span className="badge risk">classifier</span>{result.risk.classifier.reason} {result.risk.classifier.lineIds.map((id) => <Chip key={id} id={id} />)}</li>
                    )}
                    <li className="muted" style={{ fontSize: 13 }}>Flagged because at least one detector fired. Only a clinician can clear this.</li>
                  </ul>
                ) : (
                  <p style={{ fontSize: 14 }}>Neither the lexicon nor the classifier found risk language. {"error" in result.risk.classifier && <span className="badge warn">classifier didn't run: {result.risk.classifier.error}</span>}</p>
                )}
              </div>
            </div>

            {/* 2. Note */}
            <div className="panel note">
              <h2>Session note (draft)</h2>
              <div className="pad">
                {result.note.map((s) => (
                  <div key={s.heading}>
                    <h3>{s.heading}</h3>
                    <ul>
                      {s.items.map((it, i) => (
                        <li key={i}>{it.text}{it.sources.map((id) => <Chip key={id} id={id} />)}</li>
                      ))}
                    </ul>
                  </div>
                ))}
                <p className="meta">Hover a chip to see the exact source line. Past-note chips (H:…) come from the agent's retrieval.</p>
              </div>
            </div>

            {/* 3. Actions */}
            <div className="panel">
              <h2>Proposed follow-ups ({result.actions.length})</h2>
              <div className="pad actions">
                {result.actions.map((a, i) => {
                  const d = decisions[i] ?? "pending";
                  return (
                    <div key={i} className={`action ${a.type}`}>
                      <div className="head">
                        <span className="title"><span className={`badge ${a.type === "risk_flag" ? "risk" : ""}`}>{TYPE_LABEL[a.type]}</span>{a.title}</span>
                        <span className={`state ${d}`}>{d === "pending" ? "Awaiting you" : d === "approved" ? "Approved" : "Rejected"}</span>
                      </div>
                      {editing === i ? (
                        <textarea value={edits[i] ?? a.detail} onChange={(e) => setEdits({ ...edits, [i]: e.target.value })} aria-label="Edit action" />
                      ) : (
                        <p className="detail">{edits[i] ?? a.detail}</p>
                      )}
                      <div className="foot">
                        <span>To: {a.recipient} · via {a.channel} · {a.sources.map((id) => <Chip key={id} id={id} />)}</span>
                        <span className="decide">
                          <button onClick={() => setEditing(editing === i ? null : i)}>{editing === i ? "Done" : "Edit"}</button>
                          <button className="approve" onClick={() => { setDecisions({ ...decisions, [i]: "approved" }); setEditing(null); }}>Approve</button>
                          <button className="reject" onClick={() => setDecisions({ ...decisions, [i]: "rejected" })}>Reject</button>
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {outbox.length > 0 && (
              <div className="panel outbox">
                <h2>Mock outbox</h2>
                <ul className="pad">
                  {outbox.map(({ a, i }) => <li key={i}>✓ {TYPE_LABEL[a.type]} → {a.recipient} ({a.channel}): {a.title}</li>)}
                </ul>
              </div>
            )}

            {/* 4. Verifier report */}
            <div className="panel verifier">
              <h2>Verifier (code, not the model)</h2>
              <div className="pad">
                <div className="stats" style={{ marginBottom: 12 }}>
                  <div><b>{result.citation.valid}/{result.citation.total}</b>cited correctly as written</div>
                  <div><b>{result.corrected.length}</b>citations re-pointed</div>
                  <div><b>{result.removed.length}</b>lines removed</div>
                  <div><b>{(result.ms / 1000).toFixed(1)}s</b>run time</div>
                  <div><b>${cost.toFixed(3)}</b>model cost</div>
                </div>
                {result.corrected.map((c, i) => (
                  <li key={`c${i}`}><span className="badge warn">re-pointed</span>{c.where}: quote “{c.quote}” was cited to {c.from.join(", ")} but is in <Chip id={c.to} /></li>
                ))}
                {result.removed.map((r, i) => (
                  <li key={`r${i}`}><span className="badge risk">removed</span>{r.where}: “{r.text}” <span className="muted">({r.reason})</span></li>
                ))}
                {!result.corrected.length && !result.removed.length && <p style={{ fontSize: 14 }}>Every line and action cited a real source with a matching quote. Nothing was removed.</p>}
              </div>
            </div>

            {/* 5. Trace */}
            <div className="panel">
              <div className="pad">
                <details>
                  <summary>Agent trace: {result.trace.length} tool calls ({result.trace.filter((t) => t.tool === "search_history").length} retrieval searches)</summary>
                  <div className="trace">
                    {result.trace.map((t, i) => (
                      <div key={i}><b>{t.tool}</b>({JSON.stringify(t.input).slice(0, 220)}{JSON.stringify(t.input).length > 220 ? "…" : ""}){"\n"}→ {t.output.slice(0, 400)}</div>
                    ))}
                  </div>
                  <p className="meta">Models: {[...new Set(result.usage.map((u) => u.model))].join(" + ")}. {result.summary}</p>
                </details>
              </div>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
