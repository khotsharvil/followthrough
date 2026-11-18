import fs from "node:fs";
import path from "node:path";

type Row = { id: string; riskLabel: boolean; riskFlagged: boolean; riskBy: { lexicon: boolean; classifier: boolean | null }; citation: { valid: number; total: number }; corrected: number; removed: number; actionsFound: number; actionsExpected: number; violations: string[]; ms: number; usd: number };

export default function Evals() {
  const { summary: s, rows } = JSON.parse(fs.readFileSync(path.join(process.cwd(), "evals/results.json"), "utf8")) as { summary: Record<string, any>; rows: Row[] };
  const pct = (a: number, b: number) => `${Math.round((a / Math.max(b, 1)) * 100)}%`;
  return (
    <>
      <header className="top">
        <div className="brand"><a href="/" style={{ color: "inherit", textDecoration: "none" }}>Followthrough<span>.</span></a> <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>evals</span></div>
        <nav><a href="/">Demo</a><a href="https://github.com/khotsharvil/followthrough" target="_blank" rel="noopener">GitHub</a></nav>
      </header>
      <div className="page">
        <h1>Eval results</h1>
        <p>{s.sessions} synthetic sessions, each run through the full pipeline (risk screen → agent → verifier) and scored against hand-written labels in <code>data/labels.json</code>. Run it yourself with <code>npm run eval</code>. Last run: {new Date(s.runAt).toUTCString()}.</p>
        <div className="stats" style={{ marginBottom: 20 }}>
          <div><b>{s.riskRecall.caught}/{s.riskRecall.of}</b>risk sessions caught (target: all)</div>
          <div><b>{s.riskFalseAlarms.flagged}/{s.riskFalseAlarms.of}</b>false alarms on clean sessions</div>
          <div><b>{pct(s.citationValidity.valid, s.citationValidity.of)}</b>lines cited correctly as the model wrote them ({s.citationValidity.valid}/{s.citationValidity.of})</div>
          <div><b>{s.unsupportedReachingClinician}</b>unsupported lines reaching the clinician</div>
          <div><b>{s.actionRecall.found}/{s.actionRecall.of}</b>expected follow-ups proposed</div>
          <div><b>{s.ruleViolations}</b>client-rule violations in messages</div>
          <div><b>{s.medianSeconds.toFixed(1)}s</b>median run time</div>
          <div><b>${s.avgUsd.toFixed(3)}</b>average cost per session</div>
        </div>
        <div className="tablewrap">
          <table className="ev">
            <thead><tr><th>Session</th><th>Risk label</th><th>Flagged</th><th>Caught by</th><th>Citations</th><th>Re-pointed</th><th>Removed</th><th>Follow-ups</th><th>Time</th><th>Cost</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.id}</td>
                  <td>{r.riskLabel ? "risk" : "none"}</td>
                  <td>{r.riskFlagged === r.riskLabel ? "✓ " : "✗ "}{r.riskFlagged ? "flagged" : "clear"}</td>
                  <td>{[r.riskBy.lexicon && "lexicon", r.riskBy.classifier && "classifier"].filter(Boolean).join(" + ") || "–"}</td>
                  <td>{r.citation.valid}/{r.citation.total}</td>
                  <td>{r.corrected}</td>
                  <td>{r.removed}</td>
                  <td>{r.actionsFound}/{r.actionsExpected}</td>
                  <td>{(r.ms / 1000).toFixed(1)}s</td>
                  <td>${r.usd.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ marginTop: 16 }}>Honest limits: 10 sessions is a smoke test, not a benchmark. Labels were written by the builder, and follow-up matching is keyword-based. The next step is clinician-written labels and a larger set, including sessions designed to fool the risk screen.</p>
      </div>
    </>
  );
}
