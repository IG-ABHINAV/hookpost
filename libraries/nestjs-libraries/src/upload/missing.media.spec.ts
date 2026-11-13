import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findMissingMedia,
  isOwnUploadMissing,
  mediaPathsOf,
  ownUploadLocation,
} from '@hookpost/nestjs-libraries/upload/missing.media';

// Which of a post's files are gone from our storage. Videos are purged a week
// after publishing; a failed post retried after that sent the platform a dead
// link. Only our own uploads are ever checked, and only a sure answer counts.

const BUCKET = 'https://media.hookstep.in';
const APP = 'https://hookpost.hookstep.in';

const headAnswering = (status: number) =>
  jest.fn(async () => ({ status })) as unknown as typeof fetch;

describe('ownUploadLocation', () => {
  const env = {
    CLOUDFLARE_BUCKET_URL: `${BUCKET}/`,
    FRONTEND_URL: APP,
    UPLOAD_DIRECTORY: '/srv/uploads',
  };

  it('knows the bucket and the app /uploads path as ours', () => {
    expect(ownUploadLocation(`${BUCKET}/Ab3dE6gH9j.mp4`, env)).toEqual({
      url: `${BUCKET}/Ab3dE6gH9j.mp4`,
    });
    expect(ownUploadLocation(`${APP}/uploads/2026/10/11/abc.png`, env)).toEqual(
      {
        disk: path.resolve('/srv/uploads', '2026/10/11/abc.png'),
      }
    );
  });

  it('asks the URL for /uploads when there is no upload directory', () => {
    expect(
      ownUploadLocation(`${APP}/uploads/2026/10/11/abc.png`, {
        ...env,
        UPLOAD_DIRECTORY: '',
      })
    ).toEqual({ url: `${APP}/uploads/2026/10/11/abc.png` });
  });

  it('never treats another site, a look-alike host or a path escape as ours', () => {
    expect(ownUploadLocation('https://cdn.example.com/a.mp4', env)).toBeNull();
    expect(
      ownUploadLocation('https://media.hookstep.in.evil.com/a.mp4', env)
    ).toBeNull();
    expect(
      ownUploadLocation(`${APP}/uploads/../../etc/passwd`, env)
    ).toBeNull();
    expect(
      ownUploadLocation(`${APP}/uploads/%2e%2e/%2e%2e/etc/passwd`, env)
    ).toBeNull();
    expect(ownUploadLocation(`${APP}/other/a.png`, env)).toBeNull();
    expect(ownUploadLocation(undefined, env)).toBeNull();
    expect(ownUploadLocation(42, env)).toBeNull();
  });

  it('owns nothing when storage is not configured', () => {
    expect(ownUploadLocation(`${BUCKET}/a.mp4`, {})).toBeNull();
  });
});

describe('isOwnUploadMissing', () => {
  const env = { CLOUDFLARE_BUCKET_URL: BUCKET };

  it('a 404 or 410 from the bucket means gone', async () => {
    expect(
      await isOwnUploadMissing(`${BUCKET}/a.mp4`, env, headAnswering(404))
    ).toBe(true);
    expect(
      await isOwnUploadMissing(`${BUCKET}/a.mp4`, env, headAnswering(410))
    ).toBe(true);
  });

  it('asks with a HEAD that does not follow redirects and gives up quickly', async () => {
    const head = headAnswering(200);
    expect(await isOwnUploadMissing(`${BUCKET}/a.mp4`, env, head)).toBe(false);
    const [url, init] = (head as unknown as jest.Mock).mock.calls[0];
    expect(url).toBe(`${BUCKET}/a.mp4`);
    expect(init).toMatchObject({ method: 'HEAD', redirect: 'manual' });
    expect(init.signal).toBeDefined();
  });

  it('anything short of a sure answer is not "gone"', async () => {
    for (const status of [200, 301, 403, 500, 503]) {
      expect(
        await isOwnUploadMissing(`${BUCKET}/a.mp4`, env, headAnswering(status))
      ).toBe(false);
    }
    const timeout = jest.fn(async () => {
      throw new Error('The operation was aborted due to timeout');
    }) as unknown as typeof fetch;
    expect(await isOwnUploadMissing(`${BUCKET}/a.mp4`, env, timeout)).toBe(
      false
    );
  });

  it('never calls out for a link to another site', async () => {
    const head = headAnswering(404);
    expect(
      await isOwnUploadMissing('https://cdn.example.com/a.mp4', env, head)
    ).toBe(false);
    expect(head).not.toHaveBeenCalled();
  });

  describe('local uploads', () => {
    let dir: string;
    let local: Record<string, string>;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-'));
      fs.mkdirSync(path.join(dir, '2026', '10', '11'), { recursive: true });
      fs.writeFileSync(path.join(dir, '2026', '10', '11', 'kept.png'), 'x');
      local = { FRONTEND_URL: APP, UPLOAD_DIRECTORY: dir };
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('looks in the upload directory, without a request', async () => {
      const head = headAnswering(404);
      expect(
        await isOwnUploadMissing(
          `${APP}/uploads/2026/10/11/kept.png`,
          local,
          head
        )
      ).toBe(false);
      expect(
        await isOwnUploadMissing(
          `${APP}/uploads/2026/10/11/purged.mp4`,
          local,
          head
        )
      ).toBe(true);
      expect(head).not.toHaveBeenCalled();
    });
  });
});

describe('findMissingMedia', () => {
  it('checks each path once and returns only the ones that are gone', async () => {
    const head = jest.fn(async (url: string) => ({
      status: url.endsWith('dead.mp4') ? 404 : 200,
    })) as unknown as typeof fetch;
    const missing = await findMissingMedia(
      [
        `${BUCKET}/dead.mp4`,
        `${BUCKET}/dead.mp4`,
        `${BUCKET}/live.png`,
        'https://cdn.example.com/dead.mp4',
        null,
        '',
      ],
      { CLOUDFLARE_BUCKET_URL: BUCKET },
      head
    );
    expect(missing).toEqual([`${BUCKET}/dead.mp4`]);
    expect(head).toHaveBeenCalledTimes(2);
  });
});

describe('mediaPathsOf', () => {
  it("collects every file of a save's posts and comments", () => {
    expect(
      mediaPathsOf([
        {
          value: [
            { image: [{ path: 'a' }, { path: '' }] },
            { image: [{ path: 'b' }] },
            {},
          ],
        },
        { value: [{ image: [{ path: 'c' }] }] },
        {},
      ])
    ).toEqual(['a', 'b', 'c']);
  });
});
