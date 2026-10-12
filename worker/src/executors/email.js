let transport;

// Nodo «Email». Sin SMTP_URL el envío se simula y se devuelve el contenido.
export default async function email(p, _input, { log }) {
  if (!p.to) throw new Error('Falta el destinatario');
  if (!process.env.SMTP_URL) {
    log(`SMTP_URL no configurado · email simulado para ${p.to}`);
    return { enviado: false, simulado: true, to: p.to, subject: p.subject || '', body: p.body || '' };
  }
  const { default: nodemailer } = await import('nodemailer');
  transport ||= nodemailer.createTransport(process.env.SMTP_URL);
  const info = await transport.sendMail({
    from: p.from || process.env.SMTP_FROM || 'Orquesta <no-reply@localhost>',
    to: p.to, subject: p.subject || '', text: p.body || '',
  });
  log(`Enviado a ${p.to}`);
  return { enviado: true, messageId: info.messageId, accepted: info.accepted };
}
