// Este servicio no tiene interfaz: solo redirige. El layout existe porque
// Next lo exige, no porque alguien vaya a verlo.
export const metadata = { title: "Redirect" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
