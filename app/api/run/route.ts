// POST /api/run { clientId, transcript }  -> full RunResult
// The API key stays server-side. Pasted transcripts are processed in memory and never stored or logged.
import { NextResponse } from "next/server";
import { run } from "@/lib/agent";
import { clients } from "@/lib/data";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_CHARS = 20000;

export async function POST(req: Request) {
  let body: { clientId?: string; transcript?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Send JSON: { clientId, transcript }" }, { status: 400 });
  }
  const { clientId, transcript } = body;
  if (!clientId || !clients().some((c) => c.id === clientId)) return NextResponse.json({ error: "Pick one of the synthetic clients." }, { status: 400 });
  if (!transcript?.trim()) return NextResponse.json({ error: "Transcript is empty." }, { status: 400 });
  if (transcript.length > MAX_CHARS) return NextResponse.json({ error: `Transcript is over ${MAX_CHARS} characters.` }, { status: 413 });

  const t0 = Date.now();
  try {
    const result = await run({ clientId, transcript });
    console.log(JSON.stringify({ event: "run", clientId, lines: result.lines.length, ms: result.ms })); // ids and timings only, never content
    return NextResponse.json(result);
  } catch (e) {
    console.error(JSON.stringify({ event: "run_failed", clientId, ms: Date.now() - t0, error: e instanceof Error ? e.name : "unknown" }));
    return NextResponse.json({ error: e instanceof Error ? e.message : "Run failed" }, { status: 500 });
  }
}
