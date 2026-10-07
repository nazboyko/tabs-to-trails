/**
 * Number guard: every number in a rewrite must already be in its source.
 * The source side is generous (number words count, parts of times and
 * ranges count), so a flag means the model wrote a number the source lacks.
 */

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 };
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
  tenth: 10, eleventh: 11, twelfth: 12, twentieth: 20, hundredth: 100,
};
const OTHER: Record<string, number> = { twice: 2, dozen: 12, half: 50 };

const NUMBER = /\d+(?:[.,:]\d+)*/g;

function normalize(token: string): string[] {
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(token)) token = token.replace(/,/g, '');
  const pieces = token.split(',');
  return pieces.flatMap((p) => {
    if (p === '') return [];
    if (/^\d+\.\d+$/.test(p)) {
      const [i, d] = p.split('.') as [string, string];
      const dec = d.replace(/0+$/, '');
      const int = i.replace(/^0+(?=\d)/, '');
      return [dec ? `${int}.${dec}` : int];
    }
    if (/^\d+$/.test(p)) return [p.replace(/^0+(?=\d)/, '')];
    return [p];
  });
}

/** Numbers written with digits, normalized ("1,000" -> "1000", "3.50" -> "3.5"). */
export function digitNumbers(text: string): string[] {
  return (text.match(NUMBER) ?? []).flatMap(normalize);
}

/** Values of spelled-out numbers ("twenty-five", "two hundred", "third"). */
export function wordNumbers(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const found: number[] = [];
  let current: number | null = null;
  let total = 0;
  const flush = () => {
    if (current !== null || total > 0) found.push(total + (current ?? 0));
    current = null;
    total = 0;
  };
  for (const w of words) {
    if (w in UNITS) {
      if (current !== null && current % 10 !== 0) flush();
      current = (current ?? 0) + UNITS[w]!;
      found.push(UNITS[w]!);
    } else if (w in TENS) {
      if (current !== null) flush();
      current = TENS[w]!;
      found.push(TENS[w]!);
    } else if (w in SCALES) {
      const scale = SCALES[w]!;
      if (scale === 100) current = (current ?? 1) * 100;
      else {
        total += (current ?? 1) * scale;
        current = null;
      }
      found.push(scale);
    } else if (w in ORDINALS) {
      flush();
      found.push(ORDINALS[w]!);
    } else if (w in OTHER) {
      flush();
      found.push(OTHER[w]!);
    } else if (w === 'and' && current !== null) {
      continue;
    } else {
      flush();
    }
  }
  flush();
  return [...new Set(found)].map(String);
}

export function sourceNumbers(source: string): Set<string> {
  const set = new Set<string>();
  for (const n of digitNumbers(source)) {
    set.add(n);
    for (const part of n.split(/[.:]/)) set.add(part.replace(/^0+(?=\d)/, ''));
  }
  for (const n of wordNumbers(source)) set.add(n);
  return set;
}

/** Numbers in `output` that do not appear in `source`, in order of first use. */
export function newNumbers(source: string, output: string): string[] {
  const allowed = sourceNumbers(source);
  const out: string[] = [];
  for (const n of digitNumbers(output)) {
    if (!allowed.has(n) && !out.includes(n)) out.push(n);
  }
  return out;
}
