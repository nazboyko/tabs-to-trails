import { chat, type ChatReply } from '../ollama.js';
import { sectionLabel, splitSentences, type Section } from '../source/sections.js';

export const IMPORTANCE_SYSTEM = `You help shorten a piece of writing for a listener on a walk.
For each section, rate how much it matters to the main point of the piece:
5 = the core idea, 4 = important support, 3 = useful detail, 2 = side note, 1 = housekeeping (thanks, links, sign-offs, disclaimers).
Judge only from what is given. Return a score for every id.`;

const SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, score: { type: 'integer', minimum: 1, maximum: 5 } },
        required: ['id', 'score'],
      },
    },
  },
  required: ['scores'],
} as const;

export type ImportanceChat = (req: { system: string; user: string; format: object; maxTokens: number }) => Promise<ChatReply>;

function opening(section: Section): string {
  const prose = section.blocks.find((b) => b.kind === 'prose' || b.kind === 'quote' || b.kind === 'list');
  if (!prose) return `(${[...new Set(section.blocks.map((b) => b.kind))].join(', ')})`;
  const first = splitSentences(prose.text)[0] ?? prose.text;
  const words = first.split(/\s+/);
  return words.length > 30 ? `${words.slice(0, 30).join(' ')}...` : first;
}

export function importancePrompt(title: string, sections: Section[]): string {
  const lines = sections.map((s) => `${s.id} | ${sectionLabel(s)} | ${s.words} words | ${opening(s)}`);
  return `TITLE: ${title}\n\nSECTIONS (id | heading | length | first sentence):\n${lines.join('\n')}`;
}

/** Parses the model's reply; null when it is unusable, so the plan falls back to plain proportions. */
export function parseScores(text: string, ids: string[]): Record<string, number> | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const list = (body as { scores?: unknown }).scores;
  if (!Array.isArray(list)) return null;
  const out: Record<string, number> = {};
  for (const item of list) {
    const { id, score } = (item ?? {}) as { id?: unknown; score?: unknown };
    if (typeof id === 'string' && ids.includes(id) && typeof score === 'number' && score >= 1 && score <= 5) {
      out[id] = Math.round(score);
    }
  }
  return Object.keys(out).length >= Math.ceil(ids.length / 2) ? out : null;
}

export async function scoreSections(
  title: string,
  sections: Section[],
  chatFn: ImportanceChat = chat,
): Promise<{ scores: Record<string, number> | null; seconds: number }> {
  if (sections.length < 2) return { scores: null, seconds: 0 };
  try {
    const reply = await chatFn({
      system: IMPORTANCE_SYSTEM,
      user: importancePrompt(title, sections),
      format: SCHEMA,
      maxTokens: 40 + sections.length * 24,
    });
    return { scores: parseScores(reply.text, sections.map((s) => s.id)), seconds: reply.seconds };
  } catch {
    return { scores: null, seconds: 0 };
  }
}
