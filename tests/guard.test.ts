import { describe, expect, it } from 'vitest';
import { digitNumbers, newNumbers, sourceNumbers, wordNumbers } from '../src/server/script/guard.js';

describe('digitNumbers', () => {
  it('normalizes thousands, decimals and leading zeros', () => {
    expect(digitNumbers('1,200 users, 3.50 dollars, 007 agents, v2.1.0')).toEqual(['1200', '3.5', '7', '2.1.0']);
  });

  it('splits plain comma lists', () => {
    expect(digitNumbers('steps 1,2,3')).toEqual(['1', '2', '3']);
  });
});

describe('wordNumbers', () => {
  it('reads spelled-out numbers', () => {
    expect(wordNumbers('twenty-five people')).toContain('25');
    expect(wordNumbers('two hundred and five')).toContain('205');
    expect(wordNumbers('three thousand')).toContain('3000');
    expect(wordNumbers('the third time, twice')).toEqual(expect.arrayContaining(['3', '2']));
  });

  it('adds tens after a hundred, as in a Wikipedia sentence that was flagged by mistake', () => {
    expect(wordNumbers('chimpanzees expend one-hundred and fifty percent')).toContain('150');
    expect(wordNumbers('two hundred thirty-five')).toContain('235');
    expect(newNumbers('one-hundred and fifty percent of the energy', '150 percent of the energy')).toEqual([]);
    // Two tens in a row are still two numbers.
    expect(wordNumbers('twenty thirty')).not.toContain('50');
  });
});

describe('newNumbers', () => {
  it('accepts numbers that are in the source, written either way', () => {
    expect(newNumbers('It took three weeks and 1,200 requests.', 'It took 3 weeks and 1200 requests.')).toEqual([]);
    expect(newNumbers('The median fell from 840 ms to 120 ms.', 'It fell from 840 to 120 milliseconds.')).toEqual([]);
  });

  it('catches an invented number', () => {
    expect(newNumbers('The cache got faster.', 'The cache got 40% faster.')).toEqual(['40']);
    expect(newNumbers('I missed calls from my sister.', 'I missed 3 calls from my sister.')).toEqual(['3']);
  });

  it('allows parts of times and versions', () => {
    const allowed = sourceNumbers('at 10:30 on version 2.1');
    expect(allowed.has('10')).toBe(true);
    expect(allowed.has('30')).toBe(true);
    expect(allowed.has('2.1')).toBe(true);
  });

  it('lists each new number once, in order', () => {
    expect(newNumbers('nothing', '5 then 7 then 5')).toEqual(['5', '7']);
  });
});
