import { useEffect } from 'react';
import { createPortal } from 'react-dom';

// Diálogo amplio para leer con espacio lo que no cabe en el panel lateral (salidas, aprobaciones)
export default function BigView({ title, icon = 'ph-arrows-out-simple', actions, onClose, children }) {
  useEffect(() => {
    const k = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <div className="dialog-backdrop sf-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog big-dialog" role="dialog" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="big-head">
          <i className={`ph ${icon}`} />
          <b className="big-title">{title}</b>
          {actions}
          <button type="button" className="btn btn-icon btn-xs" onClick={onClose} title="Cerrar (Esc)"><i className="ph ph-x" /></button>
        </div>
        <div className="big-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// Botón «Copiar» que confirma durante un momento
export function CopyButton({ text, label = 'Copiar' }) {
  const copy = e => {
    navigator.clipboard?.writeText(text);
    const b = e.currentTarget;
    b.dataset.done = '1';
    setTimeout(() => { delete b.dataset.done; }, 1200);
  };
  return <button type="button" className="btn btn-secondary btn-xs-text copy-btn" onClick={copy} title="Copiar al portapapeles"><i className="ph ph-copy" /><span>{label}</span></button>;
}
