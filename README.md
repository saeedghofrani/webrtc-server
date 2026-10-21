# WebRTC Signaling Server

A small TypeScript, Express, and Socket.IO service for coordinating private, two-person WebRTC meetings. It manages room membership and relays negotiation messages while media remains on the WebRTC path between browsers.

## Responsibilities

- Admit at most two sockets to a room
- Publish participant presence and names
- Relay SDP offers and answers to the intended peer
- Relay ICE candidates during connection establishment
- Broadcast bounded text-chat messages within a room
- Notify the remaining participant when a peer leaves
- Expose `GET /health` for deployment checks
- Restrict signaling and chat to the socket's actual meeting
- Recover refreshed tabs without waiting for stale polling connections to expire
- Coordinate ICE restarts through one participant to avoid competing offers

## Event flow

```text
join-room
  ├─ room-full                when two participants are already present
  ├─ room-joined              confirms membership to the joining socket
  ├─ room-users               publishes the current participant list
  └─ peer-ready               tells the existing peer to start negotiation

offer → answer → ice-candidate
chat-message
disconnect → peer-left + room-users
```

## Local development

Requirements:

- Node.js 20 or newer

```bash
npm ci
npm test
npm start
```

The service listens on port `3001` by default.

### Configuration

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP and Socket.IO listener port | `3001` |
| `CORS_ORIGIN` | Comma-separated allowed browser origins | all origins when unset |

Example:

```bash
PORT=3001 CORS_ORIGIN=http://localhost:3000 npm start
```

## Verification

```bash
npm test
curl http://localhost:3001/health
```

The test command compiles TypeScript and verifies capacity, duplicate joins,
cross-room isolation, chat sender identity, malformed payloads, session replacement,
leave notifications, and coordinated ICE recovery using real Socket.IO clients.

## Container run

```bash
docker compose up --build
```

The Compose definition includes a health check against `/health`. Configure production origins through environment-specific deployment settings rather than adding credentials to the repository.

## Scope and limitations

This service stores room state only in the Socket.IO process. It has no database, authentication, durable chat history, recording, moderation, or horizontal room-state adapter. Production use beyond a personal demonstration would require authenticated room access, rate limiting, structured logging, metrics, a shared Socket.IO adapter, and abuse controls.

Per-tab session tokens are reconnect tokens, not user authentication. Chat has a
bounded message size and a basic send interval; this does not replace deployment
abuse controls. Keep backend port 3001 bound to loopback behind HTTPS.

For rollback, retain a versioned copy of the previous Docker image, retag it to the
Compose image name, then run `docker compose up -d --no-build`. This disconnects
active calls and requires no database migration.

## Related repository

- [React WebRTC client](https://github.com/saeedghofrani/Webrtc-Client-React)
