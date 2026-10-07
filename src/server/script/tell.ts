/**
 * Tell, don't announce. A listener needs what a table says, not the news that
 * there is a table: "Numbers from my laptop are listed" tells them nothing.
 * These checks find such sentences in a rewrite, and sentences of a block
 * description that only repeat the paragraph around the block.
 */

import { splitSentences } from '../source/sections.js';

const ANNOUNCE: RegExp[] = [
  /\b(?:are|is|were|was|get|gets) (?:listed|shown|presented|included|given|displayed|outlined|detailed|provided|summari[sz]ed)\b/i,
  /\b(?:the|this|that|a|one) (?:table|chart|list|grid|data|numbers|figures|results|values)\b[^.!?]{0,60}?\b(?:shows?|lists?|presents?|contains?|includes?|compares?|gives?|provides?|displays?|outlines?|details?|summari[sz]es)\b/i,
  /\b(?:in|on|from) (?:the|this) (?:table|chart|list)\b/i,
  /^(?:here (?:is|are)|there (?:is|are)) (?:a |an |the )?(?:table|chart|list)\b/i,
];

export function announces(sentence: string): boolean {
  return ANNOUNCE.some((re) => re.test(sentence));
}

export function announcingSentences(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .flatMap(splitSentences)
    .filter(announces);
}

/** Announcing sentences with no number in them: they tell the listener nothing. */
export function emptyAnnouncements(text: string): string[] {
  return announcingSentences(text).filter((s) => !/\d/.test(s));
}

/** Drops announcing sentences that carry no number; a sentence with numbers still tells something. */
export function dropAnnouncements(text: string): string {
  return keepSentences(text, (s) => !(announces(s) && !/\d/.test(s)));
}

const STOP = new Set(
  'about after again also among because been before being between both could does doing down during each from have having here into just more most much once only other over same should some such than that their them then there these they this those through under until very were what when where which while with would your'.split(' '),
);

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter((w) => !STOP.has(w));
}

/**
 * Drops sentences of a block description whose content words mostly appear in
 * the paragraphs before and after the block; those paragraphs are read anyway.
 */
export function dropRepeats(text: string, context: string, share = 0.7): string {
  const around = new Set(contentWords(context));
  return keepSentences(text, (s) => {
    const words = contentWords(s);
    if (words.length < 5) return true;
    return words.filter((w) => around.has(w)).length / words.length < share;
  });
}

/** Keeps the sentences `keep` approves, paragraph by paragraph; never returns nothing. */
function keepSentences(text: string, keep: (sentence: string) => boolean): string {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => splitSentences(p).filter(keep).join(' '))
    .filter((p) => p.trim() !== '');
  return paragraphs.length ? paragraphs.join('\n\n') : text;
}
