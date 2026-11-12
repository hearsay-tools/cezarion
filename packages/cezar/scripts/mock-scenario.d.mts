export type PlaybackResult = 'handled' | 'continue';
export type Lifecycle = (call: [string, Record<string, unknown>]) => Promise<string>;
export interface ScenarioContext {
  runner: 'claude' | 'codex' | 'opencode' | 'pi' | 'omp' | 'cursor';
  lifecycle: Lifecycle;
  toolPrompt(prompt: string): Promise<string>;
  ciPrompt(prompt: string): Promise<string>;
  crash(prompt: string): void | Promise<void>;
  session: { resumeAfterAsk?: boolean };
  unsupported?: readonly string[];
  nativeFailureControl?: boolean;
}
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output: string;
  isError: boolean;
}
export interface OpenStep {
  kind: 'open';
  ackOnly?: boolean;
  acknowledged?: boolean;
  agentStart?: boolean;
  agentStarted?: boolean;
}
export interface TextStep {
  kind: 'text';
  parts: (string | (() => string | Promise<string>))[];
}
export interface ReasoningStep { kind: 'reasoning'; text: string; index?: number; complete?: boolean }
export interface ToolStep { kind: 'toolStart' | 'toolEnd'; call: ToolCall }
export interface ChildStep { kind: 'child'; id: string; phase: 'start' | 'end'; steps: Iterable<Step> }
export interface ReadSteersStep { kind: 'readSteers'; late?: boolean; receive?: (texts: string[] | void) => void }
/** `provider`: a 400 request rejection, which fails the run. The others are provider errors the run holds on. */
export type ProviderFailureKind = 'provider' | 'unavailable' | 'rate-limit' | 'not-found' | 'credit';
export interface EndStep { kind: 'end'; error?: ProviderFailureKind }
export type Step = OpenStep | TextStep | ReasoningStep | ToolStep | ChildStep | ReadSteersStep | EndStep
  | { kind: 'effect'; run: () => void | Promise<unknown> }
  | { kind: 'reply'; prompt: string }
  | { kind: 'progress' }
  | { kind: 'sleep'; ms: number }
  | { kind: 'hold'; ms: number }
  | { kind: 'release'; fallbackMs: number; suffix?: string }
  | { kind: 'park'; prompt: string }
  | { kind: 'stall'; prompt: string };
export interface Scenario {
  variant?: 'cap' | 'cezar-ask-cap';
  name: string;
  beforeFailure: boolean;
  early?: boolean;
  steps: Iterable<Step>;
  result?: PlaybackResult;
}
export interface Encoder {
  open(step: OpenStep): void | Promise<void>;
  text(step: TextStep & { parts: string[] }): void | Promise<void>;
  reasoning(step: ReasoningStep): void | Promise<void>;
  toolStart(step: ToolStep): void | Promise<void>;
  toolEnd(step: ToolStep): void | Promise<void>;
  child(step: ChildStep, playChild: (encoder: Encoder) => PlaybackResult | Promise<PlaybackResult>): void | Promise<void>;
  /** This mock's own untokened reply, after open(), including its native turn end. */
  reply(step: { kind: 'reply'; prompt: string }): void | Promise<void>;
  progress(step: { kind: 'progress' }): void | Promise<void>;
  readSteers(step: ReadSteersStep): string[] | void | Promise<string[] | void>;
  end(step: EndStep): void | Promise<void>;
  /** A native steering hold; absent encoders sleep for ms. */
  hold?(step: { kind: 'hold'; ms: number }): void | Promise<void>;
  closeInput?: () => void;
}
export function scenarioFor(prompt: string, context: ScenarioContext): Scenario | undefined;
export function play(scenario: Pick<Scenario, 'steps' | 'result'>, encoder: Encoder): PlaybackResult | Promise<PlaybackResult>;
export function afterParityPark(prompt: string): Promise<void>;

export declare const PROVIDER_HOLD_SCENARIOS: readonly (readonly [string, Exclude<ProviderFailureKind, 'provider'>])[];
