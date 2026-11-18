// npm test  (no API key needed: these cover the deterministic safety layer)
import { test } from "node:test";
import assert from "node:assert/strict";
import { getClient, historyChunks, loadSample, parseTranscript, sourceIndex } from "../lib/data";
import { lexiconScreen, type RiskResult } from "../lib/risk";
import { search } from "../lib/retrieval";
import { checkCitation, clinicalOverreach, namesRecipient, relocate, verify, type Action } from "../lib/verifier";

const lines = (id: string) => parseTranscript(loadSample(id).raw);
const noRisk: RiskResult = { flagged: false, lexicon: [], classifier: { flagged: false, lineIds: [], reason: "" } };

test("transcript lines get stable ids and headers are skipped", () => {
  const l = lines("t01");
  assert.equal(l[0].id, "T:1");
  assert.equal(l[0].speaker, "T");
  assert.ok(!l.some((x) => x.text.includes("SYNTHETIC")));
});

test("lexicon catches passive and Hinglish risk language on client lines", () => {
  assert.ok(lexiconScreen(lines("t04")).some((h) => h.signal.includes("better off")));
  assert.ok(lexiconScreen(lines("t05")).some((h) => h.signal === "death wish"));
  const t09 = lexiconScreen(lines("t09")).map((h) => h.signal);
  assert.ok(t09.some((s) => s.startsWith("Hinglish")));
  assert.ok(t09.includes("impaired driving"));
});

test("lexicon ignores idioms like 'this exam is killing me'", () => {
  assert.deepEqual(lexiconScreen(lines("t06")), []);
});

test("BM25 finds the safety plan in past notes", () => {
  const hits = search(historyChunks(getClient("c02")), "safety plan");
  assert.ok(hits[0].text.toLowerCase().includes("safety plan"));
  assert.match(hits[0].id, /^H:c02-n05\.\d+$/);
});

test("citations: real quote passes, invented quote and unknown id fail", () => {
  const l = lines("t03");
  const idx = sourceIndex(l, historyChunks(getClient("c02")));
  assert.equal(checkCitation(["T:14"], "I was thinking of just stopping it", idx), null);
  assert.match(checkCitation(["T:14"], "the clinician told him to stop", idx)!, /not found/);
  assert.match(checkCitation(["T:999"], "anything", idx)!, /don't exist/);
  assert.match(checkCitation([], "anything", idx)!, /no source/);
});

test("a genuine quote cited from the wrong line is relocated, not invented", () => {
  const idx = sourceIndex(lines("t03"), []);
  assert.equal(relocate("I was thinking of just stopping it", idx), "T:14");
  assert.equal(relocate("this sentence is in no source", idx), null);
});

test("clinical overreach: diagnoses, codes and medication advice are blocked; reports are not", () => {
  assert.ok(clinicalOverreach("Meets criteria for major depressive disorder"));
  assert.ok(clinicalOverreach("Code F41.1"));
  assert.ok(clinicalOverreach("Suggest he should reduce the dose of his medication"));
  assert.ok(clinicalOverreach("Take 50 mg at night"));
  assert.equal(clinicalOverreach("Client was thinking of stopping the medication; routed to Dr. K."), null);
});

test("client rules: do-not-contact and do-not-mention remove the action", () => {
  const l = lines("t09");
  const idx = sourceIndex(l, []);
  const base = { title: "x", channel: "WhatsApp", sources: ["T:2"], evidence: "Layoff announce ho gaya" };
  const actions: Action[] = [
    { ...base, type: "client_message", detail: "Update", recipient: "Client's wife" },
    { ...base, type: "homework", detail: "Cab, not driving", recipient: "Client" },
  ];
  const v = verify([], actions, idx, getClient("c04"), noRisk);
  assert.equal(v.actions.length, 1);
  assert.match(v.removed[0].reason, /wife/);

  const c01 = sourceIndex(lines("t02"), []);
  const msg: Action = { type: "client_message", title: "Reminder", detail: "Your manager asked about you", recipient: "Client", channel: "WhatsApp", sources: ["T:1"], evidence: "How did the release week go" };
  assert.match(verify([], [msg], c01, getClient("c01"), noRisk).removed[0].reason, /manager/);
});

test("risk can't be dropped: a flagged session always gets a risk action, listed first", () => {
  const l = lines("t05");
  const risk: RiskResult = { flagged: true, lexicon: lexiconScreen(l), classifier: { error: "offline" } };
  const homework: Action = { type: "homework", title: "Letter", detail: "After exams", recipient: "Client", channel: "in-app", sources: ["T:22"], evidence: "After exams" };
  const v = verify([], [homework], sourceIndex(l, []), getClient("c03"), risk);
  assert.equal(v.actions[0].type, "risk_flag");
  assert.equal(v.actions.length, 2);
});

test("do-not-contact understands negation (eval caught this false positive)", () => {
  assert.equal(namesRecipient("Client's wife", "wife"), true);
  assert.equal(namesRecipient("Vikram (client only, not wife)", "wife"), false);
  assert.equal(namesRecipient("Client only, never his wife", "wife"), false);
  assert.equal(namesRecipient("Client", "wife"), false);
});
