'use strict';

/**
 * Meta (WhatsApp Cloud API e Instagram): normaliza webhooks y arma envíos.
 *
 * Funciones puras que scripts/generar-n8n.js copia en nodos Code del flujo.
 * No usan require ni módulos: el sandbox de n8n Cloud no los permite.
 */

const GRAPH = 'https://graph.facebook.com/v21.0';

/**
 * Prepara la verificación de X-Hub-Signature-256. La comparación con el App
 * Secret ocurre en Supabase (app.verificar_firma_meta), así el secreto nunca
 * pasa por n8n. Una firma con formato inválido se envía vacía.
 */
function prepararFirma(cuerpoCrudo, cabeceras) {
  const firma = String((cabeceras || {})['x-hub-signature-256'] || '').toLowerCase();
  return {
    cuerpo_b64: Buffer.from(cuerpoCrudo || '').toString('base64'),
    firma: /^sha256=[0-9a-f]{64}$/.test(firma) ? firma : '',
  };
}

function textoWhatsApp(m) {
  switch (m.type) {
    case 'text': return m.text && m.text.body;
    case 'button': return m.button && m.button.text;
    case 'interactive': {
      const i = m.interactive || {};
      return (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title);
    }
    default: return null;
  }
}

/**
 * Convierte el cuerpo de un webhook de Meta en mensajes normalizados:
 * { tipo_canal, identificador_canal, id_externo, remitente_id, nombre, texto, tipo_mensaje }
 * Ignora estados de entrega, lecturas, ecos de nuestros propios mensajes y
 * objetos no soportados.
 */
function normalizarWebhook(cuerpo) {
  const salida = [];
  const entradas = (cuerpo && Array.isArray(cuerpo.entry)) ? cuerpo.entry : [];

  if (cuerpo && cuerpo.object === 'whatsapp_business_account') {
    for (const entrada of entradas) {
      for (const cambio of entrada.changes || []) {
        const v = cambio.value || {};
        if (cambio.field !== 'messages' || !v.metadata) continue;
        const nombres = new Map((v.contacts || []).map((c) => [c.wa_id, c.profile && c.profile.name]));
        for (const m of v.messages || []) {
          salida.push({
            tipo_canal: 'whatsapp',
            identificador_canal: v.metadata.phone_number_id,
            id_externo: m.id,
            remitente_id: m.from,
            nombre: nombres.get(m.from) || null,
            texto: textoWhatsApp(m) || null,
            tipo_mensaje: m.type,
          });
        }
      }
    }
  }

  if (cuerpo && cuerpo.object === 'instagram') {
    for (const entrada of entradas) {
      for (const ev of entrada.messaging || []) {
        const m = ev.message;
        if (!m || m.is_echo || m.is_deleted || !ev.sender || ev.sender.id === entrada.id) continue;
        salida.push({
          tipo_canal: 'instagram_dm',
          identificador_canal: entrada.id,
          id_externo: m.mid,
          remitente_id: ev.sender.id,
          nombre: null,
          texto: m.text || null,
          tipo_mensaje: m.text ? 'text' : 'attachment',
        });
      }
      for (const cambio of entrada.changes || []) {
        const v = cambio.value || {};
        // Las respuestas de la propia cuenta también llegan como comentarios.
        if (cambio.field !== 'comments' || !v.id || !v.from || v.from.id === entrada.id) continue;
        salida.push({
          tipo_canal: 'instagram_comentario',
          identificador_canal: entrada.id,
          id_externo: v.id,
          remitente_id: v.from.id,
          nombre: v.from.username || null,
          texto: v.text || null,
          tipo_mensaje: 'comment',
        });
      }
    }
  }

  return salida.filter((m) => m.identificador_canal && m.id_externo && m.remitente_id);
}

/**
 * Solicitud a la Graph API para responder por el canal de la conversación.
 * `documento` ({ url, nombre_archivo }) se envía en WhatsApp como archivo con
 * el texto como descripción; en Instagram, como enlace al final del texto.
 */
function solicitudEnvio(ctx, texto, documento) {
  if (ctx.canal.tipo === 'whatsapp' && documento) {
    return {
      url: `${GRAPH}/${encodeURIComponent(ctx.canal.identificador_externo)}/messages`,
      cuerpo: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: String(ctx.contacto.telefono || '').replace(/\D/g, ''),
        type: 'document',
        document: { link: documento.url, filename: documento.nombre_archivo, caption: texto },
      },
    };
  }
  if (documento) texto = `${texto}\n\n${documento.url}`;
  if (ctx.canal.tipo === 'whatsapp') {
    return {
      url: `${GRAPH}/${encodeURIComponent(ctx.canal.identificador_externo)}/messages`,
      cuerpo: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: String(ctx.contacto.telefono || '').replace(/\D/g, ''),
        type: 'text',
        text: { preview_url: false, body: texto },
      },
    };
  }
  if (ctx.canal.tipo === 'instagram_dm') {
    return {
      url: `${GRAPH}/me/messages`,
      cuerpo: { recipient: { id: ctx.contacto.instagram_id }, message: { text: texto } },
    };
  }
  throw new Error(`Canal sin envío configurado: ${ctx.canal.tipo}`);
}

function solicitudRespuestaComentario(comentarioId, texto) {
  return { url: `${GRAPH}/${encodeURIComponent(comentarioId)}/replies`, cuerpo: { message: texto } };
}

/**
 * Interpreta la respuesta del nodo HTTP (con "continuar ante error", un fallo
 * llega como { error: {...} }).
 */
function interpretarEnvio(respuesta) {
  const r = respuesta || {};
  const id = (Array.isArray(r.messages) && r.messages[0] && r.messages[0].id) || r.message_id || r.id || null;
  if (r.error || !id) {
    const e = r.error || {};
    return {
      enviado: false,
      id_externo: null,
      error: { mensaje: e.message || 'Respuesta sin id de mensaje', codigo: e.code || e.httpCode || null, descripcion: e.description || null },
    };
  }
  return { enviado: true, id_externo: id, error: null };
}

module.exports = {
  prepararFirma,
  normalizarWebhook,
  solicitudEnvio,
  solicitudRespuestaComentario,
  interpretarEnvio,
};
