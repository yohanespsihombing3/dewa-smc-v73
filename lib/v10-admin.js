const { createClient } = require("@supabase/supabase-js");

/**
 * DEWA SMC AI V10.1
 * Supabase-backed Membership, Packages, and Pair Management.
 *
 * Drop-in replacement for: lib/v10-admin.js
 *
 * Compatible with the current server.js call:
 * registerV10Admin({ app, auth, ... })
 */
function registerV10Admin({ app, auth, uuid }) {
  const supabaseUrl = String(process.env.SUPABASE_URL || "").trim();
  const supabaseKey = String(
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    ""
  ).trim();

  const supabase =
    supabaseUrl && supabaseKey
      ? createClient(supabaseUrl, supabaseKey, {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false
          }
        })
      : null;

  function requireSupabase(req, res, next) {
    if (!supabase) {
      return res.status(503).json({
        error:
          "Supabase V10.1 belum dikonfigurasi. Isi SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY atau SUPABASE_SECRET_KEY di Render."
      });
    }
    next();
  }

  function adminOnly(req, res, next) {
    if (!req.user || req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin only" });
    }
    next();
  }

  function asyncRoute(handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        console.error("[V10.1]", error);
        if (!res.headersSent) {
          res.status(500).json({
            error: error?.message || "Internal server error"
          });
        }
      }
    };
  }

  function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
  }

  function normalizeMt5(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function normalizePair(value) {
    const raw = String(value || "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "");

    if (!raw) return "";
    if (raw.includes("/")) return raw;
    if (raw.length === 6) return `${raw.slice(0, 3)}/${raw.slice(3)}`;
    return raw;
  }

  function normalizeTimeframes(value) {
    const source = Array.isArray(value) ? value : [5, 15];
    const result = [...new Set(
      source
        .map(Number)
        .filter((tf) => tf === 5 || tf === 15)
    )];
    return result.length ? result : [5];
  }

  function normalizePriority(value) {
    const priority = String(value || "NORMAL").trim().toUpperCase();
    return ["HIGH", "NORMAL", "LOW"].includes(priority)
      ? priority
      : "NORMAL";
  }

  function packageToClient(row) {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      days: row.duration_days,
      durationDays: row.duration_days,
      maxAccounts: row.max_mt5_accounts,
      maxMt5Accounts: row.max_mt5_accounts,
      maxPairs: row.max_pairs,
      price: Number(row.price || 0),
      currency: row.currency,
      features: row.features || {},
      enabled: row.enabled,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      remainingDays: Math.max(
        0,
        Math.ceil(
          (new Date(row.expires_at).getTime() - Date.now()) / 86400000
        )
      )
    };
  }

  function pairToClient(row) {
    return {
      id: row.id,
      symbol: row.symbol,
      displayName: row.display_name,
      dataSymbol: row.data_symbol,
      brokerSymbols: row.broker_symbols || {},
      timeframes: (row.timeframes || []).map(String),
      enabled: row.enabled,
      priority: row.priority,
      structurePeriod: row.structure_period,
      prepareDistancePct: Number(row.prepare_distance_pct),
      volatilityEnabled: row.volatility_enabled,
      minRrr: Number(row.min_rrr),
      scanOrder: row.scan_order,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function memberToClient(row) {
    return {
      id: row.id,
      name: row.member_name,
      memberName: row.member_name,
      email: row.email,
      mt5Account: row.mt5_account,
      broker: row.broker,
      packageId: row.package_id,
      packageCode: row.ea_packages?.code || null,
      packageName: row.ea_packages?.name || null,
      status: row.status,
      startsAt: row.starts_at,
      expiredAt: row.expires_at,
      expiresAt: row.expires_at,
      licenseKey: row.license_key,
      eaEnabled: row.ea_enabled,
      allowedPairs: row.allowed_pairs || [],
      notes: row.notes,
      lastSeenAt: row.last_seen_at,
      lastEaVersion: row.last_ea_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  // ----------------------------------------------------------
  // Packages
  // ----------------------------------------------------------
  app.get(
    "/api/admin/v10/packages",
    auth,
    adminOnly,
    requireSupabase,
    asyncRoute(async (req, res) => {
      const { data, error } = await supabase
        .from("ea_packages")
        .select("*")
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true });

      if (error) throw error;
      res.json({ packages: (data || []).map(packageToClient) });
    })
  );

  app.post(
    "/api/admin/v10/packages",
    auth,
    adminOnly,
    requireSupabase,
    asyncRoute(async (req, res) => {
      const name = String(req.body.name || "").trim();
      const code = String(req.body.code || name)
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_-]+/g, "_")
        .replace(/^_+|_+$/g, "");

      const durationDays = Math.max(
        1,
        Number(req.body.days || req.body.durationDays || 30)
      );
      const maxAccounts = Math.max(
        1,
        Number(req.body.maxAccounts || req.body.maxMt5Accounts || 1)
      );

      if (!name || !code) {
        return res.status(400).json({ error: "Nama paket wajib diisi" });
      }

      const payload = {
        code,
        name,
        duration_days: durationDays,
        max_mt5_accounts: maxAccounts,
        max_pairs:
          req.body.maxPairs === undefined || req.body.maxPairs === null
            ? null
            : Math.max(1, Number(req.body.maxPairs)),
        price: Math.max(0, Number(req.body.price || 0)),
        currency: String(req.body.currency || "IDR").trim().toUpperCase(),
        features:
          req.body.features &&
          typeof req.body.features === "object" &&
          !Array.isArray(req.body.features)
            ? req.body.features
            : {},
        enabled: req.body.enabled !== false,
        sort_order: Number(req.body.sortOrder || 0)
      };

      const { data, error } = await supabase
        .from("ea_packages")
        .insert(payload)
        .select("*")
        .single();

      if (error) {
        if (error.code === "23505") {
          return res.status(409).json({ error: "Kode paket sudah ada" });
        }
        throw error;
      }

      res.status(201).json({
        success: true,
        package: packageToClient(data)
      });
    })
  );

  app.put(
    "/api/admin/v10/packages/:id",
    auth,
    adminOnly,
    requireSupabase,
    asyncRoute(async (req, res) => {
      const update = {};

      if (req.body.name !== undefined) {
        update.name = String(req.body.name).trim();
      }
      if (req.body.code !== undefined) {
        update.code = String(req.body.code)
          .trim()
          .toUpperCase()
          .replace(/[^A-Z0-9_-]+/g, "_");
      }
      if (req.body.days !== undefined || req.body.durationDays !== undefined) {
        update.duration_days = Math.max(
          1,
          Number(req.body.days || req.body.durationDays)
        );
      }
      if (
        req.body.maxAccounts !== undefined ||
        req.body.maxMt5Accounts !== undefined
      ) {
        update.max_mt5_accounts = Math.max(
          1,
          Number(req.body.maxAccounts || req.body.maxMt5Accounts)
        );
      }
      if (req.body.maxPairs !== undefined) {
        update.max_pairs =
          req.body.maxPairs === null
            ? null
            : Math.max(1, Number(req.body.maxPairs));
      }
      if (req.body.price !== undefined) {
        update.price = Math.max(0, Number(req.body.price));
      }
      if (req.body.currency !== undefined) {
        update.currency = String(req.body.currency).trim().toUpperCase();
      }
      if (req.body.features !== undefined) {
        update.features =
          req.body.features &&
          typeof req.body.features === "object" &&
          !Array.isArray(req.body.features)
            ? req.body.features
            : {};
      }
      if (req.body.enabled !== undefined) {
        update.enabled = Boolean(req.body.enabled);
      }
      if (req.body.sortOrder !== undefined) {
        update.sort_order = Number(req.body.sortOrder);
      }

      const { data, error } = await supabase
        .from("ea_packages")
        .update(update)
        .eq("id", req.params.id)
        .select("*")
        .maybeSingle();

      if (error) throw error;
      if (!data) {
        return res.status(404).json({ error: "Paket tidak ditemukan" });
      }

      res.json({ success: true, package: packageToClient(data) });
    })
  );

  app.delete(
    "/api/admin/v10/packages/:id",
    auth,
    adminOnly,
    requireSupabase,
    asyncRoute(async (req, res) => {
      const { error } = await supabase
        .from("ea_packages")
        .delete()
        .eq("id", req.params.id);

      if (error) throw error;
      res.json({ success: true });
    })
  );

  // ----------------------------------------------------------
  // Scanner pairs
  // ----------------------------------------------------------
  app.get(
    "/api/admin/v10/pairs",
    auth,
    adminOnly,
    requireSupabase,
    asyncRoute(async (req, res) => {
      const { data, error } = await supabase
        .from("scanner_pairs")
        .select("*")
        .order("scan_order", { ascending: true })
        .order("symbol", { ascending: true });

      if (error) throw error;
      res.json({ pairs: (data || []).map(pairToClient) });
    })
  );

  app.post(
    "/api/admin/v10/pairs",
    auth,
    adminOnly,
    requireSupabase,
    asyncRoute(async (req, res) => {
      const symbol = normalizePair(req.body.symbol);
      if (!symbol) {
        return res.status(400).json({ error: "Pair wajib diisi" });
      }

      const payload = {
        symbol,
        display_name: String(req.body.displayName || symbol).trim(),
        data_symbol: normalizePair(req.body.dataSymbol || symbol),
        broker_symbols:
          req.body.brokerSymbols &&
          typeof req.body.brokerSymbols === "object" &&
          !Array.isArray(req.body.brokerSymbols)
            ? req.body.brokerSymbols
            : {},
        timeframes: normalizeTimeframes(req.body.timeframes),
        enabled: req.body.enabled !== false,
        priority: normalizePriority(req.body.priority),
        structure_period: Math.min(
          200,
          Math.max(5, Number(req.body.structurePeriod || 20))
        ),
        prepare_distance_pct: Math.min(
          5,
          Math.max(0.00001, Number(req.body.prepareDistancePct || 0.25))
        ),
        volatility_enabled: req.body.volatilityEnabled !== false,
        min_rrr: Math.max(0.01, Number(req.body.minRrr || 1.5)),
        scan_order: Number(req.body.scanOrder || 0),
        notes: req.body.notes ? String(req.body.notes).trim() : null
      };

      const { data, error } = await supabase
        .from("scanner_pairs")
        .insert(payload)
        .select("*")
        .single();

      if (error) {
        if (error.code === "23505") {
          return res.status(409).json({ error: "Pair sudah ada" });
        }
        throw error;
      }

      res.status(201).json({
        success: true,
        pair: pairToClient(data)
      });
    })
  );

  app.put(
    "/api/admin/v10/pairs/:id",
    auth,
    adminOnly,
    requireSupabase,
    asyncRoute(async (req, res) => {
      const update = {};

      if (req.body.symbol !== undefined) {
        update.symbol = normalizePair(req.body.symbol);
      }
      if (req.body.displayName !== undefined) {
        update.display_name = String(req.body.displayName).trim();
      }
      if (req.body.dataSymbol !== undefined) {
        update.data_symbol = normalizePair(req.body.dataSymbol);
      }
      if (req.body.brokerSymbols !== undefined) {
        update.broker_symbols =
          req.body.brokerSymbols &&
          typeof req.body.brokerSymbols === "object" &&
          !Array.isArray(req.body.brokerSymbols)
            ? req.body.brokerSymbols
            : {};
      }
      if (req.body.timeframes !== undefined) {
        update.timeframes = normalizeTimeframes(req.body.timeframes);
      }
      if (req.body.enabled !== undefined) {
        update.enabled = Boolean(req.body.enabled);
      }
      if (req.body.priority !== undefined) {
        update.priority = normalizePriority(req.body.priority);
      }
      if (req.body.structurePeriod !== undefined) {
        update.structure_period = Math.min(
          200,
          Math.max(5, Number(req.body.structurePeriod))
        );
      }
      if (req.body.prepareDistancePct !== undefined) {
        update.prepare_distance_pct = Math.min(
          5,
          Math.max(0.00001, Number(req.body.prepareDistancePct))
        );
      }
      if (req.body.volatilityEnabled !== undefined) {
        update.volatility_enabled = Boolean(req.body.volatilityEnabled);
      }
      if (req.body.minRrr !== undefined) {
        update.min_rrr = Math.max(0.01, Number(req.body.minRrr));
      }
      if (req.body.scanOrder !== undefined) {
        update.scan_order = Number(req.body.scanOrder);
      }
      if (req.body.notes !== undefined) {
        update.notes = req.body.notes
          ? String(req.body.notes).trim()
          : null;
      }

      const { data, error } = await supabase
        .from("scanner_pairs")
        .update(update)
        .eq("id", req.params.id)
        .select("*")
        .maybeSingle();

      if (error) throw error;
      if (!data) {
        return res.status(404).json({ error: "Pair tidak ditemukan" });
      }

      res.json({ success: true, pair: pairToClient(data) });
    })
  );

  app.delete(
    "/api/admin/v10/pairs/:id",
    auth,
    adminOnly,
    requireSupabase,
    asyncRoute(async (req, res) => {
      const { error } = await supabase
        .from("scanner_pairs")
        .delete()
        .eq("id", req.params.id);

      if (error) throw error;
      res.json({ success: true });
    })
  );

  // ----------------------------------------------------------
  // Members
  // ----------------------------------------------------------
  app.get(
    "/api/admin/v10/members",
    auth,
    adminOnly,
    requireSupabase,
    asyncRoute(async (req, res) => {
      const { data, error } = await supabase
        .from("ea_members")
        .select(`
          *,
          ea_packages (
            code,
            name
          )
        `)
        .order("created_at", { ascending: false });

      if (error) throw error;
      res.json({ members: (data || []).map(memberToClient) });
    })
  );

  app.post(
    "/api/admin/v10/members",
    auth,
    adminOnly,
    requireSupabase,
    asyncRoute(async (req, res) => {
      const email = normalizeEmail(req.body.email);
      const mt5Account = normalizeMt5(req.body.mt5Account);

      if (!email.includes("@")) {
        return res.status(400).json({ error: "Gmail member tidak valid" });
      }
      if (!/^[0-9]{5,20}$/.test(mt5Account)) {
        return res.status(400).json({ error: "Nomor akun MT5 tidak valid" });
      }

      const days = Math.max(1, Number(req.body.days || 30));
      const startsAt = new Date();
      const expiresAt = new Date(startsAt);
      expiresAt.setUTCDate(expiresAt.getUTCDate() + days);

      const payload = {
        member_name: String(req.body.name || req.body.memberName || "").trim() || null,
        email,
        mt5_account: mt5Account,
        broker: String(req.body.broker || "").trim() || null,
        package_id: null,
        status: "ACTIVE",
        starts_at: startsAt.toISOString(),
        expires_at: expiresAt.toISOString(),
        ea_enabled: req.body.eaEnabled !== false,
        max_mt5_accounts: Math.max(
          1,
          Number(
            req.body.maxMt5Accounts || 1
          )
        ),
        allowed_pairs: Array.isArray(req.body.allowedPairs)
          ? req.body.allowedPairs.map(normalizePair).filter(Boolean)
          : [],
        notes: req.body.notes ? String(req.body.notes).trim() : null,
        created_by: req.user?.email || req.user?.id || "admin"
      };

      const { data, error } = await supabase
        .from("ea_members")
        .insert(payload)
        .select("*")
        .single();

      if (error) {
        if (error.code === "23505") {
          return res.status(409).json({
            error: "Gmail, akun MT5, atau license key sudah terdaftar"
          });
        }
        throw error;
      }

      res.status(201).json({
        success: true,
        user: memberToClient(data),
        member: memberToClient(data)
      });
    })
  );

  app.put(
    "/api/admin/v10/members/:id",
    auth,
    adminOnly,
    requireSupabase,
    asyncRoute(async (req, res) => {
      const update = {};

      if (req.body.name !== undefined || req.body.memberName !== undefined) {
        update.member_name = String(
          req.body.name || req.body.memberName || ""
        ).trim() || null;
      }
      if (req.body.email !== undefined) {
        const email = normalizeEmail(req.body.email);
        if (!email.includes("@")) {
          return res.status(400).json({ error: "Gmail member tidak valid" });
        }
        update.email = email;
      }
      if (req.body.mt5Account !== undefined) {
        const mt5Account = normalizeMt5(req.body.mt5Account);
        if (!/^[0-9]{5,20}$/.test(mt5Account)) {
          return res.status(400).json({ error: "Nomor akun MT5 tidak valid" });
        }
        update.mt5_account = mt5Account;
      }
      if (req.body.broker !== undefined) {
        update.broker = String(req.body.broker || "").trim() || null;
      }
      if (req.body.packageId !== undefined) {
        update.package_id = req.body.packageId || null;
      }
      if (req.body.status !== undefined) {
        const status = String(req.body.status).trim().toUpperCase();
        if (!["ACTIVE", "SUSPENDED", "EXPIRED", "REVOKED", "PENDING"].includes(status)) {
          return res.status(400).json({ error: "Status member tidak valid" });
        }
        update.status = status;
      }
      if (req.body.eaEnabled !== undefined) {
        update.ea_enabled = Boolean(req.body.eaEnabled);
      }
      if (req.body.allowedPairs !== undefined) {
        update.allowed_pairs = Array.isArray(req.body.allowedPairs)
          ? req.body.allowedPairs.map(normalizePair).filter(Boolean)
          : [];
      }
      if (req.body.notes !== undefined) {
        update.notes = req.body.notes
          ? String(req.body.notes).trim()
          : null;
      }

      const { data, error } = await supabase
        .from("ea_members")
        .update(update)
        .eq("id", req.params.id)
        .select("*")
        .maybeSingle();

      if (error) throw error;
      if (!data) {
        return res.status(404).json({ error: "Member tidak ditemukan" });
      }

      res.json({ success: true, member: memberToClient(data) });
    })
  );

  app.post(
    "/api/admin/v10/members/:id/set-days",
    auth,
    adminOnly,
    requireSupabase,
    asyncRoute(async (req, res) => {
      const days = Math.max(1, Number(req.body.days || 30));
      const startsAt = new Date();
      const expiresAt = new Date(startsAt);
      expiresAt.setUTCDate(expiresAt.getUTCDate() + days);

      const { data, error } = await supabase
        .from("ea_members")
        .update({
          starts_at: startsAt.toISOString(),
          expires_at: expiresAt.toISOString(),
          status: "ACTIVE",
          ea_enabled: true
        })
        .eq("id", req.params.id)
        .select("*")
        .maybeSingle();

      if (error) throw error;
      if (!data) {
        return res.status(404).json({ error: "Member tidak ditemukan" });
      }

      res.json({ success: true, member: memberToClient(data) });
    })
  );

  app.post(
    "/api/admin/v10/members/:id/extend",
    auth,
    adminOnly,
    requireSupabase,
    asyncRoute(async (req, res) => {
      const days = Math.max(1, Number(req.body.days || 30));

      const { data: current, error: readError } = await supabase
        .from("ea_members")
        .select("*")
        .eq("id", req.params.id)
        .maybeSingle();

      if (readError) throw readError;
      if (!current) {
        return res.status(404).json({ error: "Member tidak ditemukan" });
      }

      const currentExpiry = new Date(current.expires_at);
      const base =
        Number.isFinite(currentExpiry.getTime()) && currentExpiry > new Date()
          ? currentExpiry
          : new Date();

      base.setUTCDate(base.getUTCDate() + days);

      const { data, error } = await supabase
        .from("ea_members")
        .update({
          expires_at: base.toISOString(),
          status: "ACTIVE",
          ea_enabled: true
        })
        .eq("id", req.params.id)
        .select("*")
        .single();

      if (error) throw error;
      res.json({ success: true, member: memberToClient(data) });
    })
  );

  app.delete(
    "/api/admin/v10/members/:id",
    auth,
    adminOnly,
    requireSupabase,
    asyncRoute(async (req, res) => {
      const { error } = await supabase
        .from("ea_members")
        .delete()
        .eq("id", req.params.id);

      if (error) throw error;
      res.json({ success: true });
    })
  );

  // ----------------------------------------------------------
  // Worker configuration
  // ----------------------------------------------------------
  app.get(
    "/api/worker/config",
    auth,
    adminOnly,
    requireSupabase,
    asyncRoute(async (req, res) => {
      const { data, error } = await supabase
        .from("v_scanner_worker_config")
        .select("*");

      if (error) throw error;

      const pairSettings = (data || []).map(pairToClient);
      const timeframes = [
        ...new Set(
          pairSettings.flatMap((pair) =>
            (pair.timeframes || []).map(String)
          )
        )
      ].filter((tf) => tf === "5" || tf === "15");

      res.json({
        pairs: pairSettings.map((pair) => pair.dataSymbol || pair.symbol),
        timeframes: timeframes.length ? timeframes : ["5", "15"],
        pairSettings,
        updatedAt: new Date().toISOString()
      });
    })
  );

  // ----------------------------------------------------------
  // Dashboard summary
  // ----------------------------------------------------------
  app.get(
    "/api/admin/v10/summary",
    auth,
    adminOnly,
    requireSupabase,
    asyncRoute(async (req, res) => {
      const now = new Date().toISOString();

      const [
        membersResult,
        activeMembersResult,
        pairsResult,
        packagesResult,
        onlineSessionsResult
      ] = await Promise.all([
        supabase
          .from("ea_members")
          .select("id", { count: "exact", head: true }),
        supabase
          .from("ea_members")
          .select("id", { count: "exact", head: true })
          .eq("status", "ACTIVE")
          .eq("ea_enabled", true)
          .gt("expires_at", now),
        supabase
          .from("scanner_pairs")
          .select("id", { count: "exact", head: true })
          .eq("enabled", true),
        supabase
          .from("ea_packages")
          .select("id", { count: "exact", head: true })
          .eq("enabled", true),
        supabase
          .from("ea_sessions")
          .select("id", { count: "exact", head: true })
          .eq("status", "ONLINE")
      ]);

      const firstError = [
        membersResult.error,
        activeMembersResult.error,
        pairsResult.error,
        packagesResult.error,
        onlineSessionsResult.error
      ].find(Boolean);

      if (firstError) throw firstError;

      res.json({
        members: membersResult.count || 0,
        activeMembers: activeMembersResult.count || 0,
        activePairs: pairsResult.count || 0,
        packages: packagesResult.count || 0,
        onlineSessions: onlineSessionsResult.count || 0,
        storage: "SUPABASE",
        version: "10.1"
      });
    })
  );

  console.log(
    `DEWA SMC V10.3 Simple Membership: ${supabase ? "ON" : "OFF"}`
  );
}

module.exports = { registerV10Admin };
