// Catálogo de los parámetros que el panel deja editar. Las rutas son las de
// app.tenants.parametros (ver docs/configuracion.md). Un campo cuya ruta no existe
// en el tenant no se muestra: así cada tenant ve solo lo que su agente usa.

export type TipoCampo =
  | 'cop' | 'pct' | 'numero' | 'entero' | 'booleano'
  | 'texto' | 'texto_largo' | 'url' | 'opciones' | 'lista' | 'correos' | 'dossier';

export interface Campo {
  ruta: string;
  etiqueta: string;
  ayuda?: string;
  tipo: TipoCampo;
  /** Se puede dejar vacío (se guarda null y el agente lo trata como "sin valor"). */
  nulo?: boolean;
  opciones?: { valor: string; titulo: string }[];
  min?: number;
  max?: number;
}

export interface Seccion {
  id: string;
  titulo: string;
  descripcion?: string;
  campos: Campo[];
}

const RELACIONES = ['propietario', 'copropietario', 'apoderado', 'familiar', 'conocido', 'otro'];
const TIPOS_INMUEBLE = ['apartamento', 'casa', 'terreno', 'oficina', 'local', 'bodega', 'otro'];
const capitalizar = (texto: string) => texto.charAt(0).toUpperCase() + texto.slice(1);
const comoOpciones = (valores: string[]) => valores.map((valor) => ({ valor, titulo: capitalizar(valor) }));

