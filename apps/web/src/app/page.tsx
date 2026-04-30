export default function Home() {
  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1rem',
        padding: '2rem',
        textAlign: 'center',
      }}
    >
      <h1 style={{ fontSize: '3rem', margin: 0, letterSpacing: '-0.02em' }}>5 / 3 / 1</h1>
      <p style={{ opacity: 0.7, margin: 0 }}>Bootstrapped. v0.0.1.</p>
    </main>
  );
}
