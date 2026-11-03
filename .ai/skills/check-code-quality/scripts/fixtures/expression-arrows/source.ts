type X = { id: string }
export const single = (over: Partial<X> = {}): X => ({ id: 'r1', ...over }) as X
export const multi = (over: Partial<X> = {}): X =>
  ({ id: 'r1', ...over }) as unknown as X
export const unused = (over: Partial<X> = {}): X => ({ id: 'r1', ...over }) as X
