import { NextRequest, NextResponse } from 'next/server';
import { createReadStream, statSync } from 'fs';
import { resolve, sep } from 'path';
import { uploadServeHeaders } from '@hookpost/nestjs-libraries/upload/upload.serve';
async function* nodeStreamToIterator(stream: any) {
  for await (const chunk of stream) {
    yield chunk;
  }
}
function iteratorToStream(iterator: any) {
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(new Uint8Array(value));
      }
    },
  });
}

/**
 * Serves FRONTEND_URL/uploads/... when STORAGE_PROVIDER=local and nothing in
 * front of Next.js does (next.config.js rewrites /uploads here). Production
 * serves the directory from nginx instead (nginx.hookpost.conf), with the
 * same headers: upload.serve.ts.
 */
export const GET = async (
  request: NextRequest,
  context: {
    params: Promise<{
      path?: string[];
    }>;
  }
) => {
  const { path } = await context.params;
  const base = resolve(process.env.UPLOAD_DIRECTORY!);
  const filePath = resolve(base, (path ?? []).join('/'));
  // Confine reads to UPLOAD_DIRECTORY. resolve() collapses any `..` segments
  // (including URL-decoded ones), so this blocks every path-traversal variant.
  if (!filePath.startsWith(base + sep)) {
    return new NextResponse('Not found', { status: 404 });
  }
  // A missing file or a directory was a 500 (statSync threw, or the stream
  // failed after the headers went out).
  let fileStats;
  try {
    fileStats = statSync(filePath);
  } catch {
    return new NextResponse('Not found', { status: 404 });
  }
  if (!fileStats.isFile()) {
    return new NextResponse('Not found', { status: 404 });
  }
  const response = createReadStream(filePath);
  const iterator = nodeStreamToIterator(response);
  const webStream = iteratorToStream(iterator);
  return new Response(webStream, {
    headers: {
      // The type comes from the extension, never from the content; nosniff,
      // a sandbox CSP, and a download for anything not an image or a video.
      ...uploadServeHeaders(filePath),
      'Content-Length': fileStats.size.toString(),
      'Last-Modified': fileStats.mtime.toUTCString(),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
