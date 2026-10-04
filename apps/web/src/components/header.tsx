import ClerkHeader from "../integrations/clerk/header-user.tsx";
import { Navigation } from "./navigation";

/**
 * The site doc's nav (navigation.tsx) with the Clerk user button, for app routes outside the CMS
 * that want the site chrome. CMS pages render `Navigation` themselves, without the user button.
 */
export default function Header() {
  return <Navigation actions={<ClerkHeader />} />;
}
