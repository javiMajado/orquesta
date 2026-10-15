import { useCallback, useEffect, useRef, useState } from 'react';
import { connectLive } from './api.js';
import Editor from './Editor.jsx';
import Workflows from './screens/Workflows.jsx';
import Runs from './screens/Runs.jsx';
import RunDetail from './screens/RunDetail.jsx';
import Workers from './screens/Workers.jsx';
import Connections from './screens/Connections.jsx';
import Agents from './screens/Agents.jsx';
import Permissions from './screens/Permissions.jsx';
import Projects from './screens/Projects.jsx';
import { api } from './api.js';

const parse = () => {
  const [, a, b] = (location.hash || '#/workflows').split('/');
  return { screen: a || 'workflows', id: b ? decodeURIComponent(b) : null };
};

export default function App() {
  const [route, setRoute] = useState(parse);
  const [workers, setWorkers] = useState([]);
  const [live, setLive] = useState(false);
  const subs = useRef(new Set());

  useEffect(() => {
    const f = () => setRoute(parse());
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);

  useEffect(() => connectLive(m => {
    if (m.type === 'connected') setLive(true);
    else if (m.type === 'disconnected') setLive(false);
    else if (m.type === 'workers') setWorkers(m.workers);
    subs.current.forEach(f => f(m));
  }), []);

  const subscribe = useCallback(f => { subs.current.add(f); return () => subs.current.delete(f); }, []);
  // Notas que los agentes han propuesto y esperan revisión (aviso en la barra lateral)
  const [pendingNotes, setPendingNotes] = useState(0);
  useEffect(() => {
    const load = () => api('/projects').then(l => setPendingNotes(l.reduce((n, p) => n + (p.notes?.propuestas || 0), 0))).catch(() => {});
    load();
    return subscribe(m => { if (m.type === 'notes') load(); });
  }, [subscribe]);
  const props = { workers, subscribe };
  const s = route.screen;

  // Aviso permanente si algún agente puede estar usando una clave heredada del shell
  const shellKeys = [...new Map(workers.flatMap(w => w.llm || []).filter(p => p.enabled && p.source === 'shell').map(p => [p.id, p])).values()];

  const nav = [
    { href: '#/workflows', label: 'Workflows', icon: 'ph-tree-structure', on: s === 'workflows' || s === 'editor' },
    { href: '#/runs', label: 'Ejecuciones', icon: 'ph-list-checks', on: s === 'runs' },
    { href: '#/projects', label: 'Proyectos', icon: 'ph-folder-simple', on: s === 'projects', badge: pendingNotes, title: pendingNotes ? `${pendingNotes} nota${pendingNotes === 1 ? '' : 's'} propuesta${pendingNotes === 1 ? '' : 's'} por agentes, pendiente${pendingNotes === 1 ? '' : 's'} de revisar` : undefined },
    { href: '#/agents', label: 'Agentes', icon: 'ph-robot', on: s === 'agents' },
    { href: '#/connections', label: 'Conexiones', icon: 'ph-database', on: s === 'connections' },
    { href: '#/permissions', label: 'Permisos', icon: 'ph-shield-check', on: s === 'permissions' },
    { href: '#/workers', label: 'Workers', icon: 'ph-cpu', on: s === 'workers' },
  ];

  return (
    <div className="app">
      <nav className="rail">
        <div className="rail-brand"><i className="ph ph-flow-arrow" /></div>
        {nav.map(n => (
          <a key={n.href} href={n.href} className={`rail-item ${n.on ? 'on' : ''}`} title={n.title}><i className={`ph ${n.icon}`} />{n.label}{n.badge > 0 && <span className="rail-badge">{n.badge}</span>}</a>
        ))}
        {shellKeys.length > 0 && (
          <a href="#/workers" className="rail-key" title={`Agentes usando clave heredada del shell:\n${shellKeys.map(p => `${p.label} · ${p.keyEnv} · huella ${p.fingerprint}`).join('\n')}`}>
            <i className="ph-fill ph-key" />Shell
          </a>
        )}
        <div className="rail-live" title={live ? 'Conectado en vivo' : 'Reconectando…'}>
          <span className="dot" style={{ background: live ? 'var(--ok)' : 'var(--err)' }} />
        </div>
      </nav>
      {s === 'editor' && route.id ? <Editor key={route.id} id={route.id} {...props} />
        : s === 'runs' && route.id ? <RunDetail key={route.id} id={route.id} {...props} />
        : s === 'runs' ? <Runs {...props} />
        : s === 'workers' ? <Workers {...props} />
        : s === 'connections' ? <Connections {...props} />
        : s === 'permissions' ? <Permissions {...props} />
        : s === 'projects' ? <Projects key={route.id || 'lista'} id={route.id} {...props} />
        : s === 'agents' ? <Agents key={route.id || 'lista'} id={route.id} {...props} />
        : <Workflows {...props} />}
    </div>
  );
}
