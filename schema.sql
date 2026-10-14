CREATE DATABASE IF NOT EXISTS spill_the_bill CHARACTER SET utf8mb4;
USE spill_the_bill;
-- Money is stored in paise (whole numbers) to avoid decimal rounding errors.
CREATE TABLE bills (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  code          VARCHAR(16) NOT NULL UNIQUE,     -- random string used in the share link
  host_key_hash CHAR(64)    NOT NULL,            -- sha256 of the host's secret key
  tax_paise     INT         NOT NULL DEFAULT 0,
  tax_mode      ENUM('proportional','equal') NOT NULL DEFAULT 'proportional',
  created_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE items (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  bill_id     INT          NOT NULL,
  name        VARCHAR(100) NOT NULL,
  price_paise INT          NOT NULL,
  qty         INT          NOT NULL,
  FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE
);

CREATE TABLE people (
  id      INT AUTO_INCREMENT PRIMARY KEY,
  bill_id INT         NOT NULL,
  name    VARCHAR(40) NOT NULL,
  FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE
);

-- One row = "this person had this item"
CREATE TABLE selections (
  item_id   INT NOT NULL,
  person_id INT NOT NULL,
  PRIMARY KEY (item_id, person_id),
  FOREIGN KEY (item_id)   REFERENCES items(id)  ON DELETE CASCADE,
  FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
);