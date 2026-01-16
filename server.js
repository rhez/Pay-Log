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

const parseMembersFromCsv = (buffer) => {
  const text = buffer.toString("utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(",").map((value) => value.trim()))
    .filter((parts) => parts.length >= 3)
    .map(([id, firstName, lastName]) => ({
      id,
      firstName,
      lastName,
    }));
};

const parseMembersFromXlsx = (buffer) => {
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false });

  return rows
    .map((row) => row.map((value) => String(value ?? "").trim()))
    .filter((row) => row.filter(Boolean).length)
    .map(([id, firstName, lastName]) => ({
      id,
      firstName,
      lastName,
    }))
    .filter((member) => member.id && member.firstName && member.lastName);
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

app.post("/api/members/import", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded." });
    return;
  }

  const filename = req.file.originalname.toLowerCase();
  let members = [];

  if (filename.endsWith(".csv")) {
    members = parseMembersFromCsv(req.file.buffer);
  } else if (filename.endsWith(".xlsx")) {
    members = parseMembersFromXlsx(req.file.buffer);
  } else {
    res.status(400).json({ error: "Unsupported file type." });
    return;
  }

  const validMembers = members
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
