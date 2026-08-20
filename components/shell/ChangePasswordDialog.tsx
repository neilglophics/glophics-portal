"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Field, FormError } from "@/components/ui/Form";

export function ChangePasswordDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit() {
    // Checked here as well as on the server: the confirmation field only exists
    // in the browser, so the server has nothing to compare against.
    if (next !== confirm) {
      setError("The two new passwords don't match.");
      return;
    }

    setError(null);
    setPending(true);

    const res = await fetch("/api/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    }).catch(() => null);

    const data = (await res?.json().catch(() => ({}))) as { ok?: boolean; error?: string };

    if (!res?.ok || !data.ok) {
      setError(data.error ?? "Couldn't change your password.");
      setPending(false);
      return;
    }
    onDone();
  }

  return (
    <Modal
      title="Change password"
      subtitle="This signs out every other tab and device you are signed in on."
      submitLabel="Change password"
      pending={pending}
      onSubmit={submit}
      onClose={onClose}
    >
      <div className="space-y-4">
        <Field
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />
        <Field
          label="New password again"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
      </div>
      <FormError>{error}</FormError>
    </Modal>
  );
}
