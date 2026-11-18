"use client";
import { useRef, useState } from "react";

type Utterance = { speaker: number; text: string; start: number; end: number };
type Stt = { utterances: Utterance[]; roles: Record<number, "T" | "C">; roleMethod: string; languageCode: string | null; durationSec: number; ms: number };
type Person = { id: string; name: string };

const MAX = 4 * 1024 * 1024;

export default function AudioPanel({
  clients,
  clientId,
  setClientId,
  onRun,
  running,
}: {
  clients: Person[];
  clientId: string;
  setClientId: (id: string) => void;
  onRun: (transcript: string) => void;
  running: boolean;
}) {
  const [source, setSource] = useState<"sample" | "file" | "record">("sample");
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState("transcribe");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stt, setStt] = useState<Stt | null>(null);
  const [roles, setRoles] = useState<Record<number, "T" | "C">>({});
  const [draft, setDraft] = useState("");
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const build = (us: Utterance[], r: Record<number, "T" | "C">) =>
    ["# Transcribed from audio by Sarvam (Saaras). Reviewed by the clinician before drafting.", ...us.map((u) => `${r[u.speaker] ?? "C"}: ${u.text}`)].join("\n");

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
      const r = new MediaRecorder(stream, { mimeType: mime || undefined, audioBitsPerSecond: 24000 });
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: r.mimeType || "audio/webm" });
        setFile(new File([blob], `recording.${(r.mimeType || "audio/webm").includes("mp4") ? "m4a" : "webm"}`, { type: blob.type }));
      };
      r.start(1000);
      rec.current = r;
      setRecording(true);
      setElapsed(0);
      timer.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } catch {
      setError("Microphone access was blocked.");
    }
  }
  function stopRecording() {
    rec.current?.stop();
    setRecording(false);
    if (timer.current) clearInterval(timer.current);
  }

  async function doTranscribe() {
    setError(null);
    setStt(null);
    const fd = new FormData();
    fd.set("mode", mode);
    if (source === "sample") fd.set("sample", "t03");
    else {
      if (!file) return setError(source === "record" ? "Record something first." : "Choose an audio file first.");
      if (file.size > MAX) return setError("Audio is over 4 MB. Use a shorter clip or MP3/M4A/WebM.");
      fd.set("file", file);
    }
    setBusy(true);
    try {
      const res = await fetch("/api/transcribe", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Transcription failed");
      setStt(data);
      setRoles(data.roles);
      setDraft(build(data.utterances, data.roles));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function swapRoles() {
    if (!stt) return;
    const r = Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, v === "T" ? "C" : "T"])) as Record<number, "T" | "C">;
    setRoles(r);
    setDraft(build(stt.utterances, r));
  }

  return (
    <>
      <select value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Client">
        {clients.map((c) => <option key={c.id} value={c.id}>{c.id} · {c.name}</option>)}
      </select>
      <div className="tabs" style={{ marginTop: 10 }}>
        <button className={source === "sample" ? "on" : ""} onClick={() => { setSource("sample"); setClientId("c02"); }}>Sample recording</button>
        <button className={source === "file" ? "on" : ""} onClick={() => setSource("file")}>Upload</button>
        <button className={source === "record" ? "on" : ""} onClick={() => setSource("record")}>Record</button>
      </div>

      {source === "sample" && (
        <>
          <audio controls src="/samples/t03-session.mp3" style={{ width: "100%" }} />
          <p className="meta">Synthetic session t03 voiced by two Sarvam Bulbul voices (clinician and client, 1:52).</p>
        </>
      )}
      {source === "file" && (
        <>
          <input type="file" accept="audio/*,.mp3,.m4a,.wav,.webm,.ogg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <p className="meta">Up to 4 MB (about 10+ minutes as MP3). Synthetic or consented audio only.</p>
        </>
      )}
      {source === "record" && (
        <div className="row">
          {!recording ? <button className="btn ghost" onClick={startRecording}>● Record</button> : <button className="btn" onClick={stopRecording}>■ Stop ({elapsed}s)</button>}
          {file && !recording && <span className="meta" style={{ marginTop: 0 }}>Recorded {(file.size / 1024).toFixed(0)} KB</span>}
        </div>
      )}

      <div className="row" style={{ marginTop: 10 }}>
        <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Transcript script" style={{ width: "auto", flex: 1 }}>
          <option value="transcribe">Original language and script</option>
          <option value="translit">Romanised (Hinglish in Latin script)</option>
          <option value="translate">Translate to English</option>
        </select>
        <button className="btn" onClick={doTranscribe} disabled={busy || recording}>{busy ? "Transcribing…" : "Transcribe"}</button>
      </div>
      {busy && <p className="meta">Sarvam is transcribing and separating speakers. Usually under a minute for a short session.</p>}
      {error && <p className="error" style={{ marginTop: 10 }}>{error}</p>}

      {stt && (
        <div style={{ marginTop: 12 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="meta" style={{ marginTop: 0 }}>
              {stt.utterances.length} turns · {stt.languageCode ?? "language unknown"} · {(stt.ms / 1000).toFixed(0)}s · speakers labelled by {stt.roleMethod}
            </span>
            <button className="btn ghost" style={{ padding: "4px 10px", fontSize: 13 }} onClick={swapRoles}>Swap clinician / client</button>
          </div>
          <p className="meta">Check the transcript before drafting. Fix any misheard words; the note will cite these exact lines.</p>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} style={{ marginTop: 6, minHeight: 260 }} aria-label="Transcript review" />
          <button className="btn" style={{ marginTop: 8 }} disabled={running || !draft.trim()} onClick={() => onRun(draft)}>{running ? "Drafting…" : "Draft note and follow-ups"}</button>
        </div>
      )}
    </>
  );
}
