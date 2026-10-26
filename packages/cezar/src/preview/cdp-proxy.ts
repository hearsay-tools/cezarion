import type { CdpConnection, CdpMessage } from './cdp.ts';

/**
 * One agent connection to the task's Chromium (hearsay-tools/cezarion#784, spec
 * 2026-10-26-preview-agent-cdp). Chromium has no debug port, only cezar's pipe; each agent socket
 * gets its own browser session on that pipe (`Target.attachToBrowserTarget`), so its Target domain
 * state, its ids and its events stay apart from cezar's own page session and from other agents.
 *
 * - A message without `sessionId` is the agent's root: it goes to its browser session.
 * - A message naming a session goes through only when this link opened that session.
 * - Replies and events come back in the order the browser sent them, the browser session's without
 *   a `sessionId`, as a client of a root WebSocket expects.
 * - Commands that would end the owner's browser or the page the pane streams are refused.
 */

/** The agent's side of the link: an open WebSocket, as the proxy route hands it over. */
export type AgentClient = {
  send(text: string): void;
  close(code: number, reason: string): void;
};

/** End the browser for everyone: the owner's pane and every other agent share it. */
const BROWSER_ENDING = new Set(['Browser.close', 'Browser.crash', 'Browser.crashGpuProcess']);
/** Commands that close a target or a session given in their params. */
const CLOSES_TARGET = new Set(['Target.closeTarget']);
const CLOSES_PAGE = new Set(['Page.close']);
/** JSON-RPC's code for a request the server will not run: CDP uses it for unknown sessions too. */
const REFUSED_CODE = -32000;

type Attached = { sessionId?: unknown; targetInfo?: { targetId?: unknown } };

export class AgentCdpLink {
  /** Child sessions this link opened, each with the target it is attached to. */
  private readonly owned = new Map<string, string | undefined>();
  private readonly offEvent: () => void;
  private closed = false;

  private constructor(
    private readonly connection: CdpConnection,
    private readonly client: AgentClient,
    private readonly browserSession: string,
    private readonly protectedTargetId: string | undefined,
    private readonly onClose: () => void,
  ) {
    this.offEvent = connection.onEvent(msg => this.fromBrowser(msg));
    void connection.closed.then(() => this.close(1011, 'The preview browser exited'));
  }

  /**
   * Opens the agent's browser session. `protectedTargetId` is the page the owner's pane streams:
   * the agent may drive it but not close it. Rejects when the browser refuses the session.
   */
  static async open(connection: CdpConnection, client: AgentClient, opts: { protectedTargetId?: string | undefined; onClose?: () => void } = {}): Promise<AgentCdpLink> {
    const reply = await connection.call('Target.attachToBrowserTarget', {}, undefined);
    const sessionId = (reply.result as { sessionId?: unknown } | undefined)?.sessionId;
    if (reply.error || typeof sessionId !== 'string') throw new Error(`Target.attachToBrowserTarget: ${reply.error?.message ?? 'no session'}`);
    return new AgentCdpLink(connection, client, sessionId, opts.protectedTargetId, opts.onClose ?? (() => {}));
  }

  /** One message from the agent's socket. */
  fromClient(text: string): void {
    if (this.closed) return;
    let msg: CdpMessage;
    try {
      msg = JSON.parse(text) as CdpMessage;
    } catch {
      return;
    }
    if (typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
    const { id, method } = msg;
    const named = typeof msg.sessionId === 'string' ? msg.sessionId : undefined;
    const reply = (body: Pick<CdpMessage, 'result' | 'error'>) => this.deliver({ id, ...body, ...(named ? { sessionId: named } : {}) });
    if (named !== undefined && !this.owned.has(named)) return reply({ error: { code: REFUSED_CODE, message: 'Session with given id not found.' } });
    const refusal = this.refusal(method, msg.params, named);
    if (refusal) return reply({ error: { code: REFUSED_CODE, message: refusal } });
    this.connection.request(method, msg.params ?? {}, named ?? this.browserSession, answer => {
      if (method === 'Target.attachToTarget' && !answer.error) this.adopt(answer.result as Attached | undefined, (msg.params as { targetId?: unknown } | undefined)?.targetId);
      if (method === 'Target.detachFromTarget' && !answer.error) this.forget((msg.params as { sessionId?: unknown } | undefined)?.sessionId);
      reply(answer.error ? { error: answer.error } : { result: answer.result ?? {} });
    });
  }

  /** The agent's socket closed, or the link is closing it: the browser session goes, and with it every child. */
  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    this.offEvent();
    this.connection.request('Target.detachFromTarget', { sessionId: this.browserSession }, undefined, () => {});
    this.client.close(code, reason);
    this.onClose();
  }

  private refusal(method: string, params: unknown, named: string | undefined): string | undefined {
    if (BROWSER_ENDING.has(method)) return `cezar refuses ${method}: the owner's preview pane shares this browser.`;
    const p = (params ?? {}) as { targetId?: unknown; sessionId?: unknown };
    if (CLOSES_TARGET.has(method) && this.protectedTargetId !== undefined && p.targetId === this.protectedTargetId) {
      return `cezar refuses ${method} on the page the owner's preview pane shows.`;
    }
    if (CLOSES_PAGE.has(method) && named !== undefined && this.owned.get(named) === this.protectedTargetId && this.protectedTargetId !== undefined) {
      return `cezar refuses ${method} on the page the owner's preview pane shows.`;
    }
    // Only this link's sessions: a foreign id could be cezar's own page session.
    if (method === 'Target.detachFromTarget' && typeof p.sessionId === 'string' && !this.owned.has(p.sessionId)) {
      return 'Session with given id not found.';
    }
    return undefined;
  }

  private fromBrowser(msg: CdpMessage): void {
    if (this.closed || typeof msg.sessionId !== 'string') return;
    const own = msg.sessionId === this.browserSession;
    if (!own && !this.owned.has(msg.sessionId)) return;
    if (msg.method === 'Target.attachedToTarget') this.adopt(msg.params as Attached | undefined, undefined);
    if (msg.method === 'Target.detachedFromTarget') this.forget((msg.params as { sessionId?: unknown } | undefined)?.sessionId);
    if (own) {
      const { sessionId: _browserSession, ...rest } = msg;
      this.deliver(rest);
    } else {
      this.deliver(msg);
    }
  }

  private adopt(attached: Attached | undefined, targetId: unknown): void {
    if (typeof attached?.sessionId !== 'string') return;
    const target = attached.targetInfo?.targetId ?? targetId;
    this.owned.set(attached.sessionId, typeof target === 'string' ? target : undefined);
  }

  private forget(sessionId: unknown): void {
    if (typeof sessionId === 'string') this.owned.delete(sessionId);
  }

  private deliver(msg: CdpMessage): void {
    if (this.closed) return;
    try {
      this.client.send(JSON.stringify(msg));
    } catch {
      this.close(1011, 'The agent socket failed');
    }
  }
}
