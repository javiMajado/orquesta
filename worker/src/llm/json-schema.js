// Validación de la respuesta de un agente contra un JSON Schema (el subconjunto habitual: type,
// properties, required, additionalProperties, items, enum, const, límites de longitud/tamaño/valor,
// pattern, anyOf/oneOf/allOf). Devuelve la lista de problemas en español, con la ruta de cada uno.

const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const show = v => JSON.stringify(v);
const MAX = 20;

export function validateSchema(schema, value, path = '$', errors = []) {
  if (!schema || typeof schema !== 'object' || errors.length >= MAX) return errors;
  const t = typeOf(value);

  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some(x => x === t || (x === 'number' && t === 'integer'))) {
      errors.push(`${path}: debe ser ${types.join(' o ')} (es ${t})`);
      return errors;
    }
  }
  if ('const' in schema && show(schema.const) !== show(value)) errors.push(`${path}: debe ser ${show(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some(e => show(e) === show(value))) errors.push(`${path}: debe ser uno de ${schema.enum.map(show).join(', ')}`);

  if (t === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: mínimo ${schema.minLength} caracteres`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path}: máximo ${schema.maxLength} caracteres`);
    if (schema.pattern) { try { if (!new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: no cumple el patrón ${schema.pattern}`); } catch {} }
  }
  if (t === 'number' || t === 'integer') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: mínimo ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: máximo ${schema.maximum}`);
  }
  if (t === 'array') {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path}: mínimo ${schema.minItems} elementos`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path}: máximo ${schema.maxItems} elementos`);
    if (schema.items && typeof schema.items === 'object') value.forEach((v, i) => validateSchema(schema.items, v, `${path}[${i}]`, errors));
  }
  if (t === 'object') {
    for (const k of schema.required || []) if (!(k in value)) errors.push(`${path}: falta la propiedad obligatoria «${k}»`);
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      const p = `${path}.${k}`;
      if (props[k]) validateSchema(props[k], v, p, errors);
      else if (schema.additionalProperties === false) errors.push(`${p}: propiedad no permitida (el esquema no la incluye)`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateSchema(schema.additionalProperties, v, p, errors);
    }
  }

  for (const s of schema.allOf || []) validateSchema(s, value, path, errors);
  const options = schema.anyOf || schema.oneOf;
  if (Array.isArray(options) && !options.some(s => !validateSchema(s, value, path, []).length)) errors.push(`${path}: no cumple ninguna de las opciones permitidas`);
  return errors.slice(0, MAX);
}

// Esquema escrito por el usuario (texto JSON o ya objeto). Lanza un error claro si no es válido.
export function parseSchema(raw) {
  let s = raw;
  if (typeof s === 'string') {
    try { s = JSON.parse(s); } catch (e) { throw Object.assign(new Error(`El esquema JSON no es JSON válido: ${e.message}`), { retryable: false }); }
  }
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw Object.assign(new Error('El esquema JSON debe ser un objeto (p. ej. { "type": "object", "properties": { … } })'), { retryable: false });
  return s;
}
