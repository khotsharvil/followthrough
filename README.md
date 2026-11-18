# Followthrough

**After a therapy session, Followthrough drafts the clinician's note and the follow-up work. It writes nothing it can't cite, sends nothing without the clinician's approval, and puts risk first.**

Live demo: **https://followthrough-amaha.vercel.app** · Evals: **/evals** · All data is synthetic.

Built by Sharvil Khot for Amaha's AI Engineer application, under the "your own idea" option.

---

## The problem

Amaha's brief names documentation, follow-ups and "surfacing the right thing at the right moment". A notes copilot that stops at the summary leaves the real admin untouched. After every session the clinician still has to:

- write up homework,
- message the client in their channel and language,
- book the next session or a psychiatry follow-up,
- tell the psychiatrist something (only if the client consented),
- act on any risk signal.

This happens from memory, between back-to-back sessions, and it's where things slip.

I spent the past year building Unclinq, a continuity-of-care product for therapists. Two lessons from that shaped this build:

1. **Clinicians don't trust an AI line they can't trace to its source.**
2. **An AI that acts on its own in a clinical setting is a liability.**

## What it does

0. **Session audio → transcript (optional).** Upload or record a session, or use the synthetic sample recording. Sarvam's Saaras model transcribes it with speaker diarization, in the original language, romanised, or translated to English. A small model labels which speaker is the clinician (with a question-count fallback), and the clinician can swap roles and fix misheard words before drafting. The audio is staged only for the length of the Sarvam job and then deleted.
1. **Risk screen first, and it can't be skipped.** A deterministic lexicon (English and romanised Hindi) and a small-model classifier (Claude Haiku 4.5) each check the client's lines. If *either* fires, the session is flagged. Only a clinician can clear a flag.
2. **The agent (Claude Sonnet 5.5, tool-calling)** does three things:
   - reads the client's profile and rules,
   - searches the client's past notes (agentic RAG over BM25),
   - writes a structured note and proposes follow-ups.

   Every line must cite a transcript line (`T:12`) or a past-note sentence (`H:c02-n05.4`), along with a verbatim quote.
3. **A verifier written in code, not the model, decides what reaches the clinician.** It:
   - checks that every cited id exists and the quote really appears in that source,
   - blocks diagnoses, diagnostic codes and medication advice,
   - enforces each client's rules: who must not be contacted, and what must not be mentioned in messages,
   - guarantees a flagged session always carries a risk action, listed first.

   Failures are removed and shown, never silently dropped. A genuine quote cited to the wrong line is re-pointed visibly.
4. **The clinician approves, edits or rejects** each proposal. Approved items go to a mock outbox. Nothing is ever sent.

```
[audio ─► Sarvam STT + diarization ─► clinician reviews transcript] ─►
transcript ─► risk screen (lexicon ∥ Haiku classifier) ─► agent loop (Sonnet 5.5)
                    │ either fires → flag                     tools: get_client_profile
                    ▼                                                search_history  (RAG)
               risk panel (first)                                    write_note
                                                                     propose_action  (propose only)
                                                          ─► verifier (code) ─► clinician approves ─► mock outbox
```

The same tools are exposed as an **MCP server** (`npm run mcp`), so Claude Desktop or any MCP client can search the records, screen a session, or run the whole pipeline.

## Evals (`npm run eval`)

The suite has 10 synthetic sessions:
- 3 with risk: passive suicidal thoughts in English, a "better off without me" disclosure, and a Hinglish session with drink-driving
- 1 trap: "this exam is killing me"
- 2 Hindi-English code-mixed sessions

Labels are in `data/labels.json`.

| Metric | Result |
|---|---|
| Risk sessions caught | **3 / 3** |
| False alarms on clean sessions | **0 / 7** |
| Lines cited correctly, as the model wrote them | **148 / 149** (the 1 misquote was removed by the verifier) |
| Unsupported lines reaching the clinician | **0** (by construction) |
| Client-rule violations in messages | **0** |
| Expected follow-ups proposed | **24 / 25** |
| Cost per session | **~$0.045** |
| Run time | ~15–20 s per session (~24 s median with 3 running in parallel) |

**Evals caught bugs in my own safety layer, not just in the model:**
- The do-not-contact rule blocked a WhatsApp message the agent had correctly addressed to "client only, not wife". It saw the word "wife" and ignored the negation. Fixed, with a test.
- The "don't mention the manager" check was flagging the clinician's *internal* note that recorded the rule. Rules about what the client sees now apply to client messages only.

**Honest limits:** 10 sessions is a smoke test, not a benchmark. I wrote the labels myself, and follow-up matching is keyword-based. Model output varies from run to run, so numbers shift by a line or two between runs.

## Decisions I'd defend

| Decision | Why |
|---|---|
| The verifier is code, not a second model | A model checking a model fails in correlated ways. String matching against the source can't be talked out of its answer. |
| Tools only *propose* | In care, the cost of a wrong automatic action (a message to the wrong person, a missed escalation) is far higher than one extra click. |
| Risk screen runs before the agent, with "either fires" | A missed risk is the worst failure, so I trade some false alarms for recall. Two independent detectors fail differently. |
| BM25, not embeddings, for now | Short clinical sentences, a small corpus, no extra vendor, and every hit is explainable. The `search_history` tool hides the method, so embeddings can be swapped in. |
| The clinician reviews the transcript before drafting | Speech recognition mishears (in the sample, "walks" became "works"). Notes cite transcript lines, so the lines should be right first. |
| Sarvam for speech | Built for Indian languages and code-mixed speech, with diarization in its batch API. I used it in production at Unclinq. |
| Small model to screen, larger model to reason | The same cost split I used in Unclinq: the cheap classifier runs on every session, the agent only where reasoning is needed. |
| Client rules live in data and are enforced in code | "Don't contact my wife" shouldn't depend on a prompt being followed. |

## Where I'd take it next at Amaha

1. **Clinician-labelled evals.** Clinicians write the labels, and the set grows with adversarial sessions built to slip past the risk screen.
2. **Plug into real workflows.** Proposals become tasks in the actual booking and messaging systems, behind the same approval step, through MCP or integrations.
3. **Handoffs between services.** The same cited-brief pattern for a therapist → psychiatrist referral, or a hospital discharge → outpatient therapist, where context gets lost today.
4. **More languages.** Retrieval and the risk lexicon extended to more Indian languages, with each language's risk phrases reviewed by clinicians.

## Run it

```bash
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
echo "SARVAM_API_KEY=..." >> .env   # only for the audio path
npm test            # 15 unit tests (safety layer + audio handling), no API key needed
npm run eval        # full pipeline on all 10 sessions (≈ $0.45)
npm run dev         # http://localhost:3000
npm run mcp         # MCP server over stdio
npm run sample-audio  # regenerate the synthetic sample recording (needs SARVAM_API_KEY)
```

Stack: TypeScript, Next.js (Vercel), `@anthropic-ai/sdk`, `sarvamai` (Saaras speech-to-text, Bulbul voices for the synthetic sample), `@modelcontextprotocol/sdk`, Zod.

Privacy: pasted transcripts are processed in memory and never stored, server logs hold only ids and timings, and the API key stays server-side.

**Synthetic data:** the sample recording is transcript t03 voiced by two Sarvam text-to-speech voices. Every client, clinician and session in `data/` is fictional and written for this demo. No real people, and nothing from any real product or user research.
