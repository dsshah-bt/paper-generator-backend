// routes/api.js
// -----------------------------------------------------------------------
// API Layer / Repository Layer
// REST endpoints the frontend's SyncManager talks to. Every route here
// requires a valid account (see server.js: this router is mounted behind
// auth.requireAuth), and every DB call is scoped to req.user.id so one
// account can never read or write another account's data.
// -----------------------------------------------------------------------
const express = require('express');
const db = require('./database');

function buildApiRouter({ broadcast }) {
  const router = express.Router();

  // Full snapshot — used on initial load / opening on a new device.
  router.get('/state', (req, res) => {
    const deviceId = req.query.deviceId;
    if (deviceId) db.touchDevice(req.user.id, deviceId, req.query.label);
    res.json({ ok: true, state: db.readAll(req.user.id), serverTime: Date.now() });
  });

  // Incremental sync — "what changed since I last synced".
  router.get('/state/changes', (req, res) => {
    const since = Number(req.query.since) || 0;
    res.json({ ok: true, changed: db.readChangedSince(req.user.id, since), serverTime: Date.now() });
  });

  router.get('/state/:key', (req, res) => {
    const slice = db.readSlice(req.user.id, req.params.key);
    if (!slice) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, slice });
  });

  // Single-slice history (recovery / rollback).
  router.get('/state/:key/history', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 20);
    res.json({ ok: true, history: db.getHistory(req.user.id, req.params.key, limit) });
  });

  // Alias so navigator.sendBeacon() (which can only POST, used as a
  // best-effort save on tab close / crash) hits the same logic as PUT.
  router.post('/state/:key/beacon', (req, res) => putHandler(req, res));

  // The core autosave endpoint. Body: { value, updatedAt, deviceId }
  router.put('/state/:key', (req, res) => putHandler(req, res));

  function putHandler(req, res) {
    const { key } = req.params;
    const { value, updatedAt, deviceId, label } = req.body || {};
    if (value === undefined) {
      return res.status(400).json({ ok: false, error: 'missing_value' });
    }
    try {
      if (deviceId) db.touchDevice(req.user.id, deviceId, label);
      const result = db.writeSlice(req.user.id, key, value, updatedAt, deviceId);

      if (result.accepted) {
        // Tell every other connected device (tab, laptop, phone...) on
        // THIS SAME ACCOUNT that this slice changed, so they can refetch
        // it immediately instead of waiting for their next poll. This is
        // the "realtime" part. Broadcasts never cross accounts.
        broadcast(req.user.id, { type: 'changed', key, updatedAt: result.slice.updatedAt, updatedBy: deviceId }, deviceId);
        return res.json({ ok: true, accepted: true, slice: result.slice });
      }

      // Our write was stale — a newer edit already landed. Tell the
      // client so it can pull the winning value instead of retrying
      // blindly (this is the "no corruption / latest edit wins" rule).
      return res.status(409).json({ ok: true, accepted: false, reason: 'stale_write', slice: result.slice });
    } catch (err) {
      res.status(err.status || 500).json({ ok: false, error: err.message });
    }
  }

  return router;
}

module.exports = { buildApiRouter };
