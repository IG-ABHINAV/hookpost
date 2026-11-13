// /llms.txt, prerendered at build from src/llms/llms.txt. See src/llms/llms.ts
// for why it is not a file in public/ any more.
import { llmsResponse } from '@hookpost/frontend/llms/llms';

export const dynamic = 'force-static';

export function GET() {
  return llmsResponse('llms.txt');
}
