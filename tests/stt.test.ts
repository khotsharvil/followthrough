// Audio path: the deterministic parts (no Sarvam or Claude calls).
import { test } from "node:test";
import assert from "node:assert/strict";
import { heuristicRoles, mergeTurns, normalize, toTranscript } from "../lib/stt";
import { parseTranscript } from "../lib/data";

const doc = {
  language_code: "en-IN",
  diarized_transcript: {
    entries: [
      { speaker_id: "SPEAKER_01", transcript: "How has your week been?", start_time_seconds: 0, end_time_seconds: 2 },
      { speaker_id: "SPEAKER_00", transcript: "Better.", start_time_seconds: 2, end_time_seconds: 3 },
      { speaker_id: "SPEAKER_00", transcript: "I slept more.", start_time_seconds: 3, end_time_seconds: 4 },
      { speaker_id: "SPEAKER_01", transcript: "What helped? Did the log help?", start_time_seconds: 4, end_time_seconds: 6 },
      { speaker_id: "SPEAKER_00", transcript: "  ", start_time_seconds: 6, end_time_seconds: 7 },
    ],
  },
};

test("diarized Sarvam output becomes speakers 0,1 in first-seen order, empty segments dropped", () => {
  const us = normalize(doc);
  assert.deepEqual(us.map((u) => u.speaker), [0, 1, 1, 0]);
});

test("consecutive turns by the same speaker are merged", () => {
  const turns = mergeTurns(normalize(doc));
  assert.equal(turns.length, 3);
  assert.equal(turns[1].text, "Better. I slept more.");
});

test("fallback role heuristic picks the speaker asking questions as clinician", () => {
  assert.deepEqual(heuristicRoles(mergeTurns(normalize(doc))), { 0: "T", 1: "C" });
});

test("flat transcript (no diarization) still yields one utterance", () => {
  assert.equal(normalize({ transcript: "hello there" }).length, 1);
});

test("transcribed audio feeds the same citable transcript format", () => {
  const turns = mergeTurns(normalize(doc));
  const lines = parseTranscript(toTranscript(turns, { 0: "T", 1: "C" }));
  assert.equal(lines[0].id, "T:1");
  assert.equal(lines[1].speaker, "C");
  assert.equal(lines.length, 3);
});
