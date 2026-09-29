import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/lib/providers';
import { SessionsPanelProvider } from '@/lib/sessions-panel-context';
import { SessionsPanel } from '@/components/sessions-panel';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Job Tracker',
  description: 'Resume tailoring and job application tracking',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <SessionsPanelProvider>
            <nav className="border-b border-black/10 dark:border-white/10 px-6 py-3 flex gap-6 text-sm">
              <Link href="/applications">Applications</Link>
              <Link href="/resumes">Resumes</Link>
              <Link href="/dashboard">Dashboard</Link>
            </nav>
            <main className="p-6">{children}</main>
            <SessionsPanel />
          </SessionsPanelProvider>
        </Providers>
      </body>
    </html>
  );
}
