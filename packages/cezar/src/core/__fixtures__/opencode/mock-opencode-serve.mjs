#!/usr/bin/env node
// Test-only mock of `opencode serve` — speaks just enough of the HTTP+SSE
// API (§4 of agent-event-protocols.md) for the runner wiring test in
// `opencode-ui-mapper.test.ts`: POST /session, GET /event (SSE bus), one
// scripted prompt turn. Like the real server's `prompt_async`, the HTTP
// response resolves immediately — every part and the closing `session.idle`
// arrive over SSE afterwards, so a correct stream (v1 and v2 alike) must
// take its turn-end from `session.idle`, never from the HTTP response.
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const hostname = arg('--hostname', '127.0.0.1');
const port = Number(arg('--port', '0'));

const SESSION_ID = 'ses_mock_1';
const MESSAGE_ID = 'msg_mock_1';

let sse = null;
const send = (event) => {
  if (sse) sse.write(`data: ${JSON.stringify(event)}\n\n`);
};

/** Questions the runner can look up an id for. `replyQuestion`/`rejectQuestion`
 *  resolve the id through `GET /question` before answering (see
 *  `opencode-server-runner.ts`), so a native ask needs an entry here. */
const pendingQuestions = [];
let echoSerial = 0;
let lateQuestionReply = false;
let answerDone = false;

/** The question tool arrives as a `tool` part whose state.input holds it —
 *  the shape `opencode-server-runner.test.ts`'s sendQuestion helper drives. */
const sendQuestionPart = (input) =>
  send({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt_mock_question',
        messageID: MESSAGE_ID,
        sessionID: SESSION_ID,
        type: 'tool',
        callID: 'call_mock_question',
        tool: 'question',
        state: { status: 'running', input },
      },
    },
  });
const info = (extra) => ({
  id: MESSAGE_ID,
  sessionID: SESSION_ID,
  role: 'assistant',
  time: { created: 1760000000000 },
  modelID: 'mock-model',
  providerID: 'mock',
  mode: 'build',
  path: { cwd: '/repo', root: '/repo' },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  ...extra,
});

