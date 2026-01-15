import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

app.use(express.static(__dirname));

const formatMemberName = (id, firstName, lastName, padLength) => {
  const paddedId = String(id).padStart(padLength, "0");
  return `${paddedId} – ${firstName} ${lastName}`;
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
      'SELECT id, member_id, date, description, amount FROM "Transactions" WHERE member_id = $1 ORDER BY date DESC, id DESC',
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

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`NVS Pay Log server running on port ${port}`);
});
