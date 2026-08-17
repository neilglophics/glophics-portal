/**
 * Generic yes/no confirmation dialog — callers pass a title, message, and
 * an onConfirm callback; used for both force-free flows.
 */

const ConfirmModal = (() => {
  function el(id) { return document.getElementById(id); }

  let callback = null;

  function open({ title, message, confirmLabel = "Confirm", onConfirm }) {
    el("confirm-modal-title").textContent = title;
    el("confirm-modal-message").textContent = message;
    el("confirm-ok").textContent = confirmLabel;
    callback = onConfirm;
    el("confirm-modal-overlay").hidden = false;
  }

  function close() {
    el("confirm-modal-overlay").hidden = true;
    callback = null;
  }

  function run() {
    if (callback) callback();
    close();
  }

  function bindEvents() {
    el("confirm-cancel").addEventListener("click", close);
    el("confirm-modal-close").addEventListener("click", close);
    el("confirm-ok").addEventListener("click", run);
    el("confirm-modal-overlay").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) close();
    });
  }

  return { open, close, run, bindEvents };
})();
