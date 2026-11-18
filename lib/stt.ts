// Session audio -> diarized transcript (Sarvam Saaras batch job) -> clinician/client roles.
// Adapted from Unclinq's production Sarvam service. The Sarvam batch SDK is disk-based, so audio is
// staged in a unique temp dir for the life of one job and deleted in `finally`. Nothing is kept.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { SarvamAIClient } from "sarvamai";

export type Utterance = { speaker: number; text: string; start: number; end: number };
export type SttMode = "transcribe" | "translit" | "translate";
export type Transcription = {
  utterances: Utterance[];
  roles: Record<number, "T" | "C">;
  roleMethod: "model" | "heuristic";
  languageCode: string | null;
  durationSec: number;
  transcript: string; // "T: ..." / "C: ..." lines, ready for the pipeline
};

type SarvamDoc = {
  transcript?: string;
  language_code?: string;
  diarized_transcript?: { entries?: { speaker_id?: string | number; transcript?: string; start_time_seconds?: number; end_time_seconds?: number }[] };
};

/** Sarvam's opaque speaker ids -> 0, 1, 2… in first-seen order; flat transcript if no diarization. */
export function normalize(doc: SarvamDoc): Utterance[] {
  const seen = new Map<string, number>();
  const idx = (id: unknown) => {
    const k = id == null ? "0" : String(id);
    if (!seen.has(k)) seen.set(k, seen.size);
    return seen.get(k)!;
  };
  const entries = doc.diarized_transcript?.entries;
  if (entries?.length) {
    return entries
      .map((e) => ({ speaker: idx(e.speaker_id), text: (e.transcript ?? "").trim(), start: e.start_time_seconds ?? 0, end: e.end_time_seconds ?? 0 }))
      .filter((u) => u.text);
  }
  const flat = (doc.transcript ?? "").trim();
  return flat ? [{ speaker: 0, text: flat, start: 0, end: 0 }] : [];
}

/** Merge consecutive utterances from the same speaker into one turn. */
export function mergeTurns(us: Utterance[]): Utterance[] {
  const out: Utterance[] = [];
  for (const u of us) {
    const last = out[out.length - 1];
    if (last && last.speaker === u.speaker) {
      last.text = `${last.text} ${u.text}`;
      last.end = u.end;
    } else out.push({ ...u });
  }
  return out;
}

/** Fallback: the speaker who asks the most questions is usually the clinician. */
export function heuristicRoles(us: Utterance[]): Record<number, "T" | "C"> {
  const q = new Map<number, number>();
  for (const u of us) q.set(u.speaker, (q.get(u.speaker) ?? 0) + (u.text.match(/\?/g)?.length ?? 0));
  const speakers = [...new Set(us.map((u) => u.speaker))];
  const clinician = speakers.sort((a, b) => (q.get(b) ?? 0) - (q.get(a) ?? 0))[0] ?? 0;
  return Object.fromEntries(speakers.map((s) => [s, s === clinician ? "T" : "C"]));
}

const RolesSchema = z.object({ clinicianSpeaker: z.number().int(), reason: z.string() });

/** Ask a small model which diarized speaker is the clinician. Falls back to the heuristic. */
export async function labelRoles(anthropic: Anthropic | null, us: Utterance[]) {
  const speakers = [...new Set(us.map((u) => u.speaker))];
  if (speakers.length < 2 || !anthropic) return { roles: heuristicRoles(us), method: "heuristic" as const };
  try {
    const sample = us.slice(0, 30).map((u) => `S${u.speaker}: ${u.text}`).join("\n");
    const res = await anthropic.messages.parse({
      model: "claude-haiku-4-5",
      max_tokens: 300,
      system: "This is a therapy or psychiatry session transcript with diarized speakers S0, S1, ... Identify which speaker is the clinician (asks questions, reflects, sets homework, books follow-ups). Answer with that speaker's number.",
      messages: [{ role: "user", content: sample }],
      output_config: { format: zodOutputFormat(RolesSchema) },
    });
    const c = res.parsed_output?.clinicianSpeaker;
    if (c == null || !speakers.includes(c)) throw new Error("no valid speaker");
    return { roles: Object.fromEntries(speakers.map((s) => [s, s === c ? "T" : "C"])) as Record<number, "T" | "C">, method: "model" as const };
  } catch {
    return { roles: heuristicRoles(us), method: "heuristic" as const };
  }
}

export function toTranscript(us: Utterance[], roles: Record<number, "T" | "C">, header = "# Transcribed from audio by Sarvam (Saaras). Synthetic or consented audio only.") {
  return [header, ...us.map((u) => `${roles[u.speaker] ?? "C"}: ${u.text}`)].join("\n");
}

export async function transcribe(
  audio: Buffer,
  opts: { filename: string; mode?: SttMode; anthropic?: Anthropic | null; timeoutSeconds?: number },
): Promise<Transcription> {
  if (!process.env.SARVAM_API_KEY) throw new Error("SARVAM_API_KEY is not configured.");
  if (!audio.length) throw new Error("No audio received.");
  const sarvam = new SarvamAIClient({ apiSubscriptionKey: process.env.SARVAM_API_KEY });
  const ext = (path.extname(opts.filename) || ".wav").toLowerCase();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ft-stt-"));
  const inputName = `session${ext}`;
  const inputPath = path.join(work, inputName);
  try {
    fs.writeFileSync(inputPath, audio);
    const job = await sarvam.speechToTextJob.createJob({
      model: "saaras:v3",
      withDiarization: true,
      languageCode: "unknown",
      mode: opts.mode ?? "transcribe",
    } as Parameters<typeof sarvam.speechToTextJob.createJob>[0]);
    await job.uploadFiles([inputPath]);
    await job.start();
    const status = await job.waitUntilComplete(3, opts.timeoutSeconds ?? 240);
    if (String(status.job_state).toLowerCase() !== "completed") throw new Error(`Sarvam job ended in state "${status.job_state}".`);
    const results = await job.getFileResults();
    if (results.failed.length && !results.successful.length) throw new Error(`Sarvam could not transcribe the audio: ${results.failed[0].error_message ?? "unknown error"}`);
    const outDir = path.join(work, "out");
    await job.downloadOutputs(outDir);
    const outPath = path.join(outDir, `${inputName}.json`);
    if (!fs.existsSync(outPath)) throw new Error("Sarvam produced no transcript.");
    const doc: SarvamDoc = JSON.parse(fs.readFileSync(outPath, "utf8"));

    const utterances = mergeTurns(normalize(doc));
    if (!utterances.length) throw new Error("No speech detected in the audio.");
    const { roles, method } = await labelRoles(opts.anthropic ?? null, utterances);
    return {
      utterances,
      roles,
      roleMethod: method,
      languageCode: doc.language_code ?? null,
      durationSec: Math.round(utterances[utterances.length - 1].end || 0),
      transcript: toTranscript(utterances, roles),
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true }); // the audio never outlives the job
  }
}
