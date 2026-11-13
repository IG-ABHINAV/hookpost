import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import 'multer';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import mime from 'mime-types';
// @ts-ignore
import { getExtension } from 'mime';
import { IUploadProvider } from './upload.interface';
import axios from 'axios';
import { isSafePublicHttpsUrl } from '@hookpost/nestjs-libraries/dtos/webhooks/webhook.url.validator';
import { ssrfSafeDispatcher } from '@hookpost/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
import { parseDataUrl } from '@hookpost/nestjs-libraries/upload/data.url';
import {
  isGeneratedPdf,
  sniffUpload,
  STORAGE_UPLOAD_MIME,
} from '@hookpost/nestjs-libraries/upload/upload.allowlist';

class CloudflareStorage implements IUploadProvider {
  private _client: S3Client;

  constructor(
    accountID: string,
    accessKey: string,
    secretKey: string,
    private region: string,
    private _bucketName: string,
    private _uploadUrl: string
  ) {
    this._client = new S3Client({
      endpoint: `https://${accountID}.r2.cloudflarestorage.com`,
      region,
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });

    this._client.middlewareStack.add(
      (next) =>
        async (args): Promise<any> => {
          const request = args.request as RequestInit;

          // Remove checksum headers
          const headers = request.headers as Record<string, string>;
          delete headers['x-amz-checksum-crc32'];
          delete headers['x-amz-checksum-crc32c'];
          delete headers['x-amz-checksum-sha1'];
          delete headers['x-amz-checksum-sha256'];
          request.headers = headers;

          Object.entries(request.headers).forEach(
            // @ts-ignore
            ([key, value]: [string, string]): void => {
              if (!request.headers) {
                request.headers = {};
              }
              (request.headers as Record<string, string>)[key] = value;
            }
          );

          return next(args);
        },
      { step: 'build', name: 'customHeaders' }
    );
  }

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
    const detected = await sniffUpload(body, STORAGE_UPLOAD_MIME);
    if (!detected) {
      throw new Error('Unsupported file type.');
    }
    const extension = detected.ext;
    const safeContentType = detected.mime;
    const id = makeId(10);

    const params = {
      Bucket: this._bucketName,
      Key: `${id}.${extension}`,
      Body: body,
      ContentType: safeContentType,
      ChecksumMode: 'DISABLED',
    };

    const command = new PutObjectCommand({ ...params });
    await this._client.send(command);

    return `${this._uploadUrl}/${id}.${extension}`;
  }

  async uploadFile(file: Express.Multer.File): Promise<any> {
    try {
      const detected = await sniffUpload(file.buffer, STORAGE_UPLOAD_MIME);
      if (!detected) {
        throw new Error('Unsupported file type.');
      }
      const id = makeId(10);
      const extension = detected.ext;
      const safeContentType = detected.mime;

      // Create the PutObjectCommand to upload the file to Cloudflare R2
      const command = new PutObjectCommand({
        Bucket: this._bucketName,
        ACL: 'public-read',
        Key: `${id}.${extension}`,
        Body: file.buffer,
        ContentType: safeContentType,
      });

      await this._client.send(command);

      return {
        filename: `${id}.${extension}`,
        mimetype: file.mimetype,
        size: file.size,
        buffer: file.buffer,
        originalname: `${id}.${extension}`,
        fieldname: 'file',
        path: `${this._uploadUrl}/${id}.${extension}`,
        destination: `${this._uploadUrl}/${id}.${extension}`,
        encoding: '7bit',
        stream: file.buffer as any,
      };
    } catch (err) {
      console.error('Error uploading file to Cloudflare R2:', err);
      throw err;
    }
  }

  async uploadGeneratedPdf(buffer: Buffer) {
    if (!(await isGeneratedPdf(buffer))) {
      throw new Error('Not a PDF.');
    }
    const key = `${makeId(10)}.pdf`;
    await this._client.send(
      new PutObjectCommand({
        Bucket: this._bucketName,
        ACL: 'public-read',
        Key: key,
        Body: buffer,
        ContentType: 'application/pdf',
      })
    );
    return { filename: key, path: `${this._uploadUrl}/${key}` };
  }

  // Objects are stored flat, as <id>.<ext>, and served at <bucket URL>/<key>.
  ownsFile(filePath: string): boolean {
    if (!this._uploadUrl || !filePath) return false;
    const prefix = `${this._uploadUrl.replace(/\/+$/, '')}/`;
    if (!filePath.startsWith(prefix)) return false;
    const key = filePath.slice(prefix.length);
    return /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(key);
  }

  // Rejects when R2 refuses, so a caller that must know (the account purge)
  // never forgets a file it failed to delete. Deleting a key that does not
  // exist succeeds, so a retry is safe.
  async removeFile(filePath: string): Promise<void> {
    if (!this.ownsFile(filePath)) {
      throw new Error(`Not a file in this bucket: ${filePath}`);
    }
    const fileName = filePath.split('/').pop();
    try {
      const command = new DeleteObjectCommand({
        Bucket: this._bucketName,
        Key: fileName,
      });
      await this._client.send(command);
    } catch (err) {
      console.error(`Error deleting file ${filePath} from Cloudflare R2:`, err);
      throw err;
    }
  }
}

export { CloudflareStorage };
export default CloudflareStorage;
