/**
 * Settings → Booking rules panel: default claim length and what happens
 * when time runs out.
 */

const SettingsRules = (() => {
  function el(id) { return document.getElementById(id); }

  function render() {
    const settings = State.getSettings();
    el("rule-booking-length").value = String(settings.defaultBookingHours);
    el("rule-on-expiry").value = settings.onExpiry;
    el("rule-assign-whole-env").checked = settings.assignWholeEnv !== false;
  }

  function bindEvents() {
    el("rule-booking-length").addEventListener("change", (e) => {
      State.updateSettings({ defaultBookingHours: Number(e.target.value) });
    });
    el("rule-on-expiry").addEventListener("change", (e) => {
      State.updateSettings({ onExpiry: e.target.value });
    });
    el("rule-assign-whole-env").addEventListener("change", (e) => {
      State.updateSettings({ assignWholeEnv: e.target.checked });
    });
  }

  return { render, bindEvents };
})();
