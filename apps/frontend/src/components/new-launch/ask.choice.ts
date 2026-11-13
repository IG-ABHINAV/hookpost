import type { ReactNode } from 'react';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';

/** The part of useModals() that askChoice needs. */
export interface ChoiceModals {
  openModal(params: {
    id?: string;
    title?: any;
    onClose?: () => void;
    children: ReactNode | ((close: () => void) => ReactNode);
  }): void;
  closeById(id: string): void;
}

/**
 * Opens a modal whose buttons each pick an answer, and waits for one.
 * Picking closes the modal: left open, it sat on top of the composer with
 * buttons that no longer did anything, because the answer had already been
 * given. Closing it with X, Escape or a click outside answers null.
 */
export const askChoice = <T>(
  modal: ChoiceModals,
  params: {
    title: any;
    children: (choose: (value: T) => void) => ReactNode;
  }
): Promise<T | null> =>
  new Promise((resolve) => {
    const id = makeId(20);
    const choose = (value: T) => {
      resolve(value);
      modal.closeById(id);
    };
    modal.openModal({
      id,
      title: params.title,
      onClose: () => resolve(null),
      children: () => params.children(choose),
    });
  });
