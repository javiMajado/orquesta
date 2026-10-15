import { useState, useEffect } from 'react';

const LLM_PROVIDERS = [
  { id: 'openrouter', label: 'OpenRouter (recomendado)', url: 'https://openrouter.io', keyEnv: 'OPENROUTER_API_KEY', defaultModel: 'openai/gpt-4o-mini' },
  { id: 'openai', label: 'OpenAI', url: 'https://platform.openai.com', keyEnv: 'OPENAI_API_KEY', defaultModel: 'gpt-4o-mini' },
  { id: 'anthropic', label: 'Anthropic (Claude)', url: 'https://console.anthropic.com', keyEnv: 'ANTHROPIC_API_KEY', defaultModel: 'claude-haiku-4-5-20251001' },
];

function Step1Welcome({ onNext }) {
  return (
    <div className="wizard-step">
      <div className="wizard-header">
        <h1>Bienvenido a Orquesta</h1>
        <p className="step-counter">Paso 1 de 5</p>
      </div>
      <div className="wizard-body">
        <p style={{ fontSize: '16px', lineHeight: '1.6', marginBottom: '20px' }}>
          Orquesta es una plataforma de workflows con agentes IA. En los próximos pasos configuraremos:
        </p>
        <ul style={{ fontSize: '15px', lineHeight: '1.8' }}>
          <li>✓ Proveedor de agentes IA (OpenAI, Anthropic, OpenRouter...)</li>
          <li>✓ Claves API</li>
          <li>✓ Permisos de carpetas (opcional)</li>
          <li>✓ Comandos permitidos (opcional)</li>
        </ul>
        <p style={{ marginTop: '30px', color: 'var(--text-secondary)' }}>
          Sin configurar nada, puedes probar con agentes <strong>simulados</strong>.
        </p>
      </div>
      <div className="wizard-footer">
        <button className="btn btn-primary" onClick={onNext}>Empezar →</button>
      </div>
    </div>
  );
}

function Step2ChooseLLM({ onNext, onBack, onSkip, selected, setSelected }) {
  return (
    <div className="wizard-step">
      <div className="wizard-header">
        <h1>¿Usar agentes IA?</h1>
        <p className="step-counter">Paso 2 de 5</p>
      </div>
      <div className="wizard-body">
        <p style={{ marginBottom: '20px', color: 'var(--text-secondary)' }}>
          Elige dónde obtener modelos de IA. Recomendamos <strong>OpenRouter</strong> (acceso a múltiples modelos con una sola cuenta).
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {LLM_PROVIDERS.map(p => (
            <label key={p.id} style={{ display: 'flex', alignItems: 'center', padding: '12px', border: '1px solid var(--border)', borderRadius: '4px', cursor: 'pointer', background: selected === p.id ? 'var(--bg-hover)' : '' }}>
              <input type="radio" name="llm" value={p.id} checked={selected === p.id} onChange={e => setSelected(e.target.value)} style={{ marginRight: '12px' }} />
              <div>
                <strong>{p.label}</strong>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{p.url}</div>
              </div>
            </label>
          ))}
        </div>
      </div>
      <div className="wizard-footer">
        <button className="btn btn-secondary" onClick={onBack}>← Atrás</button>
        <button className="btn btn-secondary" onClick={onSkip}>Saltar (sin IA)</button>
        <button className="btn btn-primary" onClick={onNext} disabled={!selected}>Continuar →</button>
      </div>
    </div>
  );
}

