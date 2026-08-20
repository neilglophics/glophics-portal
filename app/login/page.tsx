import { Icon } from "@/components/ui/Icon";
import { LoginForm } from "@/components/LoginForm";

/**
 * The sign-in gate. Outside the (app) route group on purpose: pages in there
 * assume a shell around them, and there is no shell until someone is signed in.
 *
 * Ported from public/js/ui/login-screen.js — same two-panel layout, same copy.
 */
export const metadata = { title: "Sign in · Glophics Portal" };

function BrandPanel() {
  return (
    <div className="relative hidden overflow-hidden bg-gradient-to-br from-brand-500 to-brand-700 p-12 text-white lg:flex lg:flex-col lg:justify-between">
      <svg
        className="pointer-events-none absolute -right-16 top-1/2 h-96 w-96 -translate-y-1/2 text-white/10"
        viewBox="0 0 100 100"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M50 4c2 26 18 42 44 46-26 4-42 20-46 46-4-26-20-42-46-46 26-4 42-20 48-46z" />
      </svg>

      <div className="relative flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-white/15 backdrop-blur">
          <Icon name="servers" className="h-5 w-5" />
        </span>
        <span className="text-lg font-bold tracking-tight">Server Management</span>
      </div>

      <div className="relative max-w-md">
        <h2 className="text-[28px] font-bold leading-tight tracking-tight">
          Know which environment is free before you deploy.
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-white/75">
          Every QA and staging box, who is holding it, and which ticket claimed it — live for the whole
          team.
        </p>
      </div>

      <p className="relative text-xs text-white/50">Ask a super admin for an account.</p>
    </div>
  );
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <div className="grid h-full lg:grid-cols-2">
      <BrandPanel />
      <div className="flex items-center justify-center bg-surface px-6 py-12 sm:px-12">
        <LoginForm next={next} />
      </div>
    </div>
  );
}
