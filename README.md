# Es culta

Juego multijugador estático. Funciona en GitHub Pages sin compilar nada.

## Publicar
1. Sube estos archivos a la raíz de un repositorio de GitHub.
2. Settings → Pages → Deploy from a branch → `main` / `(root)`.
3. Comparte `https://TUUSUARIO.github.io/NOMBRE-REPO/` con tus colegas.

## Notas
- La multijugador usa brokers MQTT públicos (EMQX, HiveMQ, Mosquitto). Pueden ir lentos o caerse.
- Otro broker: añade `?broker=wss://tu-broker/mqtt` a la URL.
# es-culta
