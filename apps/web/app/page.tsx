'use client';

import { useEffect, useState } from 'react';
import type { ApiResponse, HealthCheck } from '@ai-app/shared';

export default function Home() {
  const [health, setHealth] = useState<HealthCheck | null>(null);

  useEffect(() => {
    fetch('http://localhost:4000/api/health')
      .then((res) => res.json())
      .then((data: ApiResponse<HealthCheck>) => {
        if (data.success && data.data) {
          setHealth(data.data);
        }
      })
      .catch(console.error);
  }, []);

  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>AI App</h1>
      <p>
        Backend status:{' '}
        {health ? (
          <span style={{ color: 'green' }}>{health.status}</span>
        ) : (
          <span style={{ color: 'gray' }}>connecting...</span>
        )}
      </p>
    </main>
  );
}