function Step3APIKey({ onNext, onBack, providerSelected, apiKey, setApiKey }) {
  const provider = LLM_PROVIDERS.find(p => p.id === providerSelected);
  return (
    <div className="wizard-step">
      <div className="wizard-header">
        <h1>API Key de {provider?.label}</h1>
        <p className="step-counter">Paso 3 de 5</p>
      </div>
      <div className="wizard-body">
        <p style={{ marginBottom: '20px', color: 'var(--text-secondary)' }}>
          Copia tu API key desde <a href={provider?.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>{provider?.url}</a>
        </p>
        <textarea value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Pega aquí tu clave API..." style={{ width: '100%', minHeight: '80px', padding: '10px', fontFamily: 'monospace', fontSize: '12px' }} />
        <p style={{ marginTop: '12px', fontSize: '12px', color: 'var(--text-secondary)' }}>Guardada localmente en %APPDATA%\Orquesta\.env</p>
      </div>
      <div className="wizard-footer">
        <button className="btn btn-secondary" onClick={onBack}>← Atrás</button>
        <button className="btn btn-primary" onClick={onNext} disabled={!apiKey.trim()}>Continuar →</button>
      </div>
    </div>
  );
}

function Step4Folders({ onNext, onBack }) {
  return (
    <div className="wizard-step">
      <div className="wizard-header">
        <h1>Permisos de carpetas (opcional)</h1>
        <p className="step-counter">Paso 4 de 5</p>
      </div>
      <div className="wizard-body">
        <p style={{ marginBottom: '20px' }}>Puedes configurar esto después en Permisos.</p>
      </div>
      <div className="wizard-footer">
        <button className="btn btn-secondary" onClick={onBack}>← Atrás</button>
        <button className="btn btn-primary" onClick={onNext}>Continuar →</button>
      </div>
    </div>
  );
}

function Step5Review({ onNext, onBack, provider, useLLM }) {
  const p = LLM_PROVIDERS.find(x => x.id === provider);
  return (
    <div className="wizard-step">
      <div className="wizard-header">
        <h1>Revisar configuración</h1>
        <p className="step-counter">Paso 5 de 5</p>
      </div>
      <div className="wizard-body">
        <div style={{ background: 'var(--bg)', padding: '15px', borderRadius: '4px', border: '1px solid var(--border)', lineHeight: '1.8' }}>
          <div>✓ Agentes IA: {useLLM ? p?.label : '❌ No configurados (modo simulado)'}</div>
          {useLLM && <div>✓ API Key: guardada localmente</div>}
        </div>
      </div>
      <div className="wizard-footer">
        <button className="btn btn-secondary" onClick={onBack}>← Atrás</button>
        <button className="btn btn-success" onClick={onNext}>✓ Finalizar</button>
      </div>
    </div>
  );
}

export default function SetupWizard({ onDone }) {
  const [step, setStep] = useState(0);
  const [useLLM, setUseLLM] = useState(true);
  const [provider, setProvider] = useState('openrouter');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const envLines = [];
      if (useLLM) {
        const p = LLM_PROVIDERS.find(x => x.id === provider);
        envLines.push(`ORQ_LLM_PROVIDERS=[{"id":"${provider}","label":"${p.label}","kind":"${p.kind}","keyEnv":"${p.keyEnv}","defaultModel":"${p.defaultModel}"}]`);
        envLines.push(`${p.keyEnv}=${apiKey}`);
        envLines.push(`ORQ_LLM_DEFAULT=${provider}:${p.defaultModel}`);
      } else {
        envLines.push(`ORQ_LLM_PROVIDERS=[]`);
      }
      await window.orquestaDesktop.saveEnv(envLines.join('\n') + '\n');
      setTimeout(() => onDone(), 500);
    } catch (e) {
      alert('Error: ' + e.message);
      setSaving(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'linear-gradient(135deg, var(--bg) 0%, var(--bg-secondary) 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
      <div style={{ width: '90%', maxWidth: '600px', background: 'var(--bg-panel)', borderRadius: '8px', boxShadow: '0 10px 40px rgba(0,0,0,0.3)' }}>
        {step === 0 && <Step1Welcome onNext={() => setStep(1)} />}
        {step === 1 && <Step2ChooseLLM onNext={() => setStep(2)} onBack={() => setStep(0)} onSkip={() => { setUseLLM(false); setStep(4); }} selected={provider} setSelected={setProvider} />}
        {step === 2 && <Step3APIKey onNext={() => setStep(3)} onBack={() => setStep(1)} providerSelected={provider} apiKey={apiKey} setApiKey={setApiKey} />}
        {step === 3 && <Step4Folders onNext={() => setStep(4)} onBack={() => setStep(2)} />}
        {step === 4 && <Step5Review onNext={handleSave} onBack={() => setStep(3)} provider={provider} useLLM={useLLM} />}
      </div>
      {saving && <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000 }}><span style={{ color: 'white' }}>Guardando...</span></div>}
      <style>{`
        .wizard-step { display: flex; flex-direction: column; height: 100%; }
        .wizard-header { padding: 30px 30px 20px; border-bottom: 1px solid var(--border); }
        .wizard-header h1 { margin: 0; font-size: 24px; }
        .step-counter { margin: 8px 0 0; font-size: 12px; color: var(--text-secondary); }
        .wizard-body { flex: 1; padding: 30px; overflow: auto; }
        .wizard-footer { padding: 20px 30px; border-top: 1px solid var(--border); display: flex; gap: 12px; justify-content: flex-end; }
        .btn { padding: 8px 16px; border-radius: 4px; border: none; cursor: pointer; font-size: 14px; }
        .btn-primary { background: var(--accent); color: white; }
        .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-secondary { background: var(--bg); color: var(--text); border: 1px solid var(--border); }
        .btn-success { background: #4ade80; color: white; }
      `}</style>
    </div>
  );
}