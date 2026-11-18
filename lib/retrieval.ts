// BM25 over a client's past-note chunks. Small, transparent, no extra API key.
// Embeddings can replace this behind the same search() signature.
import type { Chunk } from "./data";

const STOP = new Set(
  "a an and are as at be but by for from has have he her his i in is it its me my of on or our she that the their them they this to was we were what when which who will with you your".split(" "),
);
export const tokenize = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9ऀ-ॿ\s]/g, " ").split(/\s+/).filter((t) => t && !STOP.has(t));

export function search(chunks: Chunk[], query: string, k = 5, k1 = 1.4, b = 0.75) {
  const docs = chunks.map((c) => tokenize(c.text));
  const avg = docs.reduce((s, d) => s + d.length, 0) / Math.max(docs.length, 1);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const q = [...new Set(tokenize(query))];
  const N = docs.length;
  return chunks
    .map((c, i) => {
      const d = docs[i];
      let score = 0;
      for (const t of q) {
        const f = d.filter((x) => x === t).length;
        if (!f) continue;
        const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
      }
      return { ...c, score: Math.round(score * 100) / 100 };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
