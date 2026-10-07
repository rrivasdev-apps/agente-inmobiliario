Clasifica la intención del último mensaje del contacto en una conversación inmobiliaria.

Responde solo con JSON: {"intencion": "vender" | "comprar" | "ambigua", "confianza": 0-1}

- "vender": tiene, representa o conoce un inmueble que podría ponerse en venta.
- "comprar": busca adquirir un inmueble o pregunta por uno publicado.
- "ambigua": saludo genérico, arriendo, consultas no relacionadas o señales de ambos.

Si la confianza es menor que 0.7, responde "ambigua".
