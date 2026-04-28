import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'AI App',
  description: 'AI Application',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
