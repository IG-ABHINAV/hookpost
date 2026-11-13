import { IUploadProvider } from './upload.interface';
import { mkdirSync, unlink, writeFileSync } from 'fs';
import { resolve, sep } from 'path';
import { isSafePublicHttpsUrl } from '@hookpost/nestjs-libraries/dtos/webhooks/webhook.url.validator';
import { ssrfSafeDispatcher } from '@hookpost/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
import { parseDataUrl } from '@hookpost/nestjs-libraries/upload/data.url';
import {
  isGeneratedPdf,
  sniffUpload,
  STORAGE_UPLOAD_MIME,
} from '@hookpost/nestjs-libraries/upload/upload.allowlist';
export class LocalStorage implements IUploadProvider {
  constructor(private uploadDirectory: string) {}

  async uploadSimple(path: string) {
    const dataUrl = path.startsWith('data:') ? parseDataUrl(path) : null;

    let body: Buffer;
    if (dataUrl) {
      body = dataUrl.buffer;
    } else {
      if (!(await isSafePublicHttpsUrl(path))) {
        throw new Error('Unsafe URL');
      }
      const loadImage = await fetch(path, {
        // @ts-ignore — undici option, not in lib.dom fetch types
        dispatcher: ssrfSafeDispatcher,
      });
      body = Buffer.from(await loadImage.arrayBuffer());
    }

    // Never trust the claimed mime/extension (data URL header, remote
    // content-type, or URL path): sniff the real type from the bytes and
    // only accept the allow-list, otherwise an attacker could write an
    // arbitrary file (e.g. .html/.svg with embedded script) into the
    // publicly served uploads directory on the app's own origin.
    const detected = await sniffUpload(body, STORAGE_UPLOAD_MIME);
    if (!detected) {
      throw new Error('Unsupported file type.');
    }
    const findExtension = detected.ext;

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');

    const innerPath = `/${year}/${month}/${day}`;
    const dir = `${this.uploadDirectory}${innerPath}`;
    mkdirSync(dir, { recursive: true });

    const randomName = Array(32)
      .fill(null)
      .map(() => Math.round(Math.random() * 16).toString(16))
      .join('');

    const filePath = `${dir}/${randomName}.${findExtension}`;
    const publicPath = `${innerPath}/${randomName}.${findExtension}`;
    // Logic to save the file to the filesystem goes here
    writeFileSync(filePath, body);

    return process.env.FRONTEND_URL + '/uploads' + publicPath;
  }

  async uploadFile(file: Express.Multer.File): Promise<any> {
    try {
      const detected = await sniffUpload(file.buffer, STORAGE_UPLOAD_MIME);
      if (!detected) {
        throw new Error('Unsupported file type.');
      }
      const safeExt = `.${detected.ext}`;
      const safeMime = detected.mime;

      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');

      const innerPath = `/${year}/${month}/${day}`;
      const dir = `${this.uploadDirectory}${innerPath}`;
      mkdirSync(dir, { recursive: true });

      const randomName = Array(32)
        .fill(null)
        .map(() => Math.round(Math.random() * 16).toString(16))
        .join('');

      const filePath = `${dir}/${randomName}${safeExt}`;
      const publicPath = `${innerPath}/${randomName}${safeExt}`;

      writeFileSync(filePath, file.buffer);

      return {
        filename: `${randomName}${safeExt}`,
        path: process.env.FRONTEND_URL + '/uploads' + publicPath,
        mimetype: safeMime,
        originalname: `${randomName}${safeExt}`,
      };
    } catch (err) {
      console.error('Error uploading file to Local Storage:', err);
      throw err;
    }
  }

  async uploadGeneratedPdf(buffer: Buffer) {
    if (!(await isGeneratedPdf(buffer))) {
      throw new Error('Not a PDF.');
    }
    const now = new Date();
    const innerPath = `/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
    const dir = `${this.uploadDirectory}${innerPath}`;
    mkdirSync(dir, { recursive: true });
    const randomName = Array(32)
      .fill(null)
      .map(() => Math.round(Math.random() * 16).toString(16))
      .join('');
    writeFileSync(`${dir}/${randomName}.pdf`, buffer);
    return {
      filename: `${randomName}.pdf`,
      path: process.env.FRONTEND_URL + '/uploads' + `${innerPath}/${randomName}.pdf`,
    };
  }

  // Files are served at FRONTEND_URL/uploads/<yyyy>/<mm>/<dd>/<name>.
  private publicPrefix() {
    return `${process.env.FRONTEND_URL || ''}/uploads/`;
  }

  // The file on disk for a public URL, or null when it would fall outside the
  // upload directory.
  private diskPath(filePath: string): string | null {
    if (!this.uploadDirectory || !filePath) return null;
    const relative = filePath.startsWith(this.publicPrefix())
      ? filePath.slice(this.publicPrefix().length)
      : null;
    if (!relative) return null;
    const root = resolve(this.uploadDirectory);
    const full = resolve(root, relative);
    return full.startsWith(root + sep) ? full : null;
  }

  ownsFile(filePath: string): boolean {
    return !!process.env.FRONTEND_URL && this.diskPath(filePath) !== null;
  }

  // Takes the public URL the file is served at. A file that is already gone
  // counts as removed, so a retry is safe.
  async removeFile(filePath: string): Promise<void> {
    const target = this.ownsFile(filePath) ? this.diskPath(filePath) : null;
    if (!target) {
      throw new Error(`Not a file in the upload directory: ${filePath}`);
    }
    return new Promise((done, reject) => {
      unlink(target, (err) => {
        if (err && err.code !== 'ENOENT') {
          reject(err);
        } else {
          done();
        }
      });
    });
  }
}
