import React, { useCallback, useRef, useState } from 'react';
import { uploadCsv } from '../../lib/api.js';

const ALLOWED_EXTENSIONS = ['.csv', '.tsv', '.txt'];
const MAX_MB = 2048;

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/**
 * Drag & drop + file-picker upload zone wired to the backend with XHR
 * progress. Exposes clear error states: wrong type, too large, network
 * failure, and server-side rejection.
 */
export default function UploadDropzone({ onUploaded }) {
  const inputRef = useRef(null);
  const xhrRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const validate = (file) => {
    const name = file.name.toLowerCase();
    const ok = ALLOWED_EXTENSIONS.some((ext) => name.endsWith(ext));
    if (!ok) return `Unsupported file type. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`;
    if (file.size > MAX_MB * 1024 * 1024) return `File exceeds the ${MAX_MB} MB limit`;
    return null;
  };

  const startUpload = useCallback(
    (file) => {
      setError(null);
      setResult(null);
      const problem = validate(file);
      if (problem) {
        setError(problem);
        return;
      }
      setBusy(true);
      setProgress(0);
      const request = uploadCsv(file, setProgress);
      xhrRef.current = request;
      request
        .then((body) => {
          setResult(body);
          if (onUploaded) onUploaded(body);
        })
        .catch((err) => {
          if (err && err.message === 'Upload aborted') {
            setError('Upload canceled.');
          } else {
            setError((err && err.message) || 'Upload failed');
          }
        })
        .finally(() => {
          setBusy(false);
          xhrRef.current = null;
        });
    },
    [onUploaded]
  );

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (busy) return;
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) startUpload(file);
  };

  const onCancel = () => {
    if (xhrRef.current) xhrRef.current.abort();
  };

  return (
    <section className="panel">
      <h2>Upload CSV</h2>
      <div
        className={`dropzone${dragOver ? ' dropzone--active' : ''}${busy ? ' dropzone--busy' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => !busy && inputRef.current && inputRef.current.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !busy) inputRef.current.click();
        }}
        aria-label="Upload a CSV file"
      >
        <p className="dropzone__title">{busy ? 'Uploading…' : 'Drop a CSV here, or click to browse'}</p>
        <p className="dropzone__hint">Streaming upload — the file is never fully loaded into server memory</p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ALLOWED_EXTENSIONS.join(',')}
        hidden
        onChange={(e) => {
          const file = e.target.files && e.target.files[0];
          e.target.value = '';
          if (file) startUpload(file);
        }}
      />

      {busy && (
        <div className="progress">
          <div className="progress__bar" style={{ width: `${progress}%` }} />
          <span className="progress__label">{progress}%</span>
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}

      {error && (
        <p className="alert alert--error" role="alert">
          {error}
        </p>
      )}

      {result && (
        <p className="alert alert--ok">
          Uploaded <strong>{result.filename}</strong> ({formatBytes(result.sizeBytes)}) — uploadId{' '}
          <code>{result.uploadId}</code>
        </p>
      )}
    </section>
  );
}
