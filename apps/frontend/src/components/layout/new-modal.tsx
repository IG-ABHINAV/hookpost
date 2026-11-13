import { create } from 'zustand';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import { useShallow } from 'zustand/react/shallow';
import React, {
  createContext,
  FC,
  memo,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { Button } from '@hookpost/react/form/button';
import { useHotkeys } from 'react-hotkeys-hook';
import clsx from 'clsx';
import { EventEmitter } from 'events';

interface OpenModalInterface {
  title?: any;
  closeOnClickOutside?: boolean;
  removeLayout?: boolean;
  fullScreen?: boolean;
  top?: string | number;
  closeOnEscape?: boolean;
  withCloseButton?: boolean;
  askClose?: boolean;
  onClose?: () => void;
  children: ReactNode | ((close: () => void) => ReactNode);
  classNames?: {
    modal?: string;
  };
  size?: string | number;
  maxSize?: string | number;
  height?: string | number;
  id?: string;
}

interface ModalManagerStoreInterface {
  closeById(id: string): void;
  openModal(params: OpenModalInterface): void;
  closeAll(): void;
}

interface State extends ModalManagerStoreInterface {
  modalManager: Array<{ id: string } & OpenModalInterface>;
}

const useModalStore = create<State>((set) => ({
  modalManager: [],
  openModal: (params) => {
    const newId = params.id || makeId(20);
    set((state) => ({
      modalManager: [
        ...state.modalManager,
        ...(!state.modalManager.some((p) => p.id === newId)
          ? [{ id: newId, ...params }]
          : []),
      ],
    }));
  },
  closeById: (id) =>
    set((state) => ({
      modalManager: state.modalManager.filter((modal) => modal.id !== id),
    })),
  closeAll: () => set({ modalManager: [] }),
}));

/** True while any modal (including an "are you sure?" dialog) is open. */
export const useHasOpenModal = (): boolean =>
  useModalStore((state) => state.modalManager.length > 0);

const CurrentModalContext = createContext({ id: '' });

// Lets a modal's content own how it closes. The composer asks "are you sure?"
// only when something changed, and Escape has to follow that same rule
// instead of the modal's own askClose question.
const ModalCloseHandlerContext = createContext<{
  setCloseHandler: (handler?: () => void) => void;
}>({ setCloseHandler: () => undefined });

/** Escape on this modal runs `handler` (when given) instead of closing it. */
export const useModalCloseHandler = (handler?: () => void) => {
  const { setCloseHandler } = useContext(ModalCloseHandlerContext);
  useEffect(() => {
    setCloseHandler(handler);
    return () => setCloseHandler(undefined);
  }, [handler, setCloseHandler]);
};

interface ModalManagerInterface extends ModalManagerStoreInterface {
  closeCurrent(): void;
}

export const useModals = () => {
  const { closeAll, openModal, closeById } = useModalStore(
    useShallow((state) => ({
      openModal: state.openModal,
      closeById: state.closeById,
      closeAll: state.closeAll,
    }))
  );

  const modalContext = useContext(CurrentModalContext);

  return {
    openModal,
    closeAll,
    closeById,
    closeCurrent: () => {
      if (modalContext.id) {
        closeById(modalContext.id);
      }
    },
  } satisfies ModalManagerInterface;
};

export const Component: FC<{
  closeModal: (id: string) => void;
  zIndex: number;
  isLast: boolean;
  modal: { id: string } & OpenModalInterface;
}> = memo(({ isLast, modal, closeModal, zIndex }) => {
  const decision = useDecisionModal();
  const closeHandler = useRef<(() => void) | undefined>(undefined);
  const closeHandlerContext = useMemo(
    () => ({
      setCloseHandler: (handler?: () => void) => {
        closeHandler.current = handler;
      },
    }),
    []
  );
  const closeModalFunction = useCallback(async () => {
    if (modal.askClose) {
      const open = await decision.open();
      if (!open) {
        return;
      }
    }
    modal?.onClose?.();
    closeModal(modal.id);
  }, [modal.id, closeModal]);

  const RenderComponent = useMemo(() => {
    return typeof modal.children === 'function'
      ? modal.children(closeModalFunction)
      : modal.children;
  }, [modal, closeModalFunction]);

  useHotkeys(
    'Escape',
    (event) => {
      if (!isLast) {
        return;
      }
      if (closeHandler.current) {
        // An Escape a widget inside already handled (the emoji picker's
        // search, a mention list) closes only that widget, not the content.
        if (event?.defaultPrevented) {
          return;
        }
        closeHandler.current();
        return;
      }
      closeModalFunction();
    },
    [isLast, closeModalFunction]
  );

  if (modal.removeLayout) {
    return (
      <ModalCloseHandlerContext.Provider value={closeHandlerContext}>
        <div
          style={{ zIndex }}
          className={clsx(
            !modal.fullScreen
              ? 'pb-[50px] min-w-full min-h-full'
              : 'w-full h-full',
            'fixed flex left-0 top-0 bg-popup transition-all animate-fadeIn overflow-y-auto text-newTextColor',
            !isLast && '!overflow-hidden'
          )}
        >
          <div className={clsx(modal.fullScreen && 'flex', 'relative flex-1 min-w-0')}>
            <div
              className={clsx(
                modal.fullScreen
                  ? 'flex flex-1 min-w-0'
                  : 'absolute top-0 left-0 min-w-full min-h-full'
              )}
            >
              <div
                className={clsx(
                  modal.fullScreen ? 'w-full h-full flex-1 min-w-0' : 'mx-auto py-[48px]'
                )}
                {...(modal.size && { style: { width: modal.size } })}
              >
                {typeof modal.children === 'function'
                  ? modal.children(closeModalFunction)
                  : modal.children}
              </div>
            </div>
          </div>
        </div>
      </ModalCloseHandlerContext.Provider>
    );
  }

  return (
    <ModalCloseHandlerContext.Provider value={closeHandlerContext}>
      <CurrentModalContext.Provider value={{ id: modal.id }}>
        <div
          onClick={closeModalFunction}
          style={{ zIndex }}
          className={clsx(
            // inset-0 + overflow: the backdrop is exactly the visible screen
            // and scrolls a dialog taller than it (min-h-full let it grow
            // past an iPhone's toolbars, out of reach).
            'fixed flex inset-0 bg-popup transition-all animate-fadeIn overflow-y-auto overscroll-contain text-newTextColor',
            !modal.fullScreen && 'pb-[50px]'
          )}
        >
          <div className="relative flex-1">
            <div
              style={
                modal.top
                  ? { paddingTop: modal.top, paddingBottom: modal.top }
                  : {}
              }
              className={clsx(
                'absolute min-w-full',
                !modal.fullScreen
                  ? modal.top
                    ? ''
                    : // Centred both ways (the plan and upgrade dialogs among
                      // them); a dialog taller than the screen grows the box
                      // and scrolls from its top, as before.
                      'min-h-full flex justify-center items-center py-[24px] md:py-[48px]'
                  : 'h-screen h-dvh',
                modal.size && modal.height
                  ? 'flex justify-center items-center'
                  : 'top-0 left-0'
              )}
            >
              <div
                className={clsx(
                  // 32px of padding each side is most of a phone's width
                  !modal.removeLayout && 'gap-[24px] p-[20px] md:gap-[40px] md:p-[32px]',
                  'bg-newBgColorInner mx-auto flex flex-col w-fit rounded-[24px] relative',
                  // min-w-[600px] and a hard pixel width from modal.size both
                  // made these dialogs wider than a phone, so their text ran off
                  // the right edge with no way to scroll to it. Cap to the
                  // viewport and let the declared size act as a preference.
                  'max-w-[calc(100vw-24px)]',
                  modal.size ? '' : 'md:min-w-[600px]',
                  modal.fullScreen && 'h-full'
                )}
                {...((!!modal.size || !!modal.height || !!modal.maxSize) && {
                  style: {
                    ...(modal.size ? { width: modal.size } : {}),
                    ...(modal.height ? { height: modal.height } : {}),
                    maxWidth: modal.maxSize || 'calc(100vw - 24px)',
                  },
                })}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center">
                  {/* pe: the title never runs under the close button. */}
                  <div className="text-[20px] md:text-[24px] font-[600] flex-1 min-w-0 pe-[36px]">
                    {modal.title}
                  </div>
                  {typeof modal.withCloseButton === 'undefined' ||
                  modal.withCloseButton ? (
                    <div className="cursor-pointer">
                      <button
                        aria-label="Close"
                        // 44px to tap; the icon stays 16px.
                        className="outline-none absolute end-[8px] top-[8px] md:end-[14px] md:top-[14px] w-[44px] h-[44px] flex items-center justify-center rounded-[8px] mantine-UnstyledButton-root mantine-ActionIcon-root hover:bg-tableBorder cursor-pointer mantine-Modal-close"
                        type="button"
                        onClick={closeModalFunction}
                      >
                        <svg
                          viewBox="0 0 15 15"
                          fill="none"
                          xmlns="http://www.w3.org/2000/svg"
                          width="16"
                          height="16"
                        >
                          <path
                            d="M11.7816 4.03157C12.0062 3.80702 12.0062 3.44295 11.7816 3.2184C11.5571 2.99385 11.193 2.99385 10.9685 3.2184L7.50005 6.68682L4.03164 3.2184C3.80708 2.99385 3.44301 2.99385 3.21846 3.2184C2.99391 3.44295 2.99391 3.80702 3.21846 4.03157L6.68688 7.49999L3.21846 10.9684C2.99391 11.193 2.99391 11.557 3.21846 11.7816C3.44301 12.0061 3.80708 12.0061 4.03164 11.7816L7.50005 8.31316L10.9685 11.7816C11.193 12.0061 11.5571 12.0061 11.7816 11.7816C12.0062 11.557 12.0062 11.193 11.7816 10.9684L8.31322 7.49999L11.7816 4.03157Z"
                            fill="currentColor"
                            fillRule="evenodd"
                            clipRule="evenodd"
                          ></path>
                        </svg>
                      </button>
                    </div>
                  ) : null}
                </div>
                <div
                  className={clsx(
                    'whitespace-pre-line',
                    !!modal.height && !!modal.size && 'flex flex-1 flex-col'
                  )}
                >
                  {RenderComponent}
                </div>
              </div>
            </div>
          </div>
        </div>
      </CurrentModalContext.Provider>
    </ModalCloseHandlerContext.Provider>
  );
});

export const ModalManagerInner: FC = () => {
  const { closeModal, modalManager } = useModalStore(
    useShallow((state) => ({
      closeModal: state.closeById,
      modalManager: state.modalManager,
    }))
  );

  useEffect(() => {
    if (modalManager.length > 0) {
      document.querySelector('body')?.classList.add('overflow-hidden');
      Array.from(document.querySelectorAll('.blurMe') || []).map((p) =>
        p.classList.add('blur-xs', 'pointer-events-none')
      );
    } else {
      document.querySelector('body')?.classList.remove('overflow-hidden');
      Array.from(document.querySelectorAll('.blurMe') || []).map((p) =>
        p.classList.remove('blur-xs', 'pointer-events-none')
      );
    }
  }, [modalManager]);

  if (modalManager.length === 0) {
    return null;
  }

  return (
    <>
      <style>{`body, html { overflow: hidden !important; }`}</style>
      {modalManager.map((modal, index) => (
        <Component
          isLast={modalManager.length - 1 === index}
          key={modal.id}
          modal={modal}
          zIndex={200 + index}
          closeModal={closeModal}
        />
      ))}
    </>
  );
};
export const ModalManager: FC<{ children: ReactNode }> = ({ children }) => {
  return (
    <div>
      <ModalManagerEmitter />
      <ModalManagerInner />
      <div className="transition-all w-full">{children}</div>
    </div>
  );
};

const emitter = new EventEmitter();
export const showModalEmitter = (params: ModalManagerInterface) => {
  emitter.emit('show', params);
};

export const ModalManagerEmitter: FC = () => {
  const { showModal } = useModalStore(
    useShallow((state) => ({
      showModal: state.openModal,
    }))
  );

  useEffect(() => {
    emitter.on('show', (params: OpenModalInterface) => {
      showModal(params);
    });

    return () => {
      emitter.removeAllListeners('show');
    };
  }, []);
  return null;
};

export const DecisionModal: FC<{
  description: string;
  approveLabel: string;
  cancelLabel: string;
  onlyApprove: boolean;
  resolution: (value: boolean) => void;
}> = ({ description, cancelLabel, approveLabel, resolution, onlyApprove }) => {
  const { closeCurrent } = useModals();
  return (
    <div className="flex flex-col">
      <div className="max-w-[600px]">{description}</div>
      <div className="flex gap-[12px] mt-[16px]">
        <Button
          onClick={() => {
            resolution(true);
            closeCurrent();
          }}
        >
          {approveLabel}
        </Button>
        {!onlyApprove && (
          <Button
            onClick={() => {
              resolution(false);
              closeCurrent();
            }}
          >
            {cancelLabel}
          </Button>
        )}
      </div>
    </div>
  );
};

export const decisionModalEmitter = new EventEmitter();

export const areYouSure = ({
  title = 'Are you sure?',
  description = 'Are you sure you want to close this modal?' as any,
  approveLabel = 'Yes',
  cancelLabel = 'No',
  onlyApprove = false,
} = {}): Promise<boolean | undefined> => {
  return new Promise<boolean | undefined>((newRes) => {
    decisionModalEmitter.emit('open', {
      title,
      description,
      approveLabel,
      cancelLabel,
      onlyApprove,
      newRes,
    });
  });
};

export const DecisionEverywhere: FC = () => {
  const decision = useDecisionModal();
  useEffect(() => {
    decisionModalEmitter.on('open', decision.open);
  }, []);
  return null;
};

export const useDecisionModal = () => {
  const modals = useModals();
  const open = useCallback(
    ({
      title = 'Are you sure?',
      description = 'Are you sure you want to close this modal?' as any,
      onlyApprove = false,
      approveLabel = 'Yes',
      cancelLabel = 'No',
      newRes = undefined as any,
    } = {}) => {
      return new Promise<boolean | undefined>((res) => {
        modals.openModal({
          title,
          askClose: false,
          // X, Escape and a click outside answer "No" - as undefined, which
          // every caller reads as no, so a caller with two real choices
          // (the free-posts switch prompt) can tell "closed" from "the second
          // button". Resolving only this promise left an areYouSure caller
          // (newRes) waiting forever, with its button still spinning.
          onClose: () => (newRes ? newRes(undefined) : res(undefined)),
          children: (
            <DecisionModal
              onlyApprove={onlyApprove}
              resolution={(value) => (newRes ? newRes(value) : res(value))}
              description={description}
              approveLabel={approveLabel}
              cancelLabel={cancelLabel}
            />
          ),
        });
      });
    },
    [modals]
  );

  return { open };
};
