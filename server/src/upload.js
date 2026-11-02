const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const multer = require('multer');

const uploadDirectory = path.resolve(__dirname, '..', 'uploads');
fs.mkdirSync(uploadDirectory, { recursive: true });

const storage = multer.diskStorage({
  destination: (_request, _file, callback) => callback(null, uploadDirectory),
  filename: (_request, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase().slice(0, 10);
    callback(null, `${randomUUID()}${extension}`);
  },
});

const documentUpload = multer({
  fileFilter: (_request, file, callback) => {
    const allowed = file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf';
    callback(allowed ? null : new Error('UNSUPPORTED_FILE_TYPE'), allowed);
  },
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  storage,
});

const profileImageMimeTypes = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
]);

const profileImageUpload = multer({
  fileFilter: (_request, file, callback) => {
    const allowed = profileImageMimeTypes.has(file.mimetype);
    callback(allowed ? null : new Error('UNSUPPORTED_FILE_TYPE'), allowed);
  },
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  storage,
});

const hasProfileImageSignature = (mimeType, header) => {
  if (!header?.length) return false;

  switch (mimeType) {
    case 'image/jpeg':
      return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    case 'image/png':
      return header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/gif':
      return header.length >= 6 && ['GIF87a', 'GIF89a'].includes(header.toString('ascii', 0, 6));
    case 'image/webp':
      return header.length >= 12 && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP';
    case 'image/bmp':
      return header.length >= 2 && header.toString('ascii', 0, 2) === 'BM';
    case 'image/tiff':
      return header.length >= 4
        && ((header[0] === 0x49 && header[1] === 0x49 && header[2] === 0x2a && header[3] === 0x00)
          || (header[0] === 0x4d && header[1] === 0x4d && header[2] === 0x00 && header[3] === 0x2a));
    case 'image/avif':
    case 'image/heic':
    case 'image/heif': {
      if (header.length < 16 || header.toString('ascii', 4, 8) !== 'ftyp') return false;
      const brands = [];
      for (let offset = 8; offset + 4 <= header.length; offset += 4) {
        brands.push(header.toString('ascii', offset, offset + 4));
      }
      if (mimeType === 'image/avif') return brands.some((brand) => ['avif', 'avis'].includes(brand));
      return brands.some((brand) => ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand));
    }
    default:
      return false;
  }
};

const validateProfileImageFile = async (file) => {
  if (!file?.path || !profileImageMimeTypes.has(file.mimetype)) return false;

  let handle;
  try {
    handle = await fs.promises.open(file.path, 'r');
    const header = Buffer.alloc(32);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return hasProfileImageSignature(file.mimetype, header.subarray(0, bytesRead));
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
};

const contractDeliveryUpload = multer({
  fileFilter: (_request, file, callback) => {
    const allowed = ['image/jpeg', 'image/png'].includes(file.mimetype);
    callback(allowed ? null : new Error('UNSUPPORTED_CONTRACT_IMAGE'), allowed);
  },
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  storage: multer.memoryStorage(),
});

const removeUploadedFile = async (fileUrl) => {
  if (typeof fileUrl !== 'string' || !fileUrl.startsWith('/uploads/')) return false;

  const filename = fileUrl.slice('/uploads/'.length);
  if (!filename || filename.includes('/') || filename.includes('\\')) return false;

  const target = path.resolve(uploadDirectory, filename);
  const relativePath = path.relative(uploadDirectory, target);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return false;
  }

  try {
    await fs.promises.unlink(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    console.warn(`[upload] could not remove ${filename}`, error);
    return false;
  }
};

module.exports = {
  contractDeliveryUpload,
  documentUpload,
  profileImageUpload,
  removeUploadedFile,
  uploadDirectory,
  validateProfileImageFile,
};
