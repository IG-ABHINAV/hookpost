/**
 * The toolbar popup. Asks the background for POPUP_STATUS (yes/no facts, no
 * cookie values) and renders popup.view.ts's description of it. Builds the
 * DOM with textContent only.
 */
import { describePopup, PopupStatusView } from './popup.view';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = ''
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function render(status: PopupStatusView | undefined): void {
  const view = describePopup(status);
  const rows = document.getElementById('rows')!;
  rows.replaceChildren(
    ...view.rows.map((row) => {
      const li = el('li', `row ${row.ok ? 'ok' : 'bad'}`);
      li.append(el('span', 'dot'), el('span', 'label', row.label), el('span', 'value', row.value));
      return li;
    })
  );
  const error = document.getElementById('error')!;
  error.textContent = view.error ?? '';
  error.hidden = !view.error;
  const button = document.getElementById('open') as HTMLAnchorElement;
  button.textContent = view.button.text;
  button.href = view.button.href;
  document.getElementById('how')!.textContent = view.howItWorks;
  document.getElementById('footer')!.textContent = view.footer;
}

document.getElementById('open')!.addEventListener('click', (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: (event.currentTarget as HTMLAnchorElement).href });
  window.close();
});

chrome.runtime.sendMessage({ type: 'POPUP_STATUS' }, (status?: PopupStatusView) => {
  render(chrome.runtime.lastError ? undefined : status);
});
