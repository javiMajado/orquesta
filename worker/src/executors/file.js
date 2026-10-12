import fs from 'node:fs/promises';
import path from 'node:path';
import { mainText } from '@orquesta/shared/expr';
import { makeAccess } from '../access.js';

const fail = msg => Object.assign(new Error(msg), { retryable: false });

// Nodo «Fichero»: leer o escribir ficheros de texto SOLO en carpetas permitidas (pantalla Permisos u
// ORQ_FILES_ALLOW). Si la carpeta no tiene permiso, se pide al usuario al ejecutar (ver access.js).

// Sin access (tests, usos sueltos) solo valen los permisos fijos del .env y no se pregunta
export default async function file(p, input, { log, env = process.env, access = makeAccess({ env }) }) {
  const max = Number(env.ORQ_FILES_MAX_BYTES || 5 * 1024 * 1024);
  const write = p.action === 'Escribir';
  // Leer un fichero que aún no existe (p. ej. el estado de la primera ejecución): con «Devolver vacío»
  // no falla. Se pide igualmente permiso de lectura sobre su carpeta.
  if (!write && p.ifMissing === 'Devolver vacío' && p.path && path.isAbsolute(String(p.path))) {
    const exists = await fs.access(path.resolve(String(p.path))).then(() => true, () => false);
    if (!exists) {
      const dir = await access.dir(path.dirname(path.resolve(String(p.path))));
      const ruta = path.join(dir, path.basename(String(p.path)));
      log(`No existe ${ruta}: se devuelve vacío`);
      return { ruta, nombre: path.basename(ruta), contenido: null, existe: false };
    }
  }
  const target = await access.file(p.path, { write });

  if (!write) {
    const st = await fs.stat(target);
    if (!st.isFile()) throw fail(`No es un fichero: ${target}`);
    if (st.size > max) throw fail(`El fichero ocupa ${st.size.toLocaleString('es')} bytes y el límite es ${max.toLocaleString('es')} (ORQ_FILES_MAX_BYTES)`);
    if (/\.pdf$/i.test(target)) {
      // PDF: se extrae solo el texto (pdf.js, sin ejecutar scripts del documento)
      const { getDocumentProxy, extractText } = await import('unpdf');
      let pdf;
      try { pdf = await getDocumentProxy(new Uint8Array(await fs.readFile(target)), { isEvalSupported: false }); }
      catch (e) { throw fail(`No se pudo abrir el PDF: ${e.message}`); }
      const { totalPages, text } = await extractText(pdf, { mergePages: true });
      const contenido = String(text || '').trim();
      if (!contenido) throw fail('El PDF no tiene texto extraíble (¿es un escaneo/imagen?). Hace falta OCR, que aún no está soportado.');
      log(`Leído PDF ${target} (${totalPages} páginas, ${contenido.length.toLocaleString('es')} caracteres)`);
      return { ruta: target, nombre: path.basename(target), contenido, paginas: totalPages, bytes: st.size, modificado: st.mtime.toISOString() };
    }
    let contenido = (await fs.readFile(target, 'utf8')).replace(/^﻿/, '');
    if (p.format === 'JSON') {
      try { contenido = JSON.parse(contenido); } catch (e) { throw fail(`El fichero no es JSON válido: ${e.message}`); }
    }
    log(`Leído ${target} (${st.size.toLocaleString('es')} bytes)`);
    return { ruta: target, nombre: path.basename(target), contenido, bytes: st.size, modificado: st.mtime.toISOString() };
  }

  // Contenido vacío = automático: el texto principal del nodo anterior (p.ej. la respuesta del agente)
  const auto = p.content == null || p.content === '';
  const picked = auto ? mainText(input) : null;
  const data = auto ? picked.text : typeof p.content === 'string' ? p.content : JSON.stringify(p.content, null, 2);
  if (auto) log(`Contenido automático: ${picked.field ? `campo «${picked.field}» del nodo anterior` : 'salida del nodo anterior'}`);
  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes > max) throw fail(`El contenido ocupa ${bytes.toLocaleString('es')} bytes y el límite es ${max.toLocaleString('es')} (ORQ_FILES_MAX_BYTES)`);
  const mode = p.ifExists || 'Fallar';
  const flag = mode === 'Sobrescribir' ? 'w' : mode === 'Añadir' ? 'a' : 'wx';
  try { await fs.writeFile(target, data, { encoding: 'utf8', flag }); }
  catch (e) {
    if (e.code === 'EEXIST') throw fail(`Ya existe ${target}. Cambia «Si el fichero existe» a Sobrescribir o Añadir.`);
    throw fail(`No se pudo escribir ${target}: ${e.message}`);
  }
  log(`${mode === 'Añadir' ? 'Añadidos' : 'Escritos'} ${bytes.toLocaleString('es')} bytes en ${target}`);
  return { ruta: target, bytes, modo: mode };
}
