import React, { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, CheckCircle2, Copy, Link2, MessageCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, copyText, dateText, isInteractivePreview, money, workerPageUrl } from './api';
import { Avatar, Badge, Button, ErrorNotice, Field, Loading, Modal, Select } from './components';

export function WorkerDialog({ worker, csrfToken, onClose, onSaved }) {
  const [form, setForm] = useState({ name: worker?.name || '', phone: worker?.phone || '', contract: worker?.contract || 'SANJYOT', whatsappConsent: worker?.whatsappConsent || false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const change = event => setForm(old => ({ ...old, [event.target.name]: event.target.type === 'checkbox' ? event.target.checked : event.target.value }));
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    try { const result = await api(worker ? `/workers/${worker.id}` : '/workers', { method: worker ? 'PATCH' : 'POST', body: form, csrfToken }); await onSaved(result.worker); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  const close = useCallback(() => { if (!busy) onClose(); }, [busy, onClose]);
  return <Modal title={worker ? 'Edit worker' : 'Add a worker'} eyebrow="YOUR TEAM" onClose={close}><form onSubmit={submit} className="dialog-form">{error && <ErrorNotice>{error}</ErrorNotice>}<Field label="Worker’s name" required><input name="name" autoComplete="name" placeholder="e.g. Abhay" maxLength={80} required value={form.name} onChange={change} /></Field><Field label="WhatsApp number" required hint="Enter a 10-digit Indian number, or include the country code with +."><input name="phone" type="tel" autoComplete="tel" placeholder="e.g. +91 98765 43210" maxLength={22} required value={form.phone} onChange={change} /></Field><Field label="Contract" required><Select name="contract" value={form.contract} onChange={change}><option value="SANJYOT">SANJYOT</option><option value="TECHNOEDGE">TECHNOEDGE</option></Select></Field><label className="checkbox-field"><input type="checkbox" name="whatsappConsent" checked={form.whatsappConsent} onChange={change} /><span>This worker has agreed to receive advance updates on WhatsApp.<small>Required for automatic WhatsApp notifications.</small></span></label><div className="form-actions"><Button type="button" variant="secondary" onClick={close}>Cancel</Button><Button type="submit" loading={busy}>{worker ? 'Save changes' : 'Add worker'}</Button></div></form></Modal>;
}

export function AdvanceDialog({ advance, workers, defaultWorkerId, today, csrfToken, automatic, onClose, onSaved }) {
  const [form, setForm] = useState({ workerId: String(advance?.workerId || defaultWorkerId || workers[0]?.id || ''), amount: advance ? (advance.amountPaise / 100).toFixed(2) : '', date: advance?.date || today, method: advance?.method || 'cash', note: advance?.note || '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [clientRequestId] = useState(() => crypto.randomUUID());
  const change = event => setForm(old => ({ ...old, [event.target.name]: event.target.value }));
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = cancelling
        ? await api(`/advances/${advance.id}/void`, { method: 'POST', body: { reason, revision: advance.revision }, csrfToken })
        : await api(advance ? `/advances/${advance.id}` : '/advances', { method: advance ? 'PATCH' : 'POST', body: { ...form, workerId: form.workerId, ...(!advance ? { clientRequestId } : {}), ...(advance ? { revision: advance.revision } : {}) }, csrfToken });
      await onSaved(result.advance, result.notification);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  const close = useCallback(() => { if (!busy) onClose(); }, [busy, onClose]);
  return <Modal title={cancelling ? 'Cancel this advance' : advance ? 'Edit advance' : 'Record an advance'} eyebrow={cancelling ? 'CORRECT AN ACCIDENTAL ENTRY' : advance ? 'UPDATE THE RECORD' : 'A CLEAR RECORD, EVERY TIME'} onClose={close}>
    <form onSubmit={submit} className="dialog-form">
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {cancelling ? <>
        <div className="callout amber"><strong>{money(advance.amountPaise)} · {advance.workerName}</strong><p>This entry will be marked Cancelled and excluded from advance totals. Its history stays visible to you and the worker.</p></div>
        <Field label="Reason for cancellation" required hint="The worker can see this reason."><textarea maxLength={500} value={reason} onChange={event => setReason(event.target.value)} rows={3} required placeholder="e.g. Duplicate entry; the correct advance is already recorded" /></Field>
        <div className="form-explainer"><ShieldCheck size={17} /><span>No money is moved. After saving, use the prepared WhatsApp cancellation message to inform the worker.</span></div>
      </> : <>
        <Field label="Worker" required><Select name="workerId" value={form.workerId} onChange={change} required disabled={Boolean(advance)}><option value="" disabled>Select a worker</option>{workers.map(worker => <option value={worker.id} key={worker.id}>{worker.name} · {worker.contract}</option>)}</Select></Field>
        <Field label="Advance amount" required><div className="amount-input"><span>₹</span><input name="amount" aria-label="Advance amount in rupees" type="number" inputMode="decimal" min="0.01" max="10000000" step="0.01" placeholder="0.00" value={form.amount} onChange={change} required /></div></Field>
        <div className="form-grid"><Field label="Date" required><input name="date" type="date" value={form.date} max={today} required onChange={change} /></Field><Field label="Payment method" required><Select name="method" value={form.method} onChange={change}><option value="cash">Cash</option><option value="online">Online</option></Select></Field></div>
        <Field label="Note" hint="Optional. The worker can see this note."><textarea name="note" placeholder="e.g. Personal advance" rows={3} maxLength={500} value={form.note} onChange={change} /></Field>
        <div className="form-explainer"><ShieldCheck size={17} /><span>{advance ? 'Changes are saved in your history. The worker’s private page updates automatically.' : automatic ? 'The record is saved immediately. WhatsApp updates are requested for workers who have agreed to receive them.' : 'The record is saved immediately. You can then open WhatsApp and send the prepared message.'}</span></div>
        {advance && <button type="button" className="cancel-entry-link" onClick={() => setCancelling(true)}>Cancel this entry instead</button>}
      </>}
      <div className="form-actions"><Button type="button" variant="secondary" onClick={cancelling ? () => setCancelling(false) : close}>{cancelling ? 'Keep entry' : 'Cancel'}</Button><Button type="submit" variant={cancelling ? 'danger' : 'primary'} loading={busy}>{cancelling ? 'Confirm cancellation' : advance ? 'Save changes' : 'Save advance'}</Button></div>
    </form>
  </Modal>;
}

export function MessageDialog({ advance, notification, newlySaved, csrfToken, automatic, onClose, onNotified }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true;
    api(`/advances/${advance.id}/message`).then(result => { if (active) setData(result); }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [advance.id]);
  async function notify() {
    setBusy(true); setError('');
    try { await api(`/advances/${advance.id}/notify`, { method: 'POST', body: {}, csrfToken }); await onNotified?.(); onClose(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function copy() { try { await copyText(data.message); setCopied(true); } catch (err) { setError(err.message); } }
  return <Modal title={newlySaved ? advance.voided ? 'Entry cancelled' : 'Advance saved' : 'Notify the worker'} eyebrow={newlySaved ? 'RECORDED SUCCESSFULLY' : 'WHATSAPP UPDATE'} onClose={onClose}><div className="message-dialog">{newlySaved && <div className="saved-receipt"><CheckCircle2 size={25} /><div><strong className={advance.voided ? 'cancelled-amount' : ''}>{money(advance.amountPaise)}</strong><span>{advance.voided ? 'Cancelled · ' : ''}{advance.workerName || 'Advance'} · {dateText(advance.date)} · {advance.method === 'cash' ? 'Cash' : 'Online'}</span></div></div>}{notification?.error && <div className="callout amber">The advance is saved. WhatsApp needs attention: {notification.error}</div>}{notification?.status && notification.status !== 'not_requested' && !notification.error && <div className="callout">WhatsApp status: {notification.status === 'accepted' ? 'Accepted by WhatsApp. Delivery confirmation is pending.' : notification.status}.</div>}{error && <ErrorNotice>{error}</ErrorNotice>}{!data && !error ? <Loading label="Preparing the message…" /> : data && <><div className="whatsapp-preview"><div className="whatsapp-preview-heading"><MessageCircle size={16} /><strong>MESSAGE PREVIEW</strong></div><p>{data.message}</p></div><p className="muted small">Open WhatsApp, check the message, then tap <strong>Send</strong>. Opening it does not confirm delivery.</p><div className="stack-actions"><a className="button whatsapp" href={data.url} target="_blank" rel="noopener noreferrer"><MessageCircle size={18} />Open WhatsApp<ArrowUpRight size={16} /></a><Button variant="secondary" icon={Copy} onClick={copy}>{copied ? 'Message copied' : 'Copy message'}</Button>{automatic && !advance.voided && <Button variant="secondary" icon={MessageCircle} loading={busy} onClick={notify}>Send automatic notification</Button>}</div></>}</div></Modal>;
}

export function WorkerDetailDialog({ worker, advances, csrfToken, onClose, onEdit, onAdvance, onRotated, onMessage }) {
  const [token, setToken] = useState(worker.shareToken);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [error, setError] = useState('');
  const url = workerPageUrl(token);
  async function copy() { try { await copyText(url); setCopied(true); } catch (err) { setError(err.message); } }
  async function rotate() {
    setBusy(true); setError('');
    try { const result = await api(`/workers/${worker.id}/rotate-link`, { method: 'POST', body: {}, csrfToken }); setToken(result.worker.shareToken); setCopied(false); setConfirmRotate(false); await onRotated(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <Modal title="Worker details" eyebrow="PRIVATE ADVANCE BOOK" onClose={onClose} wide><div className="worker-detail"><div className="worker-detail-heading"><Avatar name={worker.name} large /><div><h3>{worker.name}</h3><p>{worker.phone}</p><Badge>{worker.contract}</Badge></div><Button variant="secondary" onClick={onEdit}>Edit worker</Button></div><div className="worker-detail-stats"><div><span>Total advances recorded</span><strong>{money(worker.totalPaise)}</strong></div><div><span>Entries</span><strong>{worker.advanceCount}</strong></div></div>{error && <ErrorNotice>{error}</ErrorNotice>}<section className="share-panel"><div className="section-title"><Link2 size={18} /><h3>Worker’s private link</h3></div><p>{isInteractivePreview ? 'This preview link opens the worker view in this browser. It does not share records with another device or create a protected account.' : 'Anyone with this private link can view this worker’s entries. Workers cannot edit records.'}</p><div className="share-link"><input aria-label="Worker private link" value={url} readOnly onFocus={event => event.target.select()} /><Button variant="secondary" icon={Copy} onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button></div><div className="share-actions"><a href={url} className="text-link" target="_blank" rel="noopener noreferrer">Open worker view <ArrowUpRight size={14} /></a><button className="text-link muted" onClick={() => setConfirmRotate(true)}><RefreshCw size={13} />Replace private link</button></div>{confirmRotate && <div className="callout amber"><p>The old link will stop working. Share the new link with this worker afterwards.</p><div className="inline-actions"><Button variant="secondary" onClick={() => setConfirmRotate(false)}>Cancel</Button><Button loading={busy} onClick={rotate}>Replace link</Button></div></div>}</section><div className="section-title row-between"><h3>Advance history</h3><Button variant="secondary" onClick={onAdvance}>Record advance</Button></div><div className="mini-history">{advances.length === 0 ? <p className="muted">No advances recorded yet.</p> : advances.map(advance => <div key={advance.id}><div><strong className={advance.voided ? 'cancelled-amount' : ''}>{money(advance.amountPaise)}</strong>{advance.voided && <Badge type="amber">Cancelled</Badge>}<span>{dateText(advance.date)} · {advance.method === 'cash' ? 'Cash' : 'Online'}</span>{advance.note && <small>{advance.note}</small>}</div><button className="icon-button whatsapp-icon" aria-label={`WhatsApp message for ${money(advance.amountPaise)}`} onClick={() => onMessage(advance)}><MessageCircle size={18} /></button></div>)}</div></div></Modal>;
}
