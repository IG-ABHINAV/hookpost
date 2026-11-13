import 'reflect-metadata';
import { createHash } from 'crypto';
import { Prisma, Provider } from '@prisma/client';
import { UsersRepository } from '@hookpost/nestjs-libraries/database/prisma/users/users.repository';

// UsersRepository only needs these as injection tokens; the real module opens
// a database connection. Each test hands in a fake `user` model.
jest.mock('@hookpost/nestjs-libraries/database/prisma/prisma.service', () => ({
  PrismaRepository: class {},
  PrismaTransaction: class {},
}));

const md5 = (value: string) => createHash('md5').update(value).digest('hex');

// A user row as Prisma returns it, every personal column filled in.
const row = {
  id: 'user-1',
  email: 'Jo.Mehta@Example.com',
  password: '$2b$10$saltedhashsaltedhashsaltedhashsaltedhashsaltedhash',
  providerName: Provider.GOOGLE,
  name: 'Jo',
  lastName: 'Mehta',
  isSuperAdmin: false,
  bio: 'I post about trains',
  audience: 1200,
  pictureId: 'media-1',
  providerId: '112233445566778899001',
  timezone: 330,
  createdAt: new Date('2026-10-01T09:00:00Z'),
  updatedAt: new Date('2026-10-05T09:00:00Z'),
  lastReadNotifications: new Date('2026-10-05T09:00:00Z'),
  inviteId: 'invite-1',
  activated: true,
  account: 'acct_connected_1',
  connectedAccount: true,
  lastOnline: new Date('2026-10-06T09:00:00Z'),
  ip: '203.0.113.7',
  signupCountry: 'IN',
  signupRegion: 'Maharashtra',
  signupCity: 'Mumbai',
  signupGeoAt: new Date('2026-10-01T09:01:00Z'),
  agent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0',
  deletedAt: null,
  sendSuccessEmails: true,
  sendFailureEmails: true,
  sendStreakEmails: true,
};

// Columns deleteAccount leaves alone on purpose. None of them identifies a
// person: a key, a sign-in method, flags, numbers and timestamps.
const KEPT = [
  'id',
  'providerName',
  'isSuperAdmin',
  'audience',
  'timezone',
  'createdAt',
  'updatedAt',
  'lastReadNotifications',
  'inviteId',
  'activated',
  'connectedAccount',
  'lastOnline',
  'sendSuccessEmails',
  'sendFailureEmails',
  'sendStreakEmails',
];

const setup = (found: any = row) => {
  const user = {
    findUnique: jest.fn(async () => found),
    update: jest.fn(async (args: any) => ({ ...found, ...args.data })),
    updateMany: jest.fn(async () => ({ count: 1 })),
  };
  const repository = new UsersRepository({ model: { user } } as any, {} as any);
  return { repository, user };
};

describe('UsersRepository.deleteAccount', () => {
  it('clears the sign-up country, region and city with the rest of the row', async () => {
    const { repository, user } = setup();

    await repository.deleteAccount('user-1');

    expect(user.update).toHaveBeenCalledTimes(1);
    const [{ where, data }] = user.update.mock.calls[0] as any;
    expect(where).toEqual({ id: 'user-1' });
    expect(data).toMatchObject({
      password: null,
      bio: null,
      ip: null,
      agent: null,
      account: null,
      pictureId: null,
      signupCountry: null,
      signupRegion: null,
      signupCity: null,
      signupGeoAt: null,
    });
    expect(data.deletedAt).toBeInstanceOf(Date);
  });

  it('replaces email, name and sign-in id with hashes', async () => {
    const { repository, user } = setup();

    await repository.deleteAccount('user-1');

    const [{ data }] = user.update.mock.calls[0] as any;
    expect(data.email).toMatch(/^deleted_[0-9a-f]{32}_.{5}$/);
    expect(data.email.split('_')[1]).toBe(md5('jo.mehta@example.com'));
    expect(data.name).toBe(md5('Jo'));
    expect(data.lastName).toBe(md5('Mehta'));
    expect(data.providerId).toBe(md5('112233445566778899001'));
  });

  it('leaves no readable personal value in what it writes', async () => {
    const { repository, user } = setup();

    await repository.deleteAccount('user-1');

    const written = JSON.stringify((user.update.mock.calls[0] as any)[0].data);
    for (const value of [
      'Jo.Mehta',
      'example.com',
      'I post about trains',
      '203.0.113.7',
      'Mozilla',
      'acct_connected_1',
      'Maharashtra',
      'Mumbai',
    ]) {
      expect(written).not.toContain(value);
    }
  });

  it('names every column of the User model, so a new one cannot be forgotten', async () => {
    const { repository, user } = setup();

    await repository.deleteAccount('user-1');

    const written = Object.keys((user.update.mock.calls[0] as any)[0].data);
    const columns = Object.keys(Prisma.UserScalarFieldEnum);
    const unaccountedFor = columns.filter(
      (column) => !written.includes(column) && !KEPT.includes(column)
    );
    // A new personal column on User goes into deleteAccount (cleared or
    // hashed). One that is not personal goes into KEPT above, with the others.
    expect(unaccountedFor).toEqual([]);
    // And nothing listed as kept is also being rewritten.
    expect(written.filter((column) => KEPT.includes(column))).toEqual([]);
  });

  it('revokes the Approved Apps connections and drops their tokens', async () => {
    const { repository, user } = setup();

    await repository.deleteAccount('user-1');

    const [{ data }] = user.update.mock.calls[0] as any;
    expect(data.oauthAuthorizations.updateMany).toEqual([
      { where: { revokedAt: null }, data: { revokedAt: expect.any(Date) } },
      { where: {}, data: { accessToken: null, authorizationCode: null } },
    ]);
    // Already revoked connections keep their own revocation time, and
    // everything else is revoked at the moment of deletion.
    expect(data.oauthAuthorizations.updateMany[0].data.revokedAt).toEqual(
      data.deletedAt
    );
  });

  it('does nothing for an unknown or already deleted account', async () => {
    const missing = setup(null);
    await missing.repository.deleteAccount('nobody');
    expect(missing.user.update).not.toHaveBeenCalled();

    const deleted = setup({ ...row, deletedAt: new Date('2026-10-08') });
    await deleted.repository.deleteAccount('user-1');
    expect(deleted.user.update).not.toHaveBeenCalled();
  });
});

describe('UsersRepository.recordSignupGeo', () => {
  it('writes the location once, and never onto a deleted account', async () => {
    const { repository, user } = setup();

    await repository.recordSignupGeo('user-1', {
      country: 'IN',
      region: 'Maharashtra',
      city: 'Mumbai',
    });

    const [{ where, data }] = user.updateMany.mock.calls[0] as any;
    expect(where).toEqual({ id: 'user-1', signupGeoAt: null, deletedAt: null });
    expect(data).toMatchObject({
      signupCountry: 'IN',
      signupRegion: 'Maharashtra',
      signupCity: 'Mumbai',
    });
    expect(data.signupGeoAt).toBeInstanceOf(Date);
  });
});

describe('UsersRepository.markOnline', () => {
  it('moves lastOnline only when it is older than the gap, and never on a deleted account', async () => {
    const { repository, user } = setup();
    const now = new Date('2026-10-22T10:00:00Z');

    await repository.markOnline('user-1', now, 60 * 60 * 1000);

    const [{ where, data }] = user.updateMany.mock.calls[0] as any;
    expect(where).toEqual({
      id: 'user-1',
      deletedAt: null,
      lastOnline: { lt: new Date('2026-10-22T09:00:00Z') },
    });
    expect(data).toEqual({ lastOnline: now });
  });
});
