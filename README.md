# Theatre Corner — Management System

A private inventory and sales management system for Theatre Corner. Built with vanilla HTML/CSS/JS on the frontend and a Node.js/Express API backed by MySQL.

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat&logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?style=flat&logo=express&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-8.0-4479A1?style=flat&logo=mysql&logoColor=white)
![Deployed on Vercel](https://img.shields.io/badge/Deployed%20on-Vercel-000000?style=flat&logo=vercel&logoColor=white)

---

## Overview

Theatre Corner is a full-stack management dashboard that handles day-to-day shop operations — inventory tracking, vendor management, customer records, order processing, and sales analytics — all from a single dark-themed web UI with two access roles.

---

## Features

**Dashboard**
- Sales stats (daily / monthly / yearly / all-time) for revenue, units sold, orders, and profit
- Live stock count and live clock
- Period toggle to switch views on the fly

**Inventory**
- Add, edit, and delete items with ID, name, price, stock count, and vendor
- Buying price and ordered quantity visible to admins only
- Stock auto-decrements on order, auto-restores on order deletion

**Vendors**
- Track vendor name, phone, total paid, and remaining balance
- Log payments with a running ledger
- Deleting a vendor detaches its items — items are not deleted

**Customers**
- Track customers by phone with optional email, tab count, and total spent
- TotalSpent updates automatically with every order and refund
- Deleting a customer preserves their order history

**Orders**
- Multi-item cart with live stock validation
- Walk-in orders supported (no customer required)
- Orders auto-expire after 7 days (per-row)
- Admins can delete individual orders, restoring stock and reversing spend

**Edit History**
- Every create / update / delete is logged server-side with timestamp and username
- Admins can view the last 200 actions or clear the log

**Auth & Security**
- Two roles: `admin` and `user` (counter)
- JWT sessions with 1-day expiry
- Progressive login lockout: warns at 3–4 failures, then locks for 5 min → 15 min → 45 min → 3 hrs → 24 hrs
- Live countdown timer on the login page during lockout

---

## Tech Stack

| | |
|---|---|
| Frontend | Vanilla HTML, CSS, JavaScript |
| Backend | Node.js, Express |
| Database | MySQL 8 via `mysql2` |
| Auth | JSON Web Tokens (`jsonwebtoken`) |
| Deployment | Vercel (frontend + API), Railway (MySQL) |

---

## Project Structure

```
theatre-corner/
├── api/
│   └── index.js          # Vercel serverless entry point
├── public/
│   ├── index.html        # Main app — dashboard, inventory, vendors, customers, orders
│   └── login.html        # Login page with lockout UI
├── server.js             # Express API
├── schema.sql            # Database schema and migration notes
├── vercel.json           # Vercel routing and cron config
├── package.json
├── .env.example
└── .gitignore
```

---

## Local Setup

**Prerequisites:** Node.js 18+, MySQL 8+

**1. Clone and install**
```bash
git clone https://github.com/Shamsuzoha/theatre-corner.git
cd theatre-corner
npm install
```

**2. Create the database**
```sql
CREATE DATABASE TheatreCorner;
USE TheatreCorner;
SOURCE schema.sql;
```

**3. Configure environment variables**

Copy `.env.example` to `.env` and fill in your values:
```bash
cp .env.example .env
```

```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASS=your_password
DB_NAME=TheatreCorner

JWT_SECRET=your_long_random_secret

ADMIN_USER=owner
ADMIN_PASS=your_admin_password
USER_USER=counter
USER_PASS=your_counter_password
```

**4. Run**
```bash
node server.js
# or for development:
npm run dev
```

Open `http://localhost:3000`.

---

## Deployment

This project is deployed on **Vercel** (app + API) with a **Railway** MySQL database.

**Environment variables required on Vercel:**

| Variable | Description |
|---|---|
| `DB_HOST` | Railway TCP proxy host |
| `DB_PORT` | Railway TCP proxy port |
| `DB_USER` | Database username |
| `DB_PASS` | Database password |
| `DB_NAME` | Database name |
| `JWT_SECRET` | Long random secret for signing tokens |
| `ADMIN_USER` | Admin login username |
| `ADMIN_PASS` | Admin login password |
| `USER_USER` | Counter login username |
| `USER_PASS` | Counter login password |

The `vercel.json` includes an hourly cron that hits `GET /api/purge` to clean up orders older than 7 days.

---

## API Reference

All endpoints require `Authorization: Bearer <token>`. Routes marked 🔒 require the `admin` role.

### Auth
| Method | Endpoint | Notes |
|---|---|---|
| `POST` | `/api/login` | Returns JWT and role |

### Items
| Method | Endpoint | Notes |
|---|---|---|
| `GET` | `/api/items` | BuyingPrice hidden from counter role |
| `POST` | `/api/items` | |
| `PUT` | `/api/items/:id` | |
| `DELETE` 🔒 | `/api/items/:id` | Detaches from order history, does not wipe it |

### Vendors
| Method | Endpoint | Notes |
|---|---|---|
| `GET` | `/api/vendors` | |
| `POST` | `/api/vendors` | |
| `PUT` 🔒 | `/api/vendors/:id` | |
| `DELETE` 🔒 | `/api/vendors/:id` | Detaches items, does not delete them |
| `POST` | `/api/vendors/:id/pay` | Log a vendor payment |
| `GET` | `/api/vendor-orders` | Items grouped by vendor |
| `GET` | `/api/vendor-payments/stats` | Payment totals by period |

### Customers
| Method | Endpoint | Notes |
|---|---|---|
| `GET` | `/api/customers` | |
| `POST` | `/api/customers` | |
| `PUT` | `/api/customers/:phone` | |
| `DELETE` 🔒 | `/api/customers/:phone` | Preserves order history |

### Orders
| Method | Endpoint | Notes |
|---|---|---|
| `GET` | `/api/purchases` | Raw purchase rows |
| `GET` | `/api/purchases/full` | Joined with item and customer details |
| `POST` | `/api/purchases` | Multi-item cart |
| `DELETE` 🔒 | `/api/purchases/:id` | Restores stock and reverses TotalSpent |

### Stats & History
| Method | Endpoint | Notes |
|---|---|---|
| `GET` | `/api/stats/dashboard` | Aggregated sales and profit |
| `GET` 🔒 | `/api/history` | Last 200 edit actions |
| `DELETE` 🔒 | `/api/history` | Clear history log |
| `GET` | `/api/purge` | Delete orders older than 7 days (called by cron) |

---

## Database Notes

Foreign keys are set to `ON DELETE SET NULL` throughout, meaning:
- Deleting a **vendor** → items stay, VendorName becomes null
- Deleting an **item** → order history stays, ItemID becomes null
- Deleting a **customer** → order history stays, CustomerPhone becomes null

If migrating an existing database, run the `ALTER TABLE` statements at the bottom of `schema.sql`.

---

## License

Private — all rights reserved.
