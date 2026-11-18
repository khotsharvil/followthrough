// Tools the agent can call. They read data and RECORD proposals; none of them sends or books anything.
// The same implementations back the MCP server (mcp/server.ts).
import type Anthropic from "@anthropic-ai/sdk";
import { search } from "./retrieval";
import type { Chunk, Client } from "./data";
import type { Action, NoteSection } from "./verifier";

const citedSchema = {
  type: "object",
  properties: {
    text: { type: "string", description: "One line of the note, in plain clinical English." },
    sources: { type: "array", items: { type: "string" }, description: 'Ids this line is based on, e.g. ["T:12"] or ["H:c01-n03.2"].' },
    evidence: { type: "string", description: "A short verbatim quote (3-15 words) copied exactly from one of the cited sources." },
  },
  required: ["text", "sources", "evidence"],
  additionalProperties: false,
} as const;

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "search_history",
    description:
      "Search this client's past session notes (BM25). Use it to check what was agreed before, what has been tried, and past risk history. Returns sentence chunks with ids like H:c01-n03.2 that you may cite.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "What to look for, e.g. 'safety plan' or 'sleep log homework'." } },
      required: ["query"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "get_client_profile",
    description: "Get the client's service, presenting concern, contact channel and rules (who must not be contacted, what must not be mentioned, quiet hours).",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "write_note",
    description:
      "Write the structured session note. Call once. Sections in this order: 'Since last session', 'This session', 'Client in their own words', 'Plan agreed'. Every line must cite sources and carry a verbatim evidence quote.",
    input_schema: {
      type: "object",
      properties: {
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: { heading: { type: "string" }, items: { type: "array", items: citedSchema } },
            required: ["heading", "items"],
            additionalProperties: false,
          },
        },
      },
      required: ["sections"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "propose_action",
    description:
      "Propose ONE follow-up for the clinician to approve. Nothing is sent or booked. Call once per follow-up that was agreed or clearly needed in the session. A client_message is a draft written to the client, in their channel and language.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["homework", "client_message", "booking", "check_in", "risk_flag", "care_team_note"] },
        title: { type: "string", description: "Short label, e.g. 'Book psychiatry follow-up (evening)'." },
        detail: { type: "string", description: "What exactly is proposed. For client_message, the full draft message." },
        recipient: { type: "string", description: "Who it is for, e.g. 'Client', 'Care team', 'Dr. K. (psychiatry)'." },
        channel: { type: "string", description: "e.g. 'WhatsApp (Hindi)', 'SMS', 'internal'." },
        sources: { type: "array", items: { type: "string" } },
        evidence: { type: "string", description: "A short verbatim quote from one cited source that justifies this action." },
      },
      required: ["type", "title", "detail", "recipient", "channel", "sources", "evidence"],
      additionalProperties: false,
    },
    strict: true,
  },
];

export type RunState = { note: NoteSection[]; actions: Action[] };

export function executeTool(name: string, input: Record<string, unknown>, ctx: { client: Client; chunks: Chunk[]; state: RunState }) {
  switch (name) {
    case "search_history": {
      const hits = search(ctx.chunks, String(input.query ?? ""));
      if (!hits.length) return "No matching past notes.";
      return hits.map((h) => `[${h.id}] (${h.date}) ${h.text}`).join("\n");
    }
    case "get_client_profile": {
      const { notes: _notes, ...profile } = ctx.client;
      return JSON.stringify(profile, null, 2);
    }
    case "write_note": {
      ctx.state.note = (input.sections as NoteSection[]) ?? [];
      return `Note recorded with ${ctx.state.note.reduce((s, x) => s + x.items.length, 0)} lines. It will be verified before the clinician sees it.`;
    }
    case "propose_action": {
      ctx.state.actions.push(input as unknown as Action);
      return `Proposal recorded (${ctx.state.actions.length} so far). It waits for clinician approval.`;
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
