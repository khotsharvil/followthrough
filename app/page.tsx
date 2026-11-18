import { clients, loadSample, sampleIds } from "@/lib/data";
import Workbench from "./Workbench";

export default function Home() {
  const samples = sampleIds().map((id) => {
    const s = loadSample(id);
    return { id, clientId: s.clientId, header: s.header.replace(/^#\s*/, ""), raw: s.raw };
  });
  const people = clients().map(({ notes, ...c }) => ({ ...c, noteCount: notes.length }));
  return (
    <>
      <header className="top">
        <div className="brand">
          Followthrough<span>.</span> <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>post-session notes and follow-ups, risk first</span>
        </div>
        <nav>
          <a href="/evals">Evals</a>
          <a href="https://github.com/khotsharvil/followthrough" target="_blank" rel="noopener">GitHub</a>
        </nav>
      </header>
      <div className="banner">All clients, clinicians and sessions here are synthetic. Nothing is sent or booked: approved actions go to a mock outbox.</div>
      <Workbench samples={samples} clients={people} />
    </>
  );
}
