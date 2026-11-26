'use client';

import { useState, useTransition } from 'react';
import type { Campo, Json, Seccion } from '@/lib/parametros';
import { valorDeFormulario } from '@/lib/formato';
import { guardarParametros, type EstadoGuardado } from './actions';

interface Props {
  slug: string;
  secciones: Seccion[];
  valores: Record<string, Json | undefined>;
  soloLectura: boolean;
}

function Control({ campo, valor, error, deshabilitado }: {
  campo: Campo; valor: Json | undefined; error?: string; deshabilitado: boolean;
}) {
  const comun = { id: campo.ruta, name: campo.ruta, disabled: deshabilitado, 'aria-invalid': error ? true : undefined };

  switch (campo.tipo) {
    case 'booleano':
      return (
        <label className="casilla">
          <input type="checkbox" {...comun} defaultChecked={valor === true} /> Sí
        </label>
      );
    case 'opciones': {
      const elegidos = new Set(Array.isArray(valor) ? valor : []);
      return (
        <div className="opciones" role="group" aria-labelledby={`${campo.ruta}-titulo`}>
          {campo.opciones?.map((opcion) => (
            <label key={opcion.valor}>
              <input type="checkbox" name={campo.ruta} value={opcion.valor} disabled={deshabilitado}
                defaultChecked={elegidos.has(opcion.valor)} />
              {opcion.titulo}
            </label>
          ))}
        </div>
      );
    }
    case 'texto_largo':
    case 'lista':
    case 'correos':
      return <textarea {...comun} defaultValue={valorDeFormulario(campo, valor)}
        placeholder={campo.tipo === 'texto_largo' ? '' : 'Uno por línea'} />;
    case 'dossier': {
      const dossier = valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : {};
      return (
        <>
          <input type="url" id={campo.ruta} name={`${campo.ruta}.url`} disabled={deshabilitado}
            aria-invalid={error ? true : undefined} placeholder="https://…/dossier.pdf"
            defaultValue={typeof dossier.url === 'string' ? dossier.url : ''} />
          <input type="text" name={`${campo.ruta}.nombre_archivo`} disabled={deshabilitado}
            aria-label="Nombre del archivo" placeholder="Nombre del archivo (opcional)"
            defaultValue={typeof dossier.nombre_archivo === 'string' ? dossier.nombre_archivo : ''} />
        </>
      );
    }
    default: {
      const numerico = ['cop', 'pct', 'numero', 'entero'].includes(campo.tipo);
      return (
        <div className="fila-form">
          {campo.tipo === 'cop' && <span aria-hidden="true">$</span>}
          <input type={campo.tipo === 'url' ? 'url' : 'text'} inputMode={numerico ? 'decimal' : undefined}
            {...comun} defaultValue={valorDeFormulario(campo, valor)}
            placeholder={campo.nulo ? 'Vacío = sin valor' : ''} />
          {campo.tipo === 'pct' && <span aria-hidden="true">%</span>}
        </div>
      );
    }
  }
}

export function FormularioParametros({ slug, secciones, valores, soloLectura }: Props) {
  const [estado, setEstado] = useState<EstadoGuardado | null>(null);
  const [pendiente, iniciarTransicion] = useTransition();
  // Al guardar se vuelve a montar el formulario con los valores ya normalizados
  // (p. ej. "3 000 000" pasa a "3.000.000").
  const [version, setVersion] = useState(0);
  const errores = estado?.errores ?? {};

  // Se usa onSubmit en lugar de <form action>: React reinicia los formularios
  // con action y se perderían los valores escritos cuando hay un error.
  function enviar(evento: React.FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const datos = new FormData(evento.currentTarget);
    iniciarTransicion(async () => {
      const resultado = await guardarParametros(slug, datos);
      setEstado(resultado);
      if (resultado.tipo === 'ok') setVersion((actual) => actual + 1);
    });
  }

  return (
    <form key={version} onSubmit={enviar} noValidate>
      {secciones.map((seccion) => (
        <section className="tarjeta" key={seccion.id} aria-labelledby={`seccion-${seccion.id}`}>
          <h2 id={`seccion-${seccion.id}`}>{seccion.titulo}</h2>
          {seccion.descripcion && <p>{seccion.descripcion}</p>}
          {seccion.campos.map((campo) => (
            <div className="campo" key={campo.ruta}>
              <label className="titulo" id={`${campo.ruta}-titulo`} htmlFor={campo.ruta}>{campo.etiqueta}</label>
              {campo.ayuda && <p className="ayuda">{campo.ayuda}</p>}
              <div className="control">
                <Control campo={campo} valor={valores[campo.ruta]} error={errores[campo.ruta]} deshabilitado={soloLectura} />
                {errores[campo.ruta] && <p className="error" role="alert">{errores[campo.ruta]}</p>}
              </div>
            </div>
          ))}
        </section>
      ))}

      {!soloLectura && (
        <div className="acciones">
          <button className="principal" type="submit" disabled={pendiente}>{pendiente ? 'Guardando…' : 'Guardar cambios'}</button>
          {estado && <p className={`aviso ${estado.tipo}`} role="status">{estado.mensaje}</p>}
        </div>
      )}
    </form>
  );
}
