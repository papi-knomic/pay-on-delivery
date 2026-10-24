import { useEffect, useState } from 'react';

type Health = { status: string; db: string; redis: string };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch('/health')
      .then((r) => r.json() as Promise<{ data: Health }>)
      .then((body) => setHealth(body.data))
      .catch(() => setError(true));
  }, []);

  return (
    <main className="shell">
      <h1>Pay on Delivery</h1>
      <p className="lede">
        Payment is authorized at checkout and captured only after proof of delivery is verified.
      </p>
      <p className="status">
        API:{' '}
        {error ? (
          <span className="down">unreachable</span>
        ) : health ? (
          <span className={health.status === 'ok' ? 'ok' : 'down'}>
            {health.status} (db {health.db}, redis {health.redis})
          </span>
        ) : (
          'checking…'
        )}
      </p>
      <p className="note">Checkout, rider app and ops dashboard are coming soon.</p>
    </main>
  );
}
