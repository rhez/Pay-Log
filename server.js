import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import multer from "multer";
import xlsx from "xlsx";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.static(__dirname));

const formatMemberName = (id, firstName, lastName, padLength) => {
  const paddedId = String(id).padStart(padLength, "0");
  return `${paddedId} – ${firstName} ${lastName}`;
};

const normalizeHeader = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

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

app.get("/api/members", async (req, res) => {
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

app.get("/api/members/:id", async (req, res) => {
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

app.post("/api/members/:id/transactions", express.json(), async (req, res) => {
  const memberId = Number(req.params.id);
  if (!Number.isInteger(memberId)) {
    res.status(400).json({ error: "Invalid member id." });
    return;
  }

  const { date, description, amount, type } = req.body ?? {};
  const numericAmount = Number(amount);
  const normalizedType = type === "credit" ? "credit" : "charge";

  if (!date || Number.isNaN(numericAmount)) {
    res.status(400).json({ error: "Invalid transaction payload." });
    return;
  }

  const signedAmount =
    normalizedType === "credit" ? Math.abs(numericAmount) : -Math.abs(numericAmount);

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const memberResult = await client.query(
        'SELECT balance FROM "Members" WHERE id = $1',
        [memberId]
      );

      if (memberResult.rowCount === 0) {
        res.status(404).json({ error: "Member not found." });
        return;
      }

      await client.query(
        'INSERT INTO "Transactions" (member_id, date, description, amount) VALUES ($1, $2, $3, $4)',
        [memberId, date, description || "", signedAmount]
      );

      const balanceResult = await client.query(
        'UPDATE "Members" SET balance = balance + $1 WHERE id = $2 RETURNING balance',
        [signedAmount, memberId]
      );

      await client.query("COMMIT");

      res.json({ balance: balanceResult.rows[0].balance });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({ error: "Failed to apply transaction." });
  }
});

app.delete("/api/members/:id/transactions/last", async (req, res) => {
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

      await client.query('DELETE FROM "Transactions" WHERE id = $1', [transactionId]);

      const balanceResult = await client.query(
        'UPDATE "Members" SET balance = balance - $1 WHERE id = $2 RETURNING balance',
        [amount, memberId]
      );

      await client.query("COMMIT");

      res.json({ balance: balanceResult.rows[0].balance, transactionId });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({ error: "Failed to undo transaction." });
  }
});

app.post(
  "/api/members/import/preview",
  upload.single("file"),
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

app.post("/api/members/import", upload.single("file"), async (req, res) => {
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
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`NVS Pay Log server running on port ${port}`);
});
