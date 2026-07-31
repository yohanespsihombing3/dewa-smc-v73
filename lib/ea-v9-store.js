const fs = require('fs');
    const path = require('path');

    function atomicWrite(file, data) {
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file);
    }

    function safeRead(file, fallback) {
      try {
        if (!fs.existsSync(file)) {
          atomicWrite(file, fallback);
          return JSON.parse(JSON.stringify(fallback));
        }
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        console.error('[EA V9 STORE] read failed:', file, error.message);
        return JSON.parse(JSON.stringify(fallback));
      }
    }

    function createEaV9Store(options = {}) {
      const dataDir = options.dataDir;
      const queueFile = path.join(dataDir, 'ea-queue.json');
      const ackFile = path.join(dataDir, 'ea-ack.json');
      const retentionDays = Math.max(1, Number(options.retentionDays || 14));
      const maxEvents = Math.max(100, Number(options.maxEvents || 10000));

      function ensureFiles() {
        safeRead(queueFile, { lastSequence: 0, events: [] });
        safeRead(ackFile, { acknowledgements: [] });
      }

      function loadQueue() {
        const db = safeRead(queueFile, { lastSequence: 0, events: [] });
        if (!Array.isArray(db.events)) db.events = [];
        if (!Number.isFinite(Number(db.lastSequence))) db.lastSequence = 0;
        db.lastSequence = Number(db.lastSequence);
        return db;
      }

      function saveQueue(db) { atomicWrite(queueFile, db); }

      function loadAcks() {
        const db = safeRead(ackFile, { acknowledgements: [] });
        if (!Array.isArray(db.acknowledgements)) db.acknowledgements = [];
        return db;
      }

      function saveAcks(db) { atomicWrite(ackFile, db); }

      function cleanupQueue(db) {
        const cutoff = Date.now() - retentionDays * 86400000;
        db.events = db.events.filter((event) => {
          const t = new Date(event.createdAt || 0).getTime();
          return !Number.isFinite(t) || t >= cutoff;
        });
        if (db.events.length > maxEvents) {
          db.events = db.events.slice(db.events.length - maxEvents);
        }
        return db;
      }

      function pushEvent(signal) {
        const db = cleanupQueue(loadQueue());
        const sequence = db.lastSequence + 1;
        db.lastSequence = sequence;

        const event = {
          sequence,
          signalId: String(signal.id || signal.signalId || ''),

          eventType: String(
            signal.eventType ||
            signal.status ||
            signal.signal ||
            ''
          ).toUpperCase(),
            
          key: String(signal.key || ''),
          pair: String(signal.pair || ''),
          symbol: String(signal.pair || ''),
          tf: String(signal.tf || ''),
          signal: String(signal.signal || '').toUpperCase(),
          status: String(signal.status || ''),
          direction: signal.direction || (
            String(signal.signal || '').toUpperCase().includes('LONG') ? 'LONG' :
            String(signal.signal || '').toUpperCase().includes('SHORT') ? 'SHORT' : null
          ),
          engine: String(signal.engine || ''),
          grade: String(signal.grade || ''),
          entry: Number(signal.entry || 0),
          tp1: Number(signal.tp1 || 0),
          tp2: Number(signal.tp2 || 0),
          tp3: Number(signal.tp3 || 0),
          sl: Number(signal.sl || 0),
          supersedes: signal.supersedes || null,
          createdAt: signal.createdAt || new Date().toISOString(),
          queuedAt: new Date().toISOString(),
          expiresAt: signal.expiresAt || null
        };

        db.events.push(event);
        saveQueue(db);
        return event;
      }

      function getEvents(afterSequence = 0, limit = 50) {
        const db = cleanupQueue(loadQueue());
        saveQueue(db);
        const after = Math.max(0, Number(afterSequence || 0));
        const capped = Math.min(200, Math.max(1, Number(limit || 50)));
        return {
          lastSequence: db.lastSequence,
          events: db.events
            .filter((event) => Number(event.sequence) > after)
            .sort((a, b) => Number(a.sequence) - Number(b.sequence))
            .slice(0, capped)
        };
      }

      function upsertAck(account, body) {
        const allowed = ['RECEIVED','PROCESSING','EXECUTED','FAILED','REJECTED','EXPIRED','SUPERSEDED','CANCELLED'];
        const status = String(body.status || '').toUpperCase();
        if (!allowed.includes(status)) {
          const err = new Error('Status ACK tidak valid');
          err.statusCode = 400;
          throw err;
        }

        const sequence = Number(body.sequence || 0);
        const signalId = String(body.signalId || '').trim();
        if (!sequence || !signalId) {
          const err = new Error('sequence dan signalId wajib diisi');
          err.statusCode = 400;
          throw err;
        }

        const db = loadAcks();
        const idx = db.acknowledgements.findIndex((x) =>
          String(x.account) === String(account) &&
          Number(x.sequence) === sequence
        );

        const item = {
          account: String(account),
          sequence,
          signalId,
          symbol: String(body.symbol || ''),
          status,
          ticket: body.ticket ?? null,
          fillPrice: body.fillPrice ?? body.fill_price ?? null,
          volume: body.volume ?? null,
          errorCode: body.errorCode ?? body.error_code ?? null,
          message: String(body.message || ''),
          updatedAt: new Date().toISOString()
        };

        if (idx >= 0) {
          item.createdAt = db.acknowledgements[idx].createdAt || item.updatedAt;
          db.acknowledgements[idx] = { ...db.acknowledgements[idx], ...item };
        } else {
          item.createdAt = item.updatedAt;
          db.acknowledgements.push(item);
        }

        const cutoff = Date.now() - retentionDays * 86400000;
        db.acknowledgements = db.acknowledgements.filter((ack) => {
          const t = new Date(ack.updatedAt || ack.createdAt || 0).getTime();
          return !Number.isFinite(t) || t >= cutoff;
        });

        saveAcks(db);
        return item;
      }

      ensureFiles();
      return { pushEvent, getEvents, upsertAck, ensureFiles };
    }

    module.exports = { createEaV9Store };
