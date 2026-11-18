// npm run sample-audio
// Builds public/samples/t03-session.mp3: synthetic transcript t03 voiced by two Sarvam Bulbul voices
// (clinician and client), so reviewers can try the audio path without real recordings.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SarvamAIClient } from "sarvamai";
import { loadSample, parseTranscript } from "../lib/data";

const sarvam = new SarvamAIClient({ apiSubscriptionKey: process.env.SARVAM_API_KEY! });
const VOICE = { T: "priya", C: "rahul" } as const; // bulbul:v3 voices
const lines = parseTranscript(loadSample("t03").raw);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ft-tts-"));

try {
  const parts: string[] = [];
  for (const [i, l] of lines.entries()) {
    const res = await sarvam.textToSpeech.convert({
      text: l.text,
      language_code: "en-IN",
      speaker: VOICE[l.speaker],
      model: "bulbul:v3",
      pace: l.speaker === "T" ? 0.95 : 1.0,
    });
    const file = path.join(work, `${String(i).padStart(3, "0")}.wav`);
    fs.writeFileSync(file, Buffer.from(res.audios.join(""), "base64"));
    parts.push(file);
    process.stdout.write(".");
  }
  // Short pause between turns, normalise every clip to 22.05 kHz mono, then concatenate to MP3.
  const silence = path.join(work, "gap.wav");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono", "-t", "0.6", silence]);
  const list = path.join(work, "list.txt");
  const norm = parts.map((p) => {
    const out = p.replace(".wav", "-n.wav");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", p, "-ar", "22050", "-ac", "1", out]);
    return out;
  });
  fs.writeFileSync(list, norm.flatMap((p) => [`file '${p.replace(/\\/g, "/")}'`, `file '${silence.replace(/\\/g, "/")}'`]).join("\n"));
  fs.mkdirSync("public/samples", { recursive: true });
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-ac", "1", "-b:a", "48k", "public/samples/t03-session.mp3"]);
  console.log(`\nWrote public/samples/t03-session.mp3 (${(fs.statSync("public/samples/t03-session.mp3").size / 1e6).toFixed(2)} MB)`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
