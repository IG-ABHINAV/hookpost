'use client';

import { AdminHeader } from '@hookpost/frontend/components/admin/admin.header';
import React, { FC, useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import useSWR from 'swr';
import copy from 'copy-to-clipboard';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import { useToaster } from '@hookpost/react/toaster/toaster';
import { Button } from '@hookpost/react/form/button';
import { LoadingComponent } from '@hookpost/frontend/components/layout/loading';
import type { PlanState } from '@hookpost/frontend/components/layout/user.context';
import { adminSearchMatches } from '@hookpost/frontend/components/admin/admin.search';
import {
  CheckoutSignalView,
  istTime,
  signupRows,
  SignupDetailsView,
  sourceCell,
  SignupSourceView,
} from '@hookpost/frontend/components/admin/signup.source.view';
import {
  disputeLine,
  filterWorkspaces,
  marketplaceLine,
  membersLabel,
  roleLabel,
  WorkspacesResponse,
} from '@hookpost/frontend/components/admin/workspaces.view';
import {
  BILLING_STATE_META,
  BillingState,
  BillingView,
  billingTooltip,
  countRowStates,
  rowInState,
  visibleChips,
} from '@hookpost/frontend/components/admin/billing.badge';
import {
  PlanActionDialog,
  PlanActionWorkspace,
} from '@hookpost/frontend/components/admin/plan.action.dialog';

dayjs.extend(relativeTime);

interface OrganizationInfo {
  id: string;
  name: string;
  paymentId: string | null;
  allowTrial: boolean;
  isTrailing: boolean;
  createdAt: string;
  subscription: {
    id: string;
    subscriptionTier: string;
    isLifetime: boolean;
    period: string;
    totalChannels: number;
    cancelAt: string | null;
    createdAt: string;
  } | null;
  /** From GET /admin/users: the workspace's plan state (trial.policy.ts planState). */
  planState?: PlanState;
  freePlanAvailable?: boolean;
  /** From GET /admin/users: the one billing state the badge shows (billing.state.ts). */
  billing?: BillingView;
  /** From GET /admin/users: where the sign-up came from (null: not recorded). */
  signupSource?: SignupSourceView | null;
  /** DIRECT, or the marketplace the workspace came through. */
  source?: string | null;
  /** Live members of the workspace. */
  members?: number;
  _count: {
    Integration: number;
    post: number;
  };
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  isSuperAdmin: boolean;
  activated: boolean;
  providerName: string;
  createdAt: string;
  organizations: {
    id: string;
    role: string;
    organization: OrganizationInfo;
  }[];
  /** The billing states of this user's workspaces (what the state chips filter on). */
  billingStates?: BillingState[];
}

interface UsersApiResponse {
  metrics: {
    totalUsers: number;
    deletedUsers?: number;
    totalOrgs: number;
    workspaces?: {
      total: number;
      withUsers: number;
      marketplace: number;
      withoutUsers: number;
      usersWithSeveral: number;
    };
    totalSubscriptions: number;
    activeTrials: number;
    totalIntegrations: number;
    totalPosts: number;
    /** Rows per billing state; a row counts under every state its workspaces are in. */
    states?: Partial<Record<BillingState, number>>;
    /** Live workspaces per source: direct sign-ups and each API marketplace. */
    sources?: { id: string; label: string; workspaces: number }[];
  };
  billingSource?: {
    razorpay: 'ok' | 'partial' | 'not_configured' | 'not_needed';
    failed: number;
    asOf: string;
    sunsetAt: string | null;
  };
  users: UserRow[];
}

interface JourneyEvent {
  id: string;
  type: 'SIGNUP' | 'WORKSPACE' | 'CHANNEL' | 'POST' | 'BILLING';
  title: string;
  description: string;
  timestamp: string;
  metadata?: Record<string, any>;
  status?: 'success' | 'warning' | 'info' | 'error';
}

interface UserJourneyResponse {
  user: {
    id: string;
    email: string;
    name: string | null;
    isSuperAdmin: boolean;
    activated: boolean;
    providerName: string;
    createdAt: string;
  };
  summary: {
    totalWorkspaces: number;
    totalIntegrations: number;
    totalPosts: number;
    publishedPosts: number;
    hasActiveSubscription: boolean;
    isTrailing: boolean;
  };
  /** Where the sign-up came from and how far it got (signup.source.ts). */
  signup?: SignupDetailsView;
  /** Every live workspace the user is in, oldest membership first. */
  workspaces?: {
    id: string;
    name: string;
    role: string;
    members: number;
    source: string;
    sourceLabel: string;
    createdAt: string;
  }[];
  events: JourneyEvent[];
}

const UserJourneyModal: FC<{
  userId: string;
  onClose: () => void;
  /** Razorpay's checkout record per workspace (GET /admin/checkout-signals), if read. */
  checkoutSignals?: Record<string, CheckoutSignalView>;
}> = ({ userId, onClose, checkoutSignals }) => {
  const fetch = useFetch();
  // A text selection that starts in the drawer and ends on the backdrop must not close it.
  const pressedBackdrop = useRef(false);
  const { data, error, isLoading } = useSWR<UserJourneyResponse>(
    `/admin/users/${userId}/journey`,
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error('Failed to load user journey');
      }
      return res.json();
    }
  );

  if (typeof document === 'undefined') {
    return null;
  }

  // Portal on <body>: inside the page it sat at z-[400] under the app chrome.
  return createPortal(
    <div
      className="fixed inset-0 z-[1000] bg-black/70 backdrop-blur-sm flex justify-end animate-fade"
      onMouseDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (pressedBackdrop.current && e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        data-testid="journey-drawer"
        className="admin-touch w-full max-w-[620px] bg-newBgColorInner text-textColor border-s border-newTableBorder h-full flex flex-col shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drawer Header */}
        <div className="p-[20px] border-b border-newTableBorder bg-newBgColorInner flex items-center justify-between">
          <div className="flex items-center gap-[12px] min-w-0">
            <div className="w-[42px] h-[42px] shrink-0 rounded-full bg-gradient-to-tr from-hp-primary to-hp-primary-active flex items-center justify-center font-[700] text-hp-on-primary text-[16px]">
              {data?.user?.email?.slice(0, 2).toUpperCase() || 'U'}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-[8px]">
                <h2 className="text-[17px] font-[700] text-textColor break-all">
                  {data?.user?.email || 'User Journey'}
                </h2>
                {data?.user?.isSuperAdmin && (
                  <span className="px-[6px] py-[1px] text-[10px] font-[700] bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/40 rounded-full">
                    SUPERADMIN
                  </span>
                )}
              </div>
              <p className="text-[12px] opacity-65">
                {data?.user?.name ? `${data.user.name} • ` : ''}
                Joined {data?.user?.createdAt ? dayjs(data.user.createdAt).format('MMM D, YYYY') : '—'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-[32px] h-[32px] rounded-[8px] bg-white/5 hover:bg-white/10 flex items-center justify-center text-[16px] text-textColor transition-all cursor-pointer"
          >
            ✕
          </button>
        </div>

        {/* Drawer Body */}
        <div className="flex-1 overflow-y-auto p-[20px] flex flex-col gap-[20px]">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-[60px] gap-[12px]">
              <LoadingComponent height={50} width={50} />
              <div className="text-[13px] opacity-70">Loading user lifecycle journey...</div>
            </div>
          ) : error ? (
            <div className="p-[16px] bg-red-500/15 border border-red-800 rounded-[8px] text-red-700 dark:text-red-300 text-[13px]">
              Failed to load journey: {error.message}
            </div>
          ) : data ? (
            <>
              {/* Sign-up: where they came from and how far they got, in plain words. */}
              {data.signup && (
                <div data-testid="signup-details">
                  <h3 className="text-[13px] uppercase tracking-wider font-[700] opacity-75 mb-[10px]">
                    Sign-up
                  </h3>
                  <dl className="grid grid-cols-[minmax(140px,auto)_1fr] gap-x-[14px] gap-y-[6px] border border-newTableBorder bg-newBgColorInner rounded-[10px] p-[14px] text-[13px]">
                    {signupRows(
                      data.signup,
                      data.signup.workspaceId
                        ? checkoutSignals?.[data.signup.workspaceId]
                        : undefined,
                      !!checkoutSignals
                    ).map(([label, value]) => (
                      <React.Fragment key={label}>
                        <dt className="opacity-60">{label}</dt>
                        <dd className="text-textColor break-words" data-testid={`signup-${label}`}>
                          {value}
                        </dd>
                      </React.Fragment>
                    ))}
                  </dl>
                </div>
              )}

              {/* The user's workspaces: role and members. */}
              {!!data.workspaces?.length && (
                <div data-testid="user-workspaces">
                  <h3 className="text-[13px] uppercase tracking-wider font-[700] opacity-75 mb-[10px]">
                    Workspaces ({data.workspaces.length})
                  </h3>
                  <ul className="flex flex-col gap-[6px] border border-newTableBorder bg-newBgColorInner rounded-[10px] p-[12px] text-[13px]">
                    {data.workspaces.map((w) => (
                      <li key={w.id} className="flex flex-wrap items-baseline gap-x-[8px]" data-testid="user-workspace">
                        <span className="text-textColor font-[600]">{w.name}</span>
                        <span className="opacity-70">
                          {roleLabel(w.role)} · {membersLabel(w.members)} · {w.sourceLabel}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Summary Stats Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-[10px]">
                <div className="border border-newTableBorder bg-newBgColorInner rounded-[10px] p-[12px] text-center">
                  <div className="text-[11px] opacity-60">Workspaces</div>
                  <div className="text-[18px] font-[700] text-textColor mt-[2px]">
                    {data.summary.totalWorkspaces}
                  </div>
                </div>
                <div className="border border-newTableBorder bg-newBgColorInner rounded-[10px] p-[12px] text-center">
                  <div className="text-[11px] opacity-60">Channels</div>
                  <div className="text-[18px] font-[700] text-sky-400 mt-[2px]">
                    {data.summary.totalIntegrations}
                  </div>
                </div>
                <div className="border border-newTableBorder bg-newBgColorInner rounded-[10px] p-[12px] text-center">
                  <div className="text-[11px] opacity-60">Posts</div>
                  <div className="text-[18px] font-[700] text-emerald-400 mt-[2px]">
                    {data.summary.totalPosts}
                  </div>
                  <div className="text-[9px] opacity-50">{data.summary.publishedPosts} published</div>
                </div>
                <div className="border border-newTableBorder bg-newBgColorInner rounded-[10px] p-[12px] text-center">
                  <div className="text-[11px] opacity-60">Billing</div>
                  <div className="text-[12px] font-[700] mt-[4px]">
                    {data.summary.hasActiveSubscription ? (
                      <span className="text-emerald-700 dark:text-emerald-300">Paid Plan</span>
                    ) : data.summary.isTrailing ? (
                      <span className="text-amber-700 dark:text-amber-300">Free Plan (never subscribed)</span>
                    ) : (
                      <span className="opacity-70">Free Tier</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Chronological Timeline */}
              <div>
                <h3 className="text-[13px] uppercase tracking-wider font-[700] opacity-75 mb-[14px] flex items-center gap-[6px]">
                  <span>🧭</span> Activity & Lifecycle Timeline ({data.events.length} events)
                </h3>

                {data.events.length === 0 ? (
                  <div className="text-center py-[40px] opacity-50 border border-newTableBorder rounded-[10px] bg-newBgColorInner text-[13px]">
                    No activity recorded yet for this account.
                  </div>
                ) : (
                  <div className="relative border-s-2 border-newTableBorder ms-[16px] flex flex-col gap-[16px] py-[6px]">
                    {data.events.map((evt) => {
                      const icon =
                        evt.type === 'SIGNUP'
                          ? '🚀'
                          : evt.type === 'WORKSPACE'
                          ? '🏢'
                          : evt.type === 'CHANNEL'
                          ? '🔗'
                          : evt.type === 'POST'
                          ? '📝'
                          : '💳';

                      const dotBg =
                        evt.status === 'success'
                          ? 'bg-emerald-500 ring-emerald-500/20'
                          : evt.status === 'error'
                          ? 'bg-rose-500 ring-rose-500/20'
                          : evt.status === 'warning'
                          ? 'bg-amber-500 ring-amber-500/20'
                          : 'bg-hp-primary ring-hp-primary/20';

                      return (
                        <div key={evt.id} className="relative ps-[24px]">
                          {/* Dot on timeline */}
                          <div
                            className={`absolute -start-[7px] top-[14px] w-[12px] h-[12px] rounded-full ring-4 ${dotBg}`}
                          />

                          {/* Event Card */}
                          <div className="border border-newTableBorder rounded-[10px] p-[14px] bg-newBgColorInner hover:border-primary/50 transition-all">
                            <div className="flex items-center justify-between gap-[8px]">
                              <div className="flex items-center gap-[6px] font-[600] text-textColor text-[13px]">
                                <span>{icon}</span>
                                <span>{evt.title}</span>
                              </div>
                              <span className="text-[11px] opacity-60 whitespace-nowrap">
                                {dayjs(evt.timestamp).fromNow()}
                              </span>
                            </div>

                            <p className="text-[12px] opacity-80 mt-[6px] leading-[18px]">
                              {evt.description}
                            </p>

                            <div className="flex items-center justify-between gap-[8px] mt-[10px] pt-[8px] border-t border-newTableBorder/50 text-[11px] opacity-60">
                              <span>{dayjs(evt.timestamp).format('MMM D, YYYY • h:mm A')}</span>
                              {evt.status && (
                                <span className={`capitalize font-[600] ${
                                  evt.status === 'success'
                                    ? 'text-emerald-400'
                                    : evt.status === 'error'
                                    ? 'text-rose-400'
                                    : evt.status === 'warning'
                                    ? 'text-amber-400'
                                    : 'text-hp-primary-text'
                                }`}>
                                  {evt.status}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  );
};

/**
 * Every live workspace of one source (or all), from GET /admin/workspaces:
 * name and owner, source, members, billing state, channels, posts, created
 * (IST), and for a marketplace subscriber its masked id, product, plan,
 * status, calls in the last 7 days and last call.
 */
const WorkspacesList: FC<{ source: string | null; onClose: () => void }> = ({
  source,
  onClose,
}) => {
  const fetch = useFetch();
  const [query, setQuery] = useState('');
  const { data, error, isLoading, mutate } = useSWR<WorkspacesResponse>(
    'admin-workspaces',
    async () => {
      const res = await fetch('/admin/workspaces');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    { revalidateOnFocus: false }
  );
  const rows = filterWorkspaces(data?.workspaces || [], source, query);
  const title = source
    ? `${data?.workspaces.find((w) => w.source === source)?.sourceLabel || source} workspaces`
    : 'All workspaces';
  return (
    <div
      data-testid="workspaces-list"
      className="bg-newBgColorInner border border-newTableBorder rounded-[12px] p-[14px] flex flex-col gap-[10px]"
    >
      <div className="flex flex-wrap items-center gap-[10px]">
        <h3 className="text-[14px] font-[700] text-textColor">
          {title} <span className="opacity-60 font-[400]">({rows.length})</span>
        </h3>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search workspace, owner or subscriber..."
          className="bg-newBgColor border border-newTableBorder rounded-[8px] px-[10px] py-[5px] text-[12px] w-full sm:w-auto sm:ms-auto order-last sm:order-none min-w-0 sm:min-w-[220px]"
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close workspaces"
          className="ms-auto sm:ms-0 w-[28px] h-[28px] rounded-[8px] bg-white/5 hover:bg-white/10 cursor-pointer"
        >
          ✕
        </button>
      </div>
      {isLoading ? (
        <div className="py-[20px] text-[13px] opacity-70">Loading workspaces...</div>
      ) : error ? (
        <div className="text-[13px] text-red-700 dark:text-red-300">Could not load workspaces: {error.message}</div>
      ) : (
        <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
          <table className="w-full text-start text-[12px]">
            <thead className="text-[11px] uppercase opacity-60 sticky top-0 bg-newBgColorInner">
              <tr>
                <th className="py-[6px] px-[8px] text-start">Workspace</th>
                <th className="py-[6px] px-[8px] text-start">Source</th>
                <th className="py-[6px] px-[8px] text-center">Members</th>
                <th className="py-[6px] px-[8px] text-start">Billing</th>
                <th className="py-[6px] px-[8px] text-center">Channels</th>
                <th className="py-[6px] px-[8px] text-center">Posts</th>
                <th className="py-[6px] px-[8px] text-start">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-newTableBorder">
              {rows.map((w) => (
                <tr key={w.id} data-testid="workspace-row" data-id={w.id}>
                  <td className="py-[8px] px-[8px] align-top">
                    <div className="text-textColor font-[600] break-all">{w.name}</div>
                    <div className="opacity-60 break-all">
                      {w.owner || (w.marketplace ? 'No users (marketplace subscriber)' : 'No users')}
                    </div>
                  </td>
                  <td className="py-[8px] px-[8px] align-top">
                    <div>{w.sourceLabel}</div>
                    {w.marketplace && (
                      <div className="opacity-70" data-testid="workspace-marketplace">
                        <span className="font-mono">{w.marketplace.subscriber}</span> ·{' '}
                        {marketplaceLine(w.marketplace)}
                      </div>
                    )}
                  </td>
                  <td className="py-[8px] px-[8px] text-center align-top">{w.members}</td>
                  <td className="py-[8px] px-[8px] align-top">
                    <BillingBadge view={w.billing} />
                    {w.dispute && (
                      <DisputeActions
                        workspaceId={w.id}
                        line={disputeLine(w.dispute)!}
                        onChanged={() => mutate()}
                      />
                    )}
                  </td>
                  <td className="py-[8px] px-[8px] text-center align-top">{w.channels}</td>
                  <td className="py-[8px] px-[8px] text-center align-top">{w.posts}</td>
                  <td className="py-[8px] px-[8px] align-top whitespace-nowrap">{istTime(w.createdAt)}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={7} className="py-[16px] text-center opacity-60">
                    No workspaces match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

/**
 * A disputed workspace's row in the Workspaces list: the chargeback, and the
 * owner's three moves (dispute.evidence.ts, AdminController): download the
 * evidence pack to answer Razorpay within 3 business days, restore the plan
 * once the dispute is won (the server checks Razorpay says won), or clear
 * the lock so the workspace can buy again.
 */
const DisputeActions: FC<{ workspaceId: string; line: string; onChanged: () => void }> = ({
  workspaceId,
  line,
  onChanged,
}) => {
  const fetch = useFetch();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const base = `/admin/workspaces/${encodeURIComponent(workspaceId)}/dispute`;

  const download = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(`${base}/evidence`);
      if (!res.ok) throw new Error(res.status === 404 ? 'No evidence pack for this workspace' : `HTTP ${res.status}`);
      const name =
        /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] ||
        `dispute-evidence-${workspaceId}.txt`;
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      setNote(null);
    } catch (e: any) {
      setNote(e?.message || 'Could not download the evidence pack');
    } finally {
      setBusy(false);
    }
  }, [base, fetch, workspaceId]);

  const act = useCallback(
    async (what: 'restore' | 'clear') => {
      const ask =
        what === 'restore'
          ? 'Give back the plan for the time already paid for? Only works once Razorpay says the dispute is won.'
          : 'Clear the dispute so this workspace can buy a plan again? Its old plan is not given back.';
      if (!window.confirm(ask)) return;
      setBusy(true);
      try {
        const res = await fetch(`${base}/${what}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const out = await res.json();
        const done = what === 'restore' ? out.restored : out.cleared;
        setNote(done ? (what === 'restore' ? 'Plan restored.' : 'Dispute cleared.') : out.reason || 'Nothing changed.');
        if (done) onChanged();
      } catch (e: any) {
        setNote(e?.message || 'Failed');
      } finally {
        setBusy(false);
      }
    },
    [base, fetch, onChanged]
  );

  return (
    <div className="mt-[6px] flex flex-col gap-[4px]" data-testid="workspace-dispute">
      <div className="text-red-700 dark:text-red-300 font-[600]">{line}</div>
      <div className="flex flex-wrap gap-[6px]">
        <button type="button" disabled={busy} onClick={download} className="underline disabled:opacity-50">
          Evidence pack
        </button>
        <button type="button" disabled={busy} onClick={() => act('restore')} className="underline disabled:opacity-50">
          Restore plan (won)
        </button>
        <button type="button" disabled={busy} onClick={() => act('clear')} className="underline disabled:opacity-50">
          Clear dispute
        </button>
      </div>
      {note && (
        <div className="opacity-80" data-testid="workspace-dispute-note">
          {note}
        </div>
      )}
    </div>
  );
};

const MetricCard: FC<{
  title: string;
  value: number;
  icon: string;
  subtext?: string;
  color?: string;
  testId?: string;
}> = ({ title, value, icon, subtext, color, testId }) => (
  <div
    data-testid={testId}
    className="border border-newTableBorder rounded-[12px] p-[16px] bg-newBgColorInner flex flex-col justify-between shadow-sm"
  >
    <div className="flex items-center justify-between">
      <div className="text-[13px] opacity-75 font-medium">{title}</div>
      <div className="text-[20px]">{icon}</div>
    </div>
    <div className="mt-[8px]">
      <div className={`text-[28px] font-[700] ${color || 'text-textColor'}`}>
        {value.toLocaleString()}
      </div>
      {subtext && <div className="text-[11px] opacity-60 mt-[2px]">{subtext}</div>}
    </div>
  </div>
);

/**
 * One workspace's billing state: a colour-coded badge saying what is going on
 * and when ("Free Pro until 3 Feb 2027"), and a line under it.
 */
const BillingBadge: FC<{ view: BillingView; workspace?: string }> = ({ view, workspace }) => {
  const meta = BILLING_STATE_META[view.state] ?? BILLING_STATE_META.no_workspace;
  return (
    <div className="flex flex-col gap-[3px]" data-testid="billing-state" data-state={view.state}>
      {workspace && (
        <span className="text-[10px] opacity-60 truncate max-w-[260px]">{workspace}</span>
      )}
      <span
        title={billingTooltip(view)}
        className={`inline-flex items-center gap-[6px] px-[8px] py-[3px] rounded-full text-[11px] font-[700] border w-max max-w-[300px] ${meta.badge}`}
      >
        <span aria-hidden="true" className={`w-[7px] h-[7px] rounded-full flex-shrink-0 ${meta.dot}`} />
        <span data-testid="billing-label">{view.label}</span>
      </span>
      <span className="text-[10px] opacity-65 max-w-[300px]" data-testid="billing-detail">
        {view.detail}
      </span>
    </div>
  );
};

interface CheckoutPayment {
  id: string;
  status: string;
  amount: number;
  currency: string;
  method: string;
  at: string;
  error: string | null;
}
interface CheckoutSignal {
  checkoutsOpened: number;
  currencies: string[];
  lastOpenedAt: string | null;
  authenticated: boolean;
  /** A Hookpost subscription of this workspace is pending or halted. */
  pastDue?: boolean;
  failedAuthAttempts: number;
  payments: CheckoutPayment[];
}

const money = (amount: number, currency: string) =>
  `${currency === 'INR' ? '₹' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency + ' '}${amount.toLocaleString(
    currency === 'INR' ? 'en-IN' : 'en-US'
  )}`;

// Captured, authorised and refunded all mean the money actually moved: the
// Rs 5 mandate check is refunded straight after it succeeds.
const PAID = ['captured', 'authorized', 'refunded'];

/**
 * Counts before 27 Sep 2026 include every VIEW of the plan screen: it created
 * a Razorpay subscription on page load until then. From that date a
 * subscription is only created when the visitor presses the checkout button.
 *
 * What this workspace did at checkout, from Razorpay: opened it and left,
 * tried the Rs 5 mandate authorisation and failed, or paid. The line under
 * the Razorpay ID answers "did they actually want to pay?".
 */
const CheckoutSignalCell = ({ signal }: { signal?: CheckoutSignal }) => {
  if (!signal) return null;
  const latest = signal.payments[0];
  const paid = signal.payments.filter((p) => PAID.includes(p.status));
  const failed = signal.payments.filter((p) => p.status === 'failed');
  const chip = (cls: string, text: string, title?: string) => (
    <span
      title={title}
      className={`inline-flex w-max items-center gap-[4px] rounded-full border px-[7px] py-[1px] text-[10px] font-[700] ${cls}`}
    >
      {text}
    </span>
  );
  return (
    <div className="mt-[6px] flex flex-col gap-[3px]">
      {paid.length > 0
        ? chip(
            'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40',
            `✓ ${money(paid[0].amount, paid[0].currency)} paid${
              paid[0].status === 'refunded' ? ' (auth, refunded)' : ''
            } · ${dayjs(paid[0].at).format('D MMM')}`
          )
        : latest && latest.status === 'failed'
        ? chip(
            'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/40',
            `✗ ${money(latest.amount, latest.currency)} failed${
              failed.length > 1 ? ` ×${failed.length}` : ''
            } · ${dayjs(latest.at).format('D MMM')}`,
            latest.error || undefined
          )
        : signal.checkoutsOpened > 0
        ? chip(
            'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40',
            `Pricing/checkout opened ${signal.checkoutsOpened}× · never paid`
          )
        : null}
      {(signal.checkoutsOpened > 0 || failed.length > 0) && (
        <span className="text-[10px] opacity-60">
          {signal.checkoutsOpened} checkout{signal.checkoutsOpened === 1 ? '' : 's'}
          {signal.currencies.length ? ` · ${signal.currencies.join('/')}` : ''}
          {signal.lastOpenedAt ? ` · last ${dayjs(signal.lastOpenedAt).fromNow()}` : ''}
          {paid.length === 0 && latest?.error ? ` · "${latest.error.slice(0, 60)}${latest.error.length > 60 ? '…' : ''}"` : ''}
        </span>
      )}
    </div>
  );
};

export const AdminUsersComponent: FC = () => {
  const user = useUser();
  const fetch = useFetch();
  const toaster = useToaster();
  const [planAction, setPlanAction] = useState<{
    workspace: PlanActionWorkspace;
    mode: 'end' | 'restore';
  } | null>(null);
  // ?q= prefills the search: the owner's sale alert links here with the
  // workspace id (see adminSearchMatches).
  const search = useSearchParams();
  const [searchInput, setSearchInput] = useState(() =>
    (search?.get('q') || '').slice(0, 200)
  );
  const [stateFilter, setStateFilter] = useState<'ALL' | 'ADMIN' | BillingState>('ALL');
  const [selectedJourneyUserId, setSelectedJourneyUserId] = useState<string | null>(null);
  /** The Workspaces list: a source id, 'ALL', or closed (null). */
  const [workspaceSource, setWorkspaceSource] = useState<string | null>(null);
  const [togglingAdminId, setTogglingAdminId] = useState<string | null>(null);

  const { data, error, isLoading, mutate } = useSWR<UsersApiResponse>(
    '/admin/users',
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error('Failed to load admin users');
      }
      return res.json();
    },
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    }
  );

  const { data: checkoutSignals } = useSWR<Record<string, CheckoutSignal>>(
    'admin-checkout-signals',
    async () => {
      const res = await fetch('/admin/checkout-signals');
      return res.ok ? res.json() : {};
    },
    { revalidateOnFocus: false }
  );

  const handleCopy = useCallback((text: string, label: string) => {
    copy(text);
    toaster.show(`${label} copied to clipboard`, 'success');
  }, [toaster]);

  // The id must be the UserOrganization id: auth.middleware resolves it with
  // getUserOrg(). This used to pass the user id, which matches nothing - the
  // banner said "Currently Impersonating" while every page still showed the
  // admin's own workspace and channels.
  //
  // The backend sets the cookie, as the banner's search does (impersonate.tsx):
  // httpOnly with secure cookies, and the stop button expires it the same way.
  // Never written here with setCookie: a copy set by script (host-only and
  // on the domain) is one the stop button's Set-Cookie cannot remove.
  const handleImpersonate = useCallback(
    async (userOrgId: string, email: string) => {
      if (!userOrgId) return;
      const res = await fetch('/user/impersonate', {
        method: 'POST',
        body: JSON.stringify({ id: userOrgId }),
      });
      if (!res.ok) {
        toaster.show(`Could not impersonate ${email}`, 'warning');
        return;
      }
      toaster.show(`Impersonating ${email}...`, 'success');
      setTimeout(() => {
        window.location.reload();
      }, 300);
    },
    [toaster, fetch]
  );

  const handleToggleSuperAdmin = useCallback(
    async (targetUserId: string, nextState: boolean, email: string) => {
      if (targetUserId === user?.id && !nextState) {
        toaster.show('You cannot revoke your own Super Admin access', 'warning');
        return;
      }

      const confirmMsg = nextState
        ? `Are you sure you want to grant Super Admin access to ${email}? They will have full administrative privileges.`
        : `Are you sure you want to revoke Super Admin access from ${email}?`;

      if (!window.confirm(confirmMsg)) return;

      setTogglingAdminId(targetUserId);
      try {
        const res = await fetch(`/admin/users/${targetUserId}/super-admin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isSuperAdmin: nextState }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.message || 'Failed to update admin permissions');
        }
        toaster.show(
          `Super Admin ${nextState ? 'granted to' : 'revoked from'} ${email}`,
          'success'
        );
        mutate();
      } catch (e: any) {
        toaster.show(e.message || 'Operation failed', 'warning');
      } finally {
        setTogglingAdminId(null);
      }
    },
    [user, fetch, toaster, mutate]
  );

  // The search first: the state chips count over these rows, so a chip's
  // number is always what clicking it shows, with or without a search.
  const searchedUsers = useMemo(
    () => (data?.users || []).filter((u) => adminSearchMatches(u, searchInput)),
    [data, searchInput]
  );
  const stateCounts = useMemo(() => countRowStates(searchedUsers), [searchedUsers]);

  const filteredUsers = useMemo(() => {
    return searchedUsers.filter((u) => {
      if (stateFilter === 'ALL') return true;
      if (stateFilter === 'ADMIN') return u.isSuperAdmin;
      return rowInState(u, stateFilter);
    });
  }, [searchedUsers, stateFilter]);

  const chipLabel = (state: BillingState) => BILLING_STATE_META[state].chip;

  if (!user?.isSuperAdmin) {
    return (
      <div className="border border-newTableBorder rounded-[8px] p-[24px] text-center opacity-70">
        You are not authorized to view the Super Admin panel.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[20px] max-w-[1400px] w-full min-w-0 mx-auto">
      <AdminHeader
        icon="🛡️"
        title="Super Admin Portal"
        subtitle={'Master view of all registered users, workspaces, Razorpay billing records, and system activity.'}
      />

      {/* Metrics Row */}
      {data?.metrics && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-[14px]">
          <MetricCard
            testId="metric-users"
            title="Users"
            value={data.metrics.totalUsers}
            icon="👥"
            subtext={`Live accounts${
              data.metrics.deletedUsers ? ` · ${data.metrics.deletedUsers} deleted, not counted` : ''
            }`}
          />
          {(() => {
            const w = data.metrics.workspaces;
            const parts = w
              ? [
                  `${w.withUsers} with users`,
                  w.marketplace ? `${w.marketplace} API-marketplace (no users by design)` : '',
                  w.withoutUsers ? `${w.withoutUsers} without users` : '',
                  w.usersWithSeveral ? `${w.usersWithSeveral} users own several` : '',
                ].filter(Boolean)
              : [];
            const extra = [
              w?.marketplace ? `${w.marketplace} API-marketplace` : '',
              w?.withoutUsers ? `${w.withoutUsers} without users` : '',
            ].filter(Boolean);
            return (
              <MetricCard
                testId="metric-workspaces"
                title={extra.length ? `Workspaces (incl. ${extra.join(', ')})` : 'Workspaces'}
                value={data.metrics.totalOrgs}
                icon="🏢"
                subtext={parts.join(' · ') || 'Live workspaces'}
              />
            );
          })()}
          <MetricCard
            title="Connected Channels"
            value={data.metrics.totalIntegrations}
            icon="🔗"
            subtext="Active social channels"
          />
        </div>
      )}

      {/* Where the customers came from: signed up here, or through a marketplace. */}
      {!!data?.metrics?.sources?.length && (
        <div
          data-testid="users-sources"
          className="flex flex-wrap items-center gap-[8px] text-[12px] bg-newBgColorInner border border-newTableBorder rounded-[10px] px-[12px] py-[8px]"
        >
          <span className="opacity-70">Workspaces by source:</span>
          {data.metrics.sources.map((s) => (
            <button
              type="button"
              key={s.id}
              data-testid={`users-source-${s.id}`}
              aria-pressed={workspaceSource === s.id}
              onClick={() => setWorkspaceSource(workspaceSource === s.id ? null : s.id)}
              title="List these workspaces"
              className={`rounded-[6px] border px-[8px] py-[2px] cursor-pointer hover:border-primary/60 ${
                workspaceSource === s.id ? 'border-primary bg-primary/15' : 'border-newTableBorder'
              }`}
            >
              {s.id === 'DIRECT' ? 'Direct' : s.label}: <b>{s.workspaces.toLocaleString()}</b>
            </button>
          ))}
          <button
            type="button"
            data-testid="users-source-ALL"
            aria-pressed={workspaceSource === 'ALL'}
            onClick={() => setWorkspaceSource(workspaceSource === 'ALL' ? null : 'ALL')}
            className={`rounded-[6px] border px-[8px] py-[2px] cursor-pointer hover:border-primary/60 ${
              workspaceSource === 'ALL' ? 'border-primary bg-primary/15' : 'border-newTableBorder'
            }`}
          >
            All workspaces
          </button>
          <Link href="/admin/marketplaces" className="underline opacity-80 hover:opacity-100 ms-auto">
            Marketplaces →
          </Link>
        </div>
      )}

      {workspaceSource && (
        <WorkspacesList
          source={workspaceSource === 'ALL' ? null : workspaceSource}
          onClose={() => setWorkspaceSource(null)}
        />
      )}

      {/* Billing states: one card per state, the same counts as the badges.
          A card is also the filter chip for its state. */}
      {data?.users && (
        <div className="flex flex-col gap-[8px]">
          <div className="flex flex-wrap gap-[8px]" role="group" aria-label="Filter by billing state">
            {visibleChips(stateCounts, stateFilter).map((state) => {
              const meta = BILLING_STATE_META[state];
              const selected = stateFilter === state;
              return (
                <button
                  key={state}
                  type="button"
                  data-testid={`state-chip-${state}`}
                  aria-pressed={selected}
                  onClick={() => setStateFilter(selected ? 'ALL' : state)}
                  className={`flex items-center gap-[8px] rounded-[10px] border px-[12px] py-[8px] text-start transition-all cursor-pointer ${meta.badge} ${
                    selected ? 'ring-2 ring-white/70' : 'hover:brightness-125'
                  }`}
                >
                  <span aria-hidden="true" className={`w-[8px] h-[8px] rounded-full ${meta.dot}`} />
                  <span className="text-[12px] font-[600]">{chipLabel(state)}</span>
                  <span className="text-[16px] font-[700]" data-testid="state-chip-count">
                    {stateCounts[state] ?? 0}
                  </span>
                </button>
              );
            })}
          </div>
          {data.billingSource?.razorpay === 'partial' && (
            <div className="text-[11px] text-amber-700 dark:text-amber-300">
              Razorpay could not be read for {data.billingSource.failed} plan
              {data.billingSource.failed === 1 ? '' : 's'}: those rows are labelled from the
              database only, without dates. Refresh to try again.
            </div>
          )}
        </div>
      )}

      {/* Filters & Search */}
      <div className="flex flex-wrap gap-[12px] items-center justify-between bg-newBgColorInner border border-newTableBorder rounded-[12px] p-[12px] md:p-[14px] min-w-0">
        <div className="flex flex-wrap items-center gap-[10px] flex-1 basis-full sm:basis-auto min-w-0 md:min-w-[280px]">
          <div className="relative flex-1 basis-full sm:basis-auto min-w-0 sm:min-w-[220px]">
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by email, name, workspace or source..."
              className="bg-newBgColor h-[40px] border border-newTableBorder rounded-[8px] px-[12px] text-[14px] text-textColor w-full focus:outline-none focus:border-primary transition-all"
            />
            {searchInput && (
              <button
                onClick={() => setSearchInput('')}
                className="absolute right-[10px] top-[10px] text-[12px] opacity-60 hover:opacity-100"
              >
                ✕
              </button>
            )}
          </div>

          <div className="flex items-center gap-[6px]">
            {(['ALL', 'ADMIN'] as const).map((filter) => (
              <button
                key={filter}
                data-testid={`filter-${filter.toLowerCase()}`}
                onClick={() => setStateFilter(filter)}
                className={`px-[12px] h-[38px] rounded-[8px] text-[12px] font-[600] transition-all ${
                  stateFilter === filter
                    ? 'bg-forth text-hp-on-primary border border-forth'
                    : 'bg-newBgColor border border-newTableBorder text-textColor hover:bg-white/5'
                }`}
              >
                {filter === 'ALL' && 'All Users'}
                {filter === 'ADMIN' && '🛡️ Admins'}
              </button>
            ))}
            {stateFilter !== 'ALL' && stateFilter !== 'ADMIN' && (
              <span className="text-[12px] opacity-70">
                Showing: {chipLabel(stateFilter)}
              </span>
            )}
          </div>
        </div>

        <Button
          secondary
          onClick={async () => {
            // fresh=1: Razorpay is read again rather than from the 2-minute cache.
            try {
              await mutate(
                fetch('/admin/users?fresh=1').then((r) => {
                  if (!r.ok) throw new Error('Failed to load admin users');
                  return r.json();
                }),
                { revalidate: false, rollbackOnError: true }
              );
            } catch (e: any) {
              toaster.show(e?.message || 'Refresh failed', 'warning');
            }
          }}
        >
          🔄 Refresh
        </Button>
      </div>

      {/* Main Users Table */}
      {isLoading ? (
        <LoadingComponent />
      ) : error ? (
        <div className="text-red-400 p-[20px] bg-red-950/20 border border-red-800 rounded-[8px]">
          Failed to load users: {error.message}
        </div>
      ) : filteredUsers.length === 0 ? (
        <div className="border border-newTableBorder rounded-[12px] p-[36px] text-center opacity-70 bg-newBgColorInner">
          No users matching your filters.
        </div>
      ) : (
        <div className="border border-newTableBorder rounded-[12px] overflow-hidden bg-newBgColorInner shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-newBgColorInner text-[12px] uppercase opacity-75 border-b border-newTableBorder tracking-wider">
                  <th className="py-[12px] px-[16px]">User & Identity</th>
                  <th className="py-[12px] px-[16px]">Workspace & Role</th>
                  <th className="py-[12px] px-[16px]">Joined</th>
                  <th className="py-[12px] px-[16px]">Source</th>
                  <th className="py-[12px] px-[16px]">Razorpay Customer / Sub ID</th>
                  <th className="py-[12px] px-[16px]">Billing state</th>
                  <th className="py-[12px] px-[16px] text-center">Channels</th>
                  <th className="py-[12px] px-[16px] text-right sticky end-0 bg-newBgColorInner shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.5)]">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-newTableBorder text-[13px]">
                {filteredUsers.map((u) => {
                  const mainOrg = u.organizations[0]?.organization;
                  const role = u.organizations[0]?.role || 'MEMBER';
                  const sub = mainOrg?.subscription;
                  const paymentId = mainOrg?.paymentId;
                  const otherOrgs = u.organizations.slice(1);

                  return (
                    <tr
                      key={u.id}
                      className="hover:bg-white/[0.02] transition-colors"
                    >
                      {/* User */}
                      <td className="py-[14px] px-[16px]">
                        <div className="flex items-center gap-[10px]">
                          <div className="w-[36px] h-[36px] rounded-full bg-gradient-to-tr from-hp-primary to-hp-primary-active flex items-center justify-center font-[700] text-hp-on-primary text-[14px] flex-shrink-0">
                            {u.email.slice(0, 2).toUpperCase()}
                          </div>
                          <div>
                            <div className="font-[600] text-textColor flex flex-wrap items-center gap-[6px]">
                              <span className="break-all">{u.email}</span>
                              {u.isSuperAdmin && (
                                <span className="px-[6px] py-[1px] text-[10px] font-[700] bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/40 rounded-full">
                                  SUPERADMIN
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] opacity-60 flex items-center gap-[4px] mt-[1px]">
                              {u.name ? `${u.name} • ` : ''}
                              <span className="font-mono">{u.id.split('-').at(-1)}</span>
                              <span>• {u.providerName}</span>
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Org */}
                      <td className="py-[14px] px-[16px]">
                        {mainOrg ? (
                          <div>
                            <div className="font-[600] text-textColor">
                              {mainOrg.name}
                            </div>
                            <div className="text-[11px] opacity-60">
                              {/* Workspace role, not platform role. Every
                                  signup owns its own workspace, so this read
                                  "Superadmin" for all 18 users - the platform
                                  super admins are the amber badge above. */}
                              <span data-testid="user-workspace-role">
                                {roleLabel(role)} · {membersLabel(mainOrg.members)}
                              </span>
                            </div>
                            {otherOrgs.length > 0 && (
                              <button
                                type="button"
                                onClick={() => setSelectedJourneyUserId(u.id)}
                                className="text-[11px] underline opacity-70 hover:opacity-100 cursor-pointer"
                              >
                                +{otherOrgs.length} more workspace{otherOrgs.length === 1 ? '' : 's'}
                              </button>
                            )}
                          </div>
                        ) : (
                          <span className="opacity-40">—</span>
                        )}
                      </td>

                      {/* Joined Date */}
                      <td className="py-[14px] px-[16px] whitespace-nowrap">
                        <div className="text-textColor">
                          {dayjs(u.createdAt).format('MMM D, YYYY')}
                        </div>
                        <div className="text-[11px] opacity-60">
                          {dayjs(u.createdAt).fromNow()}
                        </div>
                      </td>

                      {/* Source: where the sign-up came from (utm, ad
                          click id or referrer host) and whether the
                          workspace is direct or a marketplace's. */}
                      <td className="py-[14px] px-[16px] align-top">
                        {(() => {
                          const cell = sourceCell(mainOrg, data?.metrics?.sources);
                          return (
                            <button
                              type="button"
                              onClick={() => setSelectedJourneyUserId(u.id)}
                              className="flex flex-col gap-[3px] max-w-[200px] text-start cursor-pointer hover:opacity-80"
                              title={`${cell.title} · click for details`}
                              data-testid={`user-source-${u.id}`}
                            >
                              <span
                                className={
                                  cell.known
                                    ? 'text-textColor break-all'
                                    : 'opacity-40'
                                }
                                data-testid="user-source-label"
                              >
                                {cell.primary}
                              </span>
                              {cell.detail && (
                                <span className="text-[11px] opacity-60 break-all">
                                  {cell.detail}
                                </span>
                              )}
                              <span
                                data-testid="user-source-marketplace"
                                className={
                                  cell.viaMarketplace
                                    ? 'self-start text-[10px] px-[6px] py-[1px] rounded-full border border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300'
                                    : 'text-[10px] opacity-50'
                                }
                              >
                                {cell.marketplace}
                              </span>
                            </button>
                          );
                        })()}
                      </td>

                      {/* Razorpay Payment ID */}
                      <td className="py-[14px] px-[16px]">
                        {paymentId ? (
                          <div className="flex items-center gap-[6px]">
                            <code className="px-[6px] py-[2px] bg-newBgColor border border-newTableBorder rounded text-[11px] font-mono text-emerald-700 dark:text-emerald-300">
                              {paymentId}
                            </code>
                            <button
                              onClick={() => handleCopy(paymentId, 'Razorpay Customer / Sub ID')}
                              className="text-[12px] opacity-60 hover:opacity-100 cursor-pointer"
                              title="Copy Razorpay ID"
                            >
                              📋
                            </button>
                          </div>
                        ) : (
                          <span className="text-[12px] opacity-40">No Razorpay ID</span>
                        )}
                        <CheckoutSignalCell
                          signal={mainOrg?.id ? checkoutSignals?.[mainOrg.id] : undefined}
                        />
                      </td>

                      {/* Billing state: one colour-coded badge per workspace. */}
                      <td className="py-[14px] px-[16px] align-top">
                        <div className="flex flex-col gap-[8px]">
                          {mainOrg?.billing ? (
                            <BillingBadge view={mainOrg.billing} />
                          ) : (
                            <BillingBadge
                              view={{
                                state: 'no_workspace',
                                label: 'No workspace',
                                detail: 'This user has no live workspace',
                                at: null,
                                planState: null,
                              }}
                            />
                          )}
                          {sub && !sub.isLifetime && (
                            <span className="text-[10px] opacity-50">
                              {sub.totalChannels} channels allowed
                            </span>
                          )}
                          {otherOrgs.map((o) =>
                            o.organization?.billing ? (
                              <BillingBadge
                                key={o.id}
                                view={o.organization.billing}
                                workspace={`Also: ${o.organization.name}`}
                              />
                            ) : null
                          )}
                        </div>
                      </td>

                      {/* Channels & Posts Count */}
                      <td className="py-[14px] px-[16px] text-center">
                        <div className="font-[600] text-textColor">
                          {mainOrg?._count?.Integration || 0}
                        </div>
                        <div className="text-[10px] opacity-60">
                          {mainOrg?._count?.post || 0} posts
                        </div>
                      </td>

                      {/* Actions: sticky so they stay visible without a sideways
                          scroll. Icon-only (label in title/aria-label): with
                          three labelled buttons the pinned column was ~360px
                          wide and sat on top of Subscription and Channels. */}
                      <td className="py-[14px] px-[16px] text-right whitespace-nowrap sticky end-0 bg-newBgColorInner shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.5)]">
                        <div className="flex items-center justify-end gap-[6px]">
                          <button
                            onClick={() => setSelectedJourneyUserId(u.id)}
                            className="px-[8px] py-[5px] bg-sky-500/20 hover:bg-sky-500 text-sky-700 dark:text-sky-300 hover:text-white border border-sky-500/40 rounded-[6px] text-[12px] font-[600] transition-all cursor-pointer inline-flex items-center"
                            title="View full lifecycle journey"
                            aria-label="View full lifecycle journey"
                          >
                            <span aria-hidden="true">🧭</span>
                          </button>

                          <button
                            onClick={() => handleToggleSuperAdmin(u.id, !u.isSuperAdmin, u.email)}
                            disabled={togglingAdminId === u.id || (u.id === user?.id && u.isSuperAdmin)}
                            className={`px-[8px] py-[5px] rounded-[6px] text-[12px] font-[600] transition-all cursor-pointer inline-flex items-center border ${
                              u.isSuperAdmin
                                ? 'bg-amber-500/20 hover:bg-amber-500 text-amber-700 dark:text-amber-300 hover:text-black border-amber-500/40 disabled:opacity-40 disabled:cursor-not-allowed'
                                : 'bg-white/5 hover:bg-white/15 text-newTextColor/80 hover:text-textColor border-newTableBorder'
                            }`}
                            title={
                              u.id === user?.id && u.isSuperAdmin
                                ? 'Cannot revoke own super admin'
                                : u.isSuperAdmin
                                ? 'Revoke Super Admin Access'
                                : 'Grant Super Admin Access'
                            }
                            aria-label={
                              u.isSuperAdmin
                                ? 'Revoke Super Admin Access'
                                : 'Grant Super Admin Access'
                            }
                          >
                            <span aria-hidden="true">🛡️</span>
                          </button>

                          {mainOrg && (
                            <button
                              onClick={() =>
                                setPlanAction({
                                  workspace: {
                                    id: mainOrg.id,
                                    name: mainOrg.name,
                                    email: u.email,
                                    tier: sub?.subscriptionTier ?? null,
                                    period: sub?.period ?? null,
                                  },
                                  mode: sub ? 'end' : 'restore',
                                })
                              }
                              className="px-[8px] py-[5px] bg-rose-500/20 hover:bg-rose-500 text-rose-700 dark:text-rose-300 hover:text-white border border-rose-500/40 rounded-[6px] text-[12px] font-[600] transition-all cursor-pointer inline-flex items-center"
                              title={sub ? 'End plan now' : 'Restore plan'}
                              aria-label={sub ? 'End plan now' : 'Restore plan'}
                            >
                              <span aria-hidden="true">💳</span>
                            </button>
                          )}

                          <button
                            onClick={() => handleImpersonate(u.organizations[0]?.id, u.email)}
                            className="px-[8px] py-[5px] bg-hp-primary/15 hover:bg-hp-primary text-hp-primary-text hover:text-hp-on-primary border border-hp-primary/40 rounded-[6px] text-[12px] font-[600] transition-all cursor-pointer inline-flex items-center"
                            title="Impersonate"
                            aria-label="Impersonate"
                          >
                            <span aria-hidden="true">🎭</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {planAction && (
        <PlanActionDialog
          workspace={planAction.workspace}
          mode={planAction.mode}
          onClose={() => setPlanAction(null)}
          onDone={() => {
            setPlanAction(null);
            mutate();
          }}
        />
      )}

      {selectedJourneyUserId && (
        <UserJourneyModal
          userId={selectedJourneyUserId}
          onClose={() => setSelectedJourneyUserId(null)}
          checkoutSignals={checkoutSignals}
        />
      )}
    </div>
  );
};
