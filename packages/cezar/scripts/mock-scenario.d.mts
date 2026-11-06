export type PlaybackResult = 'handled' | 'continue';
export type Lifecycle = (call: [string, Record<string, unknown>]) => Promise<string>;
export interface ScenarioContext {
  runner: 'claude' | 'codex' | 'opencode' | 'pi' | 'omp' | 'cursor';
  lifecycle: Lifecycle;
  session: { resumeAfterAsk?: boolean; malformedFrame?: string };
  unsupported?: readonly string[];
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
  parts: (string | (() => string | void | Promise<string | void>))[];
  prepare?: boolean;
}
export interface ReasoningStep { kind: 'reasoning'; text: string; index?: number; complete?: boolean }
export interface ToolStep { kind: 'toolStart' | 'toolEnd'; call: ToolCall }
export interface ChildStep { kind: 'child'; id: string; phase: 'start' | 'end'; steps: Iterable<Step> }
export interface ReadSteersStep { kind: 'readSteers'; late?: boolean }
export interface EndStep { kind: 'end'; error?: 'provider' }
export type Step = OpenStep | TextStep | ReasoningStep | ToolStep | ChildStep | ReadSteersStep | EndStep
  | { kind: 'progress' }
  | { kind: 'sleep'; ms: number }
  | { kind: 'release'; fallbackMs: number; suffix?: string }
  | { kind: 'park'; prompt: string }
  | { kind: 'stall'; prompt: string };
export interface Scenario {
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
  progress(step: { kind: 'progress' }): void | Promise<void>;
  readSteers(step: ReadSteersStep): void | Promise<void>;
  end(step: EndStep): void | Promise<void>;
  closeInput?: () => void;
}
export function scenarioFor(prompt: string, context: ScenarioContext): Scenario | undefined;
export function play(scenario: Pick<Scenario, 'steps' | 'result'>, encoder: Encoder): PlaybackResult | Promise<PlaybackResult>;
export function afterParityPark(prompt: string): Promise<void>;
