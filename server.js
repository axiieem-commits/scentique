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
      voucher_code VARCHAR(50) UNIQUE NOT NULL,
      discount_percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
      expiry_date DATE,
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
      order_status VARCHAR(50) DEFAULT 'Order Placed',
      paid BOOLEAN DEFAULT FALSE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (voucher_id) REFERENCES vouchers(voucher_id) ON DELETE SET NULL
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
  await ensureDefaultAdmin();
  console.log("Database tables are ready.");
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
      stock,
      rating,
      image,
      sale
    } = req.body;
    const productType = type || `${perfume_type || "Eau de Parfum"} (${Number(volume_ml) || 50}ml)`;

    if (!name || !category || !productType || !price || !image) {
      return res.status(400).json({
        message: "Please fill in all required fields."
      });
    }

    const sql = `
      INSERT INTO products 
      (name, category, scent, perfume_type, volume_ml, type, description, price, stock, rating, image, sale)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
      name,
      category,
      scent || "fresh",
      perfume_type || "Eau de Parfum",
      Number(volume_ml) || 50,
      productType,
      description || null,
      Number(price),
      Number(stock) || 0,
      Number(rating) || 5,
      image,
      sale ? 1 : 0
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
        volume_ml: Number(volume_ml) || 50,
        type: productType,
        description: description || null,
        price: Number(price),
        stock: Number(stock) || 0,
        rating: Number(rating) || 5,
        image,
        sale: sale ? 1 : 0
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
      stock,
      rating,
      image,
      sale
    } = req.body;

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
      price !== undefined ? Number(price) : null,
      stock !== undefined ? Number(stock) : null,
      rating !== undefined ? Number(rating) : null,
      image ?? null,
      sale !== undefined ? (sale ? 1 : 0) : null,
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

    const calculatedTotal = items.reduce((sum, item) => {
      return sum + Number(item.price || 0) * Number(item.quantity || item.qty || 1);
    }, 0);

    const [orderResult] = await connection.query(
      `INSERT INTO orders
        (user_id, voucher_id, customer_name, phone_number, address, postcode, city, state, total_amount, order_status, paid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Order Placed', ?)`,
      [
        user_id || null,
        voucher_id || null,
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

    for (const item of items) {
      const quantity = Number(item.quantity || item.qty || 1);
      const price = Number(item.price || 0);

      await connection.query(
        `INSERT INTO order_items
          (order_id, product_id, product_name, product_type, quantity, price)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          orderId,
          item.product_id || item.id || null,
          item.product_name || item.name || null,
          item.product_type || item.type || null,
          quantity,
          price
        ]
      );

      if (item.product_id || item.id) {
        await connection.query(
          "UPDATE products SET stock = GREATEST(stock - ?, 0) WHERE id = ?",
          [quantity, item.product_id || item.id]
        );
      }
    }

    await connection.query(
      `INSERT INTO payments (order_id, payment_proof, payment_status)
       VALUES (?, ?, ?)`,
      [orderId, payment_proof || null, paid ? "Paid" : "Pending"]
    );

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
    const { status, paid } = req.body;

    const [result] = await db.query(
      "UPDATE orders SET order_status = COALESCE(?, order_status), paid = COALESCE(?, paid) WHERE order_id = ?",
      [status ?? null, paid !== undefined ? (paid ? 1 : 0) : null, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        message: "Order not found."
      });
    }

    if (paid !== undefined) {
      await db.query(
        "UPDATE payments SET payment_status = ? WHERE order_id = ?",
        [paid ? "Paid" : "Pending", id]
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

    const response = await gemini.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        "You are Scentique's friendly perfume assistant. Help customers choose perfumes, explain scent types, suggest products, and answer shop-related questions. Keep replies short and helpful.",
        `Customer: ${message}`
      ].join("\n\n")
    });

    res.json({
      reply: response.text || "Sorry, I could not answer that."
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
