/**
 * Settings → Jira integration panel: connection fields, feature checkboxes,
 * and the Occupies/Frees status-rules editor.
 */

const SettingsJira = (() => {
  const { escapeHtml } = Format;
  function el(id) { return document.getElementById(id); }

  async function render() {
    const settings = State.getSettings();
    const jira = settings.jira;

    el("jira-toggle").classList.toggle("on", jira.enabled);
    el("jira-state-label").textContent = jira.enabled ? "On — checking configuration…" : "Off — ticket keys entered manually";

    el("jira-options").innerHTML = [
      { key: "requireTicket", label: "Require a ticket key when claiming", hint: "Blocks a manual claim without a Jira reference." },
      { key: "pullTicketInfo", label: "Pull ticket title and assignee", hint: "Shows the summary when typing a ticket into a claim." },
      { key: "commentOnRelease", label: "Comment on the ticket when force-freed", hint: "Posts environment and duration back to Jira." }
    ].map((o) => `
      <label>
        <input type="checkbox" data-jira-opt="${o.key}" ${jira[o.key] ? "checked" : ""} />
        <span>
          <span class="opt-label">${escapeHtml(o.label)}</span>
          <span class="opt-hint">${escapeHtml(o.hint)}</span>
        </span>
      </label>
    `).join("");

    const occSelect = el("jira-occupying-statuses");
    const freeSelect = el("jira-releasing-statuses");
    occSelect.innerHTML = JIRA_STATUS_VOCABULARY.map((s) => `<option value="${escapeHtml(s)}" ${jira.occupyingStatuses.includes(s) ? "selected" : ""}>${escapeHtml(s)}</option>`).join("");
    freeSelect.innerHTML = JIRA_STATUS_VOCABULARY.map((s) => `<option value="${escapeHtml(s)}" ${jira.releasingStatuses.includes(s) ? "selected" : ""}>${escapeHtml(s)}</option>`).join("");
    el("jira-poll-interval").value = String(jira.pollIntervalMinutes || 1);

    try {
      const res = await fetch("/api/jira-config");
      const config = await res.json();
      el("jira-base-url").value = config.baseUrl || "";
      el("jira-email").value = config.email || "";
      el("jira-token").placeholder = config.hasToken ? "Leave blank to keep current token" : "Enter your API token";
      if (jira.enabled) {
        el("jira-state-label").textContent = config.baseUrl ? `Connected to ${config.baseUrl.replace(/^https?:\/\//, "")}` : "On — add your site URL and token below";
      }
    } catch (err) {
      // server not reachable (e.g. running without node server.js) — leave fields blank
    }
  }

  function setTestResult(message, ok) {
    const elm = el("jira-test-result");
    elm.textContent = message;
    elm.className = `jira-test-result ${ok ? "ok" : "error"}`;
  }

  function selectedValues(select) {
    return Array.from(select.selectedOptions).map((o) => o.value);
  }

  function bindEvents() {
    el("jira-toggle").addEventListener("click", () => {
      State.updateJiraOptions({ enabled: !State.getSettings().jira.enabled });
    });

    el("jira-options").addEventListener("change", (e) => {
      const key = e.target.dataset.jiraOpt;
      if (key) State.updateJiraOptions({ [key]: e.target.checked });
    });

    el("jira-occupying-statuses").addEventListener("change", (e) => {
      State.updateJiraOptions({ occupyingStatuses: selectedValues(e.target) });
    });
    el("jira-releasing-statuses").addEventListener("change", (e) => {
      State.updateJiraOptions({ releasingStatuses: selectedValues(e.target) });
    });
    el("jira-poll-interval").addEventListener("change", (e) => {
      State.updateJiraOptions({ pollIntervalMinutes: Number(e.target.value) });
    });

    el("form-jira").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const res = await fetch("/api/jira-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseUrl: el("jira-base-url").value.trim(),
            email: el("jira-email").value.trim(),
            apiToken: el("jira-token").value.trim()
          })
        });
        const data = await res.json();
        el("jira-token").value = "";
        setTestResult(data.ok ? "Saved." : (data.error || "Couldn't save."), !!data.ok);
        render();
      } catch (err) {
        setTestResult("Couldn't reach the server to save this.", false);
      }
    });

    el("jira-test").addEventListener("click", async () => {
      setTestResult("Testing…", true);
      try {
        const res = await fetch("/api/jira-config/test", { method: "POST" });
        const data = await res.json();
        setTestResult(data.ok ? `Connected as ${data.displayName}.` : data.error, !!data.ok);
      } catch (err) {
        setTestResult("Couldn't reach the server to test this.", false);
      }
    });
  }

  return { render, setTestResult, bindEvents };
})();
