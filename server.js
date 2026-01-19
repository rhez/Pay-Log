import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import pg from "pg";
import multer from "multer";
import xlsx from "xlsx";
import { WebSocketServer } from "ws";
import crypto from "crypto";
import bcrypt from "bcryptjs";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || "postgres://localhost/nvs_pay_log",
});
const upload = multer({ storage: multer.memoryStorage() });
const sessions = new Map();
const sessionMaxAgeMs = 8 * 60 * 60 * 1000;
const cookieSecurityFlags = "HttpOnly; SameSite=Strict";
const bcryptSaltRounds = 12;
const looksHashed = (value) => value.startsWith("$2a$") || value.startsWith("$2b$");
const hashPassword = (password) => bcrypt.hash(password, bcryptSaltRounds);
const verifyPassword = (password, savedPassword) => {
  if (!savedPassword) {
    return Promise.resolve(false);
  }
  if (looksHashed(savedPassword)) {
    return bcrypt.compare(password, savedPassword);
  }
  return Promise.resolve(password === savedPassword);
};

app.use(express.static(__dirname));

const parseCookies = (cookieHeader = "") =>
  cookieHeader.split(";").reduce((acc, part) => {
    const [key, ...valueParts] = part.trim().split("=");
    if (!key) {
      return acc;
    }
    acc[key] = decodeURIComponent(valueParts.join("="));
    return acc;
  }, {});

const createSessionToken = () => crypto.randomBytes(32).toString("hex");

const getSession = (req) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.admin_session;
  if (!token) {
    return null;
  }
  const session = sessions.get(token);
  if (!session) {
    return null;
  }
  if (Date.now() - session.createdAt > sessionMaxAgeMs) {
    sessions.delete(token);
    return null;
  }
  return { token, session };
};

const requireAuth = (req, res, next) => {
  const currentSession = getSession(req);
  if (!currentSession) {
    res.status(401).json({ success: false });
    return;
  }
  next();
};

const clearSession = (req, res) => {
  const currentSession = getSession(req);
  if (currentSession) {
    sessions.delete(currentSession.token);
  }
  res.setHeader(
    "Set-Cookie",
    `admin_session=; ${cookieSecurityFlags}; Max-Age=0; Path=/`
  );
};

const broadcast = (payload) => {
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
};

const formatMemberName = (id, firstName, lastName, padLength) => {
  const paddedId = String(id).padStart(padLength, "0");
  return `${paddedId} – ${firstName} ${lastName}`;
};

const normalizeHeader = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

const dollarsToCents = (value) => {
  const normalized = String(value ?? "")
    .replace(/[^0-9.-]/g, "")
    .trim();
  if (!normalized) {
    return null;
  }
  const negative = normalized.startsWith("-");
  const [wholePart, fractionalPart = ""] = normalized.replace("-", "").split(".");
  const cents = `${fractionalPart}00`.slice(0, 2);
  const combined = `${wholePart || "0"}${cents}`;
  const parsed = Number.parseInt(combined, 10);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return negative ? -parsed : parsed;
};

