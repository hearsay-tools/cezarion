/** A stable live facade. Its callback receives the facade, never the backing map. */
export class ReadonlyMapView<K, V> implements ReadonlyMap<K, V> {
  #map: Map<K, V>;
  constructor(map: Map<K, V>) { this.#map = map; Object.freeze(this); }
  get size(): number { return this.#map.size; }
  get(key: K): V | undefined { return this.#map.get(key); }
  has(key: K): boolean { return this.#map.has(key); }
  entries(): MapIterator<[K, V]> { return this.#map.entries(); }
  keys(): MapIterator<K> { return this.#map.keys(); }
  values(): MapIterator<V> { return this.#map.values(); }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.entries(); }
  forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.#map.forEach((value, key) => callback.call(thisArg, value, key, this));
  }
}

export class ReadonlySetView<T> implements ReadonlySet<T> {
  #set: Set<T>;
  constructor(set: Set<T>) { this.#set = set; Object.freeze(this); }
  get size(): number { return this.#set.size; }
  has(value: T): boolean { return this.#set.has(value); }
  entries(): SetIterator<[T, T]> { return this.#set.entries(); }
  keys(): SetIterator<T> { return this.#set.keys(); }
  values(): SetIterator<T> { return this.#set.values(); }
  [Symbol.iterator](): SetIterator<T> { return this.values(); }
  forEach(callback: (value: T, key: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    this.#set.forEach((value) => callback.call(thisArg, value, value, this));
  }
}

for (const type of [ReadonlyMapView, ReadonlySetView]) {
  Object.freeze(type.prototype);
  Object.freeze(type);
}
