/**
 * The emailed "Confirm email" link, /auth/activate/<token>. The token signs
 * in whoever uses it, so it does not stay in the address bar: the page moves
 * it into this tab's sessionStorage and shows ACTIVATION_CONFIRM_PATH instead,
 * before any analytics script reads the URL (they start in passive effects or
 * later; the page does this in a layout effect). A reload of that address
 * still finds the token in the tab.
 */
export const ACTIVATION_CODE_KEY = 'hp_activation_code';
export const ACTIVATION_CONFIRM_SEGMENT = 'confirm';
export const ACTIVATION_CONFIRM_PATH = `/auth/activate/${ACTIVATION_CONFIRM_SEGMENT}`;

type TabStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * The token for this page: the one in the address (kept for a reload), or
 * the one kept earlier in this tab when the address is already the clean one.
 * Null when there is none. Storage that throws (blocked, private mode) only
 * loses the reload case.
 */
export function takeActivationCode(
  pathCode: unknown,
  storage: TabStorage | null | undefined
): string | null {
  const code =
    typeof pathCode === 'string' ? decodeURIComponent(pathCode).trim() : '';
  if (code && code !== ACTIVATION_CONFIRM_SEGMENT) {
    try {
      storage?.setItem(ACTIVATION_CODE_KEY, code);
    } catch {
      /* blocked storage */
    }
    return code;
  }
  try {
    return storage?.getItem(ACTIVATION_CODE_KEY) || null;
  } catch {
    return null;
  }
}

/** Once the link was used (or refused), the tab keeps nothing. */
export function forgetActivationCode(storage: TabStorage | null | undefined) {
  try {
    storage?.removeItem(ACTIVATION_CODE_KEY);
  } catch {
    /* blocked storage */
  }
}
