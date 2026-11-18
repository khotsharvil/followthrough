// Loads the synthetic dataset and gives every citable unit a stable id.
//   T:12          -> line 12 of the session transcript
//   H:c01-n03.2   -> sentence 2 of past note c01-n03
import fs from "node:fs";
import path from "node:path";

const DATA = path.join(process.cwd(), "data");

export type Constraints = {
  channel: string;
  doNotMention: string[];
  doNotContact: string[];
  quietHours: string | null;
  appointmentWindow?: string;
};
export type Note = { id: string; date: string; text: string };
export type Client = {
  id: string;
  name: string;
  age: number;
  city: string;
  clinician: string;
  service: string;
  presenting: string;
  preferences: string[];
  constraints: Constraints;
  notes: Note[];
};
export type Line = { id: string; speaker: "T" | "C"; text: string };
export type Chunk = { id: string; noteId: string; date: string; text: string };

let clientsCache: Client[] | null = null;
export function clients(): Client[] {
  if (!clientsCache) clientsCache = JSON.parse(fs.readFileSync(path.join(DATA, "clients.json"), "utf8")).clients;
  return clientsCache!;
}
export function getClient(id: string): Client {
  const c = clients().find((x) => x.id === id);
  if (!c) throw new Error(`Unknown client ${id}`);
  return c;
}

/** Numbered transcript lines. Lines starting with "#" are headers and are not citable. */
export function parseTranscript(raw: string): Line[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l, i) => {
      const m = l.match(/^([TC]):\s*(.*)$/);
      return { id: `T:${i + 1}`, speaker: (m?.[1] ?? "C") as "T" | "C", text: m ? m[2] : l };
    });
}

export function sampleIds(): string[] {
  return fs.readdirSync(path.join(DATA, "transcripts")).filter((f) => f.endsWith(".txt")).map((f) => f.replace(".txt", "")).sort();
}
export function loadSample(id: string): { raw: string; clientId: string; header: string } {
  const raw = fs.readFileSync(path.join(DATA, "transcripts", `${id}.txt`), "utf8");
  const header = raw.split(/\r?\n/)[0];
  const clientId = header.match(/client (c\d+)/)?.[1] ?? "c01";
  return { raw, clientId, header };
}

/** Past notes split into sentence chunks, so retrieval and citations are precise. */
export function historyChunks(client: Client): Chunk[] {
  return client.notes.flatMap((n) =>
    n.text
      .split(/(?<=[.!?])\s+(?=[A-Z'"])/)
      .filter(Boolean)
      .map((s, i) => ({ id: `H:${n.id}.${i + 1}`, noteId: n.id, date: n.date, text: s.trim() })),
  );
}

/** Everything a run may cite, keyed by id. */
export function sourceIndex(lines: Line[], chunks: Chunk[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of lines) m.set(l.id, `${l.speaker === "T" ? "Clinician" : "Client"}: ${l.text}`);
  for (const c of chunks) m.set(c.id, c.text);
  return m;
}
