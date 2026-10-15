import { pretty } from './api.js';
import { CopyButton } from './BigView.jsx';

// Aprobaciones pendientes: qué se espera, lo que se va a ejecutar y los botones para decidir.
// Los usan el panel del nodo, la traza (también para los sub-workflows) y el detalle de la ejecución.

const shown = v => (typeof v === 'string' ? v : pretty(v));
// Lo que más importa revisar va arriba y destacado, entero y copiable
const KEY_FIELDS = ['comando', 'command', 'url', 'query', 'to'];

// Botones de una aprobación pendiente. Un permiso pedido en runtime se puede conceder siempre
// (queda en Permisos) o solo esta vez. onDecide(aprobado, alcance)
export function DecisionButtons({ meta, onDecide, size = 'sm' }) {
  const b = `btn btn-${size}`;
  if (meta?.permiso) {
    return (
      <div className="row">
        <button className={`${b} btn-primary`} onClick={() => onDecide(true, 'always')}><i className="ph ph-shield-check" />Permitir siempre</button>
        <button className={`${b} btn-secondary`} onClick={() => onDecide(true, 'once')}>Solo esta vez</button>
        <button className={`${b} btn-secondary`} onClick={() => onDecide(false)}>Denegar</button>
      </div>
    );
  }
  return (
    <div className="row">
      <button className={`${b} btn-primary`} onClick={() => onDecide(true)}><i className="ph ph-check" />Aprobar</button>
      <button className={`${b} btn-secondary`} onClick={() => onDecide(false)}>Rechazar</button>
    </div>
  );
}

// Título y explicación de la tarjeta según lo que se espera
export function approvalText(meta, node) {
  if (meta?.permiso) {
    const p = meta.permiso;
    return {
      title: p.tipo === 'comando' ? 'Pide permiso para ejecutar un comando' : `Pide permiso de ${p.acceso} en una carpeta`,
      text: '«Permitir siempre» lo guarda en Permisos (puedes revocarlo allí). «Solo esta vez» vale únicamente para esta ejecución del nodo.',
    };
  }
  if (meta?.tool) return { title: 'El agente quiere usar una herramienta', text: 'No se ejecutará hasta que lo apruebes. Si lo rechazas, el agente recibe el rechazo y sigue sin ello.' };
  if (meta?.revision) return { title: 'Revisión antes de ejecutar', text: 'Este nodo no se ejecutará hasta que lo apruebes. Se usarán exactamente estos parámetros:' };
  return { title: 'Esperando aprobación', text: `Asignado a ${node?.params?.assignee || '—'}. La ejecución está en pausa.` };
}

// Lo que se va a ejecutar, para revisarlo antes de aprobar. big: sin límite de alto (vista en grande)
export function ReviewParams({ meta, big = false }) {
  const params = meta?.revision?.params;
  if (!params) return null;
  const rows = Object.entries(params).filter(([, v]) => v !== '' && v != null);
  const key = rows.filter(([k]) => KEY_FIELDS.includes(k));
  const rest = rows.filter(([k]) => !KEY_FIELDS.includes(k));
  return (
    <div className={`review ${big ? 'big' : ''}`}>
      {key.map(([k, v]) => (
        <div key={k} className="review-key">
          <div className="review-key-head"><span className="mono">{k}</span><CopyButton text={shown(v)} /></div>
          <pre>{shown(v)}</pre>
        </div>
      ))}
      {rest.map(([k, v]) => <div key={k} className="review-row"><span className="mono">{k}</span><pre>{shown(v)}</pre></div>)}
    </div>
  );
}