export const SECCIONES: Seccion[] = [
  {
    id: 'propietarios',
    titulo: 'Propietarios (Lucía)',
    descripcion: 'Quién califica para vender con Javier.',
    campos: [
      { ruta: 'propietarios.valor_minimo_cop', etiqueta: 'Valor mínimo de la propiedad', tipo: 'cop', nulo: true,
        ayuda: 'Por debajo (menos la tolerancia), Lucía ofrece una referencia a un colega. Vacío = sin mínimo.' },
      { ruta: 'propietarios.tolerancia_valor_pct', etiqueta: 'Tolerancia bajo el mínimo', tipo: 'pct', nulo: true,
        ayuda: 'Con 450 M y 10 %, se atiende desde 405 M. Vacío = mínimo exacto.' },
      { ruta: 'propietarios.valor_premium_cop', etiqueta: 'Valor premium', tipo: 'cop',
        ayuda: 'Desde este valor Lucía responde con el mensaje premium. No cambia la calificación.' },
      { ruta: 'propietarios.relaciones_validas', etiqueta: 'Relaciones con el inmueble que califican', tipo: 'opciones',
        opciones: comoOpciones(RELACIONES), min: 1 },
    ],
  },
  {
    id: 'tipos',
    titulo: 'Tipos de inmueble',
    campos: [
      { ruta: 'cobertura.tipos_inmueble', etiqueta: 'Tipos que se atienden', tipo: 'opciones',
        opciones: comoOpciones(TIPOS_INMUEBLE), min: 1,
        ayuda: 'Aplica a venta, compra y arriendo. Terreno incluye lote.' },
    ],
  },
  {
    id: 'prioridad',
    titulo: 'Prioridad',
    campos: [
      { ruta: 'prioridad.alta_hasta_meses', etiqueta: 'Prioridad alta hasta (meses)', tipo: 'entero', min: 1,
        ayuda: 'Quien califica y quiere concretar en este plazo o menos se agenda ya. Más: prioridad B, sin cita.' },
      { ruta: 'prioridad.recordatorio_meses_antes', etiqueta: 'Recordatorio de prioridad B (meses antes)', tipo: 'entero', nulo: true, min: 1,
        ayuda: 'Cuántos meses antes de la fecha estimada de venta llega el recordatorio por correo. Vacío = sin recordatorios.' },
    ],
  },
  {
    id: 'compradores',
    titulo: 'Compradores y arriendo (Sonia)',
    campos: [
      { ruta: 'compra.presupuesto_minimo_cop', etiqueta: 'Presupuesto mínimo de compra', tipo: 'cop', nulo: true,
        ayuda: 'Vacío = sin mínimo.' },
      { ruta: 'arriendo.canon_minimo_cop', etiqueta: 'Canon mensual mínimo de arriendo', tipo: 'cop', nulo: true,
        ayuda: 'Vacío = sin mínimo.' },
    ],
  },
  {
    id: 'propuesta',
    titulo: 'Propuesta comercial',
    descripcion: 'Lo que Lucía explica antes de agendar. Lo que quede vacío no se menciona: lo aclara Javier en la llamada.',
    campos: [
      { ruta: 'comercial.asesor', etiqueta: 'Nombre corto del asesor', tipo: 'texto',
        ayuda: 'Como lo nombra el agente: "eso lo revisa Javier en la reunión".' },
      { ruta: 'comercial.asesor_nombre_completo', etiqueta: 'Nombre completo del asesor', tipo: 'texto',
        ayuda: '"Asistente virtual de …".' },
      { ruta: 'comercial.propuesta.exclusiva', etiqueta: 'Trabaja en exclusiva', tipo: 'booleano' },
      { ruta: 'comercial.propuesta.comision_pct', etiqueta: 'Comisión', tipo: 'pct' },
      { ruta: 'comercial.propuesta.comision_solo_si_vende', etiqueta: 'La comisión solo se paga si se vende', tipo: 'booleano' },
      { ruta: 'comercial.propuesta.comision_comprador_propio_pct', etiqueta: 'Comisión si el propietario consigue al comprador', tipo: 'pct', nulo: true },
      { ruta: 'comercial.propuesta.comision_comprador_propio_condicion', etiqueta: 'Condición de esa comisión', tipo: 'texto', nulo: true,
        ayuda: 'Tal como la dice Lucía.' },
      { ruta: 'comercial.propuesta.plazo_exclusividad_meses', etiqueta: 'Plazo de la exclusividad (meses)', tipo: 'entero', nulo: true, min: 1 },
      { ruta: 'comercial.propuesta.clausula_salida', etiqueta: 'Qué pasa al final del plazo', tipo: 'texto_largo', nulo: true },
      { ruta: 'comercial.propuesta.informe_mensual', etiqueta: 'Entrega informe mensual de la gestión', tipo: 'booleano' },
      { ruta: 'comercial.propuesta.beneficios', etiqueta: 'Beneficios', tipo: 'lista',
        ayuda: 'Uno por línea. Vacío = no se mencionan.' },
      { ruta: 'comercial.propuesta.video_url', etiqueta: 'Video de la propuesta (enlace)', tipo: 'url', nulo: true,
        ayuda: 'Con enlace, la propuesta se envía con el video.' },
      { ruta: 'comercial.propuesta.video_minutos', etiqueta: 'Duración del video (minutos)', tipo: 'entero', nulo: true, min: 1 },
      { ruta: 'comercial.propuesta.acuerdo_url', etiqueta: 'Borrador del acuerdo (enlace)', tipo: 'url', nulo: true },
      { ruta: 'comercial.argumento_exclusividad', etiqueta: 'Cómo responder "ya tengo agencia o asesor"', tipo: 'texto_largo' },
    ],
  },
  {
    id: 'material',
    titulo: 'Dossier y nutrición',
    campos: [
      { ruta: 'dossier.lucia', etiqueta: 'Dossier de Lucía (PDF público)', tipo: 'dossier',
        ayuda: 'Se envía a prioridad baja. Vacío = no se envía.' },
      { ruta: 'dossier.sonia', etiqueta: 'Dossier de Sonia (PDF público)', tipo: 'dossier' },
      { ruta: 'nutricion.incluir_no_calificados', etiqueta: 'Enviar mensaje de nutrición a los no calificados', tipo: 'booleano' },
    ],
  },
  {
    id: 'conversacion',
    titulo: 'Conversación',
    campos: [
      { ruta: 'conversacion.cierre_inactividad_horas', etiqueta: 'Cerrar la conversación tras (horas sin mensajes)', tipo: 'entero', min: 1 },
      { ruta: 'conversacion.retraso_escritura.minimo_s', etiqueta: 'Pausa mínima antes de responder (segundos)', tipo: 'numero', min: 0 },
      { ruta: 'conversacion.retraso_escritura.maximo_s', etiqueta: 'Pausa máxima antes de responder (segundos)', tipo: 'numero', min: 0 },
      { ruta: 'conversacion.retraso_escritura.caracteres_por_segundo', etiqueta: 'Velocidad de escritura simulada (caracteres por segundo)', tipo: 'numero', min: 1 },
    ],
  },
  {
    id: 'reporte',
    titulo: 'Reporte semanal de no calificados',
    campos: [
      { ruta: 'reporte_no_calificados.activo', etiqueta: 'Enviar el reporte', tipo: 'booleano' },
      { ruta: 'reporte_no_calificados.dias', etiqueta: 'Días que cubre cada reporte', tipo: 'entero', min: 1 },
      { ruta: 'reporte_no_calificados.destinatarios', etiqueta: 'Correos adicionales', tipo: 'correos',
        ayuda: 'Uno por línea, además de los usuarios que reciben el reporte.' },
    ],
  },
];

export type Json = null | boolean | number | string | Json[] | { [clave: string]: Json };

/** undefined = la ruta no existe; null = existe sin valor. */
export function leerRuta(objeto: Json | undefined, ruta: string): Json | undefined {
  let actual: Json | undefined = objeto;
  for (const parte of ruta.split('.')) {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual) || !(parte in actual)) return undefined;
    actual = actual[parte];
  }
  return actual;
}

/** Secciones con solo los campos que existen en los parámetros del tenant. */
export function seccionesDisponibles(parametros: Json): Seccion[] {
  return SECCIONES
    .map((seccion) => ({ ...seccion, campos: seccion.campos.filter((campo) => leerRuta(parametros, campo.ruta) !== undefined) }))
    .filter((seccion) => seccion.campos.length > 0);
}

export interface Formulario {
  get(nombre: string): string | null;
  getAll(nombre: string): string[];
}

type Resultado = { valor: Json } | { error: string };

