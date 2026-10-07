'use strict';

/**
 * Google Maps Geocoding para verificar la dirección de Lucía.
 * Criterio en docs/arquitectura.md ("Criterio para clasificar una dirección").
 *
 * 'sin_resultados' lo convierte la BD en 'ambigua' o 'no_verificada' según
 * haya habido una aclaración previa (app.registrar_verificacion).
 */

const URL_GEOCODING = 'https://maps.googleapis.com/maps/api/geocode/json';
const PRECISION_SUFICIENTE = new Set(['ROOFTOP', 'RANGE_INTERPOLATED']);
const TIPOS_CIUDAD = new Set(['locality', 'administrative_area_level_2', 'administrative_area_level_1']);

function normalizarNombre(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** La clave de API la agrega la credencial de n8n (Query Auth: key). */
function solicitudGeocodificacion(direccion, config) {
  const c = config || {};
  return {
    url: URL_GEOCODING,
    consulta: {
      address: direccion,
      region: c.region || 'co',
      language: c.language || 'es',
    },
  };
}

function enCiudad(resultado, ciudad) {
  const buscada = normalizarNombre(ciudad);
  if (!buscada) return false;
  return (resultado.address_components || []).some((c) =>
    (c.types || []).some((t) => TIPOS_CIUDAD.has(t))
    && normalizarNombre(c.long_name).includes(buscada));
}

function resumen(respuesta) {
  const r = respuesta || {};
  return {
    status: r.status || null,
    error_message: r.error_message || (r.error && r.error.message) || null,
    resultados: Array.isArray(r.results) ? r.results.length : 0,
    primero: Array.isArray(r.results) && r.results[0]
      ? { formatted_address: r.results[0].formatted_address, location_type: r.results[0].geometry && r.results[0].geometry.location_type, partial_match: Boolean(r.results[0].partial_match) }
      : null,
  };
}

/**
 * @returns {{ resultado: 'verificada'|'ambigua'|'sin_resultados'|'error',
 *   direccion_normalizada, latitud, longitud, place_id, respuesta_proveedor }}
 */
function clasificarGeocodificacion(respuesta, ciudad) {
  const r = respuesta || {};
  const base = { direccion_normalizada: null, latitud: null, longitud: null, place_id: null, respuesta_proveedor: resumen(r) };

  if (r.status === 'ZERO_RESULTS') return { ...base, resultado: 'sin_resultados' };
  if (r.status !== 'OK' || !Array.isArray(r.results) || r.results.length === 0) return { ...base, resultado: 'error' };

  const primero = r.results[0];
  const geo = primero.geometry || {};
  const datos = {
    ...base,
    direccion_normalizada: primero.formatted_address || null,
    latitud: geo.location ? geo.location.lat : null,
    longitud: geo.location ? geo.location.lng : null,
    place_id: primero.place_id || null,
  };

  const precisa = r.results.length === 1
    && !primero.partial_match
    && PRECISION_SUFICIENTE.has(geo.location_type)
    && enCiudad(primero, ciudad);

  return { ...datos, resultado: precisa ? 'verificada' : 'ambigua' };
}

module.exports = { solicitudGeocodificacion, clasificarGeocodificacion };
