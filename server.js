const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const { GoogleGenAI } = require("@google/genai");
require("dotenv").config();

const db = require("./db");
const gemini = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
});

const app = express();
const PORT = process.env.PORT || 3000;
const adminLoginAttempts = new Map();
const ADMIN_LOCK_MS = 30 * 1000;
const ADMIN_MAX_ATTEMPTS = 3;

// Middleware
app.use(cors());
app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true, limit: "12mb" }));

// Serve frontend files from public folder
app.use(express.static(path.join(__dirname, "public")));

async function addColumnIfMissing(table, columnDefinition) {
  try {
    await db.query(`ALTER TABLE ${table} ADD COLUMN ${columnDefinition}`);
  } catch (error) {
    if (error.code !== "ER_DUP_FIELDNAME") {
      throw error;
    }
  }
}

function hashPassword(password) {
  return `sha256:${crypto.createHash("sha256").update(String(password)).digest("hex")}`;
}

function verifyPassword(password, storedPassword) {
  if (!storedPassword) return false;
  if (storedPassword.startsWith("sha256:")) {
    return hashPassword(password) === storedPassword;
  }
  return String(password) === String(storedPassword);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || "").trim());
}

function normalizeWholeNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

async function ensureDefaultAdmin() {
  const [admins] = await db.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (admins.length > 0) return;

  const adminName = process.env.ADMIN_USERNAME || "admin";
  const adminEmail = process.env.ADMIN_EMAIL || "admin@scentique.local";
  const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
  const [existingUsers] = await db.query("SELECT id FROM users WHERE email = ? LIMIT 1", [adminEmail]);

  if (existingUsers.length > 0) {
    await db.query(
      "UPDATE users SET name = ?, password = ?, role = 'admin' WHERE id = ?",
      [adminName, hashPassword(adminPassword), existingUsers[0].id]
    );
    console.log(`Existing user promoted to default admin: ${adminName} / ${adminEmail}`);
    return;
  }

  await db.query(
    "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'admin')",
    [adminName, adminEmail, hashPassword(adminPassword)]
  );

  console.log(`Default admin created in database: ${adminName} / ${adminEmail}`);
}

