# Stickman Clash

Stickman Clash is a browser fighting game served by a Node.js WebSocket server.
The server pairs two browsers and authoritatively simulates each online match;
both players send controls and receive server-generated game snapshots.

## Run locally

Install Node.js 20 or later, then run:

```sh
npm ci
npm start
```

Open <http://localhost:8080> in two browser windows. In the first window, choose
**3** to open online play and click **Create room**. In the second, choose
**4**, enter the displayed six-character code, and click **Join**. Player 1 uses
A/D, Space, W, S, F and G; the joining player uses the same controls on their
own keyboard. In online play, Up/Left also punch and Down/Right also kick.
Arrow keys, I, K and L retain their local two-player controls.

## Special Powers mode

Choose **5** for Powers vs CPU or **6** for local two-player Powers mode.
To host an online Powers match, choose **7**, then click **Create room**. The
Powers checkbox is enabled for you automatically; share the room code so the
other player can join. Or choose **3** and enable the Powers checkbox to host
Powers mode from the online panel. The room creator selects the mode, and the
joining player does not need to select it. Each round gives the players different
random powers. Press **Shift** to use the displayed power; its cooldown appears
on the HUD. Power values and cooldowns are centralized in
[`power-system.js`](./power-system.js).

At the end of a match, use **Play Again** to restart the same mode or **Main
Menu** to leave. Either online player can request a rematch; the server resets
and restarts the match for both players.

## Deploy on Render

1. Push this repository to GitHub.
2. In Render, choose **New + > Blueprint**, connect the repository, and deploy
   the detected `render.yaml`.
3. Wait for the web service to finish deploying, then open its `onrender.com`
   URL in both players' browsers.
4. One player creates a room and sends the code to the other player, who joins
   from the same page.

The Render service must be a Node web service with WebSockets enabled (Render
web services support WebSocket connections). Use the HTTPS site URL in the
browser; the game automatically connects with secure WebSockets. Render's free
service may spin down when idle, so the first connection after inactivity can
take a little longer.

Online matches are server-authoritative: both browsers send only an 8-bit
control mask. The Render server simulates movement, attacks, hits, damage,
powers, cooldowns, rounds, and rematches, then broadcasts snapshots to both
players. Neither player's browser can submit match state or declare a hit. The
room creator only selects the room mode and shares its code. After a temporary
connection drop, the game attempts to reconnect and restore the room for up to
30 seconds; if that fails, the room ends. This is not rollback netcode, so a
slow or unstable connection can make controls feel delayed. The server keeps
matches in memory, so a server restart ends active rooms.