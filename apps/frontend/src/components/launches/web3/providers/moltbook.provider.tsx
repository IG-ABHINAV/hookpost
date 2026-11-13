'use client';

import React, { FC, useCallback, useEffect, useRef, useState } from 'react';
import { Web3ProviderInterface } from '@hookpost/frontend/components/launches/web3/web3.provider.interface';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { timer } from '@hookpost/helpers/utils/timer';
import { Input } from '@hookpost/react/form/input';
import { Button } from '@hookpost/react/form/button';
import copy from 'copy-to-clipboard';
import { useToaster } from '@hookpost/react/toaster/toaster';
import { useT } from '@hookpost/react/translation/get.transation.service.client';

type Status = { claimed?: boolean; status?: string; error?: string };

export const MoltbookProvider: FC<Web3ProviderInterface> = (props) => {
  const { onComplete, nonce } = props;
  const fetch = useFetch();
  const stop = useRef(false);
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [step, setStep] = useState<
    'init' | 'registering' | 'waiting' | 'checking' | 'error'
  >('init');
  const [agentName, setAgentName] = useState('');
  const [agentDescription, setAgentDescription] = useState('');
  const [existingKey, setExistingKey] = useState('');
  const [claimUrl, setClaimUrl] = useState('');
  const [error, setError] = useState('');
  const toaster = useToaster();
  const t = useT();

  // POST, never a query string: this is the agent's permanent API key.
  const readStatus = useCallback(
    async (key: string): Promise<Status> => {
      const response = await fetch('/integrations/moltbook/status', {
        method: 'POST',
        body: JSON.stringify({ apiKey: key }),
      });
      return response.json();
    },
    [fetch]
  );

  const fail = (message: string) => {
    stop.current = true;
    setError(message);
    setStep('error');
  };

  const pollForClaim = async (key: string) => {
    stop.current = false;

    while (!stop.current) {
      try {
        const data = await readStatus(key);

        if (data.claimed) {
          onComplete(key, nonce);
          return;
        }

        // the key itself was rejected, waiting longer cannot help
        if (data.error) {
          fail(data.error);
          return;
        }
      } catch (err) {
        // network blip, keep polling
      }

      await timer(3000);
    }
  };

  const register = async () => {
    if (!agentName.trim()) {
      toaster.show('Please enter an agent name', 'warning');
      return;
    }

    setStep('registering');
    setError('');

    try {
      const response = await fetch('/integrations/moltbook/register', {
        method: 'POST',
        body: JSON.stringify({
          name: agentName.trim(),
          description:
            agentDescription.trim() || 'Hookpost social media scheduler',
        }),
      });

      const data = await response.json();

      if (data.error || !data.apiKey) {
        fail(data.error || 'Moltbook did not return an API key');
        return;
      }

      setClaimUrl(data.claimUrl);
      setStep('waiting');

      pollForClaim(data.apiKey);
    } catch (err) {
      fail('Failed to register agent');
    }
  };

  // An agent registered elsewhere (or a key rotated from the Moltbook owner
  // dashboard). Moltbook allows one agent per X account, so an owner who
  // already has an agent could not connect it through registration alone.
  const connectExisting = async () => {
    const key = existingKey.trim();
    if (!key) {
      toaster.show('Please paste the agent API key', 'warning');
      return;
    }

    setStep('checking');
    setError('');

    try {
      const data = await readStatus(key);

      if (data.claimed) {
        onComplete(key, nonce);
        return;
      }

      if (data.error) {
        fail(data.error);
        return;
      }

      if (data.status === 'pending_claim') {
        fail(
          'This agent is not claimed yet. Open its claim link from Moltbook, finish the email and X verification, then try again.'
        );
        return;
      }

      if (data.status) {
        fail(
          `Moltbook reports this agent as "${data.status}", so it cannot post yet.`
        );
        return;
      }

      fail('Moltbook did not answer. Try again in a minute.');
    } catch (err) {
      fail('Could not reach Moltbook. Try again in a minute.');
    }
  };

  const copyClaimUrl = useCallback(() => {
    copy(claimUrl);
    toaster.show('Claim URL copied to clipboard', 'success');
  }, [claimUrl, toaster]);

  useEffect(() => {
    return () => {
      stop.current = true;
    };
  }, []);

  return (
    <div className="justify-center items-center flex flex-col pt-[16px]">
      {step === 'init' && (
        <>
          <div className="flex gap-[8px] mb-[16px]">
            <Button secondary={mode !== 'new'} onClick={() => setMode('new')}>
              {t('moltbook_new_agent', 'Create a new agent')}
            </Button>
            <Button
              secondary={mode !== 'existing'}
              onClick={() => setMode('existing')}
            >
              {t('moltbook_existing_agent', 'I already have an agent')}
            </Button>
          </div>

          {mode === 'new' ? (
            <>
              <div className="text-center mb-[16px]">
                {t(
                  'moltbook_register_description',
                  'Register your Moltbook agent to connect:'
                )}
              </div>
              <div className="w-full space-y-[12px]">
                <Input
                  label={t('agent_name', 'Agent Name')}
                  value={agentName}
                  name="agentName"
                  disableForm={true}
                  onChange={(e) => setAgentName(e.target.value)}
                  placeholder="MyHookpostAgent"
                />
                <Input
                  label={t('description_optional', 'Description (optional)')}
                  value={agentDescription}
                  name="agentDescription"
                  disableForm={true}
                  onChange={(e) => setAgentDescription(e.target.value)}
                  placeholder="Social media scheduler"
                />
                <Button className="w-full" onClick={register}>
                  {t('register_agent', 'Register Agent')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="text-center mb-[16px]">
                {t(
                  'moltbook_existing_description',
                  "Paste your claimed agent's API key (it starts with moltbook_). The owner dashboard at moltbook.com can issue a new one."
                )}
              </div>
              <div className="w-full space-y-[12px]">
                <Input
                  label={t('api_key', 'API Key')}
                  value={existingKey}
                  name="moltbookApiKey"
                  type="password"
                  autoComplete="off"
                  disableForm={true}
                  onChange={(e) => setExistingKey(e.target.value)}
                  placeholder="moltbook_..."
                />
                <Button className="w-full" onClick={connectExisting}>
                  {t('connect', 'Connect')}
                </Button>
              </div>
            </>
          )}
        </>
      )}

      {step === 'registering' && (
        <div className="text-center">
          {t('registering_agent', 'Registering agent...')}
        </div>
      )}

      {step === 'checking' && (
        <div className="text-center">
          {t('moltbook_checking_agent', 'Checking the agent with Moltbook...')}
        </div>
      )}

      {step === 'waiting' && (
        <div className="w-full text-center">
          <div className="mb-[16px]">
            {t(
              'moltbook_claim_instructions',
              'Please visit the claim URL to verify your agent:'
            )}
          </div>
          <div className="flex gap-[8px]">
            <div className="flex-1">
              <Input
                label=""
                value={claimUrl}
                name="claimUrl"
                disableForm={true}
                readOnly
              />
            </div>
            <Button onClick={copyClaimUrl}>{t('copy', 'Copy')}</Button>
          </div>
          <div className="mt-[16px] text-sm opacity-70">
            {t('waiting_for_claim', 'Waiting for you to claim your agent...')}
          </div>
          <div className="mt-[8px]">
            <a
              href={claimUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500 hover:underline"
            >
              {t('open_claim_page', 'Open claim page')}
            </a>
          </div>
        </div>
      )}

      {step === 'error' && (
        <div className="w-full text-center">
          <div className="text-red-500 mb-[16px]">{error}</div>
          <Button onClick={() => setStep('init')}>
            {t('try_again', 'Try Again')}
          </Button>
        </div>
      )}
    </div>
  );
};
