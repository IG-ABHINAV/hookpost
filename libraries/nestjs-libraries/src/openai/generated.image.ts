import { generationError } from '@hookpost/nestjs-libraries/openai/generation.error';
import { base64ImageDataUrl } from '@hookpost/nestjs-libraries/upload/data.url';
import { CreditsExceededError } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/credits.exceeded.error';

/** OpenaiService.generateImage: the picture as base64, or nothing. */
export type GenerateImageBase64 = (
  prompt: string
) => Promise<string | null | undefined>;

/**
 * Generates one picture and stores it, returning its public URL.
 *
 * The post generator and RSS auto-post used LangChain's DallEAPIWrapper, which
 * always sends `response_format`. The gpt-image models (OPENAI_IMAGE_MODEL,
 * default gpt-image-1-mini) reject that parameter, so every generation with
 * pictures failed with "Unknown parameter: 'response_format'". This is the
 * path the media library's "Generate image" takes and which works:
 * OpenaiService.generateImage returns base64, and the storage provider turns
 * the data URL into a public file. The result is a URL we host, not one of
 * OpenAI's links that expire after an hour.
 */
export async function generateAndUploadImage(
  prompt: string,
  generate: GenerateImageBase64,
  storage: { uploadSimple(path: string): Promise<string> }
): Promise<string> {
  const base64 = await generate(prompt);
  if (!base64) {
    throw new Error('The image model returned no image');
  }
  return storage.uploadSimple(base64ImageDataUrl(base64));
}

/**
 * What the post generator tells the user when some or all of its pictures
 * could not be made. The posts themselves are still returned. Each error goes
 * through generationError, which logs the provider's real reason for us and
 * recognises an AI safety rejection. Running out of the plan's AI image
 * credits (CreditsExceededError) is named first: trying again will not help.
 */
export function pictureFailureMessage(
  errors: unknown[],
  total: number
): string {
  const normalized = errors.map((err) => generationError(err));
  const which =
    errors.length >= total || total <= 1
      ? 'the pictures'
      : `${errors.length} of ${total} pictures`;
  if (errors.some((err) => err instanceof CreditsExceededError)) {
    return `You're out of AI image credits this month, so we couldn't create ${which}. Your posts are ready without them, and you can add images in the editor.`;
  }
  const rejected = normalized.some((e) => e.getStatus() === 422);
  return rejected
    ? `The AI safety system rejected ${which}, so your posts are ready without them. You can add images in the editor.`
    : `We couldn't create ${which}, so your posts are ready without them. You can add images in the editor.`;
}
