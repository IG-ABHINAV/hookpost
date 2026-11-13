import { Input } from '@hookpost/react/form/input';
import {
  ChangeEventHandler,
  FC,
  ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import useSWR, { useSWRConfig } from 'swr';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import { Select } from '@hookpost/react/form/select';
import { pricing } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { deleteDialog } from '@hookpost/react/helpers/delete.dialog';
import { useVariables } from '@hookpost/react/helpers/variable.context';
import { setCookie } from '@hookpost/frontend/components/layout/layout.context';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import { useModals } from '@hookpost/frontend/components/layout/new-modal';
import { useToaster } from '@hookpost/react/toaster/toaster';
import { Button } from '@hookpost/react/form/button';
import { ImportDebugPostModal } from '@hookpost/frontend/components/launches/import-debug-post.modal';
import { useForm, FormProvider } from 'react-hook-form';
import { classValidatorResolver } from '@hookform/resolvers/class-validator';
import { AdminAddTeamMemberDto } from '@hookpost/nestjs-libraries/dtos/settings/admin.add.team.member.dto';

interface Charge {
  id: string;
  amount: number;
  currency: string;
  created: number;
  status: string;
  refunded: boolean;
  amount_refunded: number;
  description: string | null;
  receipt_url: string | null;
  invoice_pdf: string | null;
}

const useCharges = () => {
  const fetch = useFetch();
  return useSWR<Charge[]>('/billing/charges', async () => {
    return (await fetch('/billing/charges')).json();
  }, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
  });
};

interface CouponInfo {
  tier: string | null;
  period: string | null;
  isLifetime: boolean;
  monthlyPrice: number;
  planPrice: number;
  nextPayment: number | null;
  coupons: {
    type: string;
    value: number;
    duration: string;
    durationInMonths: number | null;
    remainingMonths: number | null;
  }[];
  supported: boolean;
}

const useCouponInfo = () => {
  const fetch = useFetch();
  return useSWR<CouponInfo>('/billing/coupon-info', async () => {
    return (await fetch('/billing/coupon-info')).json();
  }, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
  });
};

