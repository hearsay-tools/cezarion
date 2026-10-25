import type { JSONParsed } from 'hono/utils/types';

/** Only broad catchalls are outside the parity guard; named fields remain intact. */
type NamedFields<T> = T extends readonly unknown[]
  ? { [K in keyof T]: NamedFields<T[K]> }
  : T extends object
    ? { [K in keyof T as string extends K ? never : number extends K ? never : K]: NamedFields<T[K]> }
    : T;

type Mutual<A, B> = [A] extends [B]
  ? ([B] extends [A] ? true : 'route-is-wider')
  : 'schema-is-wider';

/** Both sides describe JSON, without broad index signatures masking named-field errors. */
export type WireExact<Schema, Route> = Mutual<NamedFields<JSONParsed<Schema>>, NamedFields<Route>>;

type Assert<T extends true> = T;
type Schema = { id: string; label?: string | undefined };
type Wire = { id: string; label?: string | undefined };
type _Same = Assert<WireExact<Schema, Wire>>;
// @ts-expect-error The schema does not promise the route's added required key.
type _Added = Assert<WireExact<Schema, Wire & { added: number }>>;
// @ts-expect-error The route must retain the schema's required key.
type _Dropped = Assert<WireExact<Schema, { label?: string }>>;
// @ts-expect-error Optional and required keys remain different on the wire.
type _Required = Assert<WireExact<Schema, { id: string; label: string }>>;
// @ts-expect-error The projection must retain field value types.
type _Changed = Assert<WireExact<Schema, { id: number; label?: string }>>;

type OpenSchema = { nested: Schema & { [key: string]: unknown } };
type OpenWire = { nested: Wire & { [key: string]: unknown } };
type _OpenSame = Assert<WireExact<OpenSchema, OpenWire>>;
// @ts-expect-error A catchall cannot hide a new required named key.
type _OpenAdded = Assert<WireExact<OpenSchema, { nested: OpenWire['nested'] & { added: number } }>>;
// @ts-expect-error A catchall cannot replace a required named key.
type _OpenDropped = Assert<WireExact<OpenSchema, { nested: { label?: string; [key: string]: unknown } }>>;
// @ts-expect-error A catchall cannot change the value of a named key.
type _OpenChanged = Assert<WireExact<OpenSchema, { nested: { id: number; label?: string; [key: string]: unknown } }>>;
// @ts-expect-error A catchall cannot turn an optional named key into a required key.
type _OpenRequired = Assert<WireExact<OpenSchema, { nested: { id: string; label: string; [key: string]: unknown } }>>;
