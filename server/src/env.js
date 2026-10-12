import dotenv from 'dotenv';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotShellEnv } from '@orquesta/shared/env';

snapshotShellEnv();
// ORQ_ENV_FILE: la app de escritorio usa el .env de su carpeta de datos (%APPDATA%\Orquesta)
dotenv.config({ path: process.env.ORQ_ENV_FILE || fileURLToPath(new URL('../../.env', import.meta.url)) });

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
// Carpeta base para rutas relativas (BD, SQLite de DB_CONNECTIONS): el proyecto en desarrollo,
// %APPDATA%\Orquesta en la app de escritorio. Se publica para que el worker embebido la use igual.
const BASE = process.env.ORQ_BASE_DIR || ROOT;
process.env.ORQ_BASE_DIR = BASE;
const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

export const env = {
  PORT: Number(process.env.PORT || 3000),
  // Solo local por defecto: nadie de la red puede llegar a la API ni a los workers.
  HOST: process.env.HOST || '127.0.0.1',
  PUBLIC_URL: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`,
  API_TOKEN: process.env.API_TOKEN || '',
  // Sin WORKER_TOKEN se genera uno por arranque: solo el worker embebido podrá conectarse.
  WORKER_TOKEN: process.env.WORKER_TOKEN || crypto.randomBytes(24).toString('hex'),
  WORKER_TOKEN_GENERATED: !process.env.WORKER_TOKEN,
  ALLOWED_HOSTS: list(process.env.ALLOWED_HOSTS),
  ALLOWED_ORIGINS: list(process.env.ALLOWED_ORIGINS),
  // Rutas relativas desde la raíz del proyecto (no desde la carpeta de arranque): así la BD
  // nunca cae dentro de server/, que vigila el modo dev y lo reiniciaría al escribir.
  DB_FILE: path.resolve(BASE, process.env.DB_FILE || 'data/orquesta.db'),
  LLM_DEFAULT: process.env.ORQ_LLM_DEFAULT || '',
  LLM_MAX_TOKENS_PER_RUN: Number(process.env.ORQ_LLM_MAX_TOKENS_PER_RUN || 500000),
};
