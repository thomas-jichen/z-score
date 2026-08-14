import { Nav } from "@/components/Nav";
import { AppStateProvider } from "@/components/AppState";

/**
 * The provider sits above the nav so both can see the enrichment job. That is
 * what lets a run keep going while you walk to another screen, and it is why the
 * nav can show its progress from anywhere.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppStateProvider>
      <Nav />
      <main>{children}</main>
    </AppStateProvider>
  );
}
