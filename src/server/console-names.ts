export const CONSOLE_NAMES = [
  'Ada',
  'Bex',
  'Cy',
  'Dax',
  'Eli',
  'Fay',
  'Gus',
  'Hal',
  'Ivy',
  'Jo',
  'Kai',
  'Leo',
  'Mia',
  'Nia',
  'Otto',
  'Pip',
  'Quin',
  'Rex',
  'Sol',
  'Tia',
  'Uma',
  'Vic',
  'Wren',
  'Xan',
  'Yui',
  'Zed',
];

// First free name from the list; once all are taken, cycle again with a suffix (Ada 2, Bex 2, ...)
export function pickConsoleName(used: Iterable<string>): string {
  const taken = new Set([...used].map((name) => name.trim().toLowerCase()));
  for (let round = 1; ; round++) {
    for (const base of CONSOLE_NAMES) {
      const name = round === 1 ? base : `${base} ${round}`;
      if (!taken.has(name.toLowerCase())) return name;
    }
  }
}