// Create products table automatically
async function initDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(50) NOT NULL,
      scent VARCHAR(50) DEFAULT 'fresh',
      perfume_type VARCHAR(50) DEFAULT 'Eau de Parfum',
      volume_ml INT DEFAULT 50,
      type VARCHAR(255) NOT NULL,
      description TEXT,
      price DECIMAL(10,2) NOT NULL,
      original_price DECIMAL(10,2),
      sale_price DECIMAL(10,2),
      discount_percentage DECIMAL(5,2),
      stock INT DEFAULT 0,
      rating INT DEFAULT 5,
      image LONGTEXT NOT NULL,
      sale BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      phone_number VARCHAR(30),
      role ENUM('customer', 'admin') DEFAULT 'customer',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS vouchers (
      voucher_id INT AUTO_INCREMENT PRIMARY KEY,
      voucher_code VARCHAR(20) UNIQUE NOT NULL,
      discount_percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
      expiry_date DATE NOT NULL,
      max_redemptions INT,
      max_redemptions_per_user INT DEFAULT 1,
      first_time_only BOOLEAN DEFAULT FALSE,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS carts (
      cart_id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS cart_items (
      cart_item_id INT AUTO_INCREMENT PRIMARY KEY,
      cart_id INT NOT NULL,
      product_id INT NOT NULL,
      quantity INT NOT NULL DEFAULT 1,
      subtotal DECIMAL(10,2) NOT NULL DEFAULT 0,
      FOREIGN KEY (cart_id) REFERENCES carts(cart_id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT,
      voucher_id INT,
      customer_name VARCHAR(255),
      phone_number VARCHAR(30),
      address TEXT,
      postcode VARCHAR(20),
      city VARCHAR(100),
      state VARCHAR(100),
      order_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      total_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      order_status VARCHAR(50) DEFAULT 'Unpaid',
      tracking_number VARCHAR(100),
      paid BOOLEAN DEFAULT FALSE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (voucher_id) REFERENCES vouchers(voucher_id) ON DELETE SET NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS voucher_redemptions (
      redemption_id INT AUTO_INCREMENT PRIMARY KEY,
      voucher_id INT NOT NULL,
      user_id INT NOT NULL,
      order_id INT,
      redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (voucher_id) REFERENCES vouchers(voucher_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE SET NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      order_item_id INT AUTO_INCREMENT PRIMARY KEY,
      order_id INT NOT NULL,
      product_id INT,
      product_name VARCHAR(255),
      product_type VARCHAR(255),
      quantity INT NOT NULL DEFAULT 1,
      price DECIMAL(10,2) NOT NULL DEFAULT 0,
      FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS payments (
      payment_id INT AUTO_INCREMENT PRIMARY KEY,
      order_id INT NOT NULL,
      payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      payment_proof LONGTEXT,
      payment_status VARCHAR(50) DEFAULT 'Pending',
      FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
    )
  `);

  await db.query("ALTER TABLE products MODIFY image LONGTEXT NOT NULL");
  await addColumnIfMissing("products", "scent VARCHAR(50) DEFAULT 'fresh'");
  await addColumnIfMissing("products", "perfume_type VARCHAR(50) DEFAULT 'Eau de Parfum'");
  await addColumnIfMissing("products", "volume_ml INT DEFAULT 50");
  await addColumnIfMissing("products", "description TEXT");
  await addColumnIfMissing("products", "original_price DECIMAL(10,2)");
  await addColumnIfMissing("products", "sale_price DECIMAL(10,2)");
  await addColumnIfMissing("products", "discount_percentage DECIMAL(5,2)");
  await addColumnIfMissing("orders", "tracking_number VARCHAR(100)");
  await addColumnIfMissing("vouchers", "max_redemptions INT");
  await addColumnIfMissing("vouchers", "max_redemptions_per_user INT DEFAULT 1");
  await addColumnIfMissing("vouchers", "first_time_only BOOLEAN DEFAULT FALSE");
  await addColumnIfMissing("vouchers", "active BOOLEAN DEFAULT TRUE");
  await ensureDefaultVouchers();
  await alignVoucherSchema();
  await ensureDefaultAdmin();
  console.log("Database tables are ready.");
}

async function ensureDefaultVouchers() {
  await db.query(
    `INSERT IGNORE INTO vouchers
      (voucher_code, discount_percentage, expiry_date, max_redemptions, max_redemptions_per_user, first_time_only, active)
     VALUES ('FIRSTTIME15', 15, '2099-12-31', NULL, 1, TRUE, TRUE)`
  );
}

async function alignVoucherSchema() {
  const alterStatements = [
    "ALTER TABLE vouchers MODIFY voucher_code VARCHAR(20) NOT NULL",
    "ALTER TABLE vouchers MODIFY discount_percentage DECIMAL(5,2) NOT NULL DEFAULT 0",
    "UPDATE vouchers SET expiry_date = '2099-12-31' WHERE expiry_date IS NULL",
    "ALTER TABLE vouchers MODIFY expiry_date DATE NOT NULL"
  ];

  for (const statement of alterStatements) {
    try {
      await db.query(statement);
    } catch (error) {
      console.warn("Voucher schema alignment skipped:", error.message);
    }
  }
}

function normalizeProductPricing(data) {
  const sale = data.sale === true || data.sale === 1 || data.sale === "1" || data.sale === "true";
  const regularPrice = Number(data.original_price || data.price || 0);
  let salePrice = data.sale_price !== undefined && data.sale_price !== "" ? Number(data.sale_price) : null;
  let discountPercentage = data.discount_percentage !== undefined && data.discount_percentage !== ""
    ? Number(data.discount_percentage)
    : null;

  if (!sale) {
    return {
      sale: 0,
      price: regularPrice,
      originalPrice: regularPrice,
      salePrice: null,
      discountPercentage: null
    };
  }

  if (salePrice === null && discountPercentage !== null && regularPrice > 0) {
    salePrice = regularPrice * (1 - discountPercentage / 100);
  }

  if (discountPercentage === null && salePrice !== null && regularPrice > 0) {
    discountPercentage = ((regularPrice - salePrice) / regularPrice) * 100;
  }

  if (salePrice === null) {
    salePrice = regularPrice;
  }

  salePrice = Math.max(0, Number(salePrice.toFixed(2)));
  discountPercentage = Math.max(0, Number((discountPercentage || 0).toFixed(2)));

  return {
    sale: 1,
    price: salePrice,
    originalPrice: regularPrice,
    salePrice,
    discountPercentage
  };
}

// Test API
app.get("/api/test", (req, res) => {
  res.json({
    message: "Scentique backend is working!"
  });
});

// Test MySQL connection
app.get("/api/db-test", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT 1 + 1 AS result");

    res.json({
      message: "MySQL connected successfully!",
      result: rows[0].result
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "MySQL connection failed.",
      error: error.message
    });
  }
});

app.post("/api/admin/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const attemptKey = username.toLowerCase();
    const attempt = adminLoginAttempts.get(attemptKey) || { count: 0, lockedUntil: 0 };
    const now = Date.now();

    if (!username || !password) {
      return res.status(400).json({ message: "Please enter username and password." });
    }

    if (attempt.lockedUntil > now) {
      return res.status(429).json({
        message: "Too many wrong attempts. Please wait before trying again.",
        retryAfter: Math.ceil((attempt.lockedUntil - now) / 1000)
      });
    }

    const [rows] = await db.query(
      "SELECT id, name, email, password, role FROM users WHERE role = 'admin' AND (email = ? OR name = ?) LIMIT 1",
      [username, username]
    );
    const admin = rows[0];
    const validPassword = admin && verifyPassword(password, admin.password);

    if (!validPassword) {
      const nextCount = attempt.count + 1;
      const lockedUntil = nextCount >= ADMIN_MAX_ATTEMPTS ? now + ADMIN_LOCK_MS : 0;

      adminLoginAttempts.set(attemptKey, {
        count: lockedUntil ? 0 : nextCount,
        lockedUntil
      });

      return res.status(401).json({
        message: lockedUntil
          ? "Wrong password 3 times. Login is blocked for 30 seconds. If you forgot your password, request a password change."
          : `Invalid admin username or password. ${ADMIN_MAX_ATTEMPTS - nextCount} attempt(s) left before temporary block.`,
        retryAfter: lockedUntil ? 30 : 0
      });
    }

    adminLoginAttempts.delete(attemptKey);

    if (!admin.password.startsWith("sha256:")) {
      await db.query("UPDATE users SET password = ? WHERE id = ?", [hashPassword(password), admin.id]);
    }

    res.json({
      message: "Admin login successful.",
      admin: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: admin.role
      }
    });
  } catch (error) {
    console.error("Admin login error:", error);
    res.status(500).json({ message: "Admin login failed. Please try again." });
  }
});

app.post("/api/admin/forgot-password", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();

    if (!username) {
      return res.status(400).json({ message: "Enter your admin username or email first." });
    }

    const [rows] = await db.query(
      "SELECT id FROM users WHERE role = 'admin' AND (email = ? OR name = ?) LIMIT 1",
      [username, username]
    );

    res.json({
      message: rows.length
        ? "Password change request received. Please ask the database owner to update this admin password."
        : "If this admin account exists, request a password change from the database owner."
    });
  } catch (error) {
    console.error("Admin forgot password error:", error);
    res.status(500).json({ message: "Password change request failed. Please try again." });
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const name = String(req.body.username || req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const phoneNumber = String(req.body.phone_number || "").trim() || null;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Please fill in all fields." });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ message: "Please enter a valid email address." });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters." });
    }

    const [existing] = await db.query("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
    if (existing.length > 0) {
      return res.status(409).json({ message: "Email already registered." });
    }

    const [result] = await db.query(
      "INSERT INTO users (name, email, password, phone_number, role) VALUES (?, ?, ?, ?, 'customer')",
      [name, email, hashPassword(password), phoneNumber]
    );

    res.status(201).json({
      message: "Account created successfully.",
      user: {
        id: result.insertId,
        username: name,
        name,
        email,
        phone: phoneNumber || "",
        role: "customer"
      }
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ message: "Registration failed. Please try again." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    if (!username || !password) {
      return res.status(400).json({ message: "Please fill in all fields." });
    }

    const [rows] = await db.query(
      "SELECT id, name, email, password, phone_number, role FROM users WHERE role = 'customer' AND (email = ? OR name = ?) LIMIT 1",
      [username.toLowerCase(), username]
    );
    const user = rows[0];

    if (!user || !verifyPassword(password, user.password)) {
      return res.status(401).json({ message: "Invalid username or password." });
    }

    if (!user.password.startsWith("sha256:")) {
      await db.query("UPDATE users SET password = ? WHERE id = ?", [hashPassword(password), user.id]);
    }

    res.json({
      message: "Login successful.",
      user: {
        id: user.id,
        username: user.name,
        name: user.name,
        email: user.email,
        phone: user.phone_number || "",
        role: user.role
      }
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Login failed. Please try again." });
  }
});

app.patch("/api/users/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const name = String(req.body.username || req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const phoneNumber = String(req.body.phone_number || req.body.phone || "").trim() || null;
    const oldPassword = String(req.body.oldPassword || req.body.old_password || "");
    const newPassword = String(req.body.newPassword || req.body.new_password || "");

    if (!id) {
      return res.status(400).json({ message: "Missing user id." });
    }

    if (!name || !email) {
      return res.status(400).json({ message: "Email and username are required." });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ message: "Please enter a valid email address." });
    }

    const [rows] = await db.query(
      "SELECT id, name, email, password, phone_number, role FROM users WHERE id = ? AND role = 'customer' LIMIT 1",
      [id]
    );
    const user = rows[0];

    if (!user) {
      return res.status(404).json({ message: "Customer account not found." });
    }

    const [existingEmail] = await db.query(
      "SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1",
      [email, id]
    );

    if (existingEmail.length > 0) {
      return res.status(409).json({ message: "That email is already registered." });
    }

    let nextPassword = null;

    if (newPassword) {
      if (!oldPassword) {
        return res.status(400).json({ message: "Enter your old password before setting a new one." });
      }

      if (!verifyPassword(oldPassword, user.password)) {
        return res.status(401).json({ message: "Old password is incorrect." });
      }

      if (newPassword.length < 6) {
        return res.status(400).json({ message: "New password must be at least 6 characters." });
      }

      nextPassword = hashPassword(newPassword);
    }

    await db.query(
      `UPDATE users
       SET name = ?, email = ?, phone_number = ?, password = COALESCE(?, password)
       WHERE id = ?`,
      [name, email, phoneNumber, nextPassword, id]
    );

    res.json({
      message: "Profile updated successfully.",
      user: {
        id,
        username: name,
        name,
        email,
        phone: phoneNumber || "",
        role: user.role
      }
    });
  } catch (error) {
    console.error("Profile update error:", error);
    res.status(500).json({ message: "Profile update failed. Please try again." });
  }
});

// GET all products from MySQL
app.get("/api/products", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM products ORDER BY id DESC");
    res.json(rows);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Failed to fetch products.",
      error: error.message
    });
  }
});

// ADD new product into MySQL
app.post("/api/products", async (req, res) => {
  try {
    const {
      name,
      category,
      scent,
      perfume_type,
      volume_ml,
      type,
      description,
      price,
      original_price,
      sale_price,
      discount_percentage,
      stock,
      rating,
      image,
      sale
    } = req.body;
    const normalizedVolume = Number(volume_ml) || 50;
    const productType = type || `${perfume_type || "Eau de Parfum"} (${normalizedVolume}ml)`;
    const pricing = normalizeProductPricing({ price, original_price, sale_price, discount_percentage, sale });
    const normalizedStock = normalizeWholeNumber(stock);

    if (!name || !category || !productType || !pricing.price || !image) {
      return res.status(400).json({
        message: "Please fill in all required fields."
      });
    }

    if (!Number.isFinite(normalizedVolume) || normalizedVolume <= 0) {
      return res.status(400).json({
        message: "Volume must be greater than 0."
      });
    }

    if (!Number.isFinite(pricing.price) || pricing.price <= 0) {
      return res.status(400).json({
        message: "Regular price must be greater than 0."
      });
    }

    if (normalizedStock === null || normalizedStock < 0) {
      return res.status(400).json({
        message: "Stock quantity must be a whole number, 0 or above."
      });
    }

    const sql = `
      INSERT INTO products 
      (name, category, scent, perfume_type, volume_ml, type, description, price, original_price, sale_price, discount_percentage, stock, rating, image, sale)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
      name,
      category,
      scent || "fresh",
      perfume_type || "Eau de Parfum",
      normalizedVolume,
      productType,
      description || null,
      pricing.price,
      pricing.originalPrice,
      pricing.salePrice,
      pricing.discountPercentage,
      normalizedStock,
      Number(rating) || 5,
      image,
      pricing.sale
    ];

    const [result] = await db.query(sql, values);

    res.status(201).json({
      message: "Product added successfully.",
      productId: result.insertId,
      product: {
        id: result.insertId,
        name,
        category,
        scent: scent || "fresh",
        perfume_type: perfume_type || "Eau de Parfum",
        volume_ml: normalizedVolume,
        type: productType,
        description: description || null,
        price: pricing.price,
        original_price: pricing.originalPrice,
        sale_price: pricing.salePrice,
        discount_percentage: pricing.discountPercentage,
        stock: normalizedStock,
        rating: Number(rating) || 5,
        image,
        sale: pricing.sale
      }
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Failed to add product.",
      error: error.message
    });
  }
});

// UPDATE product
app.patch("/api/products/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      name,
      category,
      scent,
      perfume_type,
      volume_ml,
      type,
      description,
      price,
      original_price,
      sale_price,
      discount_percentage,
      stock,
      rating,
      image,
      sale
    } = req.body;
    const hasPricingUpdate =
      price !== undefined ||
      original_price !== undefined ||
      sale_price !== undefined ||
      discount_percentage !== undefined ||
      sale !== undefined;
    const pricing = hasPricingUpdate
      ? normalizeProductPricing({ price, original_price, sale_price, discount_percentage, sale })
      : null;
    const normalizedStock = stock !== undefined ? normalizeWholeNumber(stock) : null;

    if (stock !== undefined && (!Number.isInteger(normalizedStock) || normalizedStock < 0)) {
      return res.status(400).json({
        message: "Stock must be a whole number, 0 or above."
      });
    }

    const sql = `
      UPDATE products
      SET 
        name = COALESCE(?, name),
        category = COALESCE(?, category),
        scent = COALESCE(?, scent),
        perfume_type = COALESCE(?, perfume_type),
        volume_ml = COALESCE(?, volume_ml),
        type = COALESCE(?, type),
        description = COALESCE(?, description),
        price = COALESCE(?, price),
        original_price = COALESCE(?, original_price),
        sale_price = CASE WHEN ? THEN ? ELSE sale_price END,
        discount_percentage = CASE WHEN ? THEN ? ELSE discount_percentage END,
        stock = COALESCE(?, stock),
        rating = COALESCE(?, rating),
        image = COALESCE(?, image),
        sale = COALESCE(?, sale)
      WHERE id = ?
    `;

    const values = [
      name ?? null,
      category ?? null,
      scent ?? null,
      perfume_type ?? null,
      volume_ml !== undefined ? Number(volume_ml) : null,
      type ?? null,
      description ?? null,
      pricing ? pricing.price : null,
      pricing ? pricing.originalPrice : null,
      hasPricingUpdate ? 1 : 0,
      pricing ? pricing.salePrice : null,
      hasPricingUpdate ? 1 : 0,
      pricing ? pricing.discountPercentage : null,
      normalizedStock,
      rating !== undefined ? Number(rating) : null,
      image ?? null,
      pricing ? pricing.sale : null,
      id
    ];

    const [result] = await db.query(sql, values);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        message: "Product not found."
      });
    }

    res.json({
      message: "Product updated successfully."
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Failed to update product.",
      error: error.message
    });
  }
});

