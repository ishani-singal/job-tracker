import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/lib/providers';
import { SessionsPanelProvider } from '@/lib/sessions-panel-context';
import { SessionsPanel } from '@/components/sessions-panel';
import { NavChatButton } from '@/components/nav-chat-button';
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
            <nav className="border-b border-black/10 dark:border-white/10 px-6 py-3 flex items-center gap-6 text-sm">
              <Link href="/applications">Applications</Link>
              <Link href="/resumes">Resumes</Link>
              <Link href="/dashboard">Dashboard</Link>
              <Link href="/llm-usage">LLM Usage</Link>
              <Link href="/linkedin">LinkedIn</Link>
              <Link href="/company-resumes">Company Resumes</Link>
              <Link href="/resume-template">Resume Template</Link>
              <NavChatButton />
            </nav>
            <main className="p-6">{children}</main>
            <SessionsPanel />
          </SessionsPanelProvider>
        </Providers>
      </body>
    </html>
  );
}
