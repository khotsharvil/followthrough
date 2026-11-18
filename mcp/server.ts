// npm run mcp  -> an MCP server over stdio, exposing the same tools the agent uses.
// Lets Claude Desktop (or any MCP client) work with the synthetic care records directly,
// and run the full Followthrough pipeline on a session.
//
// Claude Desktop config (claude_desktop_config.json):
//   "followthrough": { "command": "npx", "args": ["tsx", "mcp/server.ts"], "cwd": "<repo path>",
//                      "env": { "ANTHROPIC_API_KEY": "..." } }   // key only needed for run_followthrough
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { clients, getClient, historyChunks, loadSample, parseTranscript, sampleIds } from "../lib/data";
import { search } from "../lib/retrieval";
import { lexiconScreen } from "../lib/risk";
import { run } from "../lib/agent";

const server = new McpServer({ name: "followthrough", version: "0.1.0" });
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const clientId = z.enum(clients().map((c) => c.id) as [string, ...string[]]).describe("Synthetic client id, e.g. c01");

server.registerTool(
  "list_clients",
  { title: "List clients", description: "List the synthetic clients and their sample sessions.", inputSchema: {}, annotations: { readOnlyHint: true } },
  async () =>
    text(
      clients()
        .map((c) => `${c.id} ${c.name}: ${c.presenting}. Sessions: ${sampleIds().filter((s) => loadSample(s).clientId === c.id).join(", ")}`)
        .join("\n"),
    ),
);

server.registerTool(
  "get_client_profile",
  { title: "Client profile", description: "Service, presenting concern, contact channel and rules (who not to contact, what not to mention).", inputSchema: { clientId }, annotations: { readOnlyHint: true } },
  async ({ clientId }) => {
    const { notes, ...profile } = getClient(clientId);
    return text(JSON.stringify({ ...profile, pastNotes: notes.length }, null, 2));
  },
);

server.registerTool(
  "search_history",
  { title: "Search past notes", description: "BM25 search over a client's past session notes. Returns citable chunks like H:c01-n03.2.", inputSchema: { clientId, query: z.string() }, annotations: { readOnlyHint: true } },
  async ({ clientId, query }) => {
    const hits = search(historyChunks(getClient(clientId)), query);
    return text(hits.length ? hits.map((h) => `[${h.id}] (${h.date}) ${h.text}`).join("\n") : "No matching past notes.");
  },
);

server.registerTool(
  "get_session",
  { title: "Get session transcript", description: "Numbered transcript for a sample session (t01–t10).", inputSchema: { sessionId: z.string().regex(/^t\d{2}$/) }, annotations: { readOnlyHint: true } },
  async ({ sessionId }) => {
    const s = loadSample(sessionId);
    return text(`${s.header}\n` + parseTranscript(s.raw).map((l) => `[${l.id}] ${l.speaker === "T" ? "Clinician" : "Client"}: ${l.text}`).join("\n"));
  },
);

server.registerTool(
  "screen_risk",
  { title: "Risk screen (lexicon)", description: "Deterministic risk-language screen over a session's client lines (English + Hinglish). No model call.", inputSchema: { sessionId: z.string().regex(/^t\d{2}$/) }, annotations: { readOnlyHint: true } },
  async ({ sessionId }) => {
    const hits = lexiconScreen(parseTranscript(loadSample(sessionId).raw));
    return text(hits.length ? hits.map((h) => `${h.lineId} [${h.signal}] "${h.quote}"`).join("\n") : "No lexicon hits. (The full pipeline also runs a model classifier.)");
  },
);

server.registerTool(
  "run_followthrough",
  {
    title: "Run Followthrough",
    description: "Run the full pipeline on a sample session: risk screen, agent (note + proposed follow-ups), code verifier. Proposals only; nothing is sent. Needs ANTHROPIC_API_KEY.",
    inputSchema: { sessionId: z.string().regex(/^t\d{2}$/) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ sessionId }) => {
    const s = loadSample(sessionId);
    const r = await run({ clientId: s.clientId, transcript: s.raw });
    return text(
      JSON.stringify(
        { risk: { flagged: r.risk.flagged, lexicon: r.risk.lexicon }, note: r.note, actions: r.actions, verifier: { citation: r.citation, removed: r.removed, corrected: r.corrected } },
        null,
        2,
      ),
    );
  },
);

await server.connect(new StdioServerTransport());
