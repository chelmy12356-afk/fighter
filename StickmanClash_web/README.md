# Stickman Clash — Web Edition

This is a browser port based on the uploaded Stickman Clash Godot source. It keeps the core procedural stickman presentation and combat values, and adds a browser-friendly room-code multiplayer layer using WebSockets.

## Run locally

Requires Node.js 18+.

```bash
npm install
npm start
```

Open `http://localhost:8080`.

## Online play

Deploy this folder to a Node.js host that supports WebSockets (Render, Railway, Fly.io, a VPS, etc.). Both players open the same URL, but they can be on completely different Wi-Fi networks. One chooses **CREATE ONLINE ROOM**, and the other enters the six-character room code and chooses **JOIN ONLINE ROOM**.

No UDP 7777 or router port forwarding is required for this version.

## Important

This is a browser port, not a byte-for-byte Godot export. The uploaded project contained the gameplay scripts plus a packaged `.pck`; the original desktop build used Godot ENet/UDP. The web version replaces that networking layer with WebSockets and reimplements the playable fighter/rendering layer in JavaScript so it can run directly in a browser.
