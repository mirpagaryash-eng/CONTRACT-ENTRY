import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { Brand, ErrorNotice, Loading } from './components';
import Admin from './Admin';
import Auth from './Auth';
import Worker from './Worker';

export default function App() {
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  const workerMatch = window.location.pathname.match(/^\/w\/([^/]+)\/?$/);
  const updateSession = useCallback(value => setSession(value), []);
  const loadSession = useCallback(() => { setError(''); return api('/session').then(setSession).catch(err => setError(err.message)); }, []);
  // A worker should bookmark their own private URL, rather than install the
  // owner's manifest whose launch address is the main sign-in page.
  useEffect(() => { if (workerMatch) document.querySelector('link[rel="manifest"]')?.remove(); }, []);
  useEffect(() => { if (!workerMatch) loadSession(); }, [loadSession]);
  if (workerMatch) return <Worker token={workerMatch[1]} />;
  if (!session) return <div className="initial-loader"><Brand />{error ? <ErrorNotice onRetry={loadSession}>{error}</ErrorNotice> : <Loading label="Opening your workspace…" />}</div>;
  if (!session.authenticated) return <Auth session={session} onAuthenticated={updateSession} />;
  return <Admin session={session} onSessionChange={updateSession} />;
}
