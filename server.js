require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const mysql = require("mysql2/promise");

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

// ---------- Helpers ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Sends errors from async routes to the error handler at the bottom.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const TAX_MODES = ["proportional", "equal"];
const toPaise = (rupees) => Math.round(rupees * 100);
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const newToken = (bytes) => crypto.randomBytes(bytes).toString("base64url");

function cleanName(value, max) {
  if (typeof value !== "string") throw new HttpError(400, "Name must be text");
  const name = value.trim();
  if (!name || name.length > max) throw new HttpError(400, `Name must be 1-${max} characters`);
  return name;
}

function cleanMoney(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1000000) {
    throw new HttpError(400, `${label} must be a number between 0 and 1000000`);
  }
  return toPaise(value);
}

async function findBill(code) {
  const [rows] = await pool.execute("SELECT * FROM bills WHERE code = ?", [code]);
  if (!rows.length) throw new HttpError(404, "Bill not found");
  return rows[0];
}

// ---------- Create a bill ----------
app.post("/api/bills", wrap(async (req, res) => {
  const { items, tax = 0, taxMode = "proportional" } = req.body ?? {};

  if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
    throw new HttpError(400, "Send between 1 and 100 items");
  }
  if (!TAX_MODES.includes(taxMode)) throw new HttpError(400, "Invalid tax mode");

  const rows = items.map((it) => {
    if (!it || typeof it !== "object") throw new HttpError(400, "Invalid item");
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > 100) {
      throw new HttpError(400, "Quantity must be a whole number from 1 to 100");
    }
    return [cleanName(it.name, 100), cleanMoney(it.price, "Price"), it.qty];
  });
  const taxPaise = cleanMoney(tax, "Tax");

  const code = newToken(9);      // goes in the share link
  const hostKey = newToken(16);  // secret; only the host keeps it

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute(
      "INSERT INTO bills (code, host_key_hash, tax_paise, tax_mode) VALUES (?, ?, ?, ?)",
      [code, sha256(hostKey), taxPaise, taxMode]
    );
    await conn.query(
      "INSERT INTO items (bill_id, name, price_paise, qty) VALUES ?",
      [rows.map((r) => [result.insertId, ...r])]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  res.status(201).json({ code, hostKey });
}));

// ---------- Load a bill (same shape the frontend's `state` uses) ----------
app.get("/api/bills/:code", wrap(async (req, res) => {
  const bill = await findBill(req.params.code);

  const [items] = await pool.execute(
    "SELECT id, name, price_paise, qty FROM items WHERE bill_id = ? ORDER BY id", [bill.id]);
  const [people] = await pool.execute(
    "SELECT id, name FROM people WHERE bill_id = ? ORDER BY id", [bill.id]);
  const [picked] = await pool.execute(
    `SELECT s.item_id, s.person_id FROM selections s
     JOIN items i ON i.id = s.item_id WHERE i.bill_id = ?`, [bill.id]);

  const selections = {};
  items.forEach((it) => (selections[it.id] = []));
  picked.forEach((s) => selections[s.item_id].push(s.person_id));

  res.set("Cache-Control", "no-store"); // the page polls this, so never cache it
  res.json({
    code: bill.code,
    tax: bill.tax_paise / 100,
    taxMode: bill.tax_mode,
    items: items.map((it) => ({ id: it.id, name: it.name, price: it.price_paise / 100, qty: it.qty })),
    people,
    selections,
  });
}));

// ---------- Join a bill ----------
app.post("/api/bills/:code/people", wrap(async (req, res) => {
  const bill = await findBill(req.params.code);
  const name = cleanName(req.body?.name, 40);

  const [[{ count }]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM people WHERE bill_id = ?", [bill.id]);
  if (count >= 50) throw new HttpError(400, "This bill is full");

  const [result] = await pool.execute(
    "INSERT INTO people (bill_id, name) VALUES (?, ?)", [bill.id, name]);
  res.status(201).json({ id: result.insertId, name });
}));

// ---------- Tick / untick an item for a person ----------
app.post("/api/bills/:code/selections", wrap(async (req, res) => {
  const bill = await findBill(req.params.code);
  const { itemId, personId, selected } = req.body ?? {};

  if (!Number.isInteger(itemId) || !Number.isInteger(personId) || typeof selected !== "boolean") {
    throw new HttpError(400, "Send itemId, personId (numbers) and selected (true/false)");
  }

  // Both must belong to THIS bill, so nobody can touch another bill's data.
  const [ok] = await pool.execute(
    `SELECT 1 FROM items i JOIN people p ON p.bill_id = i.bill_id
     WHERE i.id = ? AND p.id = ? AND i.bill_id = ?`, [itemId, personId, bill.id]);
  if (!ok.length) throw new HttpError(404, "Item or person not found on this bill");

  if (selected) {
    await pool.execute("INSERT IGNORE INTO selections (item_id, person_id) VALUES (?, ?)", [itemId, personId]);
  } else {
    await pool.execute("DELETE FROM selections WHERE item_id = ? AND person_id = ?", [itemId, personId]);
  }
  res.json({ ok: true });
}));

// ---------- Host changes tax settings (needs the host key) ----------
app.patch("/api/bills/:code", wrap(async (req, res) => {
  const bill = await findBill(req.params.code);

  const given = Buffer.from(sha256(String(req.get("x-host-key") || "")), "hex");
  const stored = Buffer.from(bill.host_key_hash, "hex");
  if (!crypto.timingSafeEqual(given, stored)) throw new HttpError(403, "Only the host can change this bill");

  const { tax, taxMode } = req.body ?? {};
  const taxPaise = tax === undefined ? bill.tax_paise : cleanMoney(tax, "Tax");
  const mode = taxMode === undefined ? bill.tax_mode : taxMode;
  if (!TAX_MODES.includes(mode)) throw new HttpError(400, "Invalid tax mode");

  await pool.execute("UPDATE bills SET tax_paise = ?, tax_mode = ? WHERE id = ?", [taxPaise, mode, bill.id]);
  res.json({ tax: taxPaise / 100, taxMode: mode });
}));

// ---------- Pages ----------
// The share link serves the same HTML file; its JavaScript reads the code from the URL.
app.get("/bill/:code", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "bill.html"));
});

// ---------- Errors ----------
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: status >= 500 ? "Something went wrong" : err.message,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
