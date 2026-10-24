export function withoutSessionContext<T>(text: T): T;
export function withoutSessionContextBody(body: string): string;
export function withoutSessionContextParts<T>(parts: T): T;
export function stripCommandMessage<T extends { message?: unknown }>(command: T): T;
export function rawMessage(command: { message?: unknown }): unknown;
