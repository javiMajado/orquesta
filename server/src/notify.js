import { env } from './env.js';

// Notifica una aprobación pendiente por Slack o Email. "Panel" no envía nada: se aprueba desde la UI.
export async function notifyApproval({ runId, workflow, node, channel, assignee }) {
  const link = `${env.PUBLIC_URL}/#/runs/${runId}`;
  const text = `Aprobación pendiente en «${workflow}» → ${node}\nAsignado a: ${assignee || '—'}\nRevisar: ${link}`;
  if (channel === 'Slack') {
    if (!process.env.SLACK_WEBHOOK_URL) throw new Error('SLACK_WEBHOOK_URL no está configurado');
    const r = await fetch(process.env.SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!r.ok) throw new Error(`Slack respondió ${r.status}`);
  } else if (channel === 'Email') {
    if (!process.env.SMTP_URL) throw new Error('SMTP_URL no está configurado');
    const { default: nodemailer } = await import('nodemailer');
    await nodemailer.createTransport(process.env.SMTP_URL).sendMail({
      from: process.env.SMTP_FROM || 'Orquesta <no-reply@localhost>', to: assignee, subject: `Aprobación pendiente: ${workflow}`, text,
    });
  }
}
