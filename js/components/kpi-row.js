/**
 * The four dashboard KPI cards.
 */

const KpiRow = (() => {
  function el(id) { return document.getElementById(id); }

  function render() {
    const s = State.getSummary();
    el("kpi-row").innerHTML = `
      <div class="kpi-card">
        <div class="kpi-label">Free now</div>
        <div class="kpi-value accent-success">${s.free}</div>
        <div class="kpi-sub">fully free · ${s.partial} partly free</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">In use</div>
        <div class="kpi-value">${s.inuse}</div>
        <div class="kpi-sub">${s.ticketsCount} ticket${s.ticketsCount === 1 ? "" : "s"} · ${s.peopleCount} people</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Needs attention</div>
        <div class="kpi-value accent-danger">${s.needsAttention}</div>
        <div class="kpi-sub">servers offline</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Freeing up soon</div>
        <div class="kpi-value">${s.freeingSoon}</div>
        <div class="kpi-sub">within 2 hours</div>
      </div>
    `;
  }

  return { render };
})();
