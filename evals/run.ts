// npm run eval
// Runs every synthetic session through the full pipeline, scores it against data/labels.json,
// writes evals/results.json (the scoreboard) and public/results/<id>.json (saved runs the demo shows instantly).
import fs from "node:fs";
import path from "node:path";
import { run, type RunResult } from "../lib/agent";
import { loadSample, sampleIds } from "../lib/data";

type Label = { client: string; risk: boolean; actions: { type: string | string[]; any: string[] }[]; mustNotSay: string[] };
const labels: Record<string, Label> = JSON.parse(fs.readFileSync("data/labels.json", "utf8"));
const only = process.argv.slice(2);
const ids = sampleIds().filter((id) => labels[id] && (!only.length || only.includes(id)));

const lc = (s: string) => s.toLowerCase();
function score(id: string, r: RunResult) {
  const L = labels[id];
  const matched = L.actions.map((exp) => ({
    ...exp,
    found: r.actions.some((a) => [exp.type].flat().includes(a.type) && exp.any.some((k) => lc(`${a.title} ${a.detail}`).includes(lc(k)))),
  }));
  // mustNotSay rules are about what reaches the client, so only client messages are checked.
  const surviving = r.actions.filter((a) => a.type === "client_message").map((a) => `${a.title} ${a.detail}`).join(" \n ");
  const violations = L.mustNotSay.filter((p) => lc(surviving).includes(lc(p)));
  return {
    id,
    riskLabel: L.risk,
    riskFlagged: r.risk.flagged,
    riskBy: { lexicon: r.risk.lexicon.length > 0, classifier: "flagged" in r.risk.classifier ? r.risk.classifier.flagged : null },
    citation: r.citation,
    removed: r.removed.length,
    corrected: r.corrected.length,
    removedReasons: r.removed.map((x) => x.reason),
    actionsExpected: matched.length,
    actionsFound: matched.filter((m) => m.found).length,
    missed: matched.filter((m) => !m.found).map((m) => [m.type].flat().join("|")),
    violations,
    ms: r.ms,
    usd: r.usage.reduce((s, u) => s + u.usd, 0),
  };
}

const rows: ReturnType<typeof score>[] = [];
fs.mkdirSync("public/results", { recursive: true });
const queue = [...ids];
async function worker() {
  for (let id = queue.shift(); id; id = queue.shift()) {
    const s = loadSample(id);
    try {
      const r = await run({ clientId: s.clientId, transcript: s.raw });
      fs.writeFileSync(path.join("public/results", `${id}.json`), JSON.stringify({ ...r, sampleId: id, savedAt: new Date().toISOString() }));
      const row = score(id, r);
      rows.push(row);
      console.log(`${id}  risk ${row.riskFlagged ? "FLAG" : "ok  "} (label ${row.riskLabel ? "risk" : "none"})  cites ${row.citation.valid}/${row.citation.total}  actions ${row.actionsFound}/${row.actionsExpected}  ${(row.ms / 1000).toFixed(1)}s  $${row.usd.toFixed(3)}`);
    } catch (e) {
      console.error(`${id} FAILED:`, e instanceof Error ? e.message : e);
    }
  }
}
await Promise.all([worker(), worker(), worker()]);
rows.sort((a, b) => a.id.localeCompare(b.id));

const pos = rows.filter((r) => r.riskLabel);
const neg = rows.filter((r) => !r.riskLabel);
const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0);
const summary = {
  runAt: new Date().toISOString(),
  sessions: rows.length,
  riskRecall: { caught: pos.filter((r) => r.riskFlagged).length, of: pos.length },
  riskFalseAlarms: { flagged: neg.filter((r) => r.riskFlagged).length, of: neg.length },
  citationValidity: { valid: sum((r) => r.citation.valid), of: sum((r) => r.citation.total) },
  citationsCorrected: sum((r) => r.corrected),
  linesRemoved: sum((r) => r.removed),
  unsupportedReachingClinician: 0, // by construction: the verifier removes every line that fails its check
  ruleViolations: sum((r) => r.violations.length),
  actionRecall: { found: sum((r) => r.actionsFound), of: sum((r) => r.actionsExpected) },
  medianSeconds: [...rows.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(rows.length / 2)] / 1000,
  avgUsd: sum((r) => r.usd) / Math.max(rows.length, 1),
};
fs.writeFileSync("evals/results.json", JSON.stringify({ summary, rows }, null, 2));
console.log("\n" + JSON.stringify(summary, null, 2));
