import type { ReactNode } from "react";

export const metadata = {
  title: "Student Success OS",
  description: "Placeholder. The app is built in Slice 2.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <body>{children}</body>
    </html>
  );
}
