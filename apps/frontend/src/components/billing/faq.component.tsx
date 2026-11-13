'use client';
import { REFUND_FAQ } from '@hookpost/frontend/app/(landing)/refund-terms';

import { FC, ReactNode, useCallback, useState } from 'react';
import clsx from 'clsx';
import { useVariables } from '@hookpost/react/helpers/variable.context';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import DeleteAccountComponent from '@hookpost/frontend/components/settings/delete-account.component';
const useFaqList = () => {
  const { isGeneral } = useVariables();
  const user = useUser();
  const t = useT();
  return [
    ...(user?.allowTrial
      ? [
          {
            title: t(
              'faq_am_i_going_to_be_charged_by_hookpost',
              'Am I going to be charged by Hookpost?'
            ),
            description: t(
              'faq_to_confirm_credit_card_information_hookpost_will_hold',
              'Your card or UPI mandate is authorised securely by Razorpay. You can cancel your subscription anytime from settings without talking to a person'
            ),
          },
        ]
      : []),
    {
      title: t(
        'faq_can_i_trust_hookpost_gitroom',
        `Can I trust ${isGeneral ? 'Hookpost' : 'Gitroom'}?`
      ),
      // Hookpost is proprietary (owner, 24 Oct 2026; LICENSE), so this answer
      // never calls it open source or self-hostable, as the one it replaced on
      // 11 Oct 2026 did. The key is new on purpose: t() reads the stored
      // translation first, so reusing an old key would bring old text back.
      description: t(
        'faq_hookpost_is_built_by_hookstep',
        `${
          isGeneral ? 'Hookpost' : 'Gitroom'
        } is built and run by Hookstep, a team based in Mumbai, India. Read how we handle your data in the privacy policy, and write to support@hookstep.in with any question.`
      ),
    },
    // The plan-change policy, in the same words as the preview under each
    // plan, /terms and /refund-policy (razorpay.mapping.ts).
    {
      title: t(
        'faq_what_happens_when_i_change_plan',
        'What happens when I upgrade or downgrade?'
      ),
      description: t(
        'faq_plan_change_policy',
        'An upgrade starts immediately, and the unused days of the cycle you have already paid for are credited against the new plan: nothing is lost and no free days are added. A downgrade starts at your next billing cycle, so you keep the plan you paid for until its last day. Nothing is refunded for part of a period, and a scheduled downgrade can be called off here before it takes effect.'
      ),
    },
    // refund-terms.ts: the same words as /terms and /refund-policy. New key
    // on purpose, so no stored translation brings back older wording.
    {
      title: t('faq_refund_on_request_title', REFUND_FAQ.q),
      description: t('faq_refund_on_request', REFUND_FAQ.a),
    },
    {
      title: t('faq_what_are_channels', 'What are channels?'),
      description: t(
        'faq_hookpost_gitroom_allows_you_to_schedule_posts',
        `${
          isGeneral ? 'Hookpost' : 'Gitroom'
        } allows you to schedule your posts between different channels.
A channel is a publishing platform where you can schedule your posts.
For example, you can schedule your posts on X, Facebook, Instagram, TikTok, YouTube, Reddit, Linkedin, Dribbble, Threads and Pinterest.`
      ),
    },
    {
      title: t('faq_what_are_team_members', 'What are team members?'),
      description: t(
        'faq_if_you_have_a_team_with_multiple_members',
        'If you have a team with multiple members, you can invite them to your workspace to collaborate on your posts and add their personal channels'
      ),
    },
    ...(user?.tier?.current === 'FREE'
      ? [
          {
            title: t(
              'faq_how_can_i_delete_my_account',
              'How can I delete my account?'
            ),
            description: t(
              'faq_delete_account_description',
              `If you don't want to continue using ${
                isGeneral ? 'Hookpost' : 'Gitroom'
              }, you can delete your account, including all your organizations, channels and posts. This action cannot be undone.`
            ),
            content: <DeleteAccountComponent isLink={true} />,
          },
        ]
      : []),
  ];
};
export const FAQSection: FC<{
  title: string;
  description: string;
  content?: ReactNode;
}> = (props) => {
  const { title, description, content } = props;
  const [show, setShow] = useState(false);
  const changeShow = useCallback(() => {
    setShow(!show);
  }, [show]);
  return (
    <div
      className="bg-sixth p-[24px] border border-tableBorder rounded-[8px] flex flex-col"
      onClick={changeShow}
    >
      <div className={`text-[20px] cursor-pointer flex justify-center`}>
        <div className="flex-1">{title}</div>
        <div className="flex items-center justify-center w-[32px]">
          {!show ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
            >
              <path
                d="M18 12.75H6C5.59 12.75 5.25 12.41 5.25 12C5.25 11.59 5.59 11.25 6 11.25H18C18.41 11.25 18.75 11.59 18.75 12C18.75 12.41 18.41 12.75 18 12.75Z"
                fill="white"
              />
              <path
                d="M12 18.75C11.59 18.75 11.25 18.41 11.25 18V6C11.25 5.59 11.59 5.25 12 5.25C12.41 5.25 12.75 5.59 12.75 6V18C12.75 18.41 12.41 18.75 12 18.75Z"
                fill="white"
              />
            </svg>
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="32"
              height="32"
              viewBox="0 0 32 32"
              fill="none"
            >
              <path
                d="M24 17H8C7.45333 17 7 16.5467 7 16C7 15.4533 7.45333 15 8 15H24C24.5467 15 25 15.4533 25 16C25 16.5467 24.5467 17 24 17Z"
                fill="#ECECEC"
              />
            </svg>
          )}
        </div>
      </div>
      <div
        className={clsx(
          'transition-all duration-500 overflow-hidden',
          !show ? 'max-h-[0]' : 'max-h-[500px]'
        )}
      >
        <div
          onClick={(e) => {
            e.stopPropagation();
          }}
          className={`mt-[16px] w-full text-wrap font-[400] text-[16px] text-customColor17 select-text max-w-[450px]`}
          dangerouslySetInnerHTML={{
            __html: description,
          }}
        />
        {content && (
          <div
            onClick={(e) => {
              e.stopPropagation();
            }}
            className="mt-[16px]"
          >
            {content}
          </div>
        )}
      </div>
    </div>
  );
};
export const FAQComponent: FC = () => {
  const t = useT();
  const list = useFaqList();
  return (
    <div>
      {/*<h3 className="text-[24px] mt-[48px] mb-[40px] tablet:mt-[80px]">*/}
      {/*  {t('frequently_asked_questions', 'Frequently Asked Questions')}*/}
      {/*</h3>*/}
      <div className="gap-[24px] flex-col flex select-none  mt-[48px] mb-[40px] tablet:mt-[80px]">
        {list.map((item, index) => (
          <FAQSection key={index} {...item} />
        ))}
      </div>
    </div>
  );
};