// DELETE product
app.delete("/api/products/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    const [result] = await db.query("DELETE FROM products WHERE id = ?", [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        message: "Product not found."
      });
    }

    res.json({
      message: "Product deleted successfully."
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: "Failed to delete product.",
      error: error.message
    });
  }
});

async function validateVoucherForUser(userId, code, subtotal, queryRunner = db) {
  const voucherCode = String(code || "").trim().toUpperCase();

  if (!voucherCode) {
    return { ok: false, message: "Enter a voucher code." };
  }

  const [voucherRows] = await queryRunner.query(
    `SELECT * FROM vouchers
     WHERE UPPER(voucher_code) = ?
     LIMIT 1`,
    [voucherCode]
  );
  const voucher = voucherRows[0];

  if (!voucher || !voucher.active) {
    return { ok: false, message: "Invalid voucher code." };
  }

  if (voucher.expiry_date) {
    const expiry = new Date(voucher.expiry_date);
    expiry.setHours(23, 59, 59, 999);
    if (expiry < new Date()) {
      return { ok: false, message: "This voucher has expired." };
    }
  }

  const [totalRows] = await queryRunner.query(
    "SELECT COUNT(*) AS count FROM voucher_redemptions WHERE voucher_id = ?",
    [voucher.voucher_id]
  );
  const totalUsed = Number(totalRows[0]?.count || 0);

  if (voucher.max_redemptions && totalUsed >= Number(voucher.max_redemptions)) {
    return { ok: false, message: "This voucher has reached its usage limit." };
  }

  const [userRows] = await queryRunner.query(
    "SELECT COUNT(*) AS count FROM voucher_redemptions WHERE voucher_id = ? AND user_id = ?",
    [voucher.voucher_id, userId]
  );
  const userUsed = Number(userRows[0]?.count || 0);
  const perUserLimit = Number(voucher.max_redemptions_per_user || 1);

  if (userUsed >= perUserLimit) {
    return { ok: false, message: "You have already redeemed this voucher." };
  }

  if (voucher.first_time_only) {
    const [orderRows] = await queryRunner.query(
      "SELECT COUNT(*) AS count FROM orders WHERE user_id = ?",
      [userId]
    );

    if (Number(orderRows[0]?.count || 0) > 0) {
      return { ok: false, message: "This voucher is only for first-time customers." };
    }
  }

  const discountRate = Number(voucher.discount_percentage || 0) / 100;
  const discountAmount = Math.round(Number(subtotal || 0) * discountRate);

  return {
    ok: true,
    voucher,
    discountAmount,
    message: `${voucher.voucher_code} applied. ${Number(voucher.discount_percentage)}% off.`
  };
}

