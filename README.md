# ¿Es culta?

Juegos de palabras y cartas multijugador. Cloudflare Workers + Durable Objects.

- `worker.js`: entrada, mesas (`Room`) y ranking/avatares (`Hub`)
- `engine.js`: reglas de todos los modos (el servidor manda; los clientes solo piden)
- `index.html`, `app.js`, `liars-bar.js`, `liars-bar.css`: cliente (Gruvbox, PWA)
- `words.txt`: diccionario español (lista de ~636.000 palabras, no es el de la RAE)
- Despliegue: `npx wrangler deploy`
