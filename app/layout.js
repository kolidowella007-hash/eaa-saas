export const metadata = {
  title: 'EAA Accessibility SaaS',
  description: 'Scan and fix EAA compliance errors instantly',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-[#0B0E14] text-[#E2E8F0] antialiased">
        {children}
      </body>
    </html>
  )
}
