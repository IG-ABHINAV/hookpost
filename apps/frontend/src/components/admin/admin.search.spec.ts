import { adminSearchMatches } from './admin.search';

// The super-admin users search, which the owner's sale alert links into
// with ?q=<workspace id>.

const priya = {
  id: 'user-7c1f',
  email: 'priya@chaipoint.in',
  name: 'Priya Shah',
  organizations: [
    { organization: { id: '02c7719a-8cf5-4d53-bcee-d0deffd731f7', name: 'Chai Point Social' } },
  ],
};

describe('adminSearchMatches', () => {
  it('an empty search matches everyone', () => {
    expect(adminSearchMatches(priya, '')).toBe(true);
    expect(adminSearchMatches(priya, '   ')).toBe(true);
  });

  it('part of an email, a name or a workspace name, any case', () => {
    expect(adminSearchMatches(priya, 'CHAIPOINT.in')).toBe(true);
    expect(adminSearchMatches(priya, 'shah')).toBe(true);
    expect(adminSearchMatches(priya, 'point soc')).toBe(true);
    expect(adminSearchMatches(priya, 'someone else')).toBe(false);
  });

  it('a whole workspace id (the sale alert link) or user id', () => {
    expect(adminSearchMatches(priya, '02c7719a-8cf5-4d53-bcee-d0deffd731f7')).toBe(true);
    expect(adminSearchMatches(priya, ' 02C7719A-8CF5-4D53-BCEE-D0DEFFD731F7 ')).toBe(true);
    expect(adminSearchMatches(priya, 'user-7c1f')).toBe(true);
  });

  it('part of an id is not a match (ids are not searched as text)', () => {
    expect(adminSearchMatches(priya, '02c7719a')).toBe(false);
    expect(adminSearchMatches(priya, 'user-7')).toBe(false);
  });

  it('copes with missing fields', () => {
    expect(adminSearchMatches({ id: 'u1' }, 'x')).toBe(false);
    expect(adminSearchMatches({ id: 'u1', organizations: [{ organization: null }] }, 'x')).toBe(false);
    expect(adminSearchMatches({ id: 'u1', email: null, name: null, organizations: null }, 'u1')).toBe(true);
  });
});
