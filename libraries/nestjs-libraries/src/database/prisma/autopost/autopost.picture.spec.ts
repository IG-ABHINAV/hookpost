import 'reflect-metadata';

// RSS auto-post with "add picture" used LangChain's DallEAPIWrapper too, which
// the gpt-image models reject (response_format). It now generates through
// OpenaiService and stores the picture, and a failed picture leaves the draft
// without one instead of failing the run. The picture takes one of the
// plan's monthly AI image credits, like the post generator's.
//   pnpm exec jest -c apps/backend/jest.config.ts autopost.picture

// The default AI provider (Gemini on Vertex) needs a project id to build its
// client; the LangChain model itself is mocked below.
process.env.VERTEX_PROJECT = process.env.VERTEX_PROJECT || 'test-project';

jest.mock('@langchain/openai', () => ({
  ChatOpenAI: class {
    withStructuredOutput() {
      return {};
    }
  },
}));
jest.mock('@langchain/core/prompts', () => ({
  ChatPromptTemplate: {
    fromTemplate: () => ({
      pipe: () => ({
        invoke: async () => ({
          generatedTextToBeSentToDallE: 'a lighthouse at dawn',
        }),
      }),
    }),
  },
}));
const uploadSimple = jest.fn();
jest.mock('@hookpost/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({ uploadSimple }) },
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/autopost/autopost.repository',
  () => ({ AutopostRepository: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/posts/posts.service',
  () => ({ PostsService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/openai/openai.service', () => ({
  OpenaiService: class {},
}));
jest.mock('nestjs-temporal-core', () => ({ TemporalService: class {} }));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  () => ({ SubscriptionService: class {} })
);

import { AutopostService } from '@hookpost/nestjs-libraries/database/prisma/autopost/autopost.service';
import { CreditsExceededError } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/credits.exceeded.error';

const imageCredits = (left = 100) => ({
  useCreditForOrganizationId: jest.fn(
    async (_org: string, type: string, run: () => Promise<unknown>) => {
      if (left <= 0) throw new CreditsExceededError(type);
      left--;
      return run();
    }
  ),
});

const make = (generateImage: jest.Mock, subscription = imageCredits()) =>
  new AutopostService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { generateImage } as any,
    subscription as any
  );

const state = {
  body: { organizationId: 'org-rss', addPicture: true },
  load: { description: 'A new lighthouse opened', url: 'https://x.test/a', date: '' },
  description: 'A new lighthouse opened',
} as any;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('AutopostService.generatePicture', () => {
  it('stores the generated picture and uses our URL', async () => {
    uploadSimple.mockResolvedValue('https://uploads.example.test/p.png');
    const generateImage = jest.fn().mockResolvedValue('aGVsbG8=');
    const out = await make(generateImage).generatePicture(state);
    expect(generateImage).toHaveBeenCalledWith('a lighthouse at dawn');
    expect(uploadSimple).toHaveBeenCalledWith('data:image/png;base64,aGVsbG8=');
    expect(out.image).toBe('https://uploads.example.test/p.png');
  });

  it("takes one AI image credit of the feed's workspace", async () => {
    uploadSimple.mockResolvedValue('https://uploads.example.test/p.png');
    const subscription = imageCredits();
    await make(jest.fn().mockResolvedValue('aGVsbG8='), subscription).generatePicture(
      state
    );
    expect(subscription.useCreditForOrganizationId).toHaveBeenCalledTimes(1);
    expect(subscription.useCreditForOrganizationId.mock.calls[0].slice(0, 2)).toEqual([
      'org-rss',
      'ai_images',
    ]);
  });

  it('out of credits: the draft goes without a picture and OpenAI is never asked', async () => {
    const generateImage = jest.fn().mockResolvedValue('aGVsbG8=');
    const out = await make(generateImage, imageCredits(0)).generatePicture(state);
    expect(generateImage).not.toHaveBeenCalled();
    expect(uploadSimple).not.toHaveBeenCalled();
    expect(out.image).toBe('');
    expect(out.description).toBe('A new lighthouse opened');
  });

  it('a picture that fails leaves the draft without one', async () => {
    const generateImage = jest
      .fn()
      .mockRejectedValue(new Error("400 Unknown parameter: 'response_format'."));
    const out = await make(generateImage).generatePicture(state);
    expect(out.image).toBe('');
    expect(out.description).toBe('A new lighthouse opened');
    expect(uploadSimple).not.toHaveBeenCalled();
  });
});
