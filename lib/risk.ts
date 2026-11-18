// Risk screen. Runs BEFORE the agent and cannot be skipped.
// Two independent detectors; if EITHER fires, the session is flagged for clinician review.
// We accept extra false alarms (idioms like "this exam is killing me") to protect recall.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Line } from "./data";

export type RiskHit = { lineId: string; quote: string; signal: string };
export type RiskResult = {
  flagged: boolean;
  lexicon: RiskHit[];
  classifier: { flagged: boolean; lineIds: string[]; reason: string } | { error: string };
};

// English + Hinglish (romanised Hindi) risk language. Only CLIENT lines are screened.
const LEXICON: { signal: string; re: RegExp }[] = [
  { signal: "death wish", re: /\b(not wake up|don'?t want to (live|be here|wake up)|wish i (was|were) dead|want (it|everything) to (stop|end))\b/i },
  { signal: "burden / better off without me", re: /\b(better off without me|i'?m a burden|burden to (everyone|them))\b/i },
  { signal: "suicide / self-harm", re: /\b(kill (myself|me)|end(ing)? (my|it) (life|all)|suicid\w*|hurt(ing)? myself|self[- ]harm)\b/i },
  { signal: "Hinglish: end it all / end my life", re: /\b(sab khatam kar (doon|dun|du)|jaan (de|le) (doon|dun|lun)|mar jaana|jeena nahi)\b/i },
  { signal: "impaired driving", re: /\b(drunk driv\w*|drove (home )?drunk|pee ke gaadi|gaadi (bhi )?chala ke)\b/i },
];

export function lexiconScreen(lines: Line[]): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const l of lines) {
    if (l.speaker !== "C") continue;
    for (const { signal, re } of LEXICON) {
      const m = l.text.match(re);
      if (m) hits.push({ lineId: l.id, quote: m[0], signal });
    }
  }
  return hits;
}

const RiskSchema = z.object({
  flagged: z.boolean(),
  lineIds: z.array(z.string()),
  reason: z.string(),
});

const CLASSIFIER_PROMPT = `You screen therapy session transcripts for safety concerns a clinician must review before anything else.
Flag the session if the CLIENT expresses any of: suicidal thoughts (including passive ones such as wishing not to wake up, feeling everyone would be better off without them, wanting everything to end), self-harm, harm to others, or behaviour that endangers themselves or others (for example driving after drinking).
Do not flag figures of speech with no such meaning (for example "this exam is killing me"). Transcripts may mix Hindi and English.
Return the transcript line ids (like "T:12") that carry the concern, and a one-sentence reason. You never diagnose.`;

export async function classify(client: Anthropic, lines: Line[]) {
  const transcript = lines.map((l) => `[${l.id}] ${l.speaker === "T" ? "Clinician" : "Client"}: ${l.text}`).join("\n");
  const res = await client.messages.parse({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    system: CLASSIFIER_PROMPT,
    messages: [{ role: "user", content: transcript }],
    output_config: { format: zodOutputFormat(RiskSchema) },
  });
  if (!res.parsed_output) throw new Error(`classifier returned no structured output (stop_reason: ${res.stop_reason})`);
  return { result: res.parsed_output, usage: res.usage };
}

export async function screen(client: Anthropic | null, lines: Line[]) {
  const lexicon = lexiconScreen(lines);
  let classifier: RiskResult["classifier"];
  let usage: Anthropic.Usage | null = null;
  if (!client) classifier = { error: "no API client (offline mode)" };
  else {
    try {
      const out = await classify(client, lines);
      classifier = out.result;
      usage = out.usage;
    } catch (e) {
      // Fail closed: if the classifier is down, a lexicon hit still flags, and the UI says the classifier didn't run.
      classifier = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  const flagged = lexicon.length > 0 || ("flagged" in classifier && classifier.flagged);
  return { risk: { flagged, lexicon, classifier } as RiskResult, usage };
}
