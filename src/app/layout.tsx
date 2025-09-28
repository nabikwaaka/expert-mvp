export const metadata = { title: "Expert MVP", description: "Find people worth talking to" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
