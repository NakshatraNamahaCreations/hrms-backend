const fs = require('fs');
const path = require('path');
const { UPLOAD_ROOT, toPublicUrl } = require('../middleware/upload');

/**
 * Storage abstraction. Local disk today; S3/Cloudinary adapters can be plugged in
 * by implementing the same { save, getUrl, remove } interface and switching DRIVER.
 */

const localDriver = {
  /**
   * Persist a buffer under uploads/<companyId>/<subDir>/<fileName>; returns the public URL.
   */
  async save({ companyId, subDir = '', fileName, buffer }) {
    const dir = path.join(UPLOAD_ROOT, String(companyId || 'platform'), subDir);
    fs.mkdirSync(dir, { recursive: true });
    const fullPath = path.join(dir, fileName);
    await fs.promises.writeFile(fullPath, buffer);
    return toPublicUrl(fullPath);
  },
  getUrl(storedPath) {
    return storedPath; // already a public /uploads url
  },
  async remove(publicUrl) {
    if (!publicUrl || !publicUrl.startsWith('/uploads/')) return;
    const fullPath = path.join(UPLOAD_ROOT, publicUrl.replace('/uploads/', ''));
    try {
      await fs.promises.unlink(fullPath);
    } catch (e) {
      /* ignore missing files */
    }
  },
};

// --- Stub adapters (same interface) ---------------------------------------
const s3Driver = {
  async save() {
    throw new Error('S3 storage driver not configured. Set STORAGE_DRIVER=local or implement S3.');
  },
  getUrl(p) {
    return p;
  },
  async remove() {},
};

const cloudinaryDriver = {
  async save() {
    throw new Error('Cloudinary storage driver not configured.');
  },
  getUrl(p) {
    return p;
  },
  async remove() {},
};

const drivers = { local: localDriver, s3: s3Driver, cloudinary: cloudinaryDriver };
const DRIVER = process.env.STORAGE_DRIVER || 'local';

module.exports = drivers[DRIVER] || localDriver;
