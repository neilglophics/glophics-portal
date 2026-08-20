import { redirect } from "next/navigation";

/** The board is the app; there is no marketing page. Middleware has already
 *  bounced a signed-out visitor to /login before this renders. */
export default function Home() {
  redirect("/dashboard");
}
