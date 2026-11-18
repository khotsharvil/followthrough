// The run: risk screen first -> agent loop (tool-calling, agentic RAG) -> code verifier.
// I own the loop (rather than the SDK tool runner) so every step is visible in the trace
// and the verifier sits between the model and the clinician.
import Anthropic from "@anthropic-ai/sdk";
import { getClient, historyChunks, parseTranscript, sourceIndex, type Line } from "./data";
import { screen, type RiskResult } from "./risk";
import { executeTool, TOOLS, type RunState } from "./tools";
import { verify, type Action, type Corrected, type NoteSection, type Removed } from "./verifier";

export const AGENT_MODEL = "claude-sonnet-5-5";
const PRICE = { "claude-sonnet-5-5": [2, 10], "claude-haiku-4-5": [1, 5] } as const; // USD per 1M tokens (in, out)

const SYSTEM = `You are Followthrough, an assistant that prepares post-session paperwork for a mental-health clinician at a care provider in India. You draft; the clinician decides.

Your job for one session:
1. Call get_client_profile, then use search_history to check what was agreed before and any past risk history that bears on this session.
2. Call write_note once, with sections in this order: "Since last session", "This session", "Client in their own words", "Plan agreed".
3. Call propose_action once for each follow-up that was agreed in the session or is clearly needed: homework, a draft client_message, a booking, a check_in, a care_team_note (for example informing the psychiatrist, only if the client consented), and a risk_flag if the risk screen flagged the session.
4. Finish with one short sentence. Do not repeat the note.

Rules you must follow:
- Every note line and every action cites ids ("T:12" for transcript lines, "H:c01-n03.2" for past notes) and includes an evidence quote copied word for word from one cited source. Anything you can't cite, leave out. Code checks every quote, and uncited lines are removed.
- Never state that the clinician instructed something unless the transcript shows the clinician saying it.
- Never diagnose, name disorders, use diagnostic codes, or advise on medication. If medication comes up, propose routing it to the prescriber.
- Respect the client's rules from the profile: channel, language, quiet hours, who must not be contacted, and what must not be mentioned. Draft client messages in the client's preferred language and channel, warm and brief, with no clinical detail.
- Safety comes first. If the risk screen flagged the session, the first action you propose is a risk_flag that quotes the client's words, and nothing in a client message should make light of it.
- Keep the client's own words in their language when quoting them (Hindi-English is fine).`;

export type TraceStep = { tool: string; input: unknown; output: string };
export type RunResult = {
  clientId: string;
  sessionHeader: string;
  lines: Line[];
  sources: Record<string, string>;
  risk: RiskResult;
  note: NoteSection[];
  actions: Action[];
  removed: Removed[];
  corrected: Corrected[];
  citation: { total: number; valid: number };
  trace: TraceStep[];
  summary: string;
  usage: { model: string; input: number; output: number; usd: number }[];
  ms: number;
  stopReason: string;
};

const usd = (model: keyof typeof PRICE, u: { input_tokens: number; output_tokens: number }) =>
  (u.input_tokens * PRICE[model][0] + u.output_tokens * PRICE[model][1]) / 1e6;

export async function run(opts: { clientId: string; transcript: string; anthropic?: Anthropic }): Promise<RunResult> {
  const t0 = Date.now();
  const anthropic = opts.anthropic ?? new Anthropic();
  const client = getClient(opts.clientId);
  const lines = parseTranscript(opts.transcript);
  if (!lines.length) throw new Error("Transcript is empty.");
  const chunks = historyChunks(client);
  const index = sourceIndex(lines, chunks);
  const usage: RunResult["usage"] = [];

  // 1. Risk screen, before the agent sees anything.
  const { risk, usage: riskUsage } = await screen(anthropic, lines);
  if (riskUsage) usage.push({ model: "claude-haiku-4-5", input: riskUsage.input_tokens, output: riskUsage.output_tokens, usd: usd("claude-haiku-4-5", riskUsage) });

  const riskBrief = risk.flagged
    ? `RISK SCREEN: FLAGGED for clinician review. Lexicon hits: ${JSON.stringify(risk.lexicon)}. Classifier: ${JSON.stringify(risk.classifier)}`
    : `RISK SCREEN: nothing flagged. (Lexicon: no hits. Classifier: ${JSON.stringify(risk.classifier)})`;
  const numbered = lines.map((l) => `[${l.id}] ${l.speaker === "T" ? "Clinician" : "Client"}: ${l.text}`).join("\n");

  // 2. Agent loop.
  const state: RunState = { note: [], actions: [] };
  const trace: TraceStep[] = [];
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: `Client id: ${client.id}\n${riskBrief}\n\nSession transcript:\n${numbered}` },
  ];
  let summary = "";
  let stopReason = "";
  for (let turn = 0; turn < 10; turn++) {
    const res = await anthropic.beta.messages.create({
      model: AGENT_MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      tools: TOOLS,
      messages,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    const servedBy = (res.model in PRICE ? res.model : AGENT_MODEL) as keyof typeof PRICE;
    usage.push({ model: res.model, input: res.usage.input_tokens, output: res.usage.output_tokens, usd: usd(servedBy, res.usage) });
    stopReason = res.stop_reason ?? "";
    if (res.stop_reason === "refusal") throw new Error("The model declined this request.");
    messages.push({ role: "assistant", content: res.content });

    const toolUses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (res.stop_reason === "end_turn" || !toolUses.length) {
      summary = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join(" ").trim();
      break;
    }
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      try {
        const out = executeTool(tu.name, tu.input as Record<string, unknown>, { client, chunks, state });
        trace.push({ tool: tu.name, input: tu.input, output: out });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        trace.push({ tool: tu.name, input: tu.input, output: `ERROR: ${msg}` });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: msg, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }

  // 3. Verifier: code decides what reaches the clinician.
  const v = verify(state.note, state.actions, index, client, risk);
  return {
    clientId: client.id,
    sessionHeader: opts.transcript.split(/\r?\n/)[0].startsWith("#") ? opts.transcript.split(/\r?\n/)[0].replace(/^#\s*/, "") : "Pasted session",
    lines,
    sources: Object.fromEntries(index),
    risk,
    ...v,
    trace,
    summary,
    usage,
    ms: Date.now() - t0,
    stopReason,
  };
}
