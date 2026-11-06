import React, { useEffect, useRef } from 'react';
import { AlertCircle, ArrowUpRight, Check, ChevronDown, LoaderCircle, MessageCircle, X } from 'lucide-react';
import { initials, notifyLabel } from './api';

export function Brand({ compact = false }) {
  return <div className={`brand ${compact ? 'compact' : ''}`}><div className="brand-symbol" aria-hidden="true"><span>h</span><i /></div><div><strong>hisab<span className="brand-period">.</span></strong>{!compact && <small>Advance register</small>}</div></div>;
}
export function Button({ children, variant = 'primary', icon: Icon, loading, className = '', ...props }) {
  return <button className={`button ${variant} ${className}`} disabled={loading || props.disabled} {...props}>{loading ? <LoaderCircle size={17} className="spin" /> : Icon && <Icon size={17} />}{children}</button>;
}
export function Avatar({ name, large, index = 0 }) { return <span className={`avatar color-${index % 4} ${large ? 'large' : ''}`}>{initials(name)}</span>; }
export function Badge({ children, type = '' }) { return <span className={`badge ${type}`}>{children}</span>; }
export function NotificationBadge({ status }) { return <Badge type={['read', 'delivered'].includes(status) ? 'green' : status === 'failed' ? 'amber' : 'neutral'}>{['read', 'delivered'].includes(status) ? <Check size={11} /> : <MessageCircle size={11} />}{notifyLabel(status)}</Badge>; }
export function ErrorNotice({ children, onRetry }) { return <div className="error-notice" role="alert"><AlertCircle size={18} /><span>{children}</span>{onRetry && <button onClick={onRetry}>Try again</button>}</div>; }
export function Loading({ label = 'Loading your register…' }) { return <div className="loading-state"><LoaderCircle className="spin" size={24} /><p>{label}</p></div>; }
export function Empty({ icon: Icon, title, description, children, compact }) { return <div className={`empty-state ${compact ? 'compact' : ''}`}><span className="empty-icon">{Icon && <Icon size={25} />}</span><h3>{title}</h3><p>{description}</p>{children}</div>; }
export function Field({ label, hint, children, required }) { return <label className="field"><span className="field-label">{label}{required && <span className="required"> *</span>}</span>{children}{hint && <small>{hint}</small>}</label>; }
export function Select({ children, ...props }) { return <div className="select-wrap"><select {...props}>{children}</select><ChevronDown size={15} /></div>; }

export function Modal({ title, eyebrow, onClose, children, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => [...(ref.current?.querySelectorAll('button:not([disabled]), input, select, textarea, a[href]') || [])];
    focusable()[0]?.focus();
    const key = event => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const items = focusable();
        if (!items.length) return;
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1).focus(); }
        else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.body.style.overflow = before; document.removeEventListener('keydown', key); previous?.focus(); };
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={ref}><div className="modal-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2 id="modal-title">{title}</h2></div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20} /></button></div>{children}</section></div>;
}
export function Toast({ children, onClose }) { useEffect(() => { const id = setTimeout(onClose, 5000); return () => clearTimeout(id); }, [onClose]); return <div className="toast" role="status"><Check size={18} /><span>{children}</span><button className="icon-button" onClick={onClose} aria-label="Dismiss"><X size={16} /></button></div>; }
export function ExternalArrow() { return <ArrowUpRight size={15} />; }
