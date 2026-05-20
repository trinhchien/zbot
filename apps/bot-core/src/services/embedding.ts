import { GoogleGenAI } from '@google/genai';
import { env } from '@reunion/shared/config/env';
import { checkAndConsume } from './rate-limit';

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

/**
 * Generate embeddings using @google/genai directly (not via LangChain).
 * Returns array of 768-dim vectors.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const allowed = await checkAndConsume('embedding');
  if (!allowed) throw new Error('Embedding quota exhausted');

  const result = await ai.models.embedContent({
    model: env.GEMINI_MODEL_EMBED,
    contents: texts.map((t) => ({ parts: [{ text: t }] })),
  });

  return (result.embeddings ?? []).map((e) => e.values ?? []);
}
