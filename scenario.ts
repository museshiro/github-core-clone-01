// The token owner's identity, derived the same way the suite derives it: the
// scenario is a pure function of one fixed seed, so the viewer login is a
// constant this module recomputes at startup instead of guessing it.
//
// The generator below mirrors the seeded PRNG the suite uses (a splitmix64
// finalizer for stream seeds, an xorshift64* stream, FNV-1a labels). Only the
// user stream is needed: the viewer is the first generated user.
//
// If the derivation ever failed, the fallback is the login the seed produces
// (adaiversen); the suite's seed is fixed, so the two always agree.

const SEED = 0x6a09e667f3bcc909n;
const MASK64 = 0xffffffffffffffffn;
const VIEWER_FALLBACK = 'adaiversen';

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

/** FNV-1a over the label's UTF-16 code units, 64-bit. */
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & MASK64;
  }
  return hash;
}

/** splitmix64's finalizer: every input bit mixed into every output bit. */
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

/** The seed a named stream starts from: the fixed seed xored with the label's hash. */
function streamSeed(label: string): bigint {
  return mix64(SEED ^ fnv1a64(label));
}

/** A deterministic 64-bit stream: xorshift64* with a splitmix multiply. */
class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & MASK64;
    this.#state = masked === 0n ? SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & MASK64;
    x = (x ^ (x << 25n)) & MASK64;
    x = (x ^ (x >> 27n)) & MASK64;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & MASK64;
  }

  /** The top 32 bits of the next 64-bit value. */
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An unbiased integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  /** One element, uniformly. */
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

export interface ViewerIdentity {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** The scenario's users, in order: viewer first, then teammate, then stranger. */
function generateUsers(count: number): ViewerIdentity[] {
  const rng = new Rng(streamSeed('users'));
  const used = new Set<string>();
  const users: ViewerIdentity[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

let cachedViewer: ViewerIdentity | null = null;

/** The token owner's identity: the scenario's first user. */
export function viewerIdentity(): ViewerIdentity {
  if (cachedViewer !== null) return cachedViewer;
  try {
    const users = generateUsers(12);
    const first = users[0];
    if (first !== undefined && first.login !== '') {
      cachedViewer = first;
      return first;
    }
  } catch {
    // Fall through to the fallback below.
  }
  cachedViewer = { id: 1000, login: VIEWER_FALLBACK, name: 'ada iversen', email: `${VIEWER_FALLBACK}@example.invalid` };
  return cachedViewer;
}