app.get("/api/vouchers", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        vouchers.*,
        COUNT(voucher_redemptions.redemption_id) AS redeemed_count
      FROM vouchers
      LEFT JOIN voucher_redemptions ON voucher_redemptions.voucher_id = vouchers.voucher_id
      GROUP BY vouchers.voucher_id
      ORDER BY vouchers.created_at DESC
    `);

    res.json(rows);
  } catch (error) {
    console.error("Voucher list error:", error);
    res.status(500).json({ message: "Failed to load vouchers." });
  }
});

app.post("/api/vouchers", async (req, res) => {
  try {
    const voucherCode = String(req.body.voucher_code || req.body.code || "").trim().toUpperCase();
    const discountPercentage = Number(req.body.discount_percentage || 0);
    const expiryDate = req.body.expiry_date || null;
    const maxRedemptions = req.body.max_redemptions ? Number(req.body.max_redemptions) : null;
    const maxRedemptionsPerUser = Number(req.body.max_redemptions_per_user || 1);
    const firstTimeOnly = Boolean(req.body.first_time_only);
    const active = req.body.active !== false;

    if (!voucherCode || discountPercentage <= 0 || !expiryDate) {
      return res.status(400).json({ message: "Voucher code, discount percentage, and expiry date are required." });
    }

    if (voucherCode.length > 20) {
      return res.status(400).json({ message: "Voucher code must be 20 characters or less." });
    }

    const [result] = await db.query(
      `INSERT INTO vouchers
        (voucher_code, discount_percentage, expiry_date, max_redemptions, max_redemptions_per_user, first_time_only, active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        voucherCode,
        discountPercentage,
        expiryDate,
        maxRedemptions,
        maxRedemptionsPerUser,
        firstTimeOnly ? 1 : 0,
        active ? 1 : 0
      ]
    );

    res.status(201).json({
      message: "Voucher created successfully.",
      voucher_id: result.insertId
    });
  } catch (error) {
    console.error("Voucher create error:", error);
    res.status(error.code === "ER_DUP_ENTRY" ? 409 : 500).json({
      message: error.code === "ER_DUP_ENTRY" ? "Voucher code already exists." : "Failed to create voucher."
    });
  }
});

