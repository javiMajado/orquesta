import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';

// Cifrado de secretos guardados en la BD (contraseñas de conexiones). AES-256-GCM con una clave
// aleatoria en secret.key, junto a la BD. Protege si se copia solo la BD; no frente a alguien
// con acceso a tu usuario de Windows (podría leer también la clave).
const KEY_FILE = path.join(path.dirname(env.DB_FILE), 'secret.key');
let key;
function getKey() {
  if (key) return key;
  if (!fs.existsSync(KEY_FILE)) fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
  key = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error(`${KEY_FILE} no es una clave válida`);
  return key;
}

export function encrypt(text) {
  if (text == null || text === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decrypt(blob) {
  if (!blob) return '';
  const [v, iv, tag, data] = String(blob).split(':');
  if (v !== 'v1') throw new Error('Formato de secreto desconocido');
  const d = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