const CORREO = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function enRango(campo: Campo, numero: number): string | null {
  if (campo.min !== undefined && numero < campo.min) return `Debe ser al menos ${campo.min}.`;
  if (campo.max !== undefined && numero > campo.max) return `Debe ser como máximo ${campo.max}.`;
  return null;
}

function esUrlSegura(texto: string): boolean {
  try {
    return new URL(texto).protocol === 'https:';
  } catch {
    return false;
  }
}

function lineas(texto: string | null): string[] {
  return (texto ?? '').split('\n').map((linea) => linea.trim()).filter(Boolean);
}

/** Convierte lo que llegó del formulario al valor que se guarda, o explica el error. */
export function interpretarCampo(campo: Campo, formulario: Formulario): Resultado {
  const crudo = (formulario.get(campo.ruta) ?? '').trim();
  const vacio = (): Resultado => (campo.nulo ? { valor: null } : { error: 'Este dato es obligatorio.' });

  switch (campo.tipo) {
    case 'booleano':
      return { valor: formulario.get(campo.ruta) === 'on' };

    case 'cop': {
      if (!crudo) return vacio();
      // Acepta "450.000.000", "450 000 000" o "$450,000,000": en pesos no hay decimales.
      const digitos = crudo.replace(/[^\d]/g, '');
      if (!digitos || /[^\d.,\s$]/.test(crudo)) return { error: 'Escribe solo el número, por ejemplo 450.000.000.' };
      const numero = Number(digitos);
      return enRango(campo, numero) ? { error: enRango(campo, numero)! } : { valor: numero };
    }

    case 'pct':
    case 'numero':
    case 'entero': {
      if (!crudo) return vacio();
      const numero = Number(crudo.replace(',', '.').replace('%', '').trim());
      if (!Number.isFinite(numero)) return { error: 'Debe ser un número.' };
      if (campo.tipo === 'entero' && !Number.isInteger(numero)) return { error: 'Debe ser un número entero.' };
      const minimo = campo.min ?? 0;
      const maximo = campo.max ?? (campo.tipo === 'pct' ? 100 : undefined);
      const error = enRango({ ...campo, min: minimo, max: maximo }, numero);
      return error ? { error } : { valor: numero };
    }

    case 'texto':
    case 'texto_largo':
      return crudo ? { valor: crudo } : vacio();

    case 'url':
      if (!crudo) return vacio();
      return esUrlSegura(crudo) ? { valor: crudo } : { error: 'Debe ser un enlace que empiece por https://' };

    case 'opciones': {
      const permitidos = new Set((campo.opciones ?? []).map((opcion) => opcion.valor));
      const elegidos = formulario.getAll(campo.ruta).filter((valor) => permitidos.has(valor));
      if (elegidos.length < (campo.min ?? 0)) return { error: `Elige al menos ${campo.min}.` };
      return { valor: elegidos };
    }

    case 'lista':
      return { valor: lineas(formulario.get(campo.ruta)) };

    case 'correos': {
      const correos = lineas(formulario.get(campo.ruta));
      const invalido = correos.find((correo) => !CORREO.test(correo));
      return invalido ? { error: `Correo inválido: ${invalido}` } : { valor: correos };
    }

    case 'dossier': {
      const url = (formulario.get(`${campo.ruta}.url`) ?? '').trim();
      const nombre = (formulario.get(`${campo.ruta}.nombre_archivo`) ?? '').trim();
      if (!url) return { valor: null };
      if (!esUrlSegura(url)) return { error: 'Debe ser un enlace que empiece por https://' };
      // WhatsApp muestra este nombre al enviar el archivo.
      const nombreArchivo = nombre || new URL(url).pathname.split('/').pop() || 'dossier.pdf';
      return { valor: { url, nombre_archivo: nombreArchivo } };
    }
  }
}

/**
 * Compara el formulario con los parámetros actuales y devuelve solo los cambios,
 * como { ruta: valor } para app.actualizar_parametros.
 */
export function calcularCambios(parametros: Json, formulario: Formulario) {
  const cambios: Record<string, Json> = {};
  const errores: Record<string, string> = {};
  const nuevos: Record<string, Json> = {};

  for (const seccion of seccionesDisponibles(parametros)) {
    for (const campo of seccion.campos) {
      const resultado = interpretarCampo(campo, formulario);
      if ('error' in resultado) {
        errores[campo.ruta] = resultado.error;
        continue;
      }
      nuevos[campo.ruta] = resultado.valor;
      if (JSON.stringify(resultado.valor) !== JSON.stringify(leerRuta(parametros, campo.ruta))) {
        cambios[campo.ruta] = resultado.valor;
      }
    }
  }

  const rutaMinimo = 'conversacion.retraso_escritura.minimo_s';
  const rutaMaximo = 'conversacion.retraso_escritura.maximo_s';
  if (typeof nuevos[rutaMinimo] === 'number' && typeof nuevos[rutaMaximo] === 'number'
      && (nuevos[rutaMinimo] as number) > (nuevos[rutaMaximo] as number)) {
    errores[rutaMaximo] = 'La pausa máxima no puede ser menor que la mínima.';
  }

  return { cambios, errores };
}
