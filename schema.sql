-- ============================================================
-- Theatre Corner Database Schema
-- ============================================================

-- Vendors Table
CREATE TABLE Vendors (
    Name      VARCHAR(255) PRIMARY KEY,
    Phone     VARCHAR(20),
    TotalPaid INT NOT NULL DEFAULT 0,
    Remaining INT NOT NULL DEFAULT 0
);

-- Vendor Payments log (for dashboard stats)
CREATE TABLE VendorPayments (
    ID         INT AUTO_INCREMENT PRIMARY KEY,
    VendorName VARCHAR(255),
    Amount     INT NOT NULL DEFAULT 0,
    PaidAt     DATETIME DEFAULT NOW(),
    FOREIGN KEY (VendorName) REFERENCES Vendors(Name) ON DELETE SET NULL
);

-- Items Table
-- ID is VARCHAR to support string IDs (e.g. "ISBN-001", "TC-42")
-- OrderedQty = fixed count of how many the vendor supplied (never changes with stock)
-- BuyingPrice = admin-only cost price from vendor
-- VendorName is nullable: deleting a vendor detaches its items rather than deleting them
CREATE TABLE Items (
    ID           VARCHAR(64)  PRIMARY KEY,
    Price        INT          NOT NULL DEFAULT 0,
    BuyingPrice  INT          NULL DEFAULT NULL,
    Name         VARCHAR(255),
    Count        INT          NOT NULL DEFAULT 0,
    OrderedQty   INT          NOT NULL DEFAULT 0,
    VendorName   VARCHAR(255) NULL,
    FOREIGN KEY (VendorName) REFERENCES Vendors(Name) ON DELETE SET NULL
);

-- Customer Table
CREATE TABLE Customer (
    Phone      VARCHAR(20) PRIMARY KEY,
    Tabs       INT         NOT NULL DEFAULT 0,
    Email      VARCHAR(255),
    TotalSpent INT         NOT NULL DEFAULT 0
);

-- Item Purchased Table
CREATE TABLE ItemPurchased (
    ID            INT AUTO_INCREMENT PRIMARY KEY,
    CustomerPhone VARCHAR(20) NULL,
    ItemID        VARCHAR(64) NOT NULL,
    Quantity      INT         NOT NULL DEFAULT 1,
    PurchasedAt   DATETIME    DEFAULT NOW(),
    FOREIGN KEY (CustomerPhone) REFERENCES Customer(Phone) ON DELETE SET NULL,
    FOREIGN KEY (ItemID)        REFERENCES Items(ID)
);

-- Server-side Edit History (persists across users and logouts)
CREATE TABLE EditHistory (
    ID        INT AUTO_INCREMENT PRIMARY KEY,
    Action    VARCHAR(20)  NOT NULL,
    Type      VARCHAR(50)  NOT NULL,
    Detail    TEXT         NOT NULL,
    UserName  VARCHAR(100) NOT NULL,
    CreatedAt DATETIME     NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Migration notes (run on existing databases):
-- ============================================================
-- ALTER TABLE Items ADD COLUMN BuyingPrice INT NOT NULL DEFAULT 0;
-- ALTER TABLE Items ADD COLUMN OrderedQty  INT NOT NULL DEFAULT 0;
-- ALTER TABLE Items MODIFY Price        INT NOT NULL DEFAULT 0;
-- ALTER TABLE Items MODIFY Count        INT NOT NULL DEFAULT 0;
-- ALTER TABLE Vendors MODIFY TotalPaid  INT NOT NULL DEFAULT 0;
-- ALTER TABLE Vendors MODIFY Remaining  INT NOT NULL DEFAULT 0;
-- ALTER TABLE VendorPayments MODIFY Amount INT NOT NULL DEFAULT 0;
-- ALTER TABLE Customer MODIFY TotalSpent INT NOT NULL DEFAULT 0;
-- ALTER TABLE ItemPurchased ADD COLUMN PurchasedAt DATETIME DEFAULT NOW();
-- CREATE TABLE EditHistory ( ID INT AUTO_INCREMENT PRIMARY KEY, Action VARCHAR(20) NOT NULL, Type VARCHAR(50) NOT NULL, Detail TEXT NOT NULL, UserName VARCHAR(100) NOT NULL, CreatedAt DATETIME NOT NULL DEFAULT NOW() );
--
-- ── Allow deleting Vendors without deleting their Items ──────────────────────
-- ALTER TABLE Items MODIFY VendorName VARCHAR(255) NULL;
-- ALTER TABLE Items DROP FOREIGN KEY <old_fk_name_for_VendorName>;
-- ALTER TABLE Items ADD CONSTRAINT fk_item_vendor FOREIGN KEY (VendorName) REFERENCES Vendors(Name) ON DELETE SET NULL;
--
-- ── Allow deleting Items/Customers without losing order history ──────────────
-- ALTER TABLE ItemPurchased MODIFY ItemID VARCHAR(64) NULL;
-- ALTER TABLE ItemPurchased DROP FOREIGN KEY <old_fk_name_for_ItemID>;
-- ALTER TABLE ItemPurchased ADD CONSTRAINT fk_ip_item     FOREIGN KEY (ItemID)        REFERENCES Items(ID)      ON DELETE SET NULL;
-- ALTER TABLE ItemPurchased DROP FOREIGN KEY <old_fk_name_for_CustomerPhone>;
-- ALTER TABLE ItemPurchased ADD CONSTRAINT fk_ip_customer FOREIGN KEY (CustomerPhone) REFERENCES Customer(Phone) ON DELETE SET NULL;
--
-- ── Auto-delete purchases older than 7 days (MySQL Event Scheduler) ──────────
-- Enable the scheduler once (run as root/admin):
-- SET GLOBAL event_scheduler = ON;
-- CREATE EVENT IF NOT EXISTS purge_old_purchases
--   ON SCHEDULE EVERY 1 HOUR
--   DO DELETE FROM ItemPurchased WHERE PurchasedAt < NOW() - INTERVAL 7 DAY;