const server = createServer((req, res) => {
  const url = req.url ?? '';
  if (req.method === 'GET' && url === '/question') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(pendingQuestions));
    return;
  }
  if (req.method === 'GET' && url.startsWith('/event')) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    sse = res;
    send({ type: 'server.connected', properties: {} });
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (req.method === 'POST' && /^\/question\/[^/]+\/(reply|reject)$/.test(url)) {
      // Native question reply resumes the held turn, then its own session.idle
      // ends it (same SSE lifecycle shape as the baseline; never the HTTP ack).
      const answered = pendingQuestions.some(question => question.id === 'q_mock_1');
      pendingQuestions.length = 0;
      if (answered && url.endsWith('/reply')) setTimeout(() => {
        send({ type: 'message.part.updated', properties: { part: {
          id: 'prt_answer', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: `human answer: ${body}${answerDone ? '\n\nCEZ:DONE' : ''}`,
        } } });
        send({ type: 'session.idle', properties: { sessionID: SESSION_ID } });
      }, 30);
      const acknowledge = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); };
      if (lateQuestionReply) setTimeout(acknowledge, 250);
      else acknowledge();
      return;
    }
    if (req.method === 'POST' && url === '/session') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: SESSION_ID, title: 'cezar task' }));
      return;
    }
    if (
      req.method === 'POST' &&
      (url === `/session/${SESSION_ID}/prompt_async` || url === `/session/${SESSION_ID}/message`)
    ) {
      if (body.includes('mock:reject-agent-post')) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'agent prompt rejected' }));
        return;
      }
      // `prompt_async` semantics: acknowledge now, stream the turn over SSE.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ info: info({}), parts: [] }));
      // The raw body is enough to spot a `mock:` marker — the prompt text is
      // inside it whatever part shape the runner used to wrap it.
      if (body.includes('mock:agent-echo')) {
        send({ type: 'message.updated', properties: { info: info({}) } });
        send({ type: 'message.part.updated', properties: { part: {
          id: `prt_echo_${++echoSerial}`, messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text',
          text: JSON.parse(body).parts.map(part => part.text ?? '').join('\n'),
        } } });
        send({ type: 'session.idle', properties: { sessionID: SESSION_ID } });
        return;
      }
      if (body.includes('mock:subagent')) {
        // Wire shape from `__fixtures__/opencode/subtask-nested.ndjson`: a
        // `subtask` part on the parent message, then a child message whose info
        // carries `parentID`, its parts, and the CHILD's own `session.idle`.
        // That child idle arrives first on purpose — the parent turn has to
        // survive it and close only on its own (#5, #600; harness parity S9).
        send({ type: 'message.updated', properties: { info: info({}) } });
        send({ type: 'message.part.updated', properties: { part: {
          id: 'prt_mock_subt', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'subtask',
          prompt: 'Trace every caller of resolveSession', description: 'Trace resolveSession callers',
          agent: 'general',
        } } });
        send({ type: 'message.updated', properties: { info: {
          ...info({}), id: 'msg_mock_child', sessionID: 'ses_mock_child',
          parentID: SESSION_ID, mode: 'subagent',
        } } });
        send({ type: 'message.part.updated', properties: { part: {
          id: 'prt_mock_ctxt', messageID: 'msg_mock_child', sessionID: 'ses_mock_child',
          type: 'text', text: 'Two callers: router.ts and session.ts.',
          time: { start: 1760000008800, end: 1760000008900 },
        } } });
        send({ type: 'session.idle', properties: { sessionID: 'ses_mock_child' } });
        setTimeout(() => {
          send({ type: 'message.part.updated', properties: { part: {
            id: 'prt_mock_ptxt', messageID: MESSAGE_ID, sessionID: SESSION_ID,
            type: 'text', text: 'Still working after the sub-agent.',
            time: { start: 1760000009000, end: 1760000009200 },
          } } });
          send({ type: 'message.updated', properties: { info: info({
            cost: 0.0001, tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
          }) } });
          setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 30);
        }, 60);
        return;
      }
      if (body.includes('mock:provider-error')) {
        // The session-level error frame, wire shape copied verbatim from
        // `__fixtures__/opencode/session-error.ndjson`. #53: a bare upstream
        // rejection used to read like a missing executable, and the run parked
        // as "Needs You" rather than failing (harness parity S7).
        send({ type: 'message.updated', properties: { info: info({}) } });
        send({ type: 'message.part.updated', properties: { part: {
          id: 'prt_mock_perr', messageID: MESSAGE_ID, sessionID: SESSION_ID,
          type: 'text', text: 'Starting the review',
        } } });
        send({ type: 'session.error', properties: { sessionID: SESSION_ID, error: {
          name: 'ProviderAuthError',
          data: { message: 'API key expired — run `opencode auth login`' },
        } } });
        setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 30);
        return;
      }
      if (body.includes('mock:split-text')) {
        // OpenCode streams a text part as successive GROWING snapshots of the
        // same part id; only the final one carries `time.end`. A runner emitting
        // one v1 `text` per snapshot publishes the torn `…CEZ:` prefix, which is
        // #2 on opencode's wire (harness parity S8).
        const full = 'parity split text\n\nCEZ:MONITORING';
        send({ type: 'message.updated', properties: { info: info({}) } });
        for (const upto of [17, 24, full.length]) {
          send({ type: 'message.part.updated', properties: { part: {
            id: 'prt_mock_split', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text',
            text: full.slice(0, upto),
            ...(upto === full.length ? { time: { start: 1760000000500, end: 1760000000600 } } : {}),
          } } });
        }
        send({ type: 'message.updated', properties: { info: info({
          cost: 0.0001, tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }) } });
        setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 30);
        return;
      }
      if (body.includes('mock:ask-bad')) {
        // Malformed: `questions` is not an array, so the runner must REJECT the
        // native question and finish the turn rather than wait for an answer to
        // a card that can never render (#6's rejection path, harness parity R4).
        send({ type: 'message.updated', properties: { info: info({}) } });
        pendingQuestions.push({ id: 'q_mock_bad', sessionID: SESSION_ID });
        sendQuestionPart({ questions: 'not-an-array' });
        setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 60);
        return;
      }
      if (body.includes('mock:ask')) {
        lateQuestionReply = body.includes('mock:ask-reply-late');
        answerDone = body.includes('mock:ask-reply-late-done');
        // The native question tool (#6). No `session.idle` follows: a real ask
        // holds the turn open until the answer is routed back.
        send({ type: 'message.updated', properties: { info: info({}) } });
        pendingQuestions.push({ id: 'q_mock_1', sessionID: SESSION_ID });
        sendQuestionPart({ questions: [{
          header: 'Library',
          question: 'Which test library?',
          options: [
            { label: 'Vitest', description: 'Use the existing test runner' },
            { label: 'Node test', description: 'Use node:test' },
          ],
        }] });
        return;
      }
      if (body.includes('mock:done')) {
        // Declares the task complete so the run reaches cezar's review gate; a
        // markerless turn-end correctly parks as `waiting` instead (harness
        // parity R1).
        send({ type: 'message.updated', properties: { info: info({}) } });
        send({ type: 'message.part.updated', properties: { part: {
          id: 'prt_mock_done', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text',
          text: 'parity done: the task is complete\n\nCEZ:DONE',
          time: { start: 1760000000500, end: 1760000000600 },
        } } });
        send({ type: 'message.updated', properties: { info: info({
          cost: 0.0001, tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }) } });
        setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 30);
        return;
      }
      if (body.includes('mock:hold-ask')) {
        // Portable CEZ:ASK after a pause, so a mid-turn sendMessage can queue
        // and then race the park (run.ts must discard that waiter).
        setTimeout(() => {
          const ask = 'Pick one.\n\nCEZ:ASK {"questions":[{"header":"Library","question":"Which date library should I standardize on?","options":[{"label":"date-fns","description":"Tree-shakeable, functional"},{"label":"Luxon","description":"Immutable, tz-aware"}]}]}';
          send({ type: 'message.updated', properties: { info: info({}) } });
          send({ type: 'message.part.updated', properties: { part: {
            id: 'prt_mock_hold_ask', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text',
            text: ask,
            time: { start: 1760000000500, end: 1760000000600 },
          } } });
          send({ type: 'message.updated', properties: { info: info({
            cost: 0.0001, tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
          }) } });
          setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 30);
        }, 250);
        return;
      }
      if (body.includes('mock:hold')) {
        // The response above is the ack (this is the #4 wire: `prompt_async`
        // resolves immediately, the turn arrives over SSE afterwards). Holding
        // the content behind it is what makes harness parity S2 meaningful.
        setTimeout(() => {
          const held = 'parity hold: content after the pause';
          send({ type: 'message.updated', properties: { info: info({}) } });
          send({ type: 'message.part.updated', properties: { part: {
            id: 'prt_mock_hold', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: held,
          } } });
          send({ type: 'message.updated', properties: { info: info({
            cost: 0.0001, tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
          }) } });
          setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 30);
        }, 250);
        return;
      }
      send({ type: 'message.updated', properties: { info: info({}) } });
      send({
        type: 'message.part.updated',
        properties: {
          part: { id: 'prt_mock_t1', messageID: MESSAGE_ID, sessionID: SESSION_ID, type: 'text', text: 'Checking the working tree.' },
        },
      });
      send({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_mock_c1',
            messageID: MESSAGE_ID,
            sessionID: SESSION_ID,
            type: 'tool',
            callID: 'call_mock_1',
            tool: 'bash',
            state: { status: 'pending', input: { command: 'git status --short' }, raw: '{}' },
          },
        },
      });
      send({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_mock_c1',
            messageID: MESSAGE_ID,
            sessionID: SESSION_ID,
            type: 'tool',
            callID: 'call_mock_1',
            tool: 'bash',
            state: { status: 'running', input: { command: 'git status --short' }, title: 'git status --short', time: { start: 1760000000100 } },
          },
        },
      });
      send({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_mock_c1',
            messageID: MESSAGE_ID,
            sessionID: SESSION_ID,
            type: 'tool',
            callID: 'call_mock_1',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'git status --short' },
              output: ' M src/example.ts\n',
              title: 'git status --short',
              metadata: { exit: 0 },
              time: { start: 1760000000100, end: 1760000000400 },
            },
          },
        },
      });
      send({
        type: 'message.updated',
        properties: {
          info: info({ cost: 0.0021, tokens: { input: 1200, output: 300, reasoning: 0, cache: { read: 0, write: 0 } } }),
        },
      });
      setTimeout(() => {
        send({
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'prt_mock_t2',
              messageID: MESSAGE_ID,
              sessionID: SESSION_ID,
              type: 'text',
              text: 'Done.',
              time: { start: 1760000000500, end: 1760000000600 },
            },
          },
        });
      }, 30);
      setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 90);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});

server.listen(port, hostname, () => {
  // The runner reads the bound URL back from stdout, like the real server.
  console.log(`opencode server listening on http://${hostname}:${port}`);
});
process.on('SIGTERM', () => process.exit(0));
