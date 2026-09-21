/* Focus containment for modal dialogs, including nested export warnings.
   The app owns opening/closing and Escape; this module owns keyboard isolation. */
(() => {
  "use strict";
  const selector = '[role="dialog"][aria-modal="true"]';
  const focusable = 'button:not(:disabled),a[href],input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';
  const stack = [];
  const inertBefore = new Map();
  let previousFocus = document.activeElement;
  let lastTrigger = null;
  let syncing = false;

  function visible(element) {
    return element.isConnected && !element.closest('[hidden],[aria-hidden="true"]') &&
      getComputedStyle(element).visibility !== "hidden" && element.getClientRects().length > 0;
  }

  function restoreBackground() {
    for (const [element, value] of inertBefore) element.inert = value;
    inertBefore.clear();
  }

  function isolate(dialog) {
    for (let branch = dialog; branch && branch !== document.body; branch = branch.parentElement) {
      for (const sibling of branch.parentElement?.children || []) {
        if (sibling === branch || /^(SCRIPT|STYLE|LINK)$/.test(sibling.tagName)) continue;
        if (!inertBefore.has(sibling)) inertBefore.set(sibling, sibling.inert);
        sibling.inert = true;
      }
    }
  }

  function controls(dialog) {
    return [...dialog.querySelectorAll(focusable)].filter(element => visible(element) && !element.closest('[inert]'));
  }

  function focusFirst(dialog) {
    const target = controls(dialog)[0] || dialog;
    if (target === dialog && !dialog.hasAttribute("tabindex")) dialog.tabIndex = -1;
    target.focus({ preventScroll: true });
  }

  function sync() {
    if (syncing) return stack.at(-1)?.dialog;
    syncing = true;
    try {
      const dialogs = [...document.querySelectorAll(selector)].filter(visible);
      // The calendar acquires dialog semantics lazily when first opened.
      // Subscribe then as well, so closing it restores background interactivity.
      dialogs.forEach(watchDialog);
      const oldTop = stack.at(-1);
      let restoreTarget = null;
      while (stack.length && !dialogs.includes(stack.at(-1).dialog)) restoreTarget = stack.pop().restore;
      // Remove closed lower dialogs without disturbing an open nested dialog.
      for (let index = stack.length - 1; index >= 0; index--) {
        if (!dialogs.includes(stack[index].dialog)) stack.splice(index, 1);
      }
      for (const dialog of dialogs) {
        if (stack.some(item => item.dialog === dialog)) continue;
        const candidate = stack.length ? previousFocus : (lastTrigger || previousFocus);
        stack.push({ dialog, restore: candidate && !dialog.contains(candidate) ? candidate : null });
        lastTrigger = null;
      }
      const top = stack.at(-1);
      if (top !== oldTop) {
        restoreBackground();
        if (top) isolate(top.dialog);
        if (restoreTarget && visible(restoreTarget) && !restoreTarget.closest('[inert]')) {
          restoreTarget.focus({ preventScroll: true });
        }
        if (top && !top.dialog.contains(document.activeElement)) focusFirst(top.dialog);
      }
      return top?.dialog;
    } finally {
      syncing = false;
    }
  }

  document.addEventListener("pointerdown", event => {
    lastTrigger = event.target.closest('button,a[href],input,select,[tabindex]');
  }, true);
  document.addEventListener("focusin", event => {
    const dialog = sync();
    if (dialog && !dialog.contains(event.target)) focusFirst(dialog);
    previousFocus = document.activeElement;
  }, true);
  document.addEventListener("keydown", event => {
    const dialog = sync();
    if (!dialog || event.key !== "Tab") return;
    const items = controls(dialog);
    const first = items[0], last = items.at(-1);
    if (!first) {
      event.preventDefault();
      focusFirst(dialog);
    } else if (!dialog.contains(document.activeElement) ||
      (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) ||
      (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus({ preventScroll: true });
    }
  }, true);
  const observer = new MutationObserver(sync);
  // Observe the modal and its visibility-controlling ancestors, not map tiles
  // or frequently changing timeline content throughout the entire document.
  const targets = new Set();
  function watchDialog(dialog) {
    for (let element = dialog; element && element !== document.body; element = element.parentElement) {
      if (targets.has(element)) continue;
      targets.add(element);
      observer.observe(element, { attributes: true, attributeFilter: ["hidden", "class", "aria-hidden", "style"] });
    }
  }
  document.querySelectorAll(selector).forEach(watchDialog);
  sync();
})();
