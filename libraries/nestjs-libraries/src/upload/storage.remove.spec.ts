import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Deleting stored files for the account purge: a provider must say which URLs
// are its own, and must reject when a delete fails (the purge then keeps the
// rows that point at the file instead of orphaning it).

jest.mock('file-type', () => ({ fileTypeFromBuffer: jest.fn() }));
jest.mock('mime', () => ({ getExtension: jest.fn() }));
jest.mock('@hookpost/nestjs-libraries/dtos/webhooks/webhook.url.validator', () => ({
  isSafePublicHttpsUrl: jest.fn(),
}));
jest.mock('@hookpost/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher', () => ({
  ssrfSafeDispatcher: {},
}));
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    middlewareStack = { add: jest.fn() };
    send = mockSend;
  },
  PutObjectCommand: class {
    constructor(public input: any) {}
  },
  DeleteObjectCommand: class {
    constructor(public input: any) {}
  },
}));

import { CloudflareStorage } from '@hookpost/nestjs-libraries/upload/cloudflare.storage';
import { LocalStorage } from '@hookpost/nestjs-libraries/upload/local.storage';

describe('CloudflareStorage file ownership and removal', () => {
  const r2 = new CloudflareStorage('acct', 'key', 'secret', 'auto', 'hookpost-media', 'https://media.hookstep.in');
  beforeEach(() => mockSend.mockReset());

  it('owns only flat <id>.<ext> keys under its bucket URL', () => {
    expect(r2.ownsFile('https://media.hookstep.in/Ab3dE6gH9j.mp4')).toBe(true);
    expect(r2.ownsFile('https://cdn.example.com/Ab3dE6gH9j.mp4')).toBe(false);
    expect(r2.ownsFile('https://media.hookstep.in/folder/Ab3dE6gH9j.mp4')).toBe(false);
    // Tablamigo shares the bucket under prefixed keys (kind/user/hex.ext):
    // never ours, so no Hookpost purge can delete one.
    expect(r2.ownsFile('https://media.hookstep.in/tablamigo/avatar/u1/0123456789abcdef.jpg')).toBe(false);
    expect(r2.ownsFile('https://media.hookstep.in/chat/u1/0123456789abcdef.jpg')).toBe(false);
    expect(r2.ownsFile('https://media.hookstep.in.evil.com/Ab3dE6gH9j.mp4')).toBe(false);
    expect(r2.ownsFile('')).toBe(false);
  });

  it('deletes the key and rejects when R2 refuses', async () => {
    mockSend.mockResolvedValueOnce({});
    await r2.removeFile('https://media.hookstep.in/Ab3dE6gH9j.mp4');
    expect(mockSend.mock.calls[0][0].input).toEqual({ Bucket: 'hookpost-media', Key: 'Ab3dE6gH9j.mp4' });

    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockSend.mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(r2.removeFile('https://media.hookstep.in/Ab3dE6gH9j.mp4')).rejects.toThrow('AccessDenied');
    errors.mockRestore();
  });

  it('never deletes a key named after someone else\'s URL', async () => {
    await expect(r2.removeFile('https://cdn.example.com/photo.jpg')).rejects.toThrow('Not a file');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('LocalStorage file ownership and removal', () => {
  const previous = process.env.FRONTEND_URL;
  let dir: string;
  let local: LocalStorage;
  beforeAll(() => {
    process.env.FRONTEND_URL = 'https://hookpost.hookstep.in';
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-'));
    fs.mkdirSync(path.join(dir, '2026', '10', '11'), { recursive: true });
    fs.writeFileSync(path.join(dir, '2026', '10', '11', 'abc.png'), 'x');
    local = new LocalStorage(dir);
  });
  afterAll(() => {
    process.env.FRONTEND_URL = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const url = 'https://hookpost.hookstep.in/uploads/2026/10/11/abc.png';

  it('owns its public /uploads URLs and nothing outside the upload directory', () => {
    expect(local.ownsFile(url)).toBe(true);
    expect(local.ownsFile('https://hookpost.hookstep.in/uploads/../../etc/passwd')).toBe(false);
    expect(local.ownsFile('https://media.hookstep.in/abc.png')).toBe(false);
  });

  it('deletes the file, and a file already gone is not an error', async () => {
    await local.removeFile(url);
    expect(fs.existsSync(path.join(dir, '2026', '10', '11', 'abc.png'))).toBe(false);
    await expect(local.removeFile(url)).resolves.toBeUndefined();
  });

  it('refuses a URL it does not own', async () => {
    await expect(local.removeFile('/etc/passwd')).rejects.toThrow('Not a file');
  });
});
