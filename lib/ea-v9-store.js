const fs = require("fs");
const path = require("path");

function registerV10Admin({
  app,
  auth,
  dataDir,
  db,
  saveDb,
  safe,
  addDays,
  newKey,
  bcrypt,
  uuid
}) {
  const packagesFile = path.join(dataDir, "ea-packages.json");
  const pairsFile = path.join(dataDir, "scanner-pairs.json");

  const defaultPackages = {
    packages: [
      { id: "trial", name: "TRIAL", days: 3, maxAccounts: 1, enabled: true },
      { id: "weekly", name: "WEEKLY", days: 7, maxAccounts: 1, enabled: true },
      { id: "monthly", name: "MONTHLY", days: 30, maxAccounts: 1, enabled: true },
      { id: "quarterly", name: "QUARTERLY", days: 90, maxAccounts: 1, enabled: true },
      { id: "yearly", name: "YEARLY", days: 365, maxAccounts: 1, enabled: true }
    ]
  };

  const defaultPairs = {
    pairs: [
      { id: "xauusd", symbol: "XAU/USD", enabled: true, timeframes: ["5", "15"], priority: "HIGH" },
      { id: "btcusd", symbol: "BTC/USD", enabled: true, timeframes: ["5", "15"], priority: "HIGH" },
      { id: "ethusd", symbol: "ETH/USD", enabled: true, timeframes: ["5", "15"], priority: "HIGH" },
      { id: "eurusd", symbol: "EUR/USD", enabled: true, timeframes: ["5", "15"], priority: "NORMAL" },
      { id: "gbpusd", symbol: "GBP/USD", enabled: true, timeframes: ["5", "15"], priority: "NORMAL" }
    ]
  };

  function ensureFile(file, initial) {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(initial, null, 2));
  }

  function readJson(file, initial) {
    ensureFile(file, initial);
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return JSON.parse(JSON.stringify(initial));
    }
  }

  function writeJson(file, value) {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  }

  function adminOnly(req, res, next) {
    if (!req.user || req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin only" });
    }
    next();
  }

  function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
  }

  function normalizeMt5(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function normalizePair(value) {
    const raw = String(value || "").trim().toUpperCase().replace(/\s+/g, "");
    if (!raw) return "";
    if (raw.includes("/")) return raw;
    if (raw.length === 6) return raw.slice(0, 3) + "/" + raw.slice(3);
    if (raw === "XAUUSD") return "XAU/USD";
    if (raw === "XAGUSD") return "XAG/USD";
    return raw;
  }

  app.get("/api/admin/v10/packages", auth, adminOnly, (req, res) => {
    res.json(readJson(packagesFile, defaultPackages));
  });

  app.post("/api/admin/v10/packages", auth, adminOnly, (req, res) => {
    const store = readJson(packagesFile, defaultPackages);
    const name = String(req.body.name || "").trim().toUpperCase();
    const days = Math.max(1, Number(req.body.days || 0));
    const maxAccounts = Math.max(1, Number(req.body.maxAccounts || 1));

    if (!name) return res.status(400).json({ error: "Nama paket wajib diisi" });
    if (store.packages.some(x => x.name === name)) {
      return res.status(409).json({ error: "Nama paket sudah ada" });
    }

    store.packages.push({
      id: uuid(),
      name,
      days,
      maxAccounts,
      enabled: req.body.enabled !== false
    });
    writeJson(packagesFile, store);
    res.json(store);
  });

  app.put("/api/admin/v10/packages/:id", auth, adminOnly, (req, res) => {
    const store = readJson(packagesFile, defaultPackages);
    const item = store.packages.find(x => x.id === req.params.id);
    if (!item) return res.status(404).json({ error: "Paket tidak ditemukan" });

    if (req.body.name !== undefined) item.name = String(req.body.name).trim().toUpperCase();
    if (req.body.days !== undefined) item.days = Math.max(1, Number(req.body.days));
    if (req.body.maxAccounts !== undefined) item.maxAccounts = Math.max(1, Number(req.body.maxAccounts));
    if (req.body.enabled !== undefined) item.enabled = !!req.body.enabled;
    writeJson(packagesFile, store);
    res.json(store);
  });

  app.delete("/api/admin/v10/packages/:id", auth, adminOnly, (req, res) => {
    const store = readJson(packagesFile, defaultPackages);
    store.packages = store.packages.filter(x => x.id !== req.params.id);
    writeJson(packagesFile, store);
    res.json(store);
  });

  app.get("/api/admin/v10/pairs", auth, adminOnly, (req, res) => {
    res.json(readJson(pairsFile, defaultPairs));
  });

  app.post("/api/admin/v10/pairs", auth, adminOnly, (req, res) => {
    const store = readJson(pairsFile, defaultPairs);
    const symbol = normalizePair(req.body.symbol);
    const timeframes = Array.isArray(req.body.timeframes)
      ? req.body.timeframes.map(String).filter(x => x === "5" || x === "15")
      : ["5", "15"];

    if (!symbol) return res.status(400).json({ error: "Pair wajib diisi" });
    if (store.pairs.some(x => x.symbol === symbol)) {
      return res.status(409).json({ error: "Pair sudah ada" });
    }

    store.pairs.push({
      id: uuid(),
      symbol,
      enabled: req.body.enabled !== false,
      timeframes: timeframes.length ? timeframes : ["5"],
      priority: String(req.body.priority || "NORMAL").toUpperCase()
    });
    writeJson(pairsFile, store);
    res.json(store);
  });

  app.put("/api/admin/v10/pairs/:id", auth, adminOnly, (req, res) => {
    const store = readJson(pairsFile, defaultPairs);
    const item = store.pairs.find(x => x.id === req.params.id);
    if (!item) return res.status(404).json({ error: "Pair tidak ditemukan" });

    if (req.body.symbol !== undefined) item.symbol = normalizePair(req.body.symbol);
    if (req.body.enabled !== undefined) item.enabled = !!req.body.enabled;
    if (req.body.priority !== undefined) item.priority = String(req.body.priority).toUpperCase();
    if (Array.isArray(req.body.timeframes)) {
      const tfs = req.body.timeframes.map(String).filter(x => x === "5" || x === "15");
      item.timeframes = tfs.length ? tfs : ["5"];
    }
    writeJson(pairsFile, store);
    res.json(store);
  });

  app.delete("/api/admin/v10/pairs/:id", auth, adminOnly, (req, res) => {
    const store = readJson(pairsFile, defaultPairs);
    store.pairs = store.pairs.filter(x => x.id !== req.params.id);
    writeJson(pairsFile, store);
    res.json(store);
  });

  app.post("/api/admin/v10/members", auth, adminOnly, async (req, res) => {
    try {
      const email = normalizeEmail(req.body.email);
      const mt5Account = normalizeMt5(req.body.mt5Account);
      const packageId = String(req.body.packageId || "monthly");
      const packages = readJson(packagesFile, defaultPackages).packages;
      const selectedPackage = packages.find(x => x.id === packageId || x.name === packageId);
      const days = Math.max(1, Number(req.body.days || selectedPackage?.days || 30));

      if (!email.includes("@")) {
        return res.status(400).json({ error: "Gmail member tidak valid" });
      }
      if (!mt5Account || mt5Account.length < 5) {
        return res.status(400).json({ error: "Nomor akun MT5 tidak valid" });
      }

      const data = db();
      if (data.users.some(x => normalizeEmail(x.email) === email)) {
        return res.status(409).json({ error: "Gmail sudah terdaftar" });
      }
      if (data.users.some(x => normalizeMt5(x.mt5Account) === mt5Account)) {
        return res.status(409).json({ error: "Akun MT5 sudah terdaftar" });
      }

      const tempPassword = String(req.body.password || "DEWA123456");
      const user = {
        id: uuid(),
        email,
        passwordHash: await bcrypt.hash(tempPassword, 10),
        role: "member",
        plan: selectedPackage?.name || String(req.body.plan || "MONTHLY").toUpperCase(),
        packageId: selectedPackage?.id || packageId,
        status: "ACTIVE",
        expiredAt: addDays(days),
        mustChangePassword: true,
        eaApiKey: newKey(),
        eaEnabled: true,
        mt5Account,
        broker: String(req.body.broker || "").trim(),
        memberName: String(req.body.name || "").trim(),
        createdAt: new Date().toISOString()
      };
      data.users.push(user);
      saveDb(data);
      res.json({ success: true, tempPassword, user: safe(user) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/admin/v10/members/:id/extend", auth, adminOnly, (req, res) => {
    const data = db();
    const user = data.users.find(x => x.id === req.params.id);
    if (!user) return res.status(404).json({ error: "Member tidak ditemukan" });

    const days = Math.max(1, Number(req.body.days || 30));
    const base = user.expiredAt && new Date(user.expiredAt).getTime() > Date.now()
      ? new Date(user.expiredAt)
      : new Date();
    base.setUTCDate(base.getUTCDate() + days);
    user.expiredAt = base.toISOString();
    user.status = "ACTIVE";
    saveDb(data);
    res.json({ success: true, user: safe(user) });
  });

  app.get("/api/worker/config", auth, adminOnly, (req, res) => {
    const store = readJson(pairsFile, defaultPairs);
    const enabledPairs = store.pairs.filter(x => x.enabled);
    const timeframes = [...new Set(enabledPairs.flatMap(x => x.timeframes || []))]
      .filter(x => x === "5" || x === "15");

    res.json({
      pairs: enabledPairs.map(x => x.symbol),
      timeframes: timeframes.length ? timeframes : ["5", "15"],
      pairSettings: enabledPairs,
      updatedAt: new Date().toISOString()
    });
  });

  app.get("/api/admin/v10/summary", auth, adminOnly, (req, res) => {
    const users = db().users.filter(x => x.role !== "admin");
    const pairs = readJson(pairsFile, defaultPairs).pairs;
    const packages = readJson(packagesFile, defaultPackages).packages;
    res.json({
      members: users.length,
      activeMembers: users.filter(x => x.status === "ACTIVE" && (!x.expiredAt || new Date(x.expiredAt) > new Date())).length,
      activePairs: pairs.filter(x => x.enabled).length,
      packages: packages.filter(x => x.enabled).length
    });
  });
}

module.exports = { registerV10Admin };
