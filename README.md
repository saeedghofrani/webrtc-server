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

## Android incoming calls (configuration required)

`/api/call-links` adds private ringing links without changing the existing room
signaling events. A recipient explicitly subscribes their Android phone to a link;
the sender requests a call and FCM delivers a high-priority, data-only alert.
Calls expire after 45 seconds and have a 60-second per-link cooldown. Answer and
decline require a device management credential; cancellation uses the unguessable
call ID and private link. Push acceptance is not proof of ringing.

Push is disabled by default. See `.env.example` and the optional
`docker-compose.calls.yml` override. Keep `CALL_LINK_STORE` on a private durable
volume, back it up, and run one signaling process. Its bounded registry supports
2,000 links and 10 devices per link. Protect link URLs like passwords. Never log
capability paths, FCM tokens, or device credentials. Configure edge rate limits;
the backend trusts forwarded IP/protocol headers from loopback and optional exact `TRUSTED_PROXY_IPS`. In Docker, set this to the actual bridge gateway used by host Nginx; other bridge peers and subnet patterns are not trusted.

The HTTPS proxy must route `/api/call-links` to this server, retaining the full
path. Existing `/socket.io/` proxy behavior is unchanged. Health checks are
`GET /health` and `GET /api/call-links/config`. Production FCM credentials must
use Application Default Credentials for the Android app's Firebase project.
The matching web/server images and Nginx API route were deployed on 2026-10-21. Physical Android ringing verification remains pending.

The `uuid` override pins the compatible CommonJS release 11.1.1 to fix the
transitive buffer-bounds advisory in Firebase Admin's dependency tree. Recheck
the override when upgrading Firebase Admin.

Android source and full setup instructions are in
[webrtc-android](https://github.com/saeedghofrani/webrtc-android) (private repository).

## Related repository

- [React WebRTC client](https://github.com/saeedghofrani/Webrtc-Client-React)
