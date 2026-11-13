/**
 * The super-admin users page's search: part of an email, a name, a
 * workspace name or a sign-up source (label such as "claude.ai" or its utm
 * campaign), or a whole user or workspace id (the owner's sale alert links to
 * /admin/users?q=<workspace id>).
 */
export interface AdminSearchable {
  id: string;
  email?: string | null;
  name?: string | null;
  organizations?: Array<{
    organization?: {
      id?: string | null;
      name?: string | null;
      signupSource?: { label?: string | null; campaign?: string | null } | null;
    } | null;
  }> | null;
}

export function adminSearchMatches(user: AdminSearchable, query: string): boolean {
  const q = (query || '').trim().toLowerCase();
  if (!q) return true;
  const has = (v?: string | null) => !!v && v.toLowerCase().includes(q);
  const is = (v?: string | null) => !!v && v.toLowerCase() === q;
  return (
    has(user.email) ||
    has(user.name) ||
    is(user.id) ||
    !!user.organizations?.some(
      (o) =>
        has(o.organization?.name) ||
        is(o.organization?.id) ||
        has(o.organization?.signupSource?.label) ||
        has(o.organization?.signupSource?.campaign)
    )
  );
}