app.post("/api/vouchers/validate", async (req, res) => {
  try {
    const userId = Number(req.body.user_id);
    const subtotal = Number(req.body.subtotal || 0);

    if (!userId) {
      return res.status(401).json({ message: "Please login before applying a voucher." });
    }

    const result = await validateVoucherForUser(userId, req.body.voucher_code || req.body.code, subtotal);

    if (!result.ok) {
      return res.status(400).json({ message: result.message });
    }

    res.json({
      message: result.message,
      voucher_id: result.voucher.voucher_id,
      voucher_code: result.voucher.voucher_code,
      discount_percentage: Number(result.voucher.discount_percentage || 0),
      discount_amount: result.discountAmount
    });
  } catch (error) {
    console.error("Voucher validation error:", error);
    res.status(500).json({ message: "Failed to validate voucher." });
  }
});

app.get("/api/orders", async (req, res) => {
  try {
    const userId = req.query.user_id ? Number(req.query.user_id) : null;
    const orderParams = [];
    let orderWhere = "";

    if (userId) {
      orderWhere = "WHERE orders.user_id = ?";
      orderParams.push(userId);
    }

    const [orders] = await db.query(`
      SELECT
        orders.*,
        payments.payment_proof,
        payments.payment_status
      FROM orders
      LEFT JOIN payments ON payments.order_id = orders.order_id
      ${orderWhere}
      ORDER BY orders.order_date DESC
    `, orderParams);
    const [items] = await db.query(`
      SELECT
        order_items.*,
        products.image AS product_image
      FROM order_items
      LEFT JOIN products ON products.id = order_items.product_id
      ORDER BY order_items.order_item_id ASC
    `);

    res.json(orders.map(order => ({
      ...order,
      items: items.filter(item => item.order_id === order.order_id)
    })));
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to fetch orders.",
      error: error.message
    });
  }
});

