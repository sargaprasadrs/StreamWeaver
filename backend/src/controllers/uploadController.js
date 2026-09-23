const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Busboy = require('busboy');

const config = require('../config');
const { insertJob } = require('../db');

const ALLOWED_EXTENSIONS = new Set(['.csv', '.tsv', '.txt']);

function isAllowedFilename(name) {
  if (!name) return false;
  const base = path.basename(name);
  // Reject any path tricks in the client-supplied filename
  if (base !== name || base.includes('/') || base.includes('\\') || base.includes('..')) {
    return false;
  }
  return ALLOWED_EXTENSIONS.has(path.extname(base).toLowerCase());
}

function safeTempName(id, originalName) {
  const ext = path.extname(originalName).toLowerCase() || '.csv';
  return `${id}${ext}`;
}

/**
 * POST /api/uploads — streams the multipart file payload to a temp file on
 * disk without ever buffering the whole file in memory.
 */
function createUploadController() {
  return function uploadController(req, res, next) {
    let busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: {
          fileSize: config.maxUploadBytes,
          files: 1,
          fields: 10,
        },
      });
    } catch {
      return res.status(400).json({ error: 'Invalid multipart request' });
    }

    const uploadId = crypto.randomUUID();

    let filePath = null;
    let originalName = null;
    let sizeBytes = 0;
    let streamError = null;
    let tooLarge = false;
    let tooManyFiles = false;
    let fileSeen = false;
    let out = null;
    let clientGone = false;

    // Response-side disconnect detection: res 'close' before the response
    // finished means the client disconnected mid-flight.
    res.on('close', () => {
      if (!res.writableEnded) {
        clientGone = true;
        if (out) out.destroy();
      }
    });

    const finished = new Promise((resolve) => {
      busboy.on('file', (fieldName, fileStream, info) => {
        if (fileSeen) {
          tooManyFiles = true;
          fileStream.resume();
          return;
        }
        fileSeen = true;

        const filename = info.filename || '';
        if (!isAllowedFilename(filename)) {
          streamError = 'Unsupported file type. Allowed: .csv, .tsv, .txt';
          fileStream.resume();
          return;
        }
        originalName = filename;
        filePath = path.join(config.uploadDir, safeTempName(uploadId, filename));

        out = fs.createWriteStream(filePath, { flags: 'wx' });

        // Manual pipe with backpressure: pause the incoming stream whenever
        // the disk write stream falls behind.
        fileStream.on('data', (chunk) => {
          sizeBytes += chunk.length;
          if (!out.write(chunk)) {
            fileStream.pause();
          }
        });

        out.on('drain', () => {
          fileStream.resume();
        });

        fileStream.on('limit', () => {
          tooLarge = true;
          out.destroy();
          fileStream.resume();
        });

        fileStream.on('error', (err) => {
          streamError = err.message || 'Upload stream failed';
          out.destroy();
          fileStream.resume();
        });

        out.on('error', (err) => {
          streamError = streamError || err.message || 'Failed to write upload';
          fileStream.resume();
        });

        fileStream.on('end', () => {
          if (!out.destroyed) out.end();
        });
      });

      // Resolve once the multipart payload is fully handled. 'close' covers
      // every terminal path including malformed payloads and aborts.
      busboy.on('finish', resolve);
      busboy.on('close', resolve);
      busboy.on('error', resolve);
    });

    req.pipe(busboy);

    finished
      .then(async () => {
        // Client vanished mid-upload: clean the temp file, no response goes anywhere.
        if (clientGone) {
          if (filePath) await fs.promises.rm(filePath, { force: true }).catch(() => {});
          return;
        }

        const fail = async (status, message) => {
          if (filePath) await fs.promises.rm(filePath, { force: true }).catch(() => {});
          res.status(status).json({ error: message });
        };

        if (tooLarge) return fail(413, 'File exceeds maximum allowed size');
        if (tooManyFiles) return fail(400, 'Only one file per upload');
        if (!fileSeen || !filePath) return fail(400, streamError || 'No file part in multipart payload');
        if (streamError) return fail(400, streamError);

        try {
          const job = {
            _id: uploadId,
            originalName,
            sizeBytes,
            bytesReceived: sizeBytes,
            tempPath: filePath,
            status: 'ready',
            createdAt: new Date().toISOString(),
          };
          const saved = await insertJob(job);
          return res.status(201).json({
            uploadId: saved._id,
            filename: saved.originalName,
            sizeBytes: saved.sizeBytes,
            status: saved.status,
          });
        } catch (err) {
          if (filePath) await fs.promises.rm(filePath, { force: true }).catch(() => {});
          next(err);
        }
      })
      .catch(next);
  };
}

module.exports = { createUploadController, isAllowedFilename, safeTempName };
