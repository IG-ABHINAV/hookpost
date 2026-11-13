/**
 * A post written with the AI generator moves the page's calendar to where it
 * landed. The generator popup is wrapped in a CalendarWeekProvider of its own,
 * so the showPost it hands to the composer must be the page calendar's, not
 * the one useCalendar() answers inside the popup.
 *   pnpm exec jest -c apps/frontend/jest.config.ts generator
 */
import React from 'react';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { TextDecoder, TextEncoder } from 'util';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockOpenModal = jest.fn();
const mockFetch = jest.fn();
const mockToast = jest.fn();
const mockCalendar = {
  integrations: [{ id: 'bsky-1' }],
  reloadCalendarView: jest.fn(),
  showPost: jest.fn(),
};
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}));
jest.mock('@hookpost/frontend/components/layout/user.context', () => ({
  useUser: () => ({ id: 'user-1', tier: { ai: true } }),
}));
jest.mock('@hookpost/frontend/components/layout/new-modal', () => ({
  useModals: () => ({ openModal: mockOpenModal, closeAll: jest.fn() }),
}));
jest.mock('@hookpost/frontend/components/launches/calendar.context', () => ({
  useCalendar: () => mockCalendar,
  CalendarWeekProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}));
jest.mock('@hookpost/helpers/utils/custom.fetch', () => ({
  useFetch: () => mockFetch,
}));
jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
}));
jest.mock('@hookpost/react/toaster/toaster', () => ({
  useToaster: () => ({ show: mockToast }),
}));
jest.mock('@hookpost/frontend/components/new-launch/add.edit.modal', () => ({
  AddEditModal: () => null,
}));
jest.mock('@hookpost/react/form/textarea', () => {
  const R = jest.requireActual('react');
  return {
    Textarea: R.forwardRef(({ label, ...props }: any, ref: any) =>
      R.createElement('textarea', { ...props, ref, 'aria-label': label })
    ),
  };
});
jest.mock('@hookpost/react/form/select', () => {
  const R = jest.requireActual('react');
  return {
    Select: R.forwardRef(({ label, ...props }: any, ref: any) =>
      R.createElement('select', { ...props, ref })
    ),
  };
});
jest.mock('@hookpost/react/form/checkbox', () => {
  const R = jest.requireActual('react');
  return {
    Checkbox: R.forwardRef(({ label, ...props }: any, ref: any) =>
      R.createElement('input', { ...props, ref, type: 'checkbox' })
    ),
  };
});
jest.mock('@hookpost/react/form/button', () => {
  const R = jest.requireActual('react');
  return {
    Button: ({ loading, ...props }: any) => R.createElement('button', props),
  };
});

import {
  GeneratorComponent,
  GeneratorPopup,
} from '@hookpost/frontend/components/launches/generator/generator';

// The app extends these once, in layout/set.timezone.tsx.
dayjs.extend(utc);
Object.assign(global, { TextDecoder, TextEncoder });

// What POST /posts/generator streams: one JSON line per step, the last one
// carrying the posts and the slot they open on.
const generated = () => {
  const line = JSON.stringify({
    name: 'post-time',
    data: {
      output: {
        hook: 'Hook',
        content: [{ content: 'Body' }],
        date: '2026-10-26T02:00:00',
      },
    },
  });
  const chunks = [new TextEncoder().encode(`${line}\n`)];
  return {
    status: 200,
    ok: true,
    body: {
      getReader: () => ({
        read: async () =>
          chunks.length
            ? { done: false, value: chunks.shift() }
            : { done: true, value: undefined },
      }),
    },
  };
};

beforeEach(() => {
  jest.clearAllMocks();
});

it('the popup gets the page calendar’s showPost', () => {
  const { container } = render(React.createElement(GeneratorComponent));
  fireEvent.click(container.firstChild as Element);
  const popup = mockOpenModal.mock.calls[0][0].children.props.children;
  expect(popup.type).toBe(GeneratorPopup);
  expect(popup.props.showPost).toBe(mockCalendar.showPost);
});

it('the composer it opens moves that calendar, not the popup’s own', async () => {
  const pageShowPost = jest.fn();
  mockFetch.mockResolvedValue(generated());
  render(React.createElement(GeneratorPopup, { showPost: pageShowPost }));
  fireEvent.change(screen.getByLabelText('Write anything'), {
    target: { value: 'Our Sunday launch, in one post' },
  });
  await act(async () => {
    fireEvent.click(screen.getByText('Generate'));
  });
  expect(mockFetch).toHaveBeenCalledWith('/posts/generator', expect.anything());
  await waitFor(() => expect(mockOpenModal).toHaveBeenCalledTimes(1));
  expect(mockToast).not.toHaveBeenCalled();
  const composer = mockOpenModal.mock.calls[0][0].children;
  expect(composer.props.onAdded).toBe(pageShowPost);
  expect(composer.props.onAdded).not.toBe(mockCalendar.showPost);
  expect(composer.props.date.utc().format()).toBe('2026-10-26T02:00:00Z');
});
