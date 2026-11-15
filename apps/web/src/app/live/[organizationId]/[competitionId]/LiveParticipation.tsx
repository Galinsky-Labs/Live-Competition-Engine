"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { describeError, useApi, type ApiResult } from "./api-client";
import styles from "./live.module.css";
import { VotingPanel } from "./VotingPanel";

const reactionKinds = ["applause", "heart", "star", "wow", "laugh"] as const;

type Message = { id: string; body: string | null; status: string; createdAt: string };
type Question = { id: string; body: string; status: string; upvoteCount: number; mine?: boolean };
type Poll = {
  id: string; question: string; status: string; acceptingVotes: boolean;
  options: { id: string; label: string }[];
  results: { optionId: string; votes: number }[] | null;
  myOptionId?: string | null;
};

export function LiveParticipation({ organizationId, competitionId }: { organizationId: string; competitionId: string }) {
  const base = `/api/organizations/${organizationId}/competitions/${competitionId}`;
  const [token, setToken] = useState("");
  const [status, setStatus] = useState("");
  const [terms, setTerms] = useState<string | null>(null);
  const [performanceId, setPerformanceId] = useState("");
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [questions, setQuestions] = useState<Question[]>([]);
  const [questionDraft, setQuestionDraft] = useState("");
  const [polls, setPolls] = useState<Poll[]>([]);
  const api = useApi(token);

  useEffect(() => {
    // Hosts may hand the token over in the URL fragment (never sent to the server).
    const match = /(?:^|[#&])token=([A-Za-z0-9_-]{43})/.exec(window.location.hash);
    if (match?.[1]) {
      setToken(match[1]);
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!token) return;
    const [settings, chat, qs, ps] = await Promise.all([
      api(`${base}/audience/settings`), api(`${base}/audience/chat`), api(`${base}/audience/questions`), api(`${base}/audience/polls`)
    ]);
    if (settings.ok) setTerms(String(settings.body.termsVersion));
    if (chat.ok) setMessages((chat.body.messages as Message[]) ?? []);
    if (qs.ok) setQuestions((qs.body.questions as Question[]) ?? []);
    if (ps.ok) setPolls((ps.body.polls as Poll[]) ?? []);
    if (!settings.ok) setStatus(describeError(settings));
  }, [api, base, token]);

  useEffect(() => { void refresh(); }, [refresh]);

  const report = (result: ApiResult, success: string) => {
    setStatus(result.ok ? success : describeError(result));
    return result.ok;
  };

  const accept = async () => {
    if (report(await api(`${base}/audience/consent`, "POST", { termsVersion: terms }), "Terms accepted. Welcome!")) await refresh();
  };

  const react = async (kind: string) => {
    const result = await api(`${base}/audience/reactions`, "POST", { performanceId, kind });
    if (report(result, `Sent ${kind}.`)) setCounts(result.body.counts as Record<string, number>);
  };

  const sendChat = async (event: FormEvent) => {
    event.preventDefault();
    if (report(await api(`${base}/audience/chat`, "POST", { body: draft }), "Message sent.")) {
      setDraft("");
      await refresh();
    }
  };

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    if (report(await api(`${base}/audience/questions`, "POST", { body: questionDraft }), "Question submitted.")) {
      setQuestionDraft("");
      await refresh();
    }
  };

  const upvote = async (id: string) => {
    if (report(await api(`${base}/audience/questions/${id}/upvote`, "POST"), "Upvoted.")) await refresh();
  };

  const vote = async (pollId: string, optionId: string) => {
    if (report(await api(`${base}/audience/polls/${pollId}/votes`, "POST", { optionId }), "Vote recorded.")) await refresh();
  };

  return (
    <div className={styles.stack}>
      <section aria-labelledby="access-heading" className={styles.card}>
        <h2 id="access-heading">Access</h2>
        <label htmlFor="token">Access token supplied by your host</label>
        <input id="token" type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value.trim())} />
        <p role="status" aria-live="polite" className={styles.status}>{status}</p>
      </section>

      <section aria-labelledby="terms-heading" className={styles.card}>
        <h2 id="terms-heading">Audience terms</h2>
        {terms ? <p>Current terms version: <strong>{terms}</strong></p> : <p>Terms are not available yet.</p>}
        <button type="button" onClick={accept} disabled={!token || !terms}>I accept the audience terms</button>
      </section>

      <section aria-labelledby="reactions-heading" className={styles.card}>
        <h2 id="reactions-heading">Reactions</h2>
        <label htmlFor="performance">Performance identifier</label>
        <input id="performance" value={performanceId} onChange={event => setPerformanceId(event.target.value.trim())} />
        <div role="group" aria-label="Send a reaction" className={styles.row}>
          {reactionKinds.map(kind => (
            <button key={kind} type="button" onClick={() => react(kind)} disabled={!token || !performanceId}>{kind}</button>
          ))}
        </div>
        {counts ? (
          <dl className={styles.counts}>
            {reactionKinds.map(kind => (<div key={kind}><dt>{kind}</dt><dd>{counts[kind] ?? 0}</dd></div>))}
          </dl>
        ) : null}
      </section>

      <section aria-labelledby="chat-heading" className={styles.card}>
        <h2 id="chat-heading">Chat</h2>
        <ol className={styles.list} aria-label="Recent messages">
          {messages.map(message => (
            <li key={message.id}>{message.body ?? <em>removed</em>}{message.status !== "visible" ? ` (${message.status})` : ""}</li>
          ))}
        </ol>
        <form onSubmit={sendChat}>
          <label htmlFor="chat-input">Message</label>
          <input id="chat-input" value={draft} maxLength={1000} onChange={event => setDraft(event.target.value)} />
          <button type="submit" disabled={!token || !draft.trim()}>Send</button>
        </form>
      </section>

      <section aria-labelledby="questions-heading" className={styles.card}>
        <h2 id="questions-heading">Questions</h2>
        <ul className={styles.list}>
          {questions.map(question => (
            <li key={question.id}>
              {question.body} <span>({question.upvoteCount} upvotes, {question.status})</span>{" "}
              {question.status === "open" ? (
                <button type="button" onClick={() => upvote(question.id)} aria-label={`Upvote: ${question.body}`}>Upvote</button>
              ) : null}
            </li>
          ))}
        </ul>
        <form onSubmit={ask}>
          <label htmlFor="question-input">Your question</label>
          <input id="question-input" value={questionDraft} maxLength={300} onChange={event => setQuestionDraft(event.target.value)} />
          <button type="submit" disabled={!token || questionDraft.trim().length < 3}>Ask</button>
        </form>
      </section>

      <section aria-labelledby="polls-heading" className={styles.card}>
        <h2 id="polls-heading">Polls</h2>
        {polls.length === 0 ? <p>No polls right now.</p> : null}
        {polls.map(poll => (
          <fieldset key={poll.id} className={styles.fieldset}>
            <legend>{poll.question}</legend>
            {poll.options.map(option => {
              const votes = poll.results?.find(row => row.optionId === option.id)?.votes;
              return (
                <div key={option.id} className={styles.row}>
                  <button type="button" onClick={() => vote(poll.id, option.id)}
                    disabled={!token || !poll.acceptingVotes || Boolean(poll.myOptionId)}
                    aria-pressed={poll.myOptionId === option.id}>
                    {option.label}
                  </button>
                  {votes !== undefined ? <span>{votes} votes</span> : null}
                </div>
              );
            })}
            {!poll.acceptingVotes ? <p>Voting is closed.</p> : null}
          </fieldset>
        ))}
      </section>

      <VotingPanel base={base} token={token} onStatus={setStatus} />
    </div>
  );
}
