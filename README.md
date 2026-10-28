# Roll&Run 🎲

**El dado decide tu destino.** Juego multijugador de dados en tiempo real: lanza, suma y corre hacia la meta… pero cuidado con el número de penitencia.

## Cómo se juega

1. El anfitrión crea una sala y configura las reglas; los demás entran con el código de 6 dígitos (o el enlace compartido).
2. En el lobby los jugadores quedan **ordenados por orden de ingreso**. Ese es el orden de los turnos.
3. En tu turno lanzas el dado (1 a 6). Si el número es distinto al de la penitencia, **se suma a tu score al instante** y decides: **seguir lanzando** o **plantarte / pasar** (hay que lanzar al menos una vez).
4. Si sale el **número de penitencia**, pierdes **todo tu score** (vuelves a 0) y el turno pasa **automáticamente** al siguiente jugador.
5. Gana el primero que llegue a la **meta de puntos**.

### Reglas configurables al crear la sala

| Opción                | Valores                                 | Por defecto |
| --------------------- | --------------------------------------- | ----------- |
| Meta de puntos        | 10 a 500 (de 5 en 5)                    | 50          |
| Dado de penitencia    | 1 a 6                                   | 1           |
| Modo de penitencia    | Pierde todo · Solo los puntos del turno | Pierde todo |
| Máximo de jugadores   | 2 a 8                                   | 6           |

El anfitrión puede editar las reglas desde el lobby, expulsar jugadores, iniciar la partida, saltar el turno de un jugador desconectado y lanzar la revancha.

### Robustez multijugador

- **Reconexión:** si recargas la página o se corta la red vuelves a tu misma silla (la sesión se guarda por pestaña). Un corte o un timeout nunca borran la sesión: se reintenta solo.
- **Atrás del navegador / gesto atrás:** dentro de la sala pide la misma confirmación que el botón de salir.
- **Jugador desconectado en su turno:** su turno se salta solo a los 20 s, o el anfitrión puede saltarlo antes.
- **Anfitrión desconectado:** el rol pasa al primer jugador conectado cuando este lleva 30 s esperando.
- **Lobby:** nadie sale por tiempo. Una silla desconectada hace 60 s o más se libera solo si hace falta: la sala se llena, alguien entra con ese apodo o empieza la partida. Quien lleva menos tiempo fuera entra a la partida y, si no vuelve, se le saltan los turnos.
- **Partida cancelada:** si alguien sale y queda un solo jugador, la partida vuelve al lobby con un aviso.
- **Salas vacías:** una sala sin nadie conectado se elimina a los 10 min.
- **Anti-abuso:** límite de códigos inexistentes por IP (evita adivinar salas), de salas creadas por minuto, de conexiones y de eventos por segundo. Los apodos se limpian de caracteres invisibles y no se aceptan imitaciones de un apodo ya usado (`Аna` con A cirílica, `ＡＮＡ`…).

## Arquitectura

```
rollyrun/
├── shared/protocol.ts   # Contrato cliente ↔ servidor (tipos, eventos, tiempos, límites)
├── server/              # Node + Socket.IO (servidor autoritativo)
│   ├── src/
│   │   ├── game-room.ts       # Motor de reglas (turnos, dado, penitencia, victoria)
│   │   ├── room-manager.ts    # Salas activas, códigos, limpieza periódica
│   │   ├── socket-handlers.ts # Eventos Socket.IO ↔ GameRoom
│   │   ├── validation.ts      # Saneo de datos de clientes
│   │   ├── app.ts             # HTTP (estáticos + /health) + Socket.IO
│   │   └── index.ts           # Punto de entrada
│   └── test/            # Vitest: motor, validación e integración con sockets reales
└── src/                 # Cliente Angular 21 (standalone + signals)
    └── app/
        ├── core/        # SocketService, GameStore, ProfileService, ToastService, SoundService
        ├── features/    # home, create-room, join-room, room (lobby · game · results)
        └── shared/      # dice (dado 3D), avatar, top-bar, sheet, settings-form, confetti…
```

- El **servidor es la fuente de verdad**: genera el dado con `crypto.randomInt`, valida que solo el jugador del turno pueda lanzar o pasar y aplica la penitencia. El cliente solo envía intenciones y pinta el `RoomView` que recibe por `room:state`.
- El servidor corre TypeScript de forma nativa con Node (`node server/src/index.ts`, requiere Node ≥ 22.18).
- Diseño "Velocity Arcade" (prototipo en `prototipo/`, no se versiona): tokens y piezas globales en `src/styles.scss`.

## Desarrollo

```bash
npm install
```

```bash
npm run dev
```

Levanta el servidor de sockets en `http://localhost:3000` y Angular en `http://localhost:4200` (con proxy de `/socket.io` hacia el servidor). Para probar el multijugador abre varias pestañas: cada pestaña es un jugador distinto.

| Script                 | Qué hace                                               |
| ---------------------- | ------------------------------------------------------ |
| `npm run dev`          | Servidor (con `--watch`) + `ng serve` a la vez         |
| `npm run server`       | Solo el servidor (`PORT`, `HOST`, `CORS_ORIGIN`; `--port` tiene prioridad sobre `PORT`) |
| `npm run server:check` | Typecheck del servidor                                 |
| `npm run test:server`  | Tests del motor, validación e integración (Vitest)     |
| `npm test`             | Tests del cliente (Angular + Vitest)                   |
| `npm run build`        | Build de producción del cliente en `dist/rollyrun/`    |
| `npm run start:prod`   | Build + servidor sirviendo el cliente en el puerto 3000 |

## Despliegue

**Un solo servicio (recomendado, p. ej. Render):** build command `npm install && npm run build`, start command `npm run server`. El servidor sirve el build de Angular y los sockets en el mismo origen.

**Front y servidor separados (p. ej. GitHub Pages + Render):** pon la URL del servidor en `socketUrl` de `src/environments/environment.ts` y define `CORS_ORIGIN` en el servidor con el origen del front.

### Variables de entorno del servidor

| Variable                 | Por defecto | Para qué sirve                                                                 |
| ------------------------ | ----------- | ------------------------------------------------------------------------------ |
| `PORT` / `HOST`          | 3000 / 0.0.0.0 | Dónde escucha (`--port` tiene prioridad sobre `PORT`)                       |
| `CORS_ORIGIN`            | —           | Origen del front cuando se sirve aparte                                        |
| `TRUST_PROXY`            | —           | Saltos de proxy de confianza (`1` o `true` en Render, Railway, Nginx…)         |
| `MAX_ROOMS`              | 2000        | Salas activas como máximo                                                      |
| `MAX_CONNECTIONS`        | 5000        | Conexiones simultáneas como máximo                                             |
| `MAX_CONNECTIONS_PER_IP` | 60          | Conexiones simultáneas por IP                                                  |

> **Detrás de un proxy (Render, etc.) define `TRUST_PROXY`.** Sin él, todos los clientes parecen venir de la IP del proxy y los límites por IP se reparten entre todos los jugadores. El servidor avisa una vez en el log si recibe `X-Forwarded-For` sin `TRUST_PROXY`.
