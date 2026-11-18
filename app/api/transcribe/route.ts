// POST /api/transcribe  multipart: file=<audio> | sample=t03, mode=transcribe|translit|translate
// Audio is held in memory, staged in a temp dir only for the Sarvam job, then deleted. Never stored or logged.
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { transcribe, type SttMode } from "@/lib/stt";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_BYTES = 4 * 1024 * 1024; // Vercel's request body limit is 4.5 MB
const MODES: SttMode[] = ["transcribe", "translit", "translate"];
const SAMPLES: Record<string, string> = { t03: "t03-session.mp3" };

export async function POST(req: Request) {
  const t0 = Date.now();
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Send multipart form data with an audio file." }, { status: 400 });
  }
  const mode = (MODES.includes(form.get("mode") as SttMode) ? form.get("mode") : "transcribe") as SttMode;
  const sample = String(form.get("sample") ?? "");
  let audio: Buffer;
  let filename: string;
  if (SAMPLES[sample]) {
    filename = SAMPLES[sample];
    audio = fs.readFileSync(path.join(process.cwd(), "public", "samples", filename));
  } else {
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "No audio file." }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: "Audio is over 4 MB. Try a shorter clip, or a compressed format such as MP3, M4A or WebM." }, { status: 413 });
    filename = file.name || "session.webm";
    audio = Buffer.from(await file.arrayBuffer());
  }
  try {
    const result = await transcribe(audio, { filename, mode, anthropic: new Anthropic() });
    console.log(JSON.stringify({ event: "transcribe", bytes: audio.length, turns: result.utterances.length, ms: Date.now() - t0 }));
    return NextResponse.json({ ...result, ms: Date.now() - t0 });
  } catch (e) {
    console.error(JSON.stringify({ event: "transcribe_failed", bytes: audio.length, ms: Date.now() - t0 }));
    return NextResponse.json({ error: e instanceof Error ? e.message : "Transcription failed" }, { status: 500 });
  }
}
