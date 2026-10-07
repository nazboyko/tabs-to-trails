import { chat, estimateTokens, type ChatReply } from '../ollama.js';
import { countWords, splitSentences } from '../source/sections.js';
import { newNumbers } from './guard.js';
import { QUESTION_SYSTEM } from './prompts.js';

export type QuestionChat = (req: { system: string; user: string; maxTokens: number; temperature?: number }) => Promise<ChatReply>;

/** Longest source text sent with the question request, in estimated tokens. */
export const QUESTION_SOURCE_TOKENS = 9000;

/** One sentence that ends with a question mark, short enough to hold in your head. */
export function cleanQuestion(text: string): string | null {
  const flat = text.replace(/[*_#`"“”]/g, '').replace(/\s+/g, ' ').trim();
  const question = splitSentences(flat).find((s) => s.endsWith('?'));
  if (!question) return null;
  const words = countWords(question);
  if (words < 5 || words > 35) return null;
  return question.charAt(0).toUpperCase() + question.slice(1);
}

/**
 * `source` is the source text when it fits, otherwise the script, which is
 * already limited to the source.
 */
export async function closingQuestion(
  title: string,
  source: string,
  chatFn: QuestionChat = chat,
): Promise<{ question: string | null; seconds: number }> {
  let seconds = 0;
  const user = `TITLE: ${title}\n\nSOURCE:\n${source}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await chatFn({ system: QUESTION_SYSTEM, user, maxTokens: 120, temperature: attempt ? 0.5 : 0.3 });
      seconds += reply.seconds;
      const q = cleanQuestion(reply.text);
      if (q && newNumbers(source, q).length === 0) return { question: q, seconds };
    } catch {
      break;
    }
  }
  return { question: null, seconds };
}

export function fitsQuestionRequest(text: string): boolean {
  return estimateTokens(text) <= QUESTION_SOURCE_TOKENS;
}
