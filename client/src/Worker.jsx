import React, { useEffect, useState } from 'react';
import { ArrowDownLeft, CalendarDays, LockKeyhole, RefreshCw, Wallet } from 'lucide-react';
import { api, dateText, money, monthText, timeText } from './api';
import { Avatar, Badge, Brand, ErrorNotice, Loading } from './components';

export default function Worker({ token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);
  useEffect(() => {
    let active = true;
    let timer;
    let loading = false;
    let revision = null;
    let interval = 8000;
    async function load() {
      if (!active || document.hidden || loading) return;
      clearTimeout(timer); loading = true;
      try {
        const result = await api(`/worker/${encodeURIComponent(token)}${revision ? `?revision=${encodeURIComponent(revision)}` : ''}`);
        if (active) {
          if (!result.unchanged) setData(result);
          revision = result.revision || null;
          if (Number.isInteger(result.pollIntervalMs) && result.pollIntervalMs >= 8000 && result.pollIntervalMs <= 300000) interval = result.pollIntervalMs;
          setError(''); setLastUpdated(new Date());
        }
      }
      catch (err) { if (active) { setError(err.message); if (err.status === 404) setData(null); } }
      finally { loading = false; if (active) timer = setTimeout(load, interval); }
    }
    load(); document.addEventListener('visibilitychange', load);
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', load); };
  }, [token]);
  if (!data) return <main className="worker-page"><div className="worker-topbar"><Brand compact /></div>{error ? <div className="worker-error"><LockKeyhole size={30} /><h1>This private page is unavailable</h1><p>{error}</p><p>Ask your contractor for your current private link.</p></div> : <Loading label="Opening your advance book…" />}</main>;
  const entries = [...data.advances].sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt || b.id).localeCompare(String(a.createdAt || a.id)));
  const month = data.today.slice(0, 7);
  return <main className="worker-page"><header className="worker-topbar"><Brand compact /><span className="secure-label"><LockKeyhole size={13} />Private worker view</span></header><div className="worker-content"><div className="worker-business"><span className="eyebrow">{data.businessName}</span><Badge type="green"><span className="live-dot" />Live register</Badge></div><section className="worker-welcome"><Avatar name={data.worker.name} large /><div><span>Your advance book</span><h1>Hello, {data.worker.name.split(' ')[0]}<span>.</span></h1><Badge>{data.worker.contract}</Badge></div></section><p className="worker-intro">A clear record of the advances recorded for you. New entries appear here automatically.</p>{error && <ErrorNotice>{error}</ErrorNotice>}<section className="worker-total"><div className="stat-label"><Wallet size={18} /><span>ADVANCES · {monthText(month).toUpperCase()}</span></div><strong>{money(data.monthTotalPaise)}</strong><p>{entries.filter(e => !e.voided && e.date.startsWith(month)).length} entries this month</p><div className="worker-total-bottom"><span>All-time advances recorded</span><b>{money(data.totalPaise)}</b></div></section><div className="section-heading worker-history-heading"><div><span className="eyebrow">YOUR RECORDS</span><h2>Advance history</h2></div><span className="count-label">{entries.length} entries</span></div>{entries.length === 0 ? <section className="panel"><div className="empty-state"><span className="empty-icon"><Wallet size={25} /></span><h3>You’re all caught up</h3><p>Your advance entries will appear here when your contractor records them.</p></div></section> : <section className="worker-entries">{entries.map(advance => <article className={`worker-entry ${advance.voided ? 'cancelled-row' : ''}`} key={advance.id}><span className="entry-symbol"><ArrowDownLeft size={19} /></span><div className="worker-entry-body"><div className="row-between"><h3>{advance.voided ? 'Advance cancelled' : 'Advance recorded'}</h3><strong className={advance.voided ? 'cancelled-amount' : ''}>{money(advance.amountPaise)}</strong></div><div className="worker-entry-meta"><span><CalendarDays size={12} />{dateText(advance.date)}</span><Badge>{advance.contract || data.worker.contract}</Badge><Badge type={advance.method === 'cash' ? 'green' : 'blue'}>{advance.method === 'cash' ? 'Cash' : 'Online'}</Badge>{advance.voided ? <Badge type="amber">Cancelled · Excluded from totals</Badge> : advance.revision > 1 && <Badge type="amber">Updated</Badge>}</div>{(advance.voided ? advance.voidReason : advance.note) && <p>{advance.voided ? `Reason: ${advance.voidReason}` : advance.note}</p>}{advance.revision > 1 && <small className="muted">Last changed {timeText(advance.updatedAt)}</small>}</div></article>)}</section>}<div className="worker-footnote"><RefreshCw size={13} /><span>Refreshes automatically · Last checked {lastUpdated?.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })}</span></div><div className="worker-readonly"><LockKeyhole size={16} /><p>Only your contractor can change these records. If something looks incorrect, contact them directly.</p></div></div><footer className="worker-footer">Your work. Your records. <strong>hisab.</strong></footer></main>;
}
