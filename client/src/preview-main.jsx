import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Eye, MonitorSmartphone, RotateCcw, UsersRound } from 'lucide-react';
import Admin from './Admin';
import Worker from './Worker';
import { installPreviewApi, previewSession, previewSnapshot, resetPreview } from './preview-api';
import './styles.css';
import './preview.css';

installPreviewApi();

function PreviewApp() {
  useEffect(() => { document.getElementById('preview-startup')?.remove(); }, []);
  const [snapshot,setSnapshot] = useState(previewSnapshot);
  const [workerToken,setWorkerToken] = useState(() => new URLSearchParams(location.hash.slice(1)).get('worker'));
  const [generation,setGeneration] = useState(0);
  const [confirmReset,setConfirmReset] = useState(false);
  const bannerRef = useRef(null);
  useEffect(() => {
    const size = () => document.documentElement.style.setProperty('--preview-banner-height', `${bannerRef.current?.offsetHeight || 70}px`);
    const observer = new ResizeObserver(size); if (bannerRef.current) observer.observe(bannerRef.current); size();
    return () => observer.disconnect();
  },[]);
  useEffect(()=>{
    const changed = () => setSnapshot(previewSnapshot());
    const hash = () => setWorkerToken(new URLSearchParams(location.hash.slice(1)).get('worker'));
    window.addEventListener('hisab-preview-change',changed); window.addEventListener('hashchange',hash);
    return ()=>{window.removeEventListener('hisab-preview-change',changed);window.removeEventListener('hashchange',hash);};
  },[]);
  const onSessionChange = useCallback(()=>setGeneration(old=>old+1),[]);
  function switchView(token) { location.hash = token ? `worker=${encodeURIComponent(token)}` : 'owner'; }
  function reset() { resetPreview(); setConfirmReset(false); switchView(null); setGeneration(old=>old+1); }
  return <div className="interactive-preview"><header className="preview-banner" ref={bannerRef}><div className="preview-label"><MonitorSmartphone size={20}/><div><strong>Interactive preview</strong><span>Data stays in this browser · No account or cross-device sharing</span></div></div><div className="preview-controls"><div className="preview-switch"><button className={!workerToken?'selected':''} onClick={()=>switchView(null)}><UsersRound size={17}/>Owner</button><button className={workerToken?'selected':''} disabled={!snapshot.workers.length} onClick={()=>switchView(snapshot.workers[0]?.shareToken)}><Eye size={17}/>Worker view</button></div>{workerToken&&snapshot.workers.length>1&&<select aria-label="Preview worker" value={workerToken} onChange={event=>switchView(event.target.value)}>{snapshot.workers.map(worker=><option value={worker.shareToken} key={worker.id}>{worker.name}</option>)}</select>}<button className="preview-reset" aria-label="Reset interactive preview" onClick={()=>setConfirmReset(true)}><RotateCcw size={17}/><span>Reset</span></button></div></header>{snapshot.storageWarning&&<div className="preview-warning" role="alert">{snapshot.storageWarning}</div>}{confirmReset&&<div className="preview-reset-confirm" role="alertdialog" aria-label="Reset interactive preview"><p>Reset only this preview’s workers and advances? This does not affect the full application.</p><div><button onClick={()=>setConfirmReset(false)}>Keep my records</button><button className="confirm" onClick={reset}>Reset preview</button></div></div>}<div className="preview-body" key={generation}>{workerToken ? <Worker token={workerToken}/> : <Admin session={previewSession()} onSessionChange={onSessionChange}/>}</div></div>;
}

createRoot(document.getElementById('root')).render(<PreviewApp/>);
