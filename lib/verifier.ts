// The verifier is code, not a model. It decides what reaches the clinician.
// Anything that fails is removed and listed, never silently dropped.
import type { Client } from "./data";
import type { RiskResult } from "./risk";

export type Cited = { text: string; sources: string[]; evidence: string };
export type NoteSection = { heading: string; items: Cited[] };
export type ActionType = "homework" | "client_message" | "booking" | "check_in" | "risk_flag" | "care_team_note";
export type Action = {
  type: ActionType;
  title: string;
  detail: string;
  recipient: string;
  channel: string;
  sources: string[];
  evidence: string;
};
export type Removed = { where: string; text: string; reason: string };
export type Corrected = { where: string; from: string[]; to: string; quote: string };

/** If the quote is genuine but cited from the wrong place, find the ONE source that really contains it. */
export function relocate(evidence: string, index: Map<string, string>): string | null {
  const q = norm(evidence);
  if (q.length < 3) return null;
  const found = [...index.entries()].filter(([, text]) => norm(text).includes(q)).map(([id]) => id);
  return found.length === 1 ? found[0] : null;
}

const norm = (s: string) =>
  s.toLowerCase().replace(/[“”"'’`]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/** The evidence quote must appear in at least one cited source. */
export function checkCitation(sources: string[], evidence: string, index: Map<string, string>): string | null {
  if (!sources.length) return "no source cited";
  const missing = sources.filter((s) => !index.has(s));
  if (missing.length) return `cites ids that don't exist: ${missing.join(", ")}`;
  const q = norm(evidence);
  if (q.length < 3) return "evidence quote is empty";
  if (!sources.some((s) => norm(index.get(s)!).includes(q))) return `quote not found in cited source(s): "${evidence}"`;
  return null;
}

// No diagnoses, ICD codes or medication advice. Clinicians decide those.
const CLINICAL_OVERREACH: { re: RegExp; reason: string }[] = [
  { re: /\b[FZ]\d{2}(\.\d)?\b/, reason: "contains an ICD-style diagnostic code" },
  { re: /\b(diagnos(e|ed|is|ing)|meets criteria for)\b/i, reason: "makes a diagnostic statement" },
  { re: /\b(major depressive disorder|generali[sz]ed anxiety disorder|bipolar disorder|ptsd|panic disorder)\b/i, reason: "names a diagnosis" },
  {
    re: /\b(should|recommend\w*|advis\w*|suggest\w*|try|consider)\b[^.]{0,25}\b(increas|decreas|reduc|lower|rais|stop|taper|switch)\w*\b[^.]{0,25}\b(dose|dosage|medication|medicine|tablets?)\b/i,
    reason: "gives medication advice",
  },
  { re: /\b\d+\s?mg\b/i, reason: "mentions a medication dose" },
];
/** True if the recipient field addresses this person, ignoring negations like "client only, not wife". */
export function namesRecipient(recipient: string, person: string): boolean {
  const named = new RegExp(`\\b${person}\\b`, "i");
  const negated = new RegExp(`\\b(not|no|never|except|excluding|without)\\b[^,;.]{0,20}\\b${person}\\b`, "i");
  return named.test(recipient) && !negated.test(recipient);
}

export function clinicalOverreach(text: string): string | null {
  for (const { re, reason } of CLINICAL_OVERREACH) if (re.test(text)) return reason;
  return null;
}

export function verify(
  note: NoteSection[],
  actions: Action[],
  index: Map<string, string>,
  client: Client,
  risk: RiskResult,
) {
  const removed: Removed[] = [];
  const corrected: Corrected[] = [];
  // Re-point a misplaced citation, visibly. Counts as invalid in the model's citation score.
  const repair = (where: string, x: { sources: string[]; evidence: string }) => {
    if (!checkCitation(x.sources, x.evidence, index)) return true;
    const to = relocate(x.evidence, index);
    if (!to) return false;
    corrected.push({ where, from: x.sources, to, quote: x.evidence });
    x.sources = [to];
    return false;
  };
  const keptNote: NoteSection[] = [];
  let citedTotal = 0;
  let citedValid = 0;

  for (const sec of note) {
    const items: Cited[] = [];
    for (const it of sec.items) {
      citedTotal++;
      if (repair(`Note · ${sec.heading}`, it)) citedValid++;
      const bad = checkCitation(it.sources, it.evidence, index) ?? clinicalOverreach(it.text);
      if (bad) removed.push({ where: `Note · ${sec.heading}`, text: it.text, reason: bad });
      else items.push(it);
    }
    if (items.length) keptNote.push({ heading: sec.heading, items });
  }

  const keptActions: Action[] = [];
  for (const a of actions) {
    citedTotal++;
    const all = `${a.title} ${a.detail}`;
    if (repair(`Action · ${a.title}`, a)) citedValid++;
    let bad = checkCitation(a.sources, a.evidence, index) ?? clinicalOverreach(all);
    // Client-specific rules: who must not be contacted, what must not be mentioned.
    const blocked = client.constraints.doNotContact.find((p) => namesRecipient(a.recipient, p));
    if (!bad && blocked) bad = `client asked that their ${blocked} not be contacted`;
    if (!bad && a.type === "client_message") {
      const word = client.constraints.doNotMention.find((w) => new RegExp(`\\b${w}\\b`, "i").test(all));
      if (word) bad = `client asked that "${word}" not appear in messages`;
    }
    if (bad) removed.push({ where: `Action · ${a.title}`, text: a.detail, reason: bad });
    else keptActions.push(a);
  }

  // Risk can't be dropped: if the screen flagged and no valid risk action survived, add one from the screen itself.
  if (risk.flagged && !keptActions.some((a) => a.type === "risk_flag")) {
    const hit = risk.lexicon[0];
    const lineIds = hit ? [hit.lineId] : "lineIds" in risk.classifier ? risk.classifier.lineIds : [];
    keptActions.unshift({
      type: "risk_flag",
      title: "Review safety concern",
      detail: "The risk screen flagged this session. Please review the quoted lines before approving any follow-ups.",
      recipient: "Treating clinician",
      channel: "internal",
      sources: lineIds,
      evidence: hit?.quote ?? "",
    });
  }
  // Risk flags first, always.
  keptActions.sort((a, b) => Number(b.type === "risk_flag") - Number(a.type === "risk_flag"));

  return { note: keptNote, actions: keptActions, removed, corrected, citation: { total: citedTotal, valid: citedValid } };
}