app.post("/api/orders", async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      user_id,
      voucher_id,
      voucher_code,
      customer_name,
      phone_number,
      address,
      postcode,
      city,
      state,
      total_amount,
      paid,
      payment_proof,
      items = []
    } = req.body;

    if (!user_id) {
      return res.status(401).json({
        message: "Please login before placing an order."
      });
    }

    if (!customer_name || !phone_number || !address || !items.length) {
      return res.status(400).json({
        message: "Please provide shipping details and at least one order item."
      });
    }

    const [customerRows] = await connection.query(
      "SELECT id, role FROM users WHERE id = ? AND role = 'customer' LIMIT 1",
      [user_id]
    );

    if (customerRows.length === 0) {
      return res.status(401).json({
        message: "Please login with a valid customer account before placing an order."
      });
    }

    await connection.beginTransaction();

    const orderItems = [];

    for (const item of items) {
      const productId = item.product_id || item.id;
      const quantity = normalizeWholeNumber(item.quantity || item.qty || 1);
      const price = Number(item.price || 0);

      if (!productId || quantity === null || quantity <= 0) {
        await connection.rollback();
        return res.status(400).json({
          message: "Each order item must have a valid product and quantity."
        });
      }

      if (!Number.isFinite(price) || price < 0) {
        await connection.rollback();
        return res.status(400).json({
          message: "Each order item must have a valid price."
        });
      }

      const [productRows] = await connection.query(
        "SELECT id, name, type, stock FROM products WHERE id = ? LIMIT 1 FOR UPDATE",
        [productId]
      );

      if (productRows.length === 0) {
        await connection.rollback();
        return res.status(400).json({
          message: `${item.name || "This product"} is no longer available.`
        });
      }

      const product = productRows[0];
      const availableStock = Number(product.stock || 0);

      if (quantity > availableStock) {
        await connection.rollback();
        return res.status(400).json({
          message: `Only ${availableStock} ${product.name} item(s) available in stock.`
        });
      }

      orderItems.push({
        ...item,
        productId,
        quantity,
        price,
        productName: item.product_name || item.name || product.name,
        productType: item.product_type || item.type || product.type
      });
    }

    const calculatedTotal = orderItems.reduce((sum, item) => {
      return sum + item.price * item.quantity;
    }, 0);
    let appliedVoucherId = voucher_id || null;

    if (voucher_code) {
      const voucherResult = await validateVoucherForUser(user_id, voucher_code, calculatedTotal, connection);

      if (!voucherResult.ok) {
        await connection.rollback();
        return res.status(400).json({ message: voucherResult.message });
      }

      appliedVoucherId = voucherResult.voucher.voucher_id;
    }

    const [orderResult] = await connection.query(
      `INSERT INTO orders
        (user_id, voucher_id, customer_name, phone_number, address, postcode, city, state, total_amount, order_status, paid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Unpaid', ?)`,
      [
        user_id || null,
        appliedVoucherId,
        customer_name,
        phone_number,
        address,
        postcode || null,
        city || null,
        state || null,
        Number(total_amount || calculatedTotal),
        paid ? 1 : 0
      ]
    );

    const orderId = orderResult.insertId;

    for (const item of orderItems) {
      await connection.query(
        `INSERT INTO order_items
          (order_id, product_id, product_name, product_type, quantity, price)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          orderId,
          item.productId,
          item.productName,
          item.productType,
          item.quantity,
          item.price
        ]
      );

      await connection.query(
        "UPDATE products SET stock = stock - ? WHERE id = ?",
        [item.quantity, item.productId]
      );
    }

    await connection.query(
      `INSERT INTO payments (order_id, payment_proof, payment_status)
       VALUES (?, ?, ?)`,
      [orderId, payment_proof || null, paid ? "Paid" : "Pending"]
    );

    if (appliedVoucherId) {
      await connection.query(
        "INSERT INTO voucher_redemptions (voucher_id, user_id, order_id) VALUES (?, ?, ?)",
        [appliedVoucherId, user_id, orderId]
      );
    }

    await connection.commit();

    res.status(201).json({
      message: "Order saved successfully.",
      order_id: orderId
    });
  } catch (error) {
    await connection.rollback();
    console.error(error);
    res.status(500).json({
      message: "Failed to save order.",
      error: error.message
    });
  } finally {
    connection.release();
  }
});

app.patch("/api/orders/:id/status", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status, paid, payment_status, tracking_number } = req.body;
    const nextStatus = status ? String(status).trim() : null;
    const trackingNumber = tracking_number !== undefined && tracking_number !== null
      ? String(tracking_number).trim()
      : null;

    if (nextStatus === "Shipped") {
      const [existingOrders] = await db.query(
        "SELECT tracking_number FROM orders WHERE order_id = ? LIMIT 1",
        [id]
      );
      const existingTrackingNumber = existingOrders[0]?.tracking_number || "";

      if (!trackingNumber && !existingTrackingNumber) {
        return res.status(400).json({
          message: "Airway bill number is required before changing status to Shipped."
        });
      }
    }

    const [result] = await db.query(
      `UPDATE orders
       SET order_status = COALESCE(?, order_status),
           paid = COALESCE(?, paid),
           tracking_number = COALESCE(?, tracking_number)
       WHERE order_id = ?`,
      [
        nextStatus,
        paid !== undefined ? (paid ? 1 : 0) : null,
        trackingNumber,
        id
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        message: "Order not found."
      });
    }

    if (paid !== undefined || payment_status !== undefined) {
      await db.query(
        "UPDATE payments SET payment_status = ? WHERE order_id = ?",
        [payment_status || (paid ? "Paid" : "Pending"), id]
      );
    }

    res.json({
      message: "Order updated successfully."
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to update order.",
      error: error.message
    });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || message.trim() === "") {
      return res.status(400).json({
        reply: "Please type a message first."
      });
    }

    const [products] = await db.query(`
      SELECT
        id,
        name,
        category,
        scent,
        perfume_type,
        volume_ml,
        type,
        description,
        price,
        original_price,
        sale_price,
        discount_percentage,
        stock,
        sale
      FROM products
      ORDER BY stock > 0 DESC, sale DESC, id DESC
    `);

    const catalog = products.map(product => {
      const sale = product.sale === 1 || product.sale === true;
      const currentPrice = Number(product.sale_price || product.price || 0);
      const originalPrice = Number(product.original_price || product.price || currentPrice);
      const discount = Number(product.discount_percentage || 0);
      const stock = Number(product.stock || 0);

      return [
        `#${product.id}`,
        `Name: ${product.name}`,
        `Audience: ${product.category || "all"}`,
        `Scent: ${product.scent || "not specified"}`,
        `Type: ${product.perfume_type || product.type || "not specified"}`,
        `Volume: ${product.volume_ml || "not specified"}ml`,
        `Price: RM${currentPrice}`,
        sale ? `Original price: RM${originalPrice}` : null,
        sale && discount ? `Discount: ${discount}%` : null,
        `Stock: ${stock}`,
        `Availability: ${stock > 0 ? "available" : "out of stock"}`,
        product.description ? `Description: ${product.description}` : null
      ].filter(Boolean).join(" | ");
    }).join("\n");

    function productChatSummary(product) {
      const sale = product.sale === 1 || product.sale === true;
      const currentPrice = Number(product.sale_price || product.price || 0);
      const originalPrice = Number(product.original_price || product.price || currentPrice);
      const discount = Number(product.discount_percentage || 0);
      const stock = Number(product.stock || 0);
      const priceText = sale && originalPrice > currentPrice
        ? `RM${currentPrice} (${Math.round(discount || ((originalPrice - currentPrice) / originalPrice) * 100)}% off)`
        : `RM${currentPrice}`;

      return `${product.name} - ${product.scent || "signature"} scent, ${priceText}, ${stock > 0 ? `${stock} in stock` : "out of stock"}`;
    }

    function fallbackCatalogReply(customerMessage) {
      const query = String(customerMessage || "").toLowerCase();
      const available = products.filter(product => Number(product.stock || 0) > 0);

      if (!products.length) {
        return "No perfumes are currently listed in Scentique. Please check again later.";
      }

      if (!available.length) {
        return "All listed perfumes are currently out of stock. Please check again later.";
      }

      const exactMatch = products.find(product => query.includes(String(product.name || "").toLowerCase()));
      const preferredPool = exactMatch && Number(exactMatch.stock || 0) <= 0
        ? available.filter(product =>
            product.scent === exactMatch.scent ||
            product.category === exactMatch.category ||
            product.perfume_type === exactMatch.perfume_type
          )
        : available;

      const scored = preferredPool.map(product => {
        const text = [
          product.name,
          product.category,
          product.scent,
          product.perfume_type,
          product.type,
          product.description
        ].join(" ").toLowerCase();
        const score = query.split(/\s+/).filter(word => word.length > 2 && text.includes(word)).length;
        return { product, score };
      }).sort((a, b) => b.score - a.score || Number(b.product.sale || 0) - Number(a.product.sale || 0));

      const suggestions = (scored.length ? scored : available.map(product => ({ product, score: 0 })))
        .slice(0, 3)
        .map(item => productChatSummary(item.product));

      const prefix = exactMatch && Number(exactMatch.stock || 0) <= 0
        ? `${exactMatch.name} is not available right now. Similar available options are:`
        : "Available Scentique options you can consider:";

      return `${prefix}\n${suggestions.map(item => `- ${item}`).join("\n")}`;
    }

    function extractGeminiText(response) {
      if (response?.text) return response.text;
      return response?.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join("")
        .trim();
    }

    const response = await gemini.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        [
          "You are Scentique's friendly perfume assistant.",
          "You must recommend only perfumes listed in the Scentique catalog below.",
          "Prioritize products with Stock greater than 0.",
          "If the customer asks for a specific perfume that is not in the catalog or is out of stock, say it is not available right now, then suggest the most similar available catalog perfumes.",
          "Similarity should be based on scent, audience, perfume type, notes/description, price range, and volume.",
          "Never invent perfume names, prices, stock, discounts, or products outside this catalog.",
          "Keep replies short and helpful. Mention product names, scent, price, and stock status when recommending.",
          "If no products are available, say no perfume is currently available and ask them to check again later."
        ].join(" "),
        `Scentique catalog:\n${catalog || "No products are currently listed."}`,
        `Customer: ${message}`
      ].join("\n\n")
    });

    res.json({
      reply: extractGeminiText(response) || fallbackCatalogReply(message)
    });
  } catch (error) {
    console.error("Chatbot error:", error);

    res.status(500).json({
      reply: "Sorry, the AI assistant is not available right now."
    });
  }
});

// Homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server only after database is ready
initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize database:", error);
    process.exit(1);
  });
