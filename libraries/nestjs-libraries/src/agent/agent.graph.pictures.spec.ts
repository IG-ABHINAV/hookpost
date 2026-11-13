import 'reflect-metadata';

// "Generate posts" with "Add pictures?" ticked failed for everyone from 9 Sep:
// LangChain's DallEAPIWrapper always sends response_format, and the gpt-image
// models reject it. The pictures now go through OpenaiService (base64) and the
// upload provider, and a picture that cannot be made no longer throws away
// the posts. Each picture takes one of the plan's monthly AI image credits.
//   pnpm exec jest -c apps/backend/jest.config.ts agent.graph.pictures

const imagesGenerate = jest.fn();
jest.mock('openai', () => {
  const OpenAI = jest.fn().mockImplementation(() => ({
    images: { generate: imagesGenerate },
    chat: { completions: { parse: jest.fn(), create: jest.fn() } },
  }));
  return { __esModule: true, default: OpenAI };
});

const uploadSimple = jest.fn();
jest.mock('@hookpost/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({ uploadSimple }) },
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/posts/posts.service',
  () => ({ PostsService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/media/media.service',
  () => ({ MediaService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  () => ({ SubscriptionService: class {} })
);

// AgentGraphService reads the workspace's links through OrganizationService,
// whose import chain builds a Resend client that throws without RESEND_API_KEY.
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);

import { AgentGraphService } from '@hookpost/nestjs-libraries/agent/agent.graph.service';
import { OpenaiService } from '@hookpost/nestjs-libraries/openai/openai.service';
import {
  generateAndUploadImage,
  pictureFailureMessage,
} from '@hookpost/nestjs-libraries/openai/generated.image';
import { CreditsExceededError } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/credits.exceeded.error';

const state = (over: Record<string, unknown> = {}) =>
  ({
    messages: [],
    orgId: 'org-1',
    question: '',
    format: 'thread_short',
    tone: 'personal',
    isPicture: true,
    content: [
      { content: 'first', prompt: 'a red bicycle' },
      { content: 'second', prompt: 'a blue kite' },
    ],
    ...over,
  } as any);

// SubscriptionService.useCreditForOrganizationId with `left` AI image credits:
// over the allowance it throws before running the call, and a call that fails
// gives its credit back (subscription.image-credits.spec.ts has the real one).
const imageCredits = (left = 100) => ({
  useCreditForOrganizationId: jest.fn(
    async (_org: string, type: string, run: () => Promise<unknown>) => {
      if (left <= 0) throw new CreditsExceededError(type);
      left--;
      try {
        return await run();
      } catch (err) {
        left++;
        throw err;
      }
    }
  ),
});

const makeService = (
  generateImage: jest.Mock,
  saveFile = jest.fn(),
  subscription = imageCredits()
) =>
  new AgentGraphService(
    {} as any,
    { saveFile } as any,
    { generateImage } as unknown as OpenaiService,
    subscription as any,
    { getLinkSources: async () => [] } as any
  );

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  uploadSimple.mockImplementation(
    async () => `https://uploads.example.test/${Math.random().toString(36).slice(2)}.png`
  );
});

describe('OpenaiService.generateImage', () => {
  // The OpenAI path (AI_IMAGE_PROVIDER=openai); Gemini is ai.provider.spec.ts.
  const before = process.env.AI_PROVIDER;
  beforeEach(() => {
    process.env.AI_PROVIDER = 'openai';
  });
  afterEach(() => {
    if (before === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = before;
  });

  it('never sends response_format, which the gpt-image models reject', async () => {
    imagesGenerate.mockResolvedValue({ data: [{ b64_json: 'aGVsbG8=' }] });
    await expect(new OpenaiService().generateImage('a cat')).resolves.toBe(
      'aGVsbG8='
    );
    const params = imagesGenerate.mock.calls[0][0];
    expect(params).not.toHaveProperty('response_format');
    expect(params.prompt).toBe('a cat');
  });
});

describe('generateAndUploadImage', () => {
  it('stores the base64 picture and returns the public URL', async () => {
    uploadSimple.mockResolvedValue('https://uploads.example.test/abc.png');
    const url = await generateAndUploadImage(
      'a cat',
      async () => 'aGVsbG8=',
      { uploadSimple }
    );
    expect(url).toBe('https://uploads.example.test/abc.png');
    expect(uploadSimple).toHaveBeenCalledWith('data:image/png;base64,aGVsbG8=');
  });

  it('fails when the model returns no picture, without uploading anything', async () => {
    await expect(
      generateAndUploadImage('a cat', async () => undefined, { uploadSimple })
    ).rejects.toThrow('returned no image');
    expect(uploadSimple).not.toHaveBeenCalled();
  });
});

describe('pictureFailureMessage', () => {
  it('says the posts are ready without the pictures', () => {
    expect(pictureFailureMessage([new Error('quota')], 1)).toBe(
      "We couldn't create the pictures, so your posts are ready without them. You can add images in the editor."
    );
    expect(pictureFailureMessage([new Error('quota')], 3)).toContain(
      '1 of 3 pictures'
    );
  });

  it("says when the month's AI image credits ran out", () => {
    expect(
      pictureFailureMessage([new CreditsExceededError('ai_images')], 1)
    ).toBe(
      "You're out of AI image credits this month, so we couldn't create the pictures. Your posts are ready without them, and you can add images in the editor."
    );
    expect(
      pictureFailureMessage(
        [new CreditsExceededError('ai_images'), new Error('quota')],
        4
      )
    ).toContain("out of AI image credits this month, so we couldn't create 2 of 4 pictures");
  });

  it('names an AI safety rejection', () => {
    const err = new Error(
      '400 Your request was rejected by the safety system, safety_violations=[violence]'
    );
    expect(pictureFailureMessage([err], 2)).toContain(
      'The AI safety system rejected'
    );
  });
});

describe('AgentGraphService pictures', () => {
  it('adds a stored picture to every post', async () => {
    const generateImage = jest.fn().mockResolvedValue('aGVsbG8=');
    const out = (await makeService(generateImage).generatePictures(
      state()
    )) as any;

    expect(generateImage.mock.calls.map((c) => c[0])).toEqual([
      'a red bicycle',
      'a blue kite',
    ]);
    expect(out.pictureError).toBeUndefined();
    expect(out.content).toHaveLength(2);
    for (const item of out.content) {
      expect(item.image).toMatch(/^https:\/\/uploads\.example\.test\//);
    }
  });

  it('a picture that fails leaves its post without one, and says so', async () => {
    const generateImage = jest
      .fn()
      .mockResolvedValueOnce('aGVsbG8=')
      .mockRejectedValueOnce(
        new Error("400 Unknown parameter: 'response_format'.")
      );
    const out = (await makeService(generateImage).generatePictures(
      state()
    )) as any;

    expect(out.content.map((p: any) => p.content)).toEqual(['first', 'second']);
    expect(out.content[0].image).toBeTruthy();
    expect(out.content[1].image).toBeUndefined();
    expect(out.pictureError).toContain('1 of 2 pictures');
  });

  it('every picture failing still returns the posts', async () => {
    const generateImage = jest.fn().mockRejectedValue(new Error('quota'));
    const out = (await makeService(generateImage).generatePictures(
      state()
    )) as any;
    expect(out.content.map((p: any) => p.content)).toEqual(['first', 'second']);
    expect(out.content.every((p: any) => !p.image)).toBe(true);
    expect(out.pictureError).toContain("couldn't create the pictures");
  });

  it("each picture takes one AI image credit of the run's workspace", async () => {
    const generateImage = jest.fn().mockResolvedValue('aGVsbG8=');
    const subscription = imageCredits();
    await makeService(generateImage, jest.fn(), subscription).generatePictures(
      state()
    );
    expect(
      subscription.useCreditForOrganizationId.mock.calls.map((c) => c.slice(0, 2))
    ).toEqual([
      ['org-1', 'ai_images'],
      ['org-1', 'ai_images'],
    ]);
    expect(generateImage).toHaveBeenCalledTimes(2);
  });

  it('out of credits: OpenAI is never asked, and the posts come back saying why', async () => {
    const generateImage = jest.fn().mockResolvedValue('aGVsbG8=');
    const out = (await makeService(
      generateImage,
      jest.fn(),
      imageCredits(0)
    ).generatePictures(state())) as any;

    expect(generateImage).not.toHaveBeenCalled();
    expect(uploadSimple).not.toHaveBeenCalled();
    expect(out.content.map((p: any) => p.content)).toEqual(['first', 'second']);
    expect(out.content.every((p: any) => !p.image)).toBe(true);
    expect(out.pictureError).toContain("You're out of AI image credits this month");
  });

  it('a thread longer than the credits left gets only as many pictures as credits', async () => {
    const generateImage = jest.fn().mockResolvedValue('aGVsbG8=');
    const out = (await makeService(
      generateImage,
      jest.fn(),
      imageCredits(1)
    ).generatePictures(
      state({
        content: [
          { content: 'first', prompt: 'a red bicycle' },
          { content: 'second', prompt: 'a blue kite' },
          { content: 'third', prompt: 'a green boat' },
        ],
      })
    )) as any;

    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(out.content.filter((p: any) => p.image)).toHaveLength(1);
    expect(out.pictureError).toContain('2 of 3 pictures');
    expect(out.pictureError).toContain('out of AI image credits');
  });

  it('a picture OpenAI fails to make does not use up a credit', async () => {
    const generateImage = jest
      .fn()
      .mockRejectedValueOnce(new Error('quota'))
      .mockResolvedValueOnce('aGVsbG8=');
    const subscription = imageCredits(1);
    const first = (await makeService(generateImage, jest.fn(), subscription).generatePictures(
      state({ content: [{ content: 'first', prompt: 'a red bicycle' }] })
    )) as any;
    expect(first.content[0].image).toBeUndefined();

    const second = (await makeService(generateImage, jest.fn(), subscription).generatePictures(
      state({ content: [{ content: 'again', prompt: 'a red bicycle' }] })
    )) as any;
    expect(second.content[0].image).toBeTruthy();
    expect(second.pictureError).toBeUndefined();
  });

  it('does nothing when pictures were not asked for', async () => {
    const generateImage = jest.fn();
    await expect(
      makeService(generateImage).generatePictures(state({ isPicture: false }))
    ).resolves.toEqual({});
    expect(generateImage).not.toHaveBeenCalled();
  });

  it('saves the stored pictures to the media library without uploading them again', async () => {
    const saveFile = jest.fn(async (_org, name, path) => ({
      id: `m-${name}`,
      name,
      path,
    }));
    const out = (await makeService(jest.fn(), saveFile).uploadPictures(
      state({
        content: [
          { content: 'first', image: 'https://uploads.example.test/a.png' },
          { content: 'second' },
        ],
      })
    )) as any;

    expect(uploadSimple).not.toHaveBeenCalled();
    expect(saveFile).toHaveBeenCalledWith(
      'org-1',
      'a.png',
      'https://uploads.example.test/a.png'
    );
    expect(out.content[0].image).toEqual({
      id: 'm-a.png',
      name: 'a.png',
      path: 'https://uploads.example.test/a.png',
    });
    expect(out.content[1]).toEqual({ content: 'second' });
    expect(out.pictureError).toBeUndefined();
  });

  it('a media row that cannot be saved drops that picture instead of failing', async () => {
    const saveFile = jest.fn().mockRejectedValue(new Error('db down'));
    const out = (await makeService(jest.fn(), saveFile).uploadPictures(
      state({
        content: [{ content: 'first', image: 'https://uploads.example.test/a.png' }],
      })
    )) as any;
    expect(out.content).toEqual([{ content: 'first' }]);
    expect(out.pictureError).toContain("couldn't create the pictures");
  });
});
