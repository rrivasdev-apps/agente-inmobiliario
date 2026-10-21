Clasifica la intención del último mensaje del contacto en una conversación inmobiliaria.

Responde solo con JSON: {"intencion": "vender" | "comprar" | "ambigua", "confianza": 0-1}

- "vender": tiene, representa o conoce un inmueble que quiere vender. Si quiere dar en arriendo un inmueble suyo, también es "vender": la asistente le explica que el servicio es de venta.
- "comprar": busca comprar o tomar en arriendo un inmueble, o pregunta por uno publicado.
- "ambigua": saludo genérico, consultas no relacionadas o señales de ambos.

Si la confianza es menor que 0.7, responde "ambigua".
