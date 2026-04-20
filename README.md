# Theatre Corner — Setup Guide

## Prerequisites
- Node.js 18+
- MySQL 8+

---

## Step 1 — Create the database

Open MySQL and run:

```sql
CREATE DATABASE bookstore CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE bookstore;
```

Then paste the full contents of **schema.sql** and execute it.

---

## Step 2 — Install Node dependencies

```bash
npm init -y
npm install express mysql2 dotenv cors jsonwebtoken
```

---

## Step 3 — Create .env file

Create a file named `.env` in the same folder:

```
DB_HOST=localhost
DB_USER=root
DB_PASS=your_mysql_password
DB_NAME=bookstore
JWT_SECRET=change_this_to_a_long_random_string
PORT=3000
```

---

## Step 4 — Set up the file structure

```
project/
├── server.js
├── .env
├── schema.sql
└── public/
    ├── index.html
    └── login.html
```

Create a `public/` folder and put both HTML files inside it.
`server.js` and `.env` stay in the root.

---

## Step 5 — Start the server

```bash
node server.js
```

You should see:
```
Server running → http://localhost:3000
```

---

## Step 6 — Open in browser

Go to: **http://localhost:3000/login.html**

### Login credentials:
| Username | Password | Role |
|----------|----------|------|
| owner    | 22062000 | Admin (full access) |
| counter  | 19710202 | User (limited access) |

---

## Role Permissions Summary

| Action | Admin | Counter |
|--------|-------|---------|
| View all tables | ✅ | ✅ |
| Add vendors/items/customers/orders | ✅ | ✅ |
| Edit vendors | ✅ | ❌ |
| Edit items & customers | ✅ | ✅ |
| Delete anything | ✅ | ❌ |

---

## What changed from your original files

### server.js
- Fixed all field names to match the schema (e.g. `Phone` not `PhoneNumber`, `Count` not `Stock`)
- Removed the generic `crudRouter` factory — replaced with explicit routes that match actual column names
- Fixed `purchases/full` JOIN — schema has no `Quantity` column
- Purchase insert now also decrements `Items.Count` and increments `Customer.TotalSpent` and `Customer.Tabs`
- DELETE for purchases uses composite key body params (no single ID column in schema)

### index.html
- Added auth token to every `api()` call (was missing — all requests would return 401)
- Implemented all missing render functions: `renderVendors`, `renderItems`, `renderCustomers`, `renderOrders`
- Implemented `openModal`, `saveRecord`, `filterTable`, `confirmDelete`
- Fixed column headers to match schema fields
- Role-based UI: Delete buttons only shown to admin, vendor Edit hidden from counter
- Dashboard charts now actually populate from live data

### login.html
- Minor cleanup and Enter-key support
- Now stores `username` in localStorage for display in sidebar
