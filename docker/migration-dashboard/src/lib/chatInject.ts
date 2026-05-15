/**
 * Inject a prompt into the embedded LibreChat iframe and submit it as if
 * the user had typed and pressed Enter.
 *
 * Same-origin lets us reach into the iframe document directly. The
 * trickiest part is React-controlled inputs: setting `textarea.value`
 * directly doesn't trigger React's onChange. The standard workaround is
 * to invoke the prototype's native setter and then dispatch an `input`
 * event so React's synthetic-event machinery picks up the change.
 */

export interface InjectResult {
  ok: boolean;
  reason?: string;
}

const SUBMIT_BUTTON_SELECTORS = [
  '[data-testid="send-button"]',
  'button[aria-label*="Send" i]',
  'button[type="submit"]',
];

export function injectPromptIntoChat(
  iframe: HTMLIFrameElement,
  promptText: string,
): InjectResult {
  const doc = iframe.contentDocument;
  if (!doc) {
    return { ok: false, reason: "iframe not ready" };
  }

  // The composer is a <textarea>. If a future LibreChat version moves to a
  // contentEditable div we'll need another branch — flagging.
  const textarea = doc.querySelector("textarea") as HTMLTextAreaElement | null;
  if (!textarea) {
    return { ok: false, reason: "chat textarea not found" };
  }

  // Set the value via the native setter so React's onChange fires. We
  // reach for the prototype of the iframe's HTMLTextAreaElement so the
  // descriptor we find is the one wrapping React's controlled value.
  const proto = Object.getPrototypeOf(textarea);
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!nativeSetter) {
    return { ok: false, reason: "could not access native value setter" };
  }
  nativeSetter.call(textarea, promptText);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));

  // Wait a tick so React has time to flush, then submit.
  requestAnimationFrame(() => {
    const sendButton = findSendButton(doc);
    if (sendButton && !sendButton.disabled) {
      sendButton.click();
      return;
    }
    textarea.focus();
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  return { ok: true };
}

function findSendButton(doc: Document): HTMLButtonElement | null {
  for (const sel of SUBMIT_BUTTON_SELECTORS) {
    const el = doc.querySelector<HTMLButtonElement>(sel);
    if (el) return el;
  }
  return null;
}