const centsToDollars = (cents) => {
  const value = Number(cents);
  if (Number.isNaN(value)) {
    return "0.00";
  }
  const negative = value < 0;
  const absolute = Math.abs(value);
  const dollars = Math.floor(absolute / 100);
  const remainder = String(absolute % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${dollars}.${remainder}`;
};

const parseMembersFromCsv = (buffer) => {
  const text = buffer.toString("utf8");
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(",").map((value) => value.trim()));

  if (rows.length < 2) {
    return [];
  }

  const headers = rows[0].map(normalizeHeader);
  const idIndex = headers.indexOf("id");
  const firstNameIndex = headers.indexOf("first_name");
  const lastNameIndex = headers.indexOf("last_name");

  if (idIndex === -1 || firstNameIndex === -1 || lastNameIndex === -1) {
    return [];
  }

  return rows.slice(1).map((row) => ({
    id: row[idIndex],
    firstName: row[firstNameIndex],
    lastName: row[lastNameIndex],
  }));
};

const parseMembersFromXlsx = (buffer) => {
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

  const normalized = rows.map((row) => {
    const mapped = Object.entries(row).reduce((acc, [key, value]) => {
      const normalizedKey = normalizeHeader(key);
      acc[normalizedKey] = value;
      return acc;
    }, {});

    return {
      id: mapped.id,
      firstName: mapped.first_name,
      lastName: mapped.last_name,
    };
  });

  return normalized.filter(
    (member) => member.id && member.firstName && member.lastName
  );
};

const normalizeMembers = (members) =>
  members
    .map((member) => ({
      id: Number(member.id),
      firstName: member.firstName,
      lastName: member.lastName,
    }))
    .filter(
      (member) =>
        Number.isInteger(member.id) &&
        member.firstName &&
        member.lastName
    );

const parseMembersFile = (file) => {
  const filename = file.originalname.toLowerCase();
  if (filename.endsWith(".csv")) {
    return parseMembersFromCsv(file.buffer);
  }
  if (filename.endsWith(".xlsx")) {
    return parseMembersFromXlsx(file.buffer);
  }
  return null;
};

app.get("/api/members", requireAuth, async (req, res) => {
  try {
    const maxResult = await pool.query('SELECT MAX(id) AS max_id FROM "Members"');
    const maxId = maxResult.rows[0]?.max_id ?? 0;
    const padLength = String(maxId).length || 1;

    const membersResult = await pool.query(
      'SELECT id, first_name, last_name, balance FROM "Members" ORDER BY id'
    );

    const members = membersResult.rows.map((row) => ({
      id: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      balance: row.balance,
      displayName: formatMemberName(
        row.id,
        row.first_name,
        row.last_name,
        padLength
      ),
    }));

    res.json({ padLength, members });
  } catch (error) {
    res.status(500).json({ error: "Failed to load members." });
  }
});

app.get("/api/members/:id", requireAuth, async (req, res) => {
  const memberId = Number(req.params.id);

  if (!Number.isInteger(memberId)) {
    res.status(400).json({ error: "Invalid member id." });
    return;
  }

  try {
    const memberResult = await pool.query(
      'SELECT id, first_name, last_name, balance FROM "Members" WHERE id = $1',
      [memberId]
    );

    if (memberResult.rowCount === 0) {
      res.status(404).json({ error: "Member not found." });
      return;
    }

    const transactionsResult = await pool.query(
      'SELECT id, member_id, date, description, amount FROM "Transactions" WHERE member_id = $1 ORDER BY id DESC',
      [memberId]
    );

    res.json({
      member: memberResult.rows[0],
      transactions: transactionsResult.rows,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to load member data." });
  }
});

app.get("/api/admin/session", (req, res) => {
  const currentSession = getSession(req);
  res.json({ authenticated: Boolean(currentSession) });
});

app.post("/api/admin/login", express.json(), async (req, res) => {
  const { password, confirmPassword } = req.body ?? {};
  if (typeof password !== "string") {
    res.status(400).json({ success: false });
    return;
  }

  try {
    const result = await pool.query('SELECT password FROM "Admin" LIMIT 1');
    const savedPassword = result.rows[0]?.password ?? "";

    if (!savedPassword) {
      if (!confirmPassword || confirmPassword !== password) {
        res.status(400).json({ success: false });
        return;
      }
      await pool.query('DELETE FROM "Admin"');
      const hashedPassword = await hashPassword(password);
      await pool.query('INSERT INTO "Admin" (password) VALUES ($1)', [
        hashedPassword,
      ]);
    } else {
      const passwordMatches = await verifyPassword(password, savedPassword);
      if (!passwordMatches) {
        res.status(401).json({ success: false });
        return;
      }
      if (!looksHashed(savedPassword)) {
        const hashedPassword = await hashPassword(password);
        await pool.query('DELETE FROM "Admin"');
        await pool.query('INSERT INTO "Admin" (password) VALUES ($1)', [
          hashedPassword,
        ]);
      }
    }

    const token = createSessionToken();
    sessions.set(token, { createdAt: Date.now() });
    res.setHeader(
      "Set-Cookie",
      `admin_session=${token}; ${cookieSecurityFlags}; Max-Age=${
        sessionMaxAgeMs / 1000
      }; Path=/`
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

app.post("/api/admin/logout", (req, res) => {
  clearSession(req, res);
  res.json({ success: true });
});

app.post(
  "/api/admin/password",
  express.json(),
  requireAuth,
  async (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body ?? {};
    if (
      typeof currentPassword !== "string" ||
      typeof newPassword !== "string" ||
      typeof confirmPassword !== "string"
    ) {
      res.status(400).json({ success: false });
      return;
    }

    if (newPassword !== confirmPassword) {
      res.status(400).json({ success: false });
      return;
    }

    try {
      const result = await pool.query('SELECT password FROM "Admin" LIMIT 1');
      const savedPassword = result.rows[0]?.password ?? "";

      const passwordMatches = await verifyPassword(
        currentPassword,
        savedPassword
      );
      if (!passwordMatches) {
        res.status(401).json({ success: false });
        return;
      }

      const hashedPassword = await hashPassword(newPassword);
      await pool.query('DELETE FROM "Admin"');
      await pool.query('INSERT INTO "Admin" (password) VALUES ($1)', [
        hashedPassword,
      ]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false });
    }
  }
);

app.post(
  "/api/members/:id/transactions",
  express.json(),
  requireAuth,
  async (req, res) => {
    const memberId = Number(req.params.id);
    if (!Number.isInteger(memberId)) {
      res.status(400).json({ error: "Invalid member id." });
      return;
    }

    const { date, description, amount, type } = req.body ?? {};
    const centsAmount = dollarsToCents(amount);
    const normalizedType = type === "credit" ? "credit" : "charge";

    if (!date || centsAmount === null) {
      res.status(400).json({ error: "Invalid transaction payload." });
      return;
    }

    const signedAmount =
      normalizedType === "credit"
        ? Math.abs(centsAmount)
        : -Math.abs(centsAmount);

    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const balanceResult = await client.query(
          'SELECT balance FROM "Members" WHERE id = $1',
          [memberId]
        );

        if (balanceResult.rowCount === 0) {
          res.status(404).json({ error: "Member not found." });
          return;
        }

        const currentCents = dollarsToCents(balanceResult.rows[0].balance);
        const nextCents = (currentCents ?? 0) + signedAmount;
        const nextBalance = centsToDollars(nextCents);

        await client.query(
          'INSERT INTO "Transactions" (member_id, date, description, amount) VALUES ($1, $2, $3, $4)',
          [memberId, date, description || "", centsToDollars(signedAmount)]
        );

        await client.query(
          'UPDATE "Members" SET balance = $1 WHERE id = $2',
          [nextBalance, memberId]
        );

        await client.query("COMMIT");

        broadcast({ type: "memberUpdated", memberId });

        res.json({ balance: nextBalance });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to apply transaction." });
    }
  }
);

app.delete(
  "/api/members/:id/transactions/last",
  requireAuth,
  async (req, res) => {
    const memberId = Number(req.params.id);
    if (!Number.isInteger(memberId)) {
      res.status(400).json({ error: "Invalid member id." });
      return;
    }

    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const transactionResult = await client.query(
          'SELECT id, amount FROM "Transactions" WHERE member_id = $1 ORDER BY id DESC LIMIT 1',
          [memberId]
        );

        if (transactionResult.rowCount === 0) {
          res.status(404).json({ error: "No transactions to undo." });
          return;
        }

        const { id: transactionId, amount } = transactionResult.rows[0];
        const amountCents = dollarsToCents(amount);
        if (amountCents === null) {
          res.status(400).json({ error: "Invalid transaction amount." });
          return;
        }

        await client.query('DELETE FROM "Transactions" WHERE id = $1', [
          transactionId,
        ]);

        const balanceResult = await client.query(
          'SELECT balance FROM "Members" WHERE id = $1',
          [memberId]
        );

        const currentCents = dollarsToCents(balanceResult.rows[0].balance);
        const nextCents = (currentCents ?? 0) - amountCents;
        const nextBalance = centsToDollars(nextCents);

        await client.query('UPDATE "Members" SET balance = $1 WHERE id = $2', [
          nextBalance,
          memberId,
        ]);

        await client.query("COMMIT");

        broadcast({ type: "memberUpdated", memberId });

        res.json({ balance: nextBalance, transactionId });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to undo transaction." });
    }
  }
);

app.post(
  "/api/members/import/preview",
  upload.single("file"),
  requireAuth,
  async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded." });
      return;
    }

    const parsedMembers = parseMembersFile(req.file);
    if (!parsedMembers) {
      res.status(400).json({ error: "Unsupported file type." });
      return;
    }

    const validMembers = normalizeMembers(parsedMembers);
    if (!validMembers.length) {
      res.status(400).json({ error: "No valid members found in file." });
      return;
    }

    try {
      const idParams = validMembers.map((member) => member.id);
      const deletePlaceholders = idParams
        .map((_, index) => `$${index + 1}`)
        .join(", ");
      const deleteResult = await pool.query(
        `SELECT COUNT(*)::int AS count FROM "Members" WHERE id NOT IN (${deletePlaceholders})`,
        idParams
      );
      res.json({ toDelete: deleteResult.rows[0].count });
    } catch (error) {
      res.status(500).json({ error: "Failed to preview import." });
    }
  }
);

app.post(
  "/api/members/import",
  upload.single("file"),
  requireAuth,
  async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded." });
      return;
    }

    const parsedMembers = parseMembersFile(req.file);
    if (!parsedMembers) {
      res.status(400).json({ error: "Unsupported file type." });
      return;
    }

    const validMembers = normalizeMembers(parsedMembers);

    if (!validMembers.length) {
      res.status(400).json({ error: "No valid members found in file." });
      return;
    }

    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const values = validMembers
          .map(
            (member, index) =>
              `($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3})`
          )
          .join(", ");
        const params = validMembers.flatMap((member) => [
          member.id,
          member.firstName,
          member.lastName,
        ]);

        const insertResult = await client.query(
          `INSERT INTO "Members" (id, first_name, last_name)
           VALUES ${values}
           ON CONFLICT (id) DO NOTHING`,
          params
        );

        const idParams = validMembers.map((member) => member.id);
        const deletePlaceholders = idParams
          .map((_, index) => `$${index + 1}`)
          .join(", ");
        const deleteResult = await client.query(
          `DELETE FROM "Members" WHERE id NOT IN (${deletePlaceholders})`,
          idParams
        );
        const removed = deleteResult.rowCount;

        await client.query("COMMIT");

        broadcast({ type: "membersUpdated" });

        res.json({
          imported: insertResult.rowCount,
          skipped: validMembers.length - insertResult.rowCount,
          removed,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to import members." });
    }
  }
);

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`NVS Pay Log server running on port ${port}`);
});
