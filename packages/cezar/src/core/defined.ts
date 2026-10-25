/** Keys with undefined values are absent from a JSON object, including in its type. */
export type Defined<T extends object> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Build a plain wire object without adding a branch for each optional field. */
export function defined<T extends object>(value: T): Defined<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Defined<T>;
}