const ApplyCouponModal: FC<{ close: () => void }> = ({ close }) => {
  const fetch = useFetch();
  const t = useT();
  const toast = useToaster();
  const { data: info, mutate } = useCouponInfo();
  const [type, setType] = useState('percentage');
  const [value, setValue] = useState('');
  const [months, setMonths] = useState('1');
  const [error, setError] = useState('');
  const [applying, setApplying] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const handleCancelCoupon = useCallback(async () => {
    if (
      !(await deleteDialog(
        t(
          'cancel_coupon_confirm',
          'Are you sure you want to cancel this coupon? The user will pay the full price from the next billing cycle.'
        ),
        t('yes_cancel_coupon', 'Yes, cancel coupon'),
        t('cancel_coupon_title', 'Cancel Coupon?'),
        t('no_go_back', 'No, go back')
      ))
    ) {
      return;
    }
    setCancelling(true);
    try {
      const response = await fetch('/billing/cancel-coupon', {
        method: 'POST',
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json.cancelled) {
        toast.show(
          json.reason ||
            t('cancel_coupon_failed', 'Could not cancel the coupon'),
          'warning'
        );
        return;
      }
      toast.show(t('cancel_coupon_success', 'Coupon cancelled'));
      await mutate();
    } finally {
      setCancelling(false);
    }
  }, []);

  const handleApply = useCallback(async () => {
    if (!info) {
      return;
    }
    const numberValue = Number(value);
    const numberMonths = Number(months);
    if (
      type === 'percentage' &&
      (!numberValue || numberValue < 1 || numberValue > 100)
    ) {
      setError(
        t(
          'apply_coupon_invalid_percentage',
          'Invalid percentage: enter a value between 1 and 100'
        )
      );
      return;
    }
    if (
      type === 'amount' &&
      (!numberValue || numberValue < 1 || numberValue > info.monthlyPrice)
    ) {
      setError(
        `${t(
          'apply_coupon_invalid_amount',
          "Invalid amount: enter a value between 1 and the plan's monthly payment:"
        )} ${info.monthlyPrice}`
      );
      return;
    }
    if (
      !numberMonths ||
      !Number.isInteger(numberMonths) ||
      numberMonths < 1 ||
      numberMonths > 12
    ) {
      setError(
        t(
          'apply_coupon_invalid_months',
          'Invalid months: enter a whole number between 1 and 12'
        )
      );
      return;
    }
    setError('');
    setApplying(true);
    try {
      const response = await fetch('/billing/apply-coupon', {
        method: 'POST',
        body: JSON.stringify({
          type,
          value: numberValue,
          months: numberMonths,
        }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json.applied) {
        toast.show(
          json.reason ||
            t('apply_coupon_failed', 'Could not apply the coupon'),
          'warning'
        );
        return;
      }
      toast.show(t('apply_coupon_success', 'Coupon applied'));
      setValue('');
      setMonths('1');
      await mutate();
    } finally {
      setApplying(false);
    }
  }, [info, type, value, months]);

  return (
    <div className="flex flex-col gap-[16px]">
      {/* Only describe how a coupon works when one can actually be applied;
          otherwise it contradicts the "can't be applied" reason below. */}
      {info?.supported && (
        <div className="text-newTextColor/60 text-[13px]">
          {t(
            'apply_coupon_subtitle',
            "The coupon applied here is simply a deduction from the user's next billing cycle(s) — one or more, depending on how many months you choose to apply it for. It is NOT a refund; this is applied as a Razorpay offer on the next cycle."
          )}
        </div>
      )}
      {!info ? (
        <div className="text-center py-[20px] text-newTextColor/60">
          {t('loading', 'Loading...')}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-[4px] text-[14px]">
            <div>
              {t('apply_coupon_plan', 'Plan:')} {info.tier || 'FREE'}
              {!!info.tier && ` - $${info.planPrice}`}
            </div>
            <div>
              {t('apply_coupon_period', 'Period:')}{' '}
              {info.period === 'MONTHLY'
                ? t('monthly', 'Monthly')
                : info.period === 'YEARLY'
                ? t('annual', 'Annual')
                : '-'}
            </div>
            <div>
              {t('apply_coupon_lifetime', 'Lifetime deal:')}{' '}
              {info.isLifetime ? t('yes', 'Yes') : t('no', 'No')}
            </div>
            <div>
              {t('apply_coupon_applied', 'Applied coupons:')}{' '}
              {!info.coupons.length && t('none', 'None')}
            </div>
            {info.coupons.map((coupon, index) => (
              <div key={index} className="ps-[10px] flex items-center gap-[10px]">
                <div>
                  -{' '}
                  {coupon.type === 'percentage'
                    ? `${coupon.value}%`
                    : `$${coupon.value}`}{' '}
                  {t('apply_coupon_off', 'off,')}{' '}
                  {coupon.duration === 'repeating'
                    ? `${coupon.durationInMonths} ${t(
                        'apply_coupon_months_total',
                        'month(s) total,'
                      )} ${coupon.remainingMonths} ${t(
                        'apply_coupon_months_left',
                        'month(s) left'
                      )}`
                    : coupon.duration === 'forever'
                    ? t('apply_coupon_forever', 'forever')
                    : t('apply_coupon_once', 'next billing cycle only')}
                </div>
                <Button
                  onClick={handleCancelCoupon}
                  loading={cancelling}
                  className="!bg-red-700 rounded-[4px] !h-[24px] !px-[10px] text-[12px]"
                >
                  {t('cancel', 'Cancel')}
                </Button>
              </div>
            ))}
            <div>
              {t('apply_coupon_next_payment', 'Next Payment:')}{' '}
              {info.nextPayment !== null ? `$${info.nextPayment}` : '-'}
            </div>
          </div>
          {info.supported ? (
            <div className="grid grid-cols-3 gap-[12px]">
              <Select
                label={t('apply_coupon_type', 'Coupon type')}
                name="couponType"
                disableForm={true}
                hideErrors={true}
                value={type}
                onChange={(e) => setType(e.target.value)}
              >
                <option value="percentage">
                  {t('apply_coupon_percentage', 'Percentage')}
                </option>
                <option value="amount">
                  {t('apply_coupon_fixed_amount', 'Fixed dollar amount')}
                </option>
              </Select>
              <Input
                label={t('apply_coupon_value', 'Value')}
                name="couponValue"
                type="number"
                disableForm={true}
                removeError={true}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
              <Input
                label={t('apply_coupon_months', 'Months')}
                name="couponMonths"
                type="number"
                disableForm={true}
                removeError={true}
                value={months}
                onChange={(e) => setMonths(e.target.value)}
              />
            </div>
          ) : (
            <div className="text-newTextColor/60 text-[13px]">
              {(info as any).reason ||
                t(
                  'apply_coupon_not_supported',
                  "Coupons can't be applied to this subscription."
                )}
            </div>
          )}
          {!!error && <div className="text-red-400 text-[12px]">{error}</div>}
          <div className="flex gap-[12px] justify-end">
            <Button onClick={close} className="rounded-[4px]">
              {t('close', 'Close')}
            </Button>
            {info.supported && (
              <Button
                onClick={handleApply}
                loading={applying}
                className="!bg-blue-700 rounded-[4px]"
              >
                {t('apply', 'Apply')}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
};

const ChargesModal: FC<{ close: () => void }> = ({ close }) => {
  const fetch = useFetch();
  const toast = useToaster();
  const t = useT();
  const { openModal } = useModals();
  const { data: charges, mutate } = useCharges();
  // Tier of the impersonated workspace, so Cancel Subscription is only offered
  // when there is a paid, non-lifetime subscription to cancel.
  const { data: billingInfo } = useCouponInfo();
  const hasPaidSubscription =
    !!billingInfo?.tier &&
    billingInfo.tier !== 'FREE' &&
    !billingInfo.isLifetime;
  // The impersonated workspace: a new-cohort one (trial.policy.ts) has no
  // Free plan and is paused when its plan ends.
  const impersonated = useUser();
  const freePlan = impersonated?.freePlanAvailable !== false;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [refunding, setRefunding] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const toggleCharge = useCallback((chargeId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(chargeId)) {
        next.delete(chargeId);
      } else {
        next.add(chargeId);
      }
      return next;
    });
  }, []);

  const handleApplyCoupon = useCallback(() => {
    close();
    openModal({
      title: t('apply_coupon', 'Apply Coupon'),
      maxSize: 600,
      children: (closeCoupon) => <ApplyCouponModal close={closeCoupon} />,
    });
  }, []);

  const handleRefund = useCallback(async () => {
    if (!selected.size) return;
    if (
      !(await deleteDialog(
        t(
          'refund_selected_confirm',
          `Are you sure you want to refund ${selected.size} charge(s)? This cannot be undone.`
        ),
        t('yes_refund', 'Yes, refund'),
        t('confirm_refund', 'Confirm Refund'),
        t('no_cancel', 'No, cancel')
      ))
    ) {
      return;
    }
    setRefunding(true);
    try {
      const response = await fetch('/billing/refund-charges', {
        method: 'POST',
        body: JSON.stringify({ chargeIds: Array.from(selected) }),
      });
      // Per charge: refunded, refused (not Hookpost's, already refunded, ...)
      // or failed, in Razorpay's words.
      const json = await response.json().catch(() => null);
      const summary = json?.summary;
      if (!response.ok || !summary) {
        toast.show(json?.message || 'The refund could not be sent', 'warning');
      } else {
        const problem = (json.results || []).find(
          (r: any) => r.status !== 'refunded'
        );
        toast.show(
          `Refunded ${summary.refunded} of ${summary.requested}` +
            (problem ? `. ${problem.paymentId}: ${problem.error}` : ''),
          problem ? 'warning' : 'success'
        );
      }
      setSelected(new Set());
      await mutate();
    } finally {
      setRefunding(false);
    }
  }, [selected]);

  const handleCancel = useCallback(async () => {
    if (
      !(await deleteDialog(
        freePlan
          ? t(
              'cancel_subscription_confirm',
              'This will immediately cancel the subscription. The user will be downgraded to the FREE plan. This cannot be undone.'
            )
          : 'This will immediately cancel the subscription. The workspace is paused (channels and posts kept) until the user chooses a plan. This cannot be undone.',
        t('yes_cancel_subscription', 'Yes, cancel subscription'),
        t('cancel_subscription_title', 'Cancel Subscription?'),
        t('no_go_back', 'No, go back')
      ))
    ) {
      return;
    }
    setCancelling(true);
    try {
      const response = await fetch('/billing/cancel-subscription', {
        method: 'POST',
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json.ok === false) {
        toast.show(
          json.reason ||
            t('cancel_subscription_failed', 'Could not cancel the subscription'),
          'warning'
        );
        setCancelling(false);
        return;
      }
      close();
      window.location.reload();
    } catch {
      setCancelling(false);
    }
  }, [freePlan]);

  return (
    <div className="flex flex-col gap-[16px] w-full md:min-w-[500px]">
      <div className="max-h-[400px] overflow-y-auto">
        {!charges?.length ? (
          <div className="text-center py-[20px] text-newTextColor/60">
            {t('no_charges', 'No charges found')}
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="text-left border-b border-newTableBorder">
                <th className="p-[8px] w-[40px]" />
                <th className="p-[8px]">{t('date', 'Date')}</th>
                <th className="p-[8px]">{t('amount', 'Amount')}</th>
                <th className="p-[8px]">{t('status', 'Status')}</th>
                <th className="p-[8px] w-[50px]" />
              </tr>
            </thead>
            <tbody>
              {charges.map((charge) => (
                <tr
                  key={charge.id}
                  className="border-b border-newTableBorder hover:bg-tableBorder cursor-pointer"
                  onClick={() => !charge.refunded && toggleCharge(charge.id)}
                >
                  <td className="p-[8px]">
                    <div
                      className={`w-[20px] h-[20px] rounded-[4px] border-2 flex items-center justify-center ${
                        charge.refunded
                          ? 'border-newTextColor/20 opacity-40'
                          : selected.has(charge.id)
                          ? 'bg-forth border-forth'
                          : 'border-newTextColor/40'
                      }`}
                    >
                      {(selected.has(charge.id) || charge.refunded) && (
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 24 24"
                          width="14"
                          height="14"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </div>
                  </td>
                  <td className="p-[8px]">
                    {new Date(charge.created * 1000).toLocaleDateString()}
                  </td>
                  <td className="p-[8px]">
                    ${(charge.amount / 100).toFixed(2)}{' '}
                    {charge.currency.toUpperCase()}
                  </td>
                  <td className="p-[8px]">
                    {charge.refunded ? (
                      <span className="text-red-400">
                        {t('refunded', 'Refunded')}
                      </span>
                    ) : (
                      <span className="text-green-400">
                        {t('paid', 'Paid')}
                      </span>
                    )}
                  </td>
                  <td className="p-[8px]">
                    {(charge.invoice_pdf || charge.receipt_url) && (
                      <a
                        href={charge.invoice_pdf || charge.receipt_url!}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center justify-center w-[28px] h-[28px] rounded-[4px] hover:bg-tableBorder transition-colors"
                        title={charge.invoice_pdf ? t('download_invoice', 'Download Invoice') : t('view_receipt', 'View Receipt')}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 24 24"
                          width="16"
                          height="16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="7 10 12 15 17 10" />
                          <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="flex gap-[12px] justify-end">
        <Button
          onClick={handleApplyCoupon}
          className="!bg-blue-700 rounded-[4px]"
        >
          {t('apply_coupon', 'Apply Coupon')}
        </Button>
        <Button
          onClick={handleRefund}
          loading={refunding}
          disabled={!selected.size}
          className="rounded-[4px]"
        >
          {t('refund_selected', 'Refund Selected')}
          {selected.size > 0 && ` (${selected.size})`}
        </Button>
        {hasPaidSubscription ? (
          <Button
            onClick={handleCancel}
            loading={cancelling}
            className="!bg-red-700 rounded-[4px]"
          >
            {t('cancel_subscription', 'Cancel Subscription')}
          </Button>
        ) : (
          <div className="self-center text-[12px] text-newTextColor/60">
            {billingInfo?.isLifetime
              ? t('lifetime_no_cancel', 'Lifetime plan - nothing to cancel')
              : impersonated?.planState === 'locked'
              ? 'Needs a plan - no subscription to cancel'
              : impersonated?.planState === 'free_posts'
              ? 'Free posts - no subscription to cancel'
              : t('free_no_cancel', 'Free plan - no subscription to cancel')}
          </div>
        )}
      </div>
    </div>
  );
};

const ManageBilling = () => {
  const { openModal } = useModals();
  const t = useT();

  const handleClick = useCallback(() => {
    openModal({
      title: t('manage_billing', 'Manage Billing'),
      children: (close) => <ChargesModal close={close} />,
    });
  }, []);

  return (
    <div
      className="px-[10px] rounded-[4px] bg-red-700 text-white cursor-pointer whitespace-nowrap"
      onClick={handleClick}
    >
      {t('manage_billing', 'Manage Billing')}
    </div>
  );
};

export const Subscription = () => {
  const fetch = useFetch();
  const t = useT();

  const addSubscription: ChangeEventHandler<HTMLSelectElement> = useCallback(
    async (e) => {
      const value = e.target.value;
      if (
        await deleteDialog(
          'Are you sure you want to add a user subscription?',
          'Add'
        )
      ) {
        await fetch('/billing/add-subscription', {
          method: 'POST',
          body: JSON.stringify({
            subscription: value,
          }),
        });
        window.location.reload();
      }
    },
    []
  );
  return (
    <Select
      onChange={addSubscription}
      hideErrors={true}
      disableForm={true}
      name="sub"
      label=""
      value=""
    >
      <option>
        {t('add_free_subscription', '-- ADD FREE SUBSCRIPTION --')}
      </option>
      {Object.keys(pricing)
        .filter((f) => !f.includes('FREE'))
        .map((key) => (
          <option key={key} value={key}>
            {key}
          </option>
        ))}
    </Select>
  );
};
const colorOptions = [
  { value: 'INFO', label: 'Info (Blue)', className: 'bg-blue-600' },
  { value: 'WARNING', label: 'Warning (Amber)', className: 'bg-amber-600' },
  { value: 'ERROR', label: 'Error (Red)', className: 'bg-red-600' },
];

const AddAnnouncementModal: FC<{ close: () => void }> = ({ close }) => {
  const fetch = useFetch();
  const { mutate } = useSWRConfig();
  const t = useT();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('INFO');
  const [saving, setSaving] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (!title.trim() || !description.trim()) return;
    setSaving(true);
    try {
      await fetch('/announcements', {
        method: 'POST',
        body: JSON.stringify({ title, description, color }),
      });
      await mutate('/announcements');
      close();
    } finally {
      setSaving(false);
    }
  }, [title, description, color]);

  return (
    <div className="flex flex-col gap-[16px] w-full md:min-w-[500px]">
      <Input
        label={t('announcement_title', 'Title')}
        name="title"
        disableForm={true}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t('announcement_title_placeholder', 'Announcement title')}
      />
      <div className="flex flex-col gap-[6px]">
        <label className="text-[14px]">
          {t('announcement_description', 'Description')}
        </label>
        <textarea
          className="bg-input border border-tableBorder rounded-[8px] p-[10px] text-newTextColor min-h-[120px] outline-none resize-y"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t(
            'announcement_description_placeholder',
            'Announcement description'
          )}
        />
      </div>
      <div className="flex flex-col gap-[6px]">
        <label className="text-[14px]">
          {t('announcement_color', 'Color')}
        </label>
        <div className="flex gap-[8px]">
          {colorOptions.map((opt) => (
            <div
              key={opt.value}
              onClick={() => setColor(opt.value)}
              className={`flex-1 text-center py-[8px] rounded-[8px] text-white text-[13px] cursor-pointer transition-opacity ${opt.className} ${
                color === opt.value ? 'opacity-100 ring-2 ring-white' : 'opacity-40'
              }`}
            >
              {opt.label}
            </div>
          ))}
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          onClick={handleSubmit}
          loading={saving}
          disabled={!title.trim() || !description.trim()}
          className="rounded-[4px]"
        >
          {t('create_announcement', 'Create Announcement')}
        </Button>
      </div>
    </div>
  );
};

const AddAnnouncement = () => {
  const { openModal } = useModals();
  const t = useT();

  const handleClick = useCallback(() => {
    openModal({
      title: t('add_announcement', 'Add Announcement'),
      children: (close) => <AddAnnouncementModal close={close} />,
    });
  }, []);

  return (
    <div
      className="px-[10px] rounded-[4px] bg-green-700 text-white cursor-pointer whitespace-nowrap"
      onClick={handleClick}
    >
      {t('add_announcement', 'Add Announcement')}
    </div>
  );
};

const AddTeamMemberModal: FC<{ close: () => void }> = ({ close }) => {
  const fetch = useFetch();
  const toast = useToaster();
  const t = useT();
  const [saving, setSaving] = useState(false);
  const resolver = useMemo(() => {
    return classValidatorResolver(AdminAddTeamMemberDto);
  }, []);
  const form = useForm({
    values: {
      email: '',
      role: '',
    },
    resolver,
    mode: 'onChange',
  });

  const submit = useCallback(
    async (values: { email: string; role: string }) => {
      setSaving(true);
      try {
        const response = await fetch('/settings/team/add', {
          method: 'POST',
          body: JSON.stringify(values),
        });
        if (!response.ok) {
          toast.show(
            (await response.json()).message ||
              t('could_not_add_member', 'Could not add the member'),
            'warning'
          );
          return;
        }
        toast.show(t('member_added', 'Member added'));
        close();
      } finally {
        setSaving(false);
      }
    },
    []
  );

  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(submit)}>
        <div className="flex flex-col gap-[10px] w-full md:min-w-[400px]">
          <Input
            label="Email"
            placeholder={t('enter_email', 'Enter email')}
            name="email"
          />
          <Select label="Role" name="role">
            <option value="">{t('select_role', 'Select Role')}</option>
            <option value="USER">{t('user', 'User')}</option>
            <option value="ADMIN">{t('admin', 'Admin')}</option>
          </Select>
          <Button type="submit" loading={saving} className="rounded-[4px]">
            {t('add_team_member', 'Add Team Member')}
          </Button>
        </div>
      </form>
    </FormProvider>
  );
};

const AddTeamMember = () => {
  const { openModal } = useModals();
  const t = useT();

  const handleClick = useCallback(() => {
    openModal({
      title: t('add_team_member', 'Add Team Member'),
      children: (close) => <AddTeamMemberModal close={close} />,
    });
  }, []);

  return (
    <div
      className="px-[10px] rounded-[4px] bg-teal-700 text-white cursor-pointer whitespace-nowrap"
      onClick={handleClick}
    >
      {t('add_team_member', 'Add Team Member')}
    </div>
  );
};

const ViewUsers = () => {
  const t = useT();
  const handleClick = useCallback(() => {
    window.location.href = '/admin/users';
  }, []);
  return (
    <div
      className="px-[10px] rounded-[4px] bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer whitespace-nowrap font-medium transition-colors"
      onClick={handleClick}
    >
      {t('view_users', 'View Users')}
    </div>
  );
};

const ViewErrors = () => {
  const t = useT();
  const handleClick = useCallback(() => {
    window.location.href = '/admin/errors';
  }, []);
  return (
    <div
      className="px-[10px] rounded-[4px] bg-blue-700 text-white cursor-pointer whitespace-nowrap"
      onClick={handleClick}
    >
      {t('view_errors', 'View Errors')}
    </div>
  );
};

const ViewContact = () => {
  const t = useT();
  const handleClick = useCallback(() => {
    window.location.href = '/admin/contact';
  }, []);
  return (
    <div
      className="px-[10px] rounded-[4px] bg-hp-accent text-hp-on-accent cursor-pointer whitespace-nowrap"
      onClick={handleClick}
    >
      {t('view_contact', 'View Contact')}
    </div>
  );
};

const ViewStats = () => {
  const t = useT();
  const handleClick = useCallback(() => {
    window.location.href = '/admin/stats';
  }, []);
  return (
    <div
      className="px-[10px] rounded-[4px] bg-hp-primary text-hp-on-primary cursor-pointer whitespace-nowrap"
      onClick={handleClick}
    >
      {t('view_stats', 'View Stats')}
    </div>
  );
};

const ViewAffiliates = () => {
  const handleClick = useCallback(() => {
    window.location.href = '/admin/affiliates';
  }, []);
  return (
    <div
      className="px-[10px] rounded-[4px] bg-sky-700 text-white cursor-pointer whitespace-nowrap"
      onClick={handleClick}
    >
      Affiliates
    </div>
  );
};

const ImportDebugPost = () => {
  const { openModal } = useModals();
  const t = useT();

  const handleClick = useCallback(() => {
    openModal({
      title: t('import_debug_post', 'Import Debug Post'),
      maxSize: 800,
      children: (close) => <ImportDebugPostModal close={close} />,
    });
  }, []);

  return (
    <div
      className="px-[10px] rounded-[4px] bg-yellow-600 text-white cursor-pointer whitespace-nowrap"
      onClick={handleClick}
    >
      {t('import_debug_post', 'Import Debug Post')}
    </div>
  );
};

// The super-admin bar is a fixed 52px strip that scrolls sideways
// (overflow-x-auto, overflow-y-hidden), so a dropdown positioned inside it is
// clipped to nothing: typing dimmed the screen and no results ever showed.
// Render the results in a portal on <body>, pinned under the input.
const AnchoredResults: FC<{
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
}> = ({ anchor, onClose, children }) => {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!anchor) {
      return;
    }
    const update = () => setRect(anchor.getBoundingClientRect());
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchor]);

  if (!anchor || !rect || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <>
      <div
        className="bg-primary/80 fixed start-0 top-0 w-full h-full z-[998]"
        onClick={onClose}
      />
      <div
        data-testid="admin-bar-results"
        className="fixed max-h-[60vh] overflow-y-auto bg-sixth border border-customColor6 text-textColor z-[999]"
        // Ends 8px inside the screen's right edge whatever its left (a 90vw cap
        // from a left past 10vw ran off screen); the rows truncate.
        style={{
          top: rect.bottom + 4,
          left: Math.max(8, rect.left),
          minWidth: rect.width,
          maxWidth: `calc(100vw - ${Math.max(8, rect.left)}px - 8px)`,
        }}
      >
        {children}
      </div>
    </>,
    document.body
  );
};

const SwitchUser = () => {
  const fetch = useFetch();
  const t = useT();
  const toaster = useToaster();
  const currentUser = useUser();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<{
    id: string;
    name: string;
    email: string;
  } | null>(null);
  const [switching, setSwitching] = useState(false);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    if (!name) {
      return [];
    }
    return await (await fetch(`/user/impersonate?name=${name}`)).json();
  }, [name]);

  const { data } = useSWR(`/switch-search-${name}`, load, {
    refreshWhenHidden: false,
    revalidateOnMount: true,
    revalidateOnReconnect: false,
    revalidateOnFocus: false,
    refreshWhenOffline: false,
    revalidateIfStale: false,
    refreshInterval: 0,
  });

  const mapData = useMemo(() => {
    // one row per user-organization: dedupe by user id, drop the impersonated user
    const seen = new Set<string>();
    return (data || [])
      .filter((curr: any) => curr?.user?.id !== currentUser?.id)
      .filter((curr: any) => {
        if (seen.has(curr?.user?.id)) {
          return false;
        }
        seen.add(curr?.user?.id);
        return true;
      })
      .map((curr: any) => ({
        id: curr?.user?.id,
        name: curr?.user?.name,
        email: curr?.user?.email,
        orgs: (data || [])
          .filter((org: any) => org?.user?.id === curr?.user?.id)
          .map(
            (org: any) =>
              `${org?.organization?.name} (${org?.role} / ${
                org?.organization?.subscription?.subscriptionTier || 'FREE'
              })`
          )
          .join(', '),
      }));
  }, [data, currentUser?.id]);

  const pick = useCallback(
    (item: { id: string; name: string; email: string }) => () => {
      setSelected(item);
      setName('');
    },
    []
  );

  const doSwitch = useCallback(async () => {
    if (!selected) {
      return;
    }
    if (
      !(await deleteDialog(
        t(
          'switch_user_confirm',
          `This will replace the current account's login with ${selected.email}. All data and the subscription stay with the account — only the login changes, and the new login gains its full access. Switch back to revert.`
        ),
        t('yes_switch', 'Yes, switch'),
        t('switch_user_title', 'Switch User?'),
        t('no_cancel', 'No, cancel')
      ))
    ) {
      return;
    }
    setSwitching(true);
    try {
      const res = await fetch('/user/switch', {
        method: 'POST',
        body: JSON.stringify({ id: selected.id }),
      });
      // customFetch does not throw on HTTP errors
      if (!res.ok) {
        throw new Error(await res.text().catch(() => ''));
      }
      window.location.reload();
    } catch {
      setSwitching(false);
      toaster.show(
        t('switch_user_failed', 'The user switch failed and nothing was changed'),
        'warning'
      );
    }
  }, [selected]);

  return (
    // Phones: the whole width of the bar, the box on its own line and Switch
    // User under it (beside the button the box was 80px wide at 320px and
    // cut its placeholder to "Select use"). From md up, one row as before.
    <div
      data-testid="admin-bar-switch-user"
      className="relative flex flex-wrap md:flex-nowrap items-center justify-center gap-[10px] w-full md:w-auto"
    >
      <div className="basis-full md:basis-auto flex-1 min-w-0 md:min-w-[220px]" ref={setAnchor}>
        <Input
          autoComplete="off"
          placeholder={t('select_user_to_switch_to', 'Select user to switch to')}
          name="switchUser"
          disableForm={true}
          label=""
          removeError={true}
          value={
            selected
              ? `${selected.name ? `${selected.name} - ` : ''}${selected.email}`
              : name
          }
          onChange={(e) => {
            setSelected(null);
            setName(e.target.value);
          }}
        />
      </div>
      <Button
        onClick={doSwitch}
        loading={switching}
        disabled={!selected}
        className="rounded-[4px] whitespace-nowrap"
      >
        {t('switch_user', 'Switch User')}
      </Button>
      {!!mapData?.length && !selected && (
        <AnchoredResults anchor={anchor} onClose={() => setName('')}>
            {mapData.map((item: any) => (
              <div
                onClick={pick(item)}
                key={item?.id}
                className="p-[10px] border-b border-customColor6 hover:bg-tableBorder cursor-pointer whitespace-nowrap truncate"
              >
                {t('user_1', 'user:')}
                {item?.id?.split('-')?.at(-1)} -{' '}
                {item?.name ? `${item?.name} - ` : ''}
                {item?.email}
                {item?.orgs ? ` - ${item?.orgs}` : ''}
              </div>
            ))}
        </AnchoredResults>
      )}
    </div>
  );
};

export const Impersonate = () => {
  const fetch = useFetch();
  const [name, setName] = useState('');
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const { isSecured, billingEnabled } = useVariables();
  const user = useUser();
  const load = useCallback(async () => {
    if (!name) {
      return [];
    }
    const value = await (await fetch(`/user/impersonate?name=${name}`)).json();
    return value;
  }, [name]);
  const stopImpersonating = useCallback(async () => {
    // Any copy set by script, host-only or on the domain: a Set-Cookie from
    // the backend cannot remove a host-only cookie, and the browser may send
    // that copy first. With secure cookies the backend's own httpOnly cookie
    // is then expired by the POST.
    setCookie('impersonate', '', -10);
    if (isSecured) {
      await fetch(`/user/impersonate`, {
        method: 'POST',
        body: JSON.stringify({
          id: '',
        }),
      });
    }
    window.location.reload();
  }, [isSecured, fetch]);
  const t = useT();

  const setUser = useCallback(
    (userId: string) => async () => {
      await fetch(`/user/impersonate`, {
        method: 'POST',
        body: JSON.stringify({
          id: userId,
        }),
      });
      window.location.reload();
    },
    []
  );
  const { data } = useSWR(`/impersonate-${name}`, load, {
    refreshWhenHidden: false,
    revalidateOnMount: true,
    revalidateOnReconnect: false,
    revalidateOnFocus: false,
    refreshWhenOffline: false,
    revalidateIfStale: false,
    refreshInterval: 0,
  });
  const mapData = useMemo(() => {
    return data?.map(
      (curr: any) => ({
        id: curr?.id,
        name: curr?.user?.name,
        email: curr?.user?.email,
        orgName: curr?.organization?.name,
        role: curr?.role,
        tier: curr?.organization?.subscription?.subscriptionTier || 'FREE',
      }),
      []
    );
  }, [data]);
  return (
    // Phones: the bar grows to fit, with the search box on its own line and
    // the buttons wrapping under it (they used to run off the right edge of a
    // 52px strip that scrolled sideways). From md up it is one 52px row.
    <div data-testid="admin-bar">
      <div className="bg-forth min-h-[52px] md:h-[52px] flex items-center border-input border rounded-[8px] text-hp-on-primary md:overflow-x-auto md:overflow-y-hidden">
        <div
          className={`relative flex flex-col ${
            user?.impersonate ? 'w-full px-[20px]' : 'w-full max-w-[600px] lg:w-max lg:max-w-none mx-auto min-w-0 px-[8px]'
          }`}
        >
          <div className="relative z-[1]">
            {user?.impersonate ? (
              <div className="text-center flex flex-wrap md:flex-nowrap [justify-content:safe_center] items-center gap-[8px] md:gap-[10px] py-[6px] md:py-0">
                <div className="whitespace-nowrap">
                  {t('currently_impersonating', 'Currently Impersonating')}
                </div>
                <div>
                  <button
                    type="button"
                    aria-label="Stop impersonating"
                    title="Stop impersonating"
                    className="px-[10px] rounded-[4px] bg-red-500 text-white cursor-pointer"
                    onClick={stopImpersonating}
                  >
                    X
                  </button>
                </div>
                {user?.tier?.current === 'FREE' && <Subscription />}
                {user?.tier?.team_members && <AddTeamMember />}
                {billingEnabled && <ManageBilling />}
                <SwitchUser />
              </div>
            ) : (
              <div className="flex flex-wrap md:flex-nowrap items-center gap-[8px] py-[6px] md:py-[2px]">
                <div
                  className="basis-full md:basis-auto flex-1 min-w-0 md:min-w-[160px] lg:min-w-[240px]"
                  ref={setAnchor}
                >
                  <Input
                    autoComplete="off"
                    placeholder="Write the user details"
                    name="impersonate"
                    disableForm={true}
                    label=""
                    removeError={true}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div data-testid="admin-bar-actions" className="flex flex-wrap md:flex-nowrap items-center gap-[6px] md:shrink-0">
                  <ViewUsers />
                  <ImportDebugPost />
                  <AddAnnouncement />
                  <ViewErrors />
                  <ViewStats />
                  <ViewAffiliates />
                  <ViewContact />
                </div>
              </div>
            )}
          </div>
          {!!data?.length && (
            <AnchoredResults anchor={anchor} onClose={() => setName('')}>
                {mapData?.map((user: any) => (
                  <div
                    onClick={setUser(user?.id)}
                    key={user?.id}
                    className="p-[10px] border-b border-customColor6 hover:bg-tableBorder cursor-pointer whitespace-nowrap truncate"
                  >
                    {t('user_1', 'user:')}
                    {user?.id?.split('-')?.at(-1)} - {user?.name} - {user?.email}{' '}
                    - {user?.orgName} ({user?.role} / {user?.tier})
                  </div>
                ))}
            </AnchoredResults>
          )}
        </div>
      </div>
    </div>
  );
};
